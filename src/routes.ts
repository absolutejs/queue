import { Elysia } from 'elysia';
import type { JobId, JobMap, JobStatus, JobStore } from './types';

export type QueueRoutesOptions<Jobs extends JobMap> = {
	prefix?: string;
	store: JobStore<Jobs>;
};

// Admin/observability routes for a queue store. Endpoints degrade to 501 when the
// store doesn't implement the optional capability.
export const createQueueRoutes = <Jobs extends JobMap>({
	prefix = '/queue',
	store
}: QueueRoutesOptions<Jobs>) =>
	new Elysia({ name: '@absolutejs/queue/routes', prefix })
		.get('/stats', ({ status }) =>
			store.countByStatus
				? store.countByStatus()
				: status(501, 'countByStatus not supported')
		)
		.get('/jobs', ({ query, status }) => {
			if (!store.list) return status(501, 'list not supported');

			return store.list({
				kind: query.kind,
				limit:
					query.limit === undefined ? undefined : Number(query.limit),
				offset:
					query.offset === undefined
						? undefined
						: Number(query.offset),
				status: query.status as JobStatus | undefined
			});
		})
		.get('/jobs/:id', async ({ params, status }) => {
			if (!store.get) return status(501, 'get not supported');
			const job = await store.get(params.id as JobId);

			return job ?? status(404, 'Not found');
		})
		.post('/jobs/:id/retry', async ({ params, status }) => {
			if (!store.retry) return status(501, 'retry not supported');

			return (await store.retry(params.id as JobId))
				? { retried: true }
				: status(404, 'Not found');
		})
		.post('/jobs/:id/cancel', async ({ params, status }) => {
			if (!store.cancel) return status(501, 'cancel not supported');

			return (await store.cancel(params.id as JobId))
				? { canceled: true }
				: status(404, 'Not found or not active');
		});
