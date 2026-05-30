import { DEFAULT_MAX_ATTEMPTS } from './constants';
import { createJobId } from './ids';
import type {
	InMemoryJobStore,
	Job,
	JobDefinition,
	JobId,
	JobMapFromDefinition,
	JobStatus
} from './types';
import { assertValidPayload, compileJobValidators } from './validation';

export const createInMemoryJobStore = <const Def extends JobDefinition>(
	definition: Def
): InMemoryJobStore<JobMapFromDefinition<Def>> => {
	type Jobs = JobMapFromDefinition<Def>;
	const cloneJob = (job: Job<Jobs>): Job<Jobs> => ({ ...job });
	const validators = compileJobValidators(definition);
	const jobs = new Map<JobId, Job<Jobs>>();

	const findByIdempotencyKey = (key: string) => {
		for (const job of jobs.values())
			if (
				job.idempotencyKey === key &&
				(job.status === 'pending' || job.status === 'claimed')
			)
				return job;

		return undefined;
	};

	return {
		cancel: async (id) => {
			const job = jobs.get(id);
			if (
				!job ||
				job.status === 'done' ||
				job.status === 'dead' ||
				job.status === 'canceled'
			)
				return false;

			jobs.set(id, {
				...job,
				lockedAt: undefined,
				lockedBy: undefined,
				status: 'canceled',
				updatedAt: Date.now()
			});

			return true;
		},
		claimDue: async ({ limit, now, workerId }) => {
			const due = [...jobs.values()]
				.filter((job) => job.status === 'pending' && job.runAt <= now)
				.sort((left, right) => left.runAt - right.runAt)
				.slice(0, limit);

			return due.map((job) => {
				const claimed: Job<Jobs> = {
					...job,
					lockedAt: now,
					lockedBy: workerId,
					status: 'claimed',
					updatedAt: now
				};
				jobs.set(job.id, claimed);

				return cloneJob(claimed);
			});
		},
		complete: async (id) => {
			const job = jobs.get(id);
			if (!job) return;

			jobs.set(id, { ...job, status: 'done', updatedAt: Date.now() });
		},
		countByStatus: async () => {
			const counts: Record<JobStatus, number> = {
				canceled: 0,
				claimed: 0,
				dead: 0,
				done: 0,
				pending: 0
			};
			for (const job of jobs.values()) counts[job.status] += 1;

			return counts;
		},
		enqueue: async (input) => {
			assertValidPayload(
				validators.get(String(input.kind)),
				String(input.kind),
				input.payload
			);

			if (input.idempotencyKey) {
				const existing = findByIdempotencyKey(input.idempotencyKey);
				if (existing) return existing.id;
			}

			const now = Date.now();
			const id = createJobId();
			const job = {
				attempts: 0,
				createdAt: now,
				id,
				idempotencyKey: input.idempotencyKey,
				kind: input.kind,
				maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
				payload: input.payload,
				runAt: input.runAt ?? now,
				status: 'pending',
				updatedAt: now
			} as Job<Jobs>;
			jobs.set(id, job);

			return id;
		},
		fail: async (id, { dead, error, retryAt }) => {
			const job = jobs.get(id);
			if (!job) return;

			jobs.set(id, {
				...job,
				attempts: job.attempts + 1,
				lastError: error,
				lockedAt: undefined,
				lockedBy: undefined,
				runAt: retryAt ?? job.runAt,
				status: dead ? 'dead' : 'pending',
				updatedAt: Date.now()
			});
		},
		get: async (id) => {
			const job = jobs.get(id);

			return job ? cloneJob(job) : undefined;
		},
		list: async (options) => {
			const matched = [...jobs.values()]
				.filter((job) =>
					options?.status ? job.status === options.status : true
				)
				.filter((job) =>
					options?.kind ? job.kind === options.kind : true
				)
				.sort((left, right) => right.createdAt - left.createdAt);
			const offset = options?.offset ?? 0;
			const limit = options?.limit ?? 100;

			return matched.slice(offset, offset + limit).map(cloneJob);
		},
		listByKind: async (kind, options) => {
			const matched = [...jobs.values()].filter(
				(job) =>
					job.kind === kind &&
					(options?.status ? job.status === options.status : true)
			);
			const limited = options?.limit
				? matched.slice(0, options.limit)
				: matched;

			return limited.map(cloneJob) as Job<Jobs, typeof kind>[];
		},
		reapStuck: async ({ leaseMs, now }) => {
			let reaped = 0;
			for (const job of jobs.values())
				if (
					job.status === 'claimed' &&
					job.lockedAt !== undefined &&
					job.lockedAt + leaseMs <= now
				) {
					jobs.set(job.id, {
						...job,
						lockedAt: undefined,
						lockedBy: undefined,
						status: 'pending',
						updatedAt: now
					});
					reaped += 1;
				}

			return reaped;
		},
		retry: async (id) => {
			const job = jobs.get(id);
			if (!job) return false;

			jobs.set(id, {
				...job,
				attempts: 0,
				lastError: undefined,
				lockedAt: undefined,
				lockedBy: undefined,
				runAt: Date.now(),
				status: 'pending',
				updatedAt: Date.now()
			});

			return true;
		},
		// 0.1.0: shard-rotation persistence. The host serializes this on a
		// timer or on SIGTERM, persists wherever (disk, S3, another instance
		// over the cluster bus), and hands it back to the replacement
		// worker. `restore` overwrites the current map; refuse mid-flight
		// restore to keep semantics clear.
		snapshot: () => ({
			exportedAt: Date.now(),
			jobs: [...jobs.values()].map(cloneJob)
		}),
		restore: (snapshot) => {
			jobs.clear();
			for (const job of snapshot.jobs) {
				jobs.set(job.id, cloneJob(job));
			}
			return snapshot.jobs.length;
		}
	};
};
