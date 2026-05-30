import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({
	'always.fail': t.Object({ reason: t.String() }),
	'math.add': t.Object({ left: t.Number(), right: t.Number() })
});

describe('worker.metrics() — 0.1.0', () => {
	it('starts with zeroed cumulative counters', () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs);
		const worker = createQueueWorker({ concurrency: 4, registry, store });
		const m = worker.metrics();
		expect(m).toEqual({
			active: 0,
			capacity: 4,
			completed: 0,
			deadLettered: 0,
			draining: false,
			failed: 0,
			lastTickMs: 0,
			polls: 0,
			reaped: 0,
			retried: 0,
			runs: 0
		});
	});

	it('counts completed runs', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on('math.add', () => {});
		const worker = createQueueWorker({ registry, store });

		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 2 }
		});
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 3, right: 4 }
		});
		// concurrency 1 by default → two ticks to drain.
		await worker.runOnce();
		await worker.runOnce();

		const m = worker.metrics();
		expect(m.runs).toBe(2);
		expect(m.completed).toBe(2);
		expect(m.failed).toBe(0);
		expect(m.polls).toBe(2);
	});

	it('counts retried separate from deadLettered', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on('always.fail', () => {
			throw new Error('nope');
		});
		// 2 attempts → first throw is a retry, second is dead-lettered.
		const worker = createQueueWorker({
			backoff: () => 0,
			registry,
			store
		});

		await store.enqueue({
			kind: 'always.fail',
			maxAttempts: 2,
			payload: { reason: 'test' }
		});
		await worker.runOnce(); // attempt 1 → retry
		await worker.runOnce(); // attempt 2 → dead

		const m = worker.metrics();
		expect(m.runs).toBe(2);
		expect(m.failed).toBe(1);
		expect(m.retried).toBe(1);
		expect(m.deadLettered).toBe(1);
		expect(m.completed).toBe(0);
	});

	it('updates lastTickMs after each tick', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on('math.add', () => {});
		const worker = createQueueWorker({ registry, store });
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		await worker.runOnce();
		expect(worker.metrics().lastTickMs).toBeGreaterThanOrEqual(0);
		// Subsequent empty tick still updates lastTickMs.
		const before = worker.metrics().polls;
		await worker.runOnce();
		expect(worker.metrics().polls).toBe(before + 1);
	});
});

describe('worker.drain() — 0.1.0', () => {
	it('refuses new claims after drain but keeps polling for reaps', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on('math.add', () => {});
		const worker = createQueueWorker({ registry, store });

		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		worker.drain();
		expect(worker.metrics().draining).toBe(true);
		const claimed = await worker.runOnce();
		expect(claimed).toBe(0);
		// The job is still pending in the store — drain didn't touch it.
		const pending = (await store.list?.({ status: 'pending' })) ?? [];
		expect(pending).toHaveLength(1);
		// Polls counter incremented even though no claims happened.
		expect(worker.metrics().polls).toBe(1);
	});

	it('lets in-flight handlers complete after drain', async () => {
		const store = createInMemoryJobStore(jobs);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registry = createJobRegistry(jobs).on('math.add', async () => {
			await gate;
		});
		const worker = createQueueWorker({ registry, store });
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		// Start a tick — handler claims but hangs on `gate`.
		const tickPromise = worker.runOnce();
		// Give the claim a tick to advance.
		await Promise.resolve();
		await Promise.resolve();
		worker.drain();
		// In-flight handler is still active — drain didn't kill it.
		expect(worker.metrics().active).toBe(1);
		release();
		await tickPromise;
		expect(worker.metrics().active).toBe(0);
		expect(worker.metrics().completed).toBe(1);
	});
});

describe('inMemoryJobStore.snapshot() / restore() — 0.1.0', () => {
	it('round-trips pending + claimed jobs through a snapshot', async () => {
		const a = createInMemoryJobStore(jobs);
		const id1 = await a.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 2 }
		});
		const id2 = await a.enqueue({
			kind: 'math.add',
			payload: { left: 3, right: 4 }
		});
		const snap = a.snapshot();
		expect(snap.jobs).toHaveLength(2);
		expect(typeof snap.exportedAt).toBe('number');

		const b = createInMemoryJobStore(jobs);
		const restored = b.restore(snap);
		expect(restored).toBe(2);
		expect((await b.get?.(id1))?.payload).toEqual({ left: 1, right: 2 });
		expect((await b.get?.(id2))?.payload).toEqual({ left: 3, right: 4 });
	});

	it('replacement worker drains restored jobs', async () => {
		const original = createInMemoryJobStore(jobs);
		await original.enqueue({
			kind: 'math.add',
			payload: { left: 10, right: 20 }
		});
		const snap = original.snapshot();

		const replacement = createInMemoryJobStore(jobs);
		replacement.restore(snap);
		let sum = 0;
		const registry = createJobRegistry(jobs).on(
			'math.add',
			({ left, right }) => {
				sum = left + right;
			}
		);
		const worker = createQueueWorker({ registry, store: replacement });
		const ran = await worker.runOnce();
		expect(ran).toBe(1);
		expect(sum).toBe(30);
		expect(worker.metrics().completed).toBe(1);
	});

	it('restore overwrites existing jobs', async () => {
		const a = createInMemoryJobStore(jobs);
		await a.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		const snap1 = a.snapshot();

		const b = createInMemoryJobStore(jobs);
		await b.enqueue({
			kind: 'math.add',
			payload: { left: 9, right: 9 }
		});
		b.restore(snap1);
		const pending = (await b.list?.({ status: 'pending' })) ?? [];
		expect(pending).toHaveLength(1);
		expect(pending[0]!.payload).toEqual({ left: 1, right: 1 });
	});

	it('snapshot is a copy — mutating the store after export does not change it', async () => {
		const a = createInMemoryJobStore(jobs);
		await a.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		const snap = a.snapshot();
		const before = snap.jobs.length;
		await a.enqueue({
			kind: 'math.add',
			payload: { left: 2, right: 2 }
		});
		expect(snap.jobs.length).toBe(before);
	});
});
