import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { runQueueWorker } from '../src/standaloneWorker';

const jobs = defineJobs({
	'math.add': t.Object({ left: t.Number(), right: t.Number() })
});

describe('runQueueWorker', () => {
	it('starts a polling worker that drains the queue, then stops', async () => {
		const store = createInMemoryJobStore(jobs);
		let ran = 0;
		const registry = createJobRegistry(jobs).on('math.add', () => {
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
