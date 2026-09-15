import { describe, expect, test } from 'bun:test';
import { Type as t } from 'typebox';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';
const jobs = defineJobs({ process: t.Object({}) });

describe('claim ownership fencing', () => {
	test('reclaim creates a fresh token even with the same worker ID and clock', async () => {
		const store = createInMemoryJobStore(jobs);
		const id = await store.enqueue({
			kind: 'process',
			payload: {},
			runAt: 1
		});
		const [first] = await store.claimDue({
			now: 10,
			limit: 1,
			workerId: 'same-worker'
		});
		await store.reapStuck({ now: 10, leaseMs: 0 });
		const [second] = await store.claimDue({
			now: 10,
			limit: 1,
			workerId: 'same-worker'
		});
		expect(second!.claimToken).not.toBe(first!.claimToken);
		expect(await store.completeClaim!(id, first!.claimToken!)).toBe(false);
		expect(
			await store.failClaim!(id, first!.claimToken!, {
				dead: true,
				error: 'stale'
			})
		).toBe(false);
		expect((await store.get!(id))!.status).toBe('claimed');
		expect((await store.get!(id))!.attempts).toBe(0);
		expect(await store.completeClaim!(id, second!.claimToken!)).toBe(true);
		expect(
			await store.failClaim!(id, second!.claimToken!, {
				error: 'late failure'
			})
		).toBe(false);
		expect((await store.get!(id))!.status).toBe('done');
	});
	for (const failure of [false, true]) {
		test(`a live worker cannot ${failure ? 'fail' : 'complete'} a reclaimed attempt`, async () => {
			const store = createInMemoryJobStore(jobs);
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const registry = createJobRegistry(jobs).on(
				'process',
				async (_payload, context) => {
					expect(context.claimToken).toBeDefined();
					started.resolve();
					await finish.promise;
				}
			);
			const worker = createQueueWorker({
				store,
				registry,
				requireClaimFencing: true
			});
			const id = await store.enqueue({ kind: 'process', payload: {} });
			const running = worker.runOnce();
			await started.promise;
			const now = Date.now() + 1000;
			await store.reapStuck({ now, leaseMs: 0 });
			const [newer] = await store.claimDue({
				now,
				limit: 1,
				workerId: 'replacement'
			});
			if (failure) finish.reject(new Error('old attempt failed'));
			else finish.resolve();
			await running;
			const current = await store.get!(id);
			expect(typeof newer!.claimToken).toBe('string');
			expect(current!.claimToken).toBe(newer!.claimToken!);
			expect(current!.status).toBe('claimed');
			expect(current!.attempts).toBe(0);
			expect(worker.metrics().completed).toBe(0);
		});
	}
	test('cancellation invalidates completion and strict workers reject legacy stores', async () => {
		const store = createInMemoryJobStore(jobs);
		const id = await store.enqueue({
			kind: 'process',
			payload: {},
			runAt: 1
		});
		const [claim] = await store.claimDue({
			now: 10,
			limit: 1,
			workerId: 'worker'
		});
		await store.cancel!(id);
		expect(await store.completeClaim!(id, claim!.claimToken!)).toBe(false);
		store.completeClaim = undefined;
		store.failClaim = undefined;
		expect(() =>
			createQueueWorker({
				store,
				registry: createJobRegistry(jobs),
				requireClaimFencing: true
			})
		).toThrow('requires a store with atomic claim fencing');
	});
});
