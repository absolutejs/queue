import { expect, test } from 'bun:test';
import {
	t,
	defineJobs,
	createInMemoryJobStore,
	createJobRegistry,
	createQueueWorker,
	NonRetryableJobError
} from '../src';
test('permanent failure is dead after one attempt with its reason, ordinary errors remain retryable', async () => {
	const jobs = defineJobs({ paid: t.Object({ permanent: t.Boolean() }) });
	const store = createInMemoryJobStore(jobs);
	const terminal = await store.enqueue({
		kind: 'paid',
		payload: { permanent: true },
		maxAttempts: 5
	});
	const transient = await store.enqueue({
		kind: 'paid',
		payload: { permanent: false },
		maxAttempts: 5
	});
	const worker = createQueueWorker({
		store,
		registry: createJobRegistry(jobs).on('paid', ({ permanent }) => {
			if (permanent) throw new NonRetryableJobError('Approval expired');
			throw Error('Try later');
		})
	});
	await worker.runOnce();
	expect((await store.get?.(terminal))?.status).toBe('dead');
	expect((await store.get?.(terminal))?.lastError).toBe('Approval expired');
	expect((await store.get?.(transient))?.status).toBe('pending');
	expect(worker.metrics().deadLettered).toBe(1);
});
