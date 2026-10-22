import { Type as t } from 'typebox';
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { queue } from '../src/plugin';
import { createJobRegistry } from '../src/registry';

const jobs = defineJobs({
	'math.add': t.Object({ left: t.Number(), right: t.Number() })
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('queue plugin', () => {
	it('runs its worker while the server runs, and stops with it', async () => {
		const store = createInMemoryJobStore(jobs);
		let ran = 0;
		const registry = createJobRegistry(jobs).on('math.add', () => {
			ran += 1;
		});
		const app = new Elysia().use(queue({ registry, store }));

		app.listen(0);
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 1, right: 1 }
		});
		await settle();
		expect(ran).toBe(1);

		await app.stop();
		await store.enqueue({
			kind: 'math.add',
			payload: { left: 2, right: 2 }
		});
		await settle();
		expect(ran).toBe(1);
	});
});
