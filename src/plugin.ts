import { Elysia } from 'elysia';
import { createQueueWorker } from './worker';
import type {
	BackoffStrategy,
	JobId,
	JobMap,
	JobRegistry,
	JobStore
} from './types';

export type QueueEnqueueOptions = {
	idempotencyKey?: string;
	maxAttempts?: number;
	runAt?: number;
};

export type QueueDecorator<Jobs extends JobMap> = {
	enqueue: <Kind extends keyof Jobs>(
		kind: Kind,
		payload: Jobs[Kind],
		options?: QueueEnqueueOptions
	) => Promise<JobId>;
	store: JobStore<Jobs>;
};

export type QueuePluginOptions<Jobs extends JobMap> = {
	backoff?: BackoffStrategy;
	concurrency?: number;
	registry: JobRegistry<Jobs>;
	runWorker?: boolean;
	store: JobStore<Jobs>;
};

export const queue = <Jobs extends JobMap>({
	backoff,
	concurrency,
	registry,
	runWorker = true,
	store
}: QueuePluginOptions<Jobs>) => {
	const worker = createQueueWorker({ backoff, concurrency, registry, store });

	const decorator: QueueDecorator<Jobs> = {
		enqueue: (kind, payload, options) =>
			store.enqueue({
				idempotencyKey: options?.idempotencyKey,
				kind,
				maxAttempts: options?.maxAttempts,
				payload,
				runAt: options?.runAt
			}),
		store
	};

	return new Elysia({ name: '@absolutejs/queue' })
		.decorate('queue', decorator)
		.onStart(() => {
			if (runWorker) worker.start();
		})
		.onStop(async () => {
			if (runWorker) await worker.stop();
		});
};
