import { describe, expect, it } from 'bun:test';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { runQueueWorker } from '../src/standaloneWorker';

type Jobs = { 'math.add': { left: number; right: number } };

describe('runQueueWorker', () => {
	it('starts a polling worker that drains the queue, then stops', async () => {
		const store = createInMemoryJobStore<Jobs>();
		let ran = 0;
		const registry = createJobRegistry<Jobs>().on('math.add', () => {
			ran += 1;
		});

		// signals: [] so the test registers no process signal handlers
		const worker = runQueueWorker({
			pollIntervalMs: 5,
			registry,
			signals: [],
			store
		});

		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		await worker.stop();

		expect(ran).toBe(1);
	});
});
