import { describe, expect, it } from 'bun:test';
import {
	ABS_ATTRS,
	createNoopSpan,
	type Span,
	type Tracer,
	type TracerProvider
} from '@absolutejs/telemetry';
import { cronMatchesMinute, parseCronExpression } from '../src/cron';
import type { WakeEntry } from '../src/types';
import { createWakeScheduler, httpWake } from '../src/wakeScheduler';

const makeClock = (startMs = 1_000_000) => {
	let currentMs = startMs;

	return {
		advance: (ms: number) => {
			currentMs += ms;
		},
		now: () => currentMs,
		set: (ms: number) => {
			currentMs = ms;
		}
	};
};

const makeRecordingWake = () => {
	const fired: string[] = [];

	return {
		fired,
		wake: (entry: WakeEntry) => {
			fired.push(entry.id);
		}
	};
};

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

describe('cron parsing + matching (UTC) — 0.4.0', () => {
	it('matches wildcard, list, range, and step fields', () => {
		const everyMinute = parseCronExpression('* * * * *');
		expect(
			cronMatchesMinute(everyMinute, Date.UTC(2026, 0, 1, 12, 34))
		).toBe(true);

		const list = parseCronExpression('0,30 * * * *');
		expect(cronMatchesMinute(list, Date.UTC(2026, 0, 1, 10, 0))).toBe(true);
		expect(cronMatchesMinute(list, Date.UTC(2026, 0, 1, 10, 30))).toBe(
			true
		);
		expect(cronMatchesMinute(list, Date.UTC(2026, 0, 1, 10, 15))).toBe(
			false
		);

		const range = parseCronExpression('0 9-17 * * *');
		expect(cronMatchesMinute(range, Date.UTC(2026, 0, 1, 9, 0))).toBe(true);
		expect(cronMatchesMinute(range, Date.UTC(2026, 0, 1, 17, 0))).toBe(
			true
		);
		expect(cronMatchesMinute(range, Date.UTC(2026, 0, 1, 8, 0))).toBe(
			false
		);
		expect(cronMatchesMinute(range, Date.UTC(2026, 0, 1, 9, 30))).toBe(
			false
		);

		const step = parseCronExpression('*/15 * * * *');
		expect(cronMatchesMinute(step, Date.UTC(2026, 0, 1, 3, 0))).toBe(true);
		expect(cronMatchesMinute(step, Date.UTC(2026, 0, 1, 3, 45))).toBe(true);
		expect(cronMatchesMinute(step, Date.UTC(2026, 0, 1, 3, 20))).toBe(
			false
		);
	});

	it('evaluates in UTC and crosses day boundaries correctly', () => {
		const midnight = parseCronExpression('0 0 * * *');
		expect(cronMatchesMinute(midnight, Date.UTC(2026, 0, 2, 0, 0))).toBe(
			true
		);
		expect(cronMatchesMinute(midnight, Date.UTC(2026, 0, 1, 23, 59))).toBe(
			false
		);
		expect(cronMatchesMinute(midnight, Date.UTC(2026, 0, 2, 1, 0))).toBe(
			false
		);
	});

	it('uses standard OR semantics when both day fields are restricted', () => {
		// 2026-01-05 is a Monday; 2026-01-04 is a Sunday.
		const monday = parseCronExpression('0 8 * * 1');
		expect(cronMatchesMinute(monday, Date.UTC(2026, 0, 5, 8, 0))).toBe(
			true
		);
		expect(cronMatchesMinute(monday, Date.UTC(2026, 0, 6, 8, 0))).toBe(
			false
		);

		const sundayAlias = parseCronExpression('0 0 * * 7');
		expect(cronMatchesMinute(sundayAlias, Date.UTC(2026, 0, 4, 0, 0))).toBe(
			true
		);

		// Both day-of-month AND day-of-week restricted → either fires.
		const orDays = parseCronExpression('0 0 15 * 1');
		expect(cronMatchesMinute(orDays, Date.UTC(2026, 0, 15, 0, 0))).toBe(
			true // the 15th (a Thursday)
		);
		expect(cronMatchesMinute(orDays, Date.UTC(2026, 0, 12, 0, 0))).toBe(
			true // a Monday (not the 15th)
		);
		expect(cronMatchesMinute(orDays, Date.UTC(2026, 0, 13, 0, 0))).toBe(
			false
		);
	});

	it('rejects malformed expressions with clear errors', () => {
		expect(() => parseCronExpression('* * * *')).toThrow('expected 5');
		expect(() => parseCronExpression('60 * * * *')).toThrow('0-59');
		expect(() => parseCronExpression('* 24 * * *')).toThrow('0-23');
		expect(() => parseCronExpression('*/0 * * * *')).toThrow('step');
		expect(() => parseCronExpression('5/2 * * * *')).toThrow('range');
		expect(() => parseCronExpression('30-5 * * * *')).toThrow('inverted');
		expect(() => parseCronExpression('a * * * *')).toThrow('unparseable');
	});
});

describe('createWakeScheduler — interval firing', () => {
	it('fires every `every` ms with injected now + manual tick()', async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		expect(await scheduler.tick()).toBe(0);
		clock.advance(999);
		expect(await scheduler.tick()).toBe(0);
		clock.advance(1);
		expect(await scheduler.tick()).toBe(1);
		// Same instant: not due again.
		expect(await scheduler.tick()).toBe(0);
		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['a', 'a']);
	});

	it('an `every` below the tick cadence fires once per tick, never as backlog', async () => {
		// Regression: every=5s with tickMs=15s means each evaluation sees a
		// slot that is up to 10s "stale". The freshness bound must be
		// max(every, tickMs) so this fires normally on every tick instead of
		// being misclassified as downtime backlog (skipped / double-counted).
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 5_000, id: 'fast', tenant: 'acme' }],
			now: clock.now,
			tickMs: 15_000,
			wake
		});

		clock.advance(15_000);
		expect(await scheduler.tick()).toBe(1);
		clock.advance(15_000);
		expect(await scheduler.tick()).toBe(1);
		clock.advance(15_000);
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['fast', 'fast', 'fast']);
		expect(scheduler.metrics().missedSkipped).toBe(0);
	});

	it('validates entries at add-time', () => {
		const clock = makeClock();
		const { wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({ now: clock.now, wake });

		expect(() => scheduler.add({ id: 'x', tenant: 't' })).toThrow(
			'got neither'
		);
		expect(() =>
			scheduler.add({
				cron: '* * * * *',
				every: 1000,
				id: 'x',
				tenant: 't'
			})
		).toThrow('got both');
		expect(() => scheduler.add({ every: 0, id: 'x', tenant: 't' })).toThrow(
			'non-positive'
		);
		expect(() =>
			scheduler.add({ cron: 'bogus', id: 'x', tenant: 't' })
		).toThrow('Invalid cron expression');

		scheduler.add({ every: 1000, id: 'x', tenant: 't' });
		expect(() =>
			scheduler.add({ every: 2000, id: 'x', tenant: 't' })
		).toThrow('already exists');
	});
});

describe('createWakeScheduler — cron firing', () => {
	it('fires once per matching minute, never twice within it', async () => {
		const clock = makeClock(Date.UTC(2026, 0, 1, 9, 59, 50));
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ cron: '0 * * * *', id: 'hourly', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		expect(await scheduler.tick()).toBe(0); // 09:59 doesn't match
		clock.set(Date.UTC(2026, 0, 1, 10, 0, 5));
		expect(await scheduler.tick()).toBe(1);
		clock.advance(20_000); // 10:00:25 — same minute
		expect(await scheduler.tick()).toBe(0);
		clock.advance(30_000); // 10:00:55 — still the same minute
		expect(await scheduler.tick()).toBe(0);
		clock.set(Date.UTC(2026, 0, 1, 11, 0, 0));
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['hourly', 'hourly']);
	});
});

describe('createWakeScheduler — catch-up after downtime', () => {
	it("interval + 'skip' (default) drops the backlog and resumes the cadence", async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			// tickMs declares the expected cadence; a clock jump far beyond
			// it (below) reads as downtime rather than a slow tick.
			tickMs: 10,
			wake
		});

		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		// "Downtime": 3.5 intervals pass without a tick.
		clock.advance(3500);
		expect(await scheduler.tick()).toBe(0);
		expect(scheduler.metrics().missedSkipped).toBe(3);
		// Cadence resumed from the skip point.
		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['a', 'a']);
	});

	it("interval + 'once' fires a single compensating wake", async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			catchUp: 'once',
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			tickMs: 10,
			wake
		});

		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		clock.advance(3500);
		expect(await scheduler.tick()).toBe(1); // one fire for 3 missed slots
		expect(scheduler.metrics().missedSkipped).toBe(2);
		expect(fired).toEqual(['a', 'a']);
	});

	it("cron + 'once' fires once for missed matches; 'skip' only counts them", async () => {
		const start = Date.UTC(2026, 0, 1, 1, 0, 0);
		const downtimeEnd = Date.UTC(2026, 0, 1, 3, 30, 0);

		const onceClock = makeClock(start);
		const onceWake = makeRecordingWake();
		const once = createWakeScheduler({
			catchUp: 'once',
			entries: [{ cron: '0 * * * *', id: 'hourly', tenant: 'acme' }],
			now: onceClock.now,
			wake: onceWake.wake
		});
		expect(await once.tick()).toBe(1); // 01:00 matches
		onceClock.set(downtimeEnd); // missed 02:00 and 03:00
		expect(await once.tick()).toBe(1); // one compensating fire at 03:30
		expect(once.metrics().missedSkipped).toBe(1);
		expect(onceWake.fired).toEqual(['hourly', 'hourly']);

		const skipClock = makeClock(start);
		const skipWake = makeRecordingWake();
		const skip = createWakeScheduler({
			entries: [{ cron: '0 * * * *', id: 'hourly', tenant: 'acme' }],
			now: skipClock.now,
			wake: skipWake.wake
		});
		expect(await skip.tick()).toBe(1);
		skipClock.set(downtimeEnd);
		expect(await skip.tick()).toBe(0);
		expect(skip.metrics().missedSkipped).toBe(2);
		// The missed minutes are not re-counted on the next tick.
		expect(await skip.tick()).toBe(0);
		expect(skip.metrics().missedSkipped).toBe(2);
		expect(skipWake.fired).toEqual(['hourly']);
	});
});

describe('createWakeScheduler — snapshot/restore', () => {
	it('prevents double-fire across a "restart" and keeps schedules', async () => {
		const clock = makeClock();
		const first = makeRecordingWake();
		const original = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', jitterMs: 0, tenant: 'acme' }],
			now: clock.now,
			wake: first.wake
		});

		clock.advance(1000);
		expect(await original.tick()).toBe(1);
		const snapshot = original.snapshot();
		expect(snapshot.exportedAt).toBe(clock.now());

		// "Restart": a fresh scheduler in a replacement process.
		const second = makeRecordingWake();
		const replacement = createWakeScheduler({
			now: clock.now,
			wake: second.wake
		});
		expect(replacement.restore(snapshot)).toBe(1);
		expect(replacement.list()).toHaveLength(1);

		// The restored lastFiredAt suppresses an immediate re-fire...
		expect(await replacement.tick()).toBe(0);
		// ...and the cadence picks up where the original left off.
		clock.advance(1000);
		expect(await replacement.tick()).toBe(1);
		expect(second.fired).toEqual(['a']);
	});

	it('restore replaces existing schedules', async () => {
		const clock = makeClock();
		const { wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'old', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		scheduler.restore({
			entries: [{ entry: { every: 2000, id: 'new', tenant: 'globex' } }]
		});
		expect(scheduler.list().map((entry) => entry.id)).toEqual(['new']);
	});
});

describe('createWakeScheduler — error isolation', () => {
	it('a throwing wake hits onError without blocking other entries', async () => {
		const clock = makeClock();
		const seen: { entryId?: string; error: unknown }[] = [];
		const fired: string[] = [];
		const scheduler = createWakeScheduler({
			entries: [
				{ every: 1000, id: 'bad', tenant: 'acme' },
				{ every: 1000, id: 'good', tenant: 'globex' }
			],
			now: clock.now,
			onError: (error, entry) => seen.push({ entryId: entry?.id, error }),
			wake: (entry) => {
				if (entry.id === 'bad') throw new Error('poke failed');
				fired.push(entry.id);
			}
		});

		clock.advance(1000);
		expect(await scheduler.tick()).toBe(2);
		expect(fired).toEqual(['good']);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.entryId).toBe('bad');
		expect(seen[0]?.error).toBeInstanceOf(Error);

		const metrics = scheduler.metrics();
		expect(metrics.firings).toBe(2);
		expect(metrics.errors).toBe(1);
		expect(metrics.byTenant).toEqual({
			acme: { errors: 1, firings: 1 },
			globex: { errors: 0, firings: 1 }
		});

		// A failed wake waits for its next slot — no immediate retry storm.
		expect(await scheduler.tick()).toBe(0);
	});
});

describe('createWakeScheduler — enable / disable / remove', () => {
	it('disable parks an entry; enable re-anchors the cadence', async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		expect(scheduler.disable('a')).toBe(true);
		clock.advance(5000);
		expect(await scheduler.tick()).toBe(0);

		expect(scheduler.enable('a')).toBe(true);
		// Re-anchored at enable time — no downtime backlog, no instant fire.
		expect(await scheduler.tick()).toBe(0);
		expect(scheduler.metrics().missedSkipped).toBe(0);
		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['a']);
	});

	it('remove deletes the schedule; unknown ids return false', async () => {
		const clock = makeClock();
		const { wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		expect(scheduler.remove('a')).toBe(true);
		expect(scheduler.list()).toEqual([]);
		clock.advance(1000);
		expect(await scheduler.tick()).toBe(0);

		expect(scheduler.remove('missing')).toBe(false);
		expect(scheduler.enable('missing')).toBe(false);
		expect(scheduler.disable('missing')).toBe(false);
	});
});

describe('createWakeScheduler — drain, overlap guard, metrics', () => {
	it('drain() stops firing new wakes', async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			wake
		});

		clock.advance(1000);
		scheduler.drain();
		expect(await scheduler.tick()).toBe(0);
		expect(fired).toEqual([]);
		expect(scheduler.metrics().draining).toBe(true);
	});

	it('skips (and counts) a tick while the previous one is settling', async () => {
		const clock = makeClock();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', tenant: 'acme' }],
			now: clock.now,
			wake: () => gate
		});

		clock.advance(1000);
		const inFlight = scheduler.tick();
		expect(await scheduler.tick()).toBe(0);
		expect(scheduler.metrics().skippedTicks).toBe(1);
		release();
		expect(await inFlight).toBe(1);
	});

	it('metrics() starts zeroed and counts per tenant', async () => {
		const clock = makeClock();
		const { wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [
				{ every: 1000, id: 'a', tenant: 'acme' },
				{ enabled: false, every: 1000, id: 'b', tenant: 'globex' }
			],
			now: clock.now,
			wake
		});

		expect(scheduler.metrics()).toEqual({
			byTenant: {},
			draining: false,
			enabled: 1,
			entries: 2,
			errors: 0,
			firings: 0,
			lastTickMs: 0,
			missedSkipped: 0,
			skippedTicks: 0
		});

		clock.advance(1000);
		await scheduler.tick();
		const metrics = scheduler.metrics();
		expect(metrics.firings).toBe(1);
		expect(metrics.byTenant).toEqual({ acme: { errors: 0, firings: 1 } });
	});
});

describe('createWakeScheduler — jitter', () => {
	it('delays a due firing by random() * jitterMs (injected random)', async () => {
		const clock = makeClock();
		const { fired, wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'a', jitterMs: 500, tenant: 'acme' }],
			now: clock.now,
			random: () => 0.5,
			wake
		});

		clock.advance(1000); // due — arms at +250 instead of firing
		expect(await scheduler.tick()).toBe(0);
		clock.advance(249);
		expect(await scheduler.tick()).toBe(0);
		clock.advance(1); // reaches the armed time
		expect(await scheduler.tick()).toBe(1);
		expect(fired).toEqual(['a']);
	});
});

describe('createWakeScheduler — start()/stop() loop', () => {
	it('runs ticks on tickMs and stop() halts the loop', async () => {
		let fires = 0;
		let resolveFirst!: () => void;
		const firstFire = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const scheduler = createWakeScheduler({
			entries: [{ every: 1, id: 'a', tenant: 'acme' }],
			tickMs: 5,
			wake: () => {
				fires += 1;
				resolveFirst();
			}
		});

		scheduler.start();
		await firstFire;
		await scheduler.stop();
		const firesAtStop = fires;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(fires).toBe(firesAtStop);
		expect(firesAtStop).toBeGreaterThanOrEqual(1);
	});
});

describe('httpWake', () => {
	it('POSTs entry.url and resolves on 2xx', async () => {
		const calls: { init?: RequestInit; url: string }[] = [];
		const fetchImpl = (async (
			url: Parameters<typeof fetch>[0],
			init?: RequestInit
		) => {
			calls.push({ init, url: String(url) });

			return new Response(null, { status: 204 });
		}) as typeof fetch;

		await httpWake(fetchImpl)({
			every: 1000,
			id: 'a',
			tenant: 'acme',
			url: 'https://tenant.example/wake'
		});
		expect(calls).toEqual([
			{ init: { method: 'POST' }, url: 'https://tenant.example/wake' }
		]);
	});

	it('rejects on non-2xx and on a missing url', async () => {
		const failing = (async (_url: Parameters<typeof fetch>[0]) =>
			new Response(null, { status: 503 })) as typeof fetch;

		await expect(
			httpWake(failing)({
				every: 1000,
				id: 'a',
				tenant: 'acme',
				url: 'https://tenant.example/wake'
			})
		).rejects.toThrow('HTTP 503');
		await expect(
			httpWake(failing)({ every: 1000, id: 'b', tenant: 'acme' })
		).rejects.toThrow('no "url"');
	});

	it('feeds errors into the scheduler error path (mock fetch)', async () => {
		const clock = makeClock();
		const errors: unknown[] = [];
		const failing = (async (_url: Parameters<typeof fetch>[0]) =>
			new Response(null, { status: 500 })) as typeof fetch;
		const scheduler = createWakeScheduler({
			entries: [
				{
					every: 1000,
					id: 'a',
					tenant: 'acme',
					url: 'https://tenant.example/wake'
				}
			],
			now: clock.now,
			onError: (error) => errors.push(error),
			wake: httpWake(failing)
		});

		clock.advance(1000);
		expect(await scheduler.tick()).toBe(1);
		expect(errors).toHaveLength(1);
		expect(scheduler.metrics().errors).toBe(1);
	});
});

describe('createWakeScheduler — OTel tracing', () => {
	it('emits a queue.wake span with abs.tenant + abs.wake.id', async () => {
		const clock = makeClock();
		const { provider, spans } = makeCapturingTracerProvider();
		const { wake } = makeRecordingWake();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'poke-acme', tenant: 'acme' }],
			now: clock.now,
			tracerProvider: provider,
			wake
		});

		clock.advance(1000);
		await scheduler.tick();
		const wakeSpan = spans.find((span) => span.name === 'queue.wake');
		expect(wakeSpan).toBeDefined();
		expect(wakeSpan!.attrs[ABS_ATTRS.tenant]).toBe('acme');
		expect(wakeSpan!.attrs['abs.wake.id']).toBe('poke-acme');
		expect(wakeSpan!.status?.code).toBe(1);
		expect(wakeSpan!.ended).toBe(true);
	});

	it('records the exception + ERROR status on a failing wake', async () => {
		const clock = makeClock();
		const { provider, spans } = makeCapturingTracerProvider();
		const scheduler = createWakeScheduler({
			entries: [{ every: 1000, id: 'poke-acme', tenant: 'acme' }],
			now: clock.now,
			tracerProvider: provider,
			wake: () => {
				throw new Error('tenant unreachable');
			}
		});

		clock.advance(1000);
		await scheduler.tick();
		const wakeSpan = spans.find((span) => span.name === 'queue.wake');
		expect(wakeSpan).toBeDefined();
		expect(wakeSpan!.status?.code).toBe(2);
		expect(wakeSpan!.exception).toBeInstanceOf(Error);
		expect(wakeSpan!.ended).toBe(true);
	});
});
