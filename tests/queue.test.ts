import { describe, expect, it } from 'bun:test';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';

type Jobs = {
	'always.fail': { reason: string };
	'math.add': { left: number; right: number };
};

describe('@absolutejs/queue', () => {
	it('runs an enqueued job through the worker', async () => {
		const store = createInMemoryJobStore<Jobs>();
		let sum = 0;
		const registry = createJobRegistry<Jobs>().on(
			'math.add',
			({ left, right }) => {
				sum = left + right;
			}
		);
		const worker = createQueueWorker({ registry, store });

		await store.enqueue({
			kind: 'math.add',
			payload: { left: 2, right: 3 }
		});
		const ran = await worker.runOnce();

		expect(ran).toBe(1);
		expect(sum).toBe(5);
	});

	it('dedupes enqueue by idempotency key', async () => {
		const store = createInMemoryJobStore<Jobs>();
		const first = await store.enqueue({
			idempotencyKey: 'once',
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		const second = await store.enqueue({
			idempotencyKey: 'once',
			kind: 'math.add',
			payload: { left: 9, right: 9 }
		});

		expect(second).toBe(first);
	});

	it('retries then dead-letters after maxAttempts', async () => {
		const store = createInMemoryJobStore<Jobs>();
		let calls = 0;
		const registry = createJobRegistry<Jobs>().on('always.fail', () => {
			calls += 1;
			throw new Error('boom');
		});
		const worker = createQueueWorker({
			backoff: () => 0,
			registry,
			store
		});

		await store.enqueue({
			kind: 'always.fail',
			maxAttempts: 3,
			payload: { reason: 'test' }
		});

		await worker.runOnce();
		await worker.runOnce();
		await worker.runOnce();

		const dead = await store.listByKind?.('always.fail', {
			status: 'dead'
		});

		expect(calls).toBe(3);
		expect(dead?.length).toBe(1);
	});
});
