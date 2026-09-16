import { expect, test } from 'bun:test';
import { Type as t } from 'typebox';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({ old: t.Object({}), added: t.Object({}) });
test('an older worker leaves newer jobs pending and can reach its own jobs behind them', async () => {
	const store = createInMemoryJobStore(jobs);
	const added = await store.enqueue({ kind: 'added', payload: {}, runAt: 1 });
	const old = await store.enqueue({ kind: 'old', payload: {}, runAt: 2 });
	const worker = createQueueWorker({
		store,
		registry: createJobRegistry(jobs).on('old', () => {}),
		concurrency: 1,
		requireKindFiltering: true
	});
	expect(await worker.runOnce()).toBe(1);
	expect((await store.get?.(added))?.status).toBe('pending');
	expect((await store.get?.(added))?.attempts).toBe(0);
	expect((await store.get?.(old))?.status).toBe('done');
	const upgraded = createQueueWorker({
		store,
		registry: createJobRegistry(jobs).on('added', () => {}),
		requireKindFiltering: true
	});
	expect(await upgraded.runOnce()).toBe(1);
	expect((await store.get?.(added))?.status).toBe('done');
});
test('a worker with no handlers claims nothing', async () => {
	const store = createInMemoryJobStore(jobs);
	const id = await store.enqueue({ kind: 'added', payload: {} });
	const worker = createQueueWorker({
		store,
		registry: createJobRegistry(jobs),
		requireKindFiltering: true
	});
	expect(await worker.runOnce()).toBe(0);
	expect((await store.get?.(id))?.status).toBe('pending');
});
test('strict workers reject stores that ignore kind filtering', () => {
	const store = createInMemoryJobStore(jobs);
	expect(() =>
		createQueueWorker({
			store: { ...store, supportsKindFiltering: undefined },
			registry: createJobRegistry(jobs),
			requireKindFiltering: true
		})
	).toThrow('atomic job kind filtering');
});
