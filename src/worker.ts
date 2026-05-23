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
	QueueWorker
} from './types';

export const createQueueWorker = <Jobs extends JobMap>({
	backoff = exponentialBackoff(),
	concurrency = DEFAULT_CONCURRENCY,
	leaseMs = DEFAULT_LEASE_MS,
	onError,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	registry,
	store,
	workerId = crypto.randomUUID()
}: CreateQueueWorkerOptions<Jobs>): QueueWorker => {
	let running = false;
	let active = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const runJob = async (job: Job<Jobs>) => {
		const handler = registry.getHandler(job.kind);
		if (!handler) {
			await store.fail(job.id, {
				dead: true,
				error: `No handler registered for kind "${String(job.kind)}"`
			});

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
		} catch (error) {
			const attempt = job.attempts + 1;
			const message =
				error instanceof Error ? error.message : String(error);

			if (attempt >= job.maxAttempts)
				await store.fail(job.id, { dead: true, error: message });
			else
				await store.fail(job.id, {
					error: message,
					retryAt: Date.now() + backoff(attempt)
				});

			onError?.(error, job);
		}
	};

	const tick = async () => {
		const now = Date.now();
		await store.reapStuck({ leaseMs, now });

		const capacity = concurrency - active;
		if (capacity <= 0) return 0;

		const claimed = await store.claimDue({
			limit: capacity,
			now,
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

	return {
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
