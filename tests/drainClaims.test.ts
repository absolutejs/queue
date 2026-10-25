import { expect, test } from 'bun:test';
import { Type as t } from 'typebox';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({ task: t.Object({}) });
const gate = () => {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
};

test('drain reports pending claims and stop waits through the resulting handler', async () => {
	const store = createInMemoryJobStore(jobs);
	await store.enqueue({ kind: 'task', payload: {} });
	await store.enqueue({ kind: 'task', payload: {} });
	const claimEntered = gate(),
		claimReleased = gate(),
		handlerEntered = gate(),
		handlerReleased = gate();
	const claim = store.claimDue.bind(store);
	store.claimDue = async (options) => {
		claimEntered.release();
		await claimReleased.promise;
		return claim(options);
	};
	const worker = createQueueWorker({
		concurrency: 1,
		store,
		registry: createJobRegistry(jobs).on('task', async () => {
			handlerEntered.release();
			await handlerReleased.promise;
		})
	});
	const tick = worker.runOnce();
	await claimEntered.promise;
	expect(worker.metrics()).toMatchObject({ active: 0, claiming: 1 });
	expect(await worker.runOnce()).toBe(0);
	worker.drain();
	let stopped = false;
	const stop = worker.stop().then(() => {
		stopped = true;
	});
	await Bun.sleep(1);
	expect(stopped).toBe(false);
	claimReleased.release();
	await handlerEntered.promise;
	expect(worker.metrics()).toMatchObject({ active: 1, claiming: 0 });
	expect(stopped).toBe(false);
	handlerReleased.release();
	await Promise.all([tick, stop]);
	expect(worker.metrics()).toMatchObject({
		active: 0,
		claiming: 0,
		completed: 1
	});
	expect(await worker.runOnce()).toBe(0);
	worker.resume();
	expect(await worker.runOnce()).toBe(1);
});

test('stop prevents a poll already awaiting reaping from making a new claim', async () => {
	const store = createInMemoryJobStore(jobs);
	await store.enqueue({ kind: 'task', payload: {} });
	const entered = gate(),
		released = gate();
	store.reapStuck = async () => {
		entered.release();
		await released.promise;
		return 0;
	};
	let calls = 0;
	const worker = createQueueWorker({
		concurrency: 1,
		store,
		registry: createJobRegistry(jobs).on('task', () => {
			calls++;
		})
	});
	const tick = worker.runOnce();
	await entered.promise;
	let stopped = false;
	const stop = worker.stop().then(() => {
		stopped = true;
	});
	await Bun.sleep(1);
	expect(stopped).toBe(false);
	released.release();
	expect(await tick).toBe(0);
	await stop;
	expect(calls).toBe(0);
	expect(await worker.runOnce()).toBe(1);
});

test('a rejected claim releases shutdown accounting', async () => {
	const store = createInMemoryJobStore(jobs);
	const entered = gate(),
		released = gate();
	store.claimDue = async () => {
		entered.release();
		await released.promise;
		throw Error('claim unavailable');
	};
	const worker = createQueueWorker({
		concurrency: 1,
		store,
		registry: createJobRegistry(jobs).on('task', () => {})
	});
	const tick = worker.runOnce();
	const rejected = tick.catch((error) => error);
	await entered.promise;
	const stop = worker.stop();
	released.release();
	expect(await rejected).toMatchObject({ message: 'claim unavailable' });
	await stop;
	expect(worker.metrics()).toMatchObject({ active: 0, claiming: 0 });
});
