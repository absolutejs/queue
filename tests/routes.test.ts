import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createQueueRoutes } from '../src/routes';

const jobs = defineJobs({
	'math.add': t.Object({ left: t.Number(), right: t.Number() })
});

const makeApp = () => {
	const store = createInMemoryJobStore(jobs);

	return { app: new Elysia().use(createQueueRoutes({ store })), store };
};

const json = (app: Elysia, path: string, method = 'GET') =>
	app
		.handle(new Request(`http://local${path}`, { method }))
		.then((response) => response.json());

describe('createQueueRoutes', () => {
	it('lists jobs and reports stats', async () => {
		const { app, store } = makeApp();
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 2 }
		});

		const list = await json(app, '/queue/jobs');
		expect(list).toHaveLength(1);

		const stats = await json(app, '/queue/stats');
		expect(stats.pending).toBe(1);
	});

	it('cancels then retries a job', async () => {
		const { app, store } = makeApp();
		const id = await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});

		const canceled = await json(app, `/queue/jobs/${id}/cancel`, 'POST');
		expect(canceled.canceled).toBe(true);
		expect((await json(app, '/queue/stats')).canceled).toBe(1);

		const retried = await json(app, `/queue/jobs/${id}/retry`, 'POST');
		expect(retried.retried).toBe(true);

		const stats = await json(app, '/queue/stats');
		expect(stats.pending).toBe(1);
		expect(stats.canceled).toBe(0);
	});

	it('404s an unknown job', async () => {
		const { app } = makeApp();
		const response = await app.handle(
			new Request('http://local/queue/jobs/nope/retry', {
				method: 'POST'
			})
		);
		expect(response.status).toBe(404);
	});
});
