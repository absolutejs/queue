import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import {
	ABS_ATTRS,
	createNoopSpan,
	type Span,
	type Tracer,
	type TracerProvider
} from '@absolutejs/telemetry';
import { defineJobs } from '../src/defineJobs';
import { createInMemoryJobStore } from '../src/inMemoryJobStore';
import { createJobRegistry } from '../src/registry';
import { createQueueWorker } from '../src/worker';

const jobs = defineJobs({
	'math.add': t.Object({ a: t.Number(), b: t.Number() }),
	'math.fail': t.Object({})
});

type CapturedSpan = {
	name: string;
	attrs: Record<string, unknown>;
	status?: { code: number; message?: string };
	exception?: unknown;
	ended: boolean;
};

const makeCapturingTracerProvider = (): {
	provider: TracerProvider;
	spans: CapturedSpan[];
} => {
	const spans: CapturedSpan[] = [];
	const makeSpan = (record: CapturedSpan): Span => {
		const noop = createNoopSpan();
		return {
			...noop,
			end: () => {
				record.ended = true;
			},
			isRecording: () => !record.ended,
			recordException: (exception) => {
				record.exception = exception;
			},
			setAttribute: ((key, value) => {
				record.attrs[key] = value;
				return makeSpan(record);
			}) as Span['setAttribute'],
			setStatus: ((status) => {
				record.status = status;
				return makeSpan(record);
			}) as Span['setStatus']
		};
	};
	const tracer: Tracer = {
		startActiveSpan: ((name, optionsOrFn, maybeFn) => {
			const fn =
				typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
			const record: CapturedSpan = { attrs: {}, ended: false, name };
			spans.push(record);
			return (fn as (s: Span) => unknown)(makeSpan(record));
		}) as Tracer['startActiveSpan'],
		startSpan: (name, options) => {
			const record: CapturedSpan = {
				attrs: { ...(options?.attributes ?? {}) },
				ended: false,
				name
			};
			spans.push(record);
			return makeSpan(record);
		}
	};
	return {
		provider: { getTracer: () => tracer },
		spans
	};
};

describe('queue 0.2.0 — OTel tracing via @absolutejs/telemetry', () => {
	it('emits queue.runJob span on a successful job', async () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on(
			'math.add',
			() => {}
		);
		const worker = createQueueWorker({
			registry,
			store,
			tracerProvider: provider,
			workerId: 'worker-1'
		});
		await store.enqueue({
			kind: 'math.add',
			payload: { a: 1, b: 2 }
		});
		await worker.runOnce();
		const jobSpan = spans.find((span) => span.name === 'queue.runJob');
		expect(jobSpan).toBeDefined();
		expect(jobSpan!.attrs[ABS_ATTRS.jobKind]).toBe('math.add');
		expect(jobSpan!.attrs[ABS_ATTRS.workerId]).toBe('worker-1');
		expect(jobSpan!.attrs[ABS_ATTRS.jobAttempt]).toBe(0);
		expect(jobSpan!.status?.code).toBe(1);
		expect(jobSpan!.ended).toBe(true);
	});

	it('records exception + sets ERROR status on a failing job', async () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on(
			'math.fail',
			() => {
				throw new Error('handler boom');
			}
		);
		const worker = createQueueWorker({
			backoff: () => 0,
			registry,
			store,
			tracerProvider: provider
		});
		await store.enqueue({ kind: 'math.fail', maxAttempts: 1, payload: {} });
		await worker.runOnce();
		const jobSpan = spans.find((span) => span.name === 'queue.runJob');
		expect(jobSpan).toBeDefined();
		expect(jobSpan!.status?.code).toBe(2);
		expect(jobSpan!.exception).toBeInstanceOf(Error);
		expect(jobSpan!.ended).toBe(true);
	});

	it('without tracerProvider the worker still runs (noop path)', async () => {
		const store = createInMemoryJobStore(jobs);
		const registry = createJobRegistry(jobs).on(
			'math.add',
			() => {}
		);
		const worker = createQueueWorker({ registry, store });
		await store.enqueue({
			kind: 'math.add',
			payload: { a: 1, b: 2 }
		});
		await worker.runOnce();
		const metrics = worker.metrics();
		expect(metrics.runs).toBe(1);
		expect(metrics.completed).toBe(1);
	});
});
