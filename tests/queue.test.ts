import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { QueuePayloadValidationError } from '../src/validation';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({
	'always.fail': t.Object({ reason: t.String() }),
	'math.add': t.Object({ left: t.Number(), right: t.Number() })
});

describe('@absolutejs/queue', () => {
	it('runs an enqueued job through the worker', async () => {
		const store = createInMemoryJobStore(jobs);
		let sum = 0;
		const registry = createJobRegistry(jobs).on(
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
		const store = createInMemoryJobStore(jobs);
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

	it('rejects an invalid payload at enqueue', async () => {
		const store = createInMemoryJobStore(jobs);

		const result = store.enqueue({
			kind: 'math.add',
			// @ts-expect-error - missing `right`, caught at compile time and runtime
			payload: { left: 1 }
		});

		await expect(result).rejects.toBeInstanceOf(
			QueuePayloadValidationError
		);
	});

	it('retries then dead-letters after maxAttempts', async () => {
		const store = createInMemoryJobStore(jobs);
		let calls = 0;
		const registry = createJobRegistry(jobs).on('always.fail', () => {
			calls += 1;
			throw new Error('boom');
		});
		const worker = createQueueWorker({ backoff: () => 0, registry, store });

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
