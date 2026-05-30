import { TypeCompiler } from '@sinclair/typebox/compiler';
import { ABS_ATTRS, tracerOrNoop } from '@absolutejs/telemetry';
import { exponentialBackoff } from './backoff';
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_LEASE_MS,
	DEFAULT_POLL_INTERVAL_MS
} from './constants';
import type {
	CreateQueueWorkerOptions,
	Job,
	JobMap,
	QueueWorker,
	QueueWorkerMetrics
} from './types';
import {
	collectPayloadIssues,
	QueuePayloadValidationError,
	type JobValidators
} from './validation';

export const createQueueWorker = <Jobs extends JobMap>({
	backoff = exponentialBackoff(),
	concurrency = DEFAULT_CONCURRENCY,
	leaseMs = DEFAULT_LEASE_MS,
	onError,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	registry,
	store,
	tracerProvider,
	workerId = crypto.randomUUID()
}: CreateQueueWorkerOptions<Jobs>): QueueWorker => {
	// 0.2.0: OTel tracer (noop when tracerProvider unset).
	const tracer = tracerOrNoop(tracerProvider, '@absolutejs/queue');
	let running = false;
	let active = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 0.1.0: operator-shaped metrics + drain state. All counters are
	// cumulative since createQueueWorker().
	let draining = false;
	let runs = 0;
	let completed = 0;
	let failed = 0;
	let retried = 0;
	let deadLettered = 0;
	let polls = 0;
	let reaped = 0;
	let lastTickMs = 0;

	// Compile a validator per kind so a job whose persisted payload no longer
	// matches the schema (stale data, schema drift) is dead-lettered instead of
	// crashing the handler.
	const validators: JobValidators = new Map();
	for (const kind of registry.kinds()) {
		const schema = registry.getSchema(kind);
		if (schema) validators.set(String(kind), TypeCompiler.Compile(schema));
	}

	const runJob = async (job: Job<Jobs>) => {
		// 0.2.0: per-job span. The span lifetime IS the job's handler
		// invocation — fail / retry / dead-letter all reflected in
		// status + recorded exception.
		const span = tracer.startSpan('queue.runJob', {
			attributes: {
				[ABS_ATTRS.jobAttempt]: job.attempts,
				[ABS_ATTRS.jobId]: job.id,
				[ABS_ATTRS.jobKind]: String(job.kind),
				[ABS_ATTRS.jobMaxAttempts]: job.maxAttempts,
				[ABS_ATTRS.workerId]: workerId
			}
		});
		runs += 1;
		try {
		const handler = registry.getHandler(job.kind);
		if (!handler) {
			await store.fail(job.id, {
				dead: true,
				error: `No handler registered for kind "${String(job.kind)}"`
			});
			failed += 1;
			deadLettered += 1;

			return;
		}

		const issues = collectPayloadIssues(
			validators.get(String(job.kind)),
			job.payload
		);
		if (issues) {
			await store.fail(job.id, {
				dead: true,
				error: `Payload validation failed: ${issues.join('; ')}`
			});
			failed += 1;
			deadLettered += 1;
			onError?.(
				new QueuePayloadValidationError(String(job.kind), issues),
				job
			);

			return;
		}

		const controller = new AbortController();
		try {
			await handler(job.payload, {
				attempts: job.attempts,
				id: job.id,
				kind: job.kind,
				maxAttempts: job.maxAttempts,
				signal: controller.signal
			});
			await store.complete(job.id);
			completed += 1;
			span.setStatus({ code: 1 /* OK */ });
		} catch (error) {
			const attempt = job.attempts + 1;
			const message =
				error instanceof Error ? error.message : String(error);

			const isDead = attempt >= job.maxAttempts;
			if (isDead) {
				await store.fail(job.id, { dead: true, error: message });
				failed += 1;
				deadLettered += 1;
			} else {
				await store.fail(job.id, {
					error: message,
					retryAt: Date.now() + backoff(attempt)
				});
				retried += 1;
			}

			// 0.2.0: span captures the handler's exception. Status
			// code is ERROR for both retryable + dead-lettered outcomes
			// — the trace records that THIS attempt failed; downstream
			// retries get their own span on the next run.
			span.recordException(error);
			span.setStatus({
				code: 2 /* ERROR */,
				message
			});

			onError?.(error, job);
		}
		} finally {
			// 0.2.0: end the span on every exit path — handler-not-
			// found early return, validation-failed early return,
			// successful completion, and caught handler exceptions.
			span.end();
		}
	};

	const tick = async () => {
		const tickStart = Date.now();
		polls += 1;
		reaped += await store.reapStuck({ leaseMs, now: tickStart });

		// 0.1.0: while draining, skip claiming new jobs. In-flight handlers
		// keep running; stuck-lease reaps continue. The polling loop only
		// halts on stop().
		const capacity = draining ? 0 : concurrency - active;
		if (capacity <= 0) {
			lastTickMs = Date.now() - tickStart;
			return 0;
		}

		const claimed = await store.claimDue({
			limit: capacity,
			now: tickStart,
			workerId
		});

		await Promise.all(
			claimed.map(async (job) => {
				active += 1;
				try {
					await runJob(job);
				} finally {
					active -= 1;
				}
			})
		);

		lastTickMs = Date.now() - tickStart;
		return claimed.length;
	};

	const loop = async () => {
		if (!running) return;

		try {
			await tick();
		} catch (error) {
			onError?.(error);
		} finally {
			if (running) timer = setTimeout(loop, pollIntervalMs);
		}
	};

	const metrics = (): QueueWorkerMetrics => ({
		active,
		capacity: concurrency,
		completed,
		deadLettered,
		draining,
		failed,
		lastTickMs,
		polls,
		reaped,
		retried,
		runs
	});

	return {
		drain: () => {
			draining = true;
		},
		metrics,
		runOnce: tick,
		start: () => {
			if (running) return;
			running = true;
			timer = setTimeout(loop, 0);
		},
		stop: async () => {
			running = false;
			if (timer) clearTimeout(timer);
			while (active > 0)
				await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
};
