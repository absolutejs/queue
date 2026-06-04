import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { QueueHandlerTimeoutError } from '../src/validation';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({
	'slow.task': t.Object({ ms: t.Number() })
});

describe('handler timeout', () => {
	it('aborts the handler signal and fails the job past handlerTimeoutMs', async () => {
		const store = createInMemoryJobStore(jobs);
		let aborted = false;
		const registry = createJobRegistry(jobs).on(
			'slow.task',
			async (_payload, ctx) =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5_000);
					ctx.signal.addEventListener('abort', () => {
						aborted = true;
						clearTimeout(timer);
						resolve();
					});
				})
		);
		const errors: unknown[] = [];
		const worker = createQueueWorker({
			backoff: () => 0,
			handlerTimeoutMs: 20,
			onError: (error) => errors.push(error),
			registry,
			store
		});
		await store.enqueue({ kind: 'slow.task', payload: { ms: 5_000 } });

		await worker.runOnce();

		const m = worker.metrics();
		// The slot freed via failure (retry or dead-letter), not a 30s lease hold.
		expect(m.failed + m.retried).toBeGreaterThan(0);
		expect(m.completed).toBe(0);
		expect(aborted).toBe(true);
		expect(errors[0]).toBeInstanceOf(QueueHandlerTimeoutError);
	});

	it('per-kind function returning undefined imposes no timeout', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on(
			'slow.task',
			async () => new Promise<void>((resolve) => setTimeout(resolve, 10))
		);
		const worker = createQueueWorker({
			handlerTimeoutMs: () => undefined,
			registry,
			store
		});
		await store.enqueue({ kind: 'slow.task', payload: { ms: 10 } });
		await worker.runOnce();
		expect(worker.metrics().completed).toBe(1);
	});
});
