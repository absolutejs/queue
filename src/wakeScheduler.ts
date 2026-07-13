import { ABS_ATTRS, tracerOrNoop } from '@absolutejs/telemetry';
import { DEFAULT_WAKE_TICK_MS, MILLISECONDS_IN_A_MINUTE } from './constants';
import { cronMatchesMinute, parseCronExpression } from './cron';
import type { CronExpression } from './cron';
import type {
	CreateWakeSchedulerOptions,
	WakeEntry,
	WakeScheduler,
	WakeSchedulerMetrics
} from './types';

// @absolutejs/telemetry doesn't mint abs.wake.id yet — keep the literal
// here, following the abs.* semantic-convention naming.
const WAKE_ID_ATTR = 'abs.wake.id';

// After downtime longer than this, cron catch-up scanning stops looking
// further back: missed-firing counts (and 'once' detection) only consider
// the most recent week of minutes. Interval (`every`) entries are exact at
// any downtime length — this cap is cron-only.
const CRON_SCAN_LIMIT_MINUTES = 7 * 24 * 60;

const STOP_POLL_MS = 10;

type EntryState = {
	/** Jitter-armed fire time; set when a due firing is delayed by jitter. */
	armedAt?: number;
	/** Add/restore/enable time — the schedule anchor before the first fire. */
	baselineAt: number;
	cron?: CronExpression;
	entry: WakeEntry;
	lastFiredAt?: number;
	/** In-memory cron scan high-water mark (minutes since epoch). */
	scannedThroughMinute?: number;
};

/**
 * Host/control-plane-side durable scheduler: fires per-tenant schedules and
 * wakes tenants via a caller-supplied action. Closes the "background jobs
 * that survive process death" gap — a tenant's 6-hourly cron still fires
 * when the tenant process was idle-killed, because the schedule lives in
 * the always-on control plane and the wake pokes the tenant back up.
 *
 * The wake itself is the single seam: an HTTP poke (see {@link httpWake}),
 * `runtime.ensure(entry.tenant)`, a cluster-bus message. Added in 0.4.0.
 */
export const createWakeScheduler = ({
	catchUp = 'skip',
	entries = [],
	now = Date.now,
	onError,
	random = Math.random,
	tickMs = DEFAULT_WAKE_TICK_MS,
	tracerProvider,
	wake
}: CreateWakeSchedulerOptions): WakeScheduler => {
	const tracer = tracerOrNoop(tracerProvider, '@absolutejs/queue');
	const states = new Map<string, EntryState>();
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tickInFlight = false;
	// 0.4.0: operator-shaped metrics + drain state, matching the worker's
	// idiom. All counters are cumulative since createWakeScheduler().
	let draining = false;
	let firings = 0;
	let errors = 0;
	let missedSkipped = 0;
	let skippedTicks = 0;
	let lastTickMs = 0;
	const byTenant = new Map<string, { errors: number; firings: number }>();

	const tenantCounters = (tenant: string) => {
		const existing = byTenant.get(tenant);
		if (existing) return existing;
		const created = { errors: 0, firings: 0 };
		byTenant.set(tenant, created);

		return created;
	};

	const makeState = (entry: WakeEntry, lastFiredAt?: number): EntryState => {
		if (entry.every === undefined && entry.cron === undefined)
			throw new Error(
				`Wake entry "${entry.id}" needs exactly one of "every" or "cron" — got neither`
			);
		if (entry.every !== undefined && entry.cron !== undefined)
			throw new Error(
				`Wake entry "${entry.id}" needs exactly one of "every" or "cron" — got both`
			);
		if (entry.every !== undefined && entry.every <= 0)
			throw new Error(
				`Wake entry "${entry.id}" has a non-positive "every" (${entry.every}ms)`
			);

		return {
			baselineAt: now(),
			cron:
				entry.cron === undefined
					? undefined
					: parseCronExpression(entry.cron),
			entry: { ...entry },
			lastFiredAt
		};
	};

	const add = (entry: WakeEntry) => {
		if (states.has(entry.id))
			throw new Error(
				`Wake entry "${entry.id}" already exists — remove() it first`
			);
		states.set(entry.id, makeState(entry));
	};

	for (const entry of entries) add(entry);

	const intervalDue = (state: EntryState, tickNow: number): boolean => {
		const every = state.entry.every as number;
		const base = state.lastFiredAt ?? state.baselineAt;
		const elapsed = tickNow - base;
		if (elapsed < every) return false;

		// Freshness: a due slot evaluated within one interval — or one tick,
		// whichever is larger (an `every` below the tick cadence can never be
		// evaluated faster than tickMs) — of becoming due fires normally.
		const staleMs = elapsed - every;
		if (staleMs < Math.max(every, tickMs)) return true;

		// The due slot is stale by more than a full interval AND a full tick:
		// the scheduler was down. catchUp decides what happens to the backlog.
		const intervalsElapsed = Math.floor(elapsed / every);
		if (catchUp === 'once') {
			// One compensating fire stands in for the whole backlog.
			missedSkipped += intervalsElapsed - 1;

			return true;
		}
		// 'skip': drop the backlog; resume the cadence from now.
		missedSkipped += intervalsElapsed;
		state.lastFiredAt = tickNow;

		return false;
	};

	const cronDue = (state: EntryState, tickNow: number): boolean => {
		const expression = state.cron as CronExpression;
		const currentMinute = Math.floor(tickNow / MILLISECONDS_IN_A_MINUTE);
		const baselineMinute = Math.floor(
			state.baselineAt / MILLISECONDS_IN_A_MINUTE
		);
		const lastFiredMinute =
			state.lastFiredAt === undefined
				? undefined
				: Math.floor(state.lastFiredAt / MILLISECONDS_IN_A_MINUTE);
		const scanFloor = Math.max(
			lastFiredMinute ?? baselineMinute,
			state.scannedThroughMinute ?? baselineMinute,
			currentMinute - CRON_SCAN_LIMIT_MINUTES
		);
		// Minutes strictly between the scan floor and the current minute that
		// matched but never fired are missed firings (downtime, restore, or
		// an injected-clock jump). In normal operation the range is empty — a
		// matching minute fires within itself and advances the floor.
		let missed = 0;
		for (let minute = scanFloor + 1; minute < currentMinute; minute += 1)
			if (
				cronMatchesMinute(expression, minute * MILLISECONDS_IN_A_MINUTE)
			)
				missed += 1;
		state.scannedThroughMinute = currentMinute;

		// The lastFiredMinute guard is the no-double-fire-within-a-minute
		// rule: 15s ticks land in a matching minute up to 4 times.
		const matchesNow =
			cronMatchesMinute(expression, tickNow) &&
			lastFiredMinute !== currentMinute;

		if (missed === 0) return matchesNow;
		if (catchUp === 'once') {
			// One compensating fire; when the current minute also matches,
			// the normal fire IS the compensation.
			missedSkipped += matchesNow ? missed : missed - 1;

			return true;
		}
		missedSkipped += missed;

		return matchesNow;
	};

	// Decide whether an entry should fire at tickNow. Mutates schedule state
	// (jitter arming, catch-up bookkeeping) but never fires itself.
	const isDue = (state: EntryState, tickNow: number): boolean => {
		// A jitter-armed fire waits out its delay regardless of schedule type.
		if (state.armedAt !== undefined) return tickNow >= state.armedAt;

		const due = state.cron
			? cronDue(state, tickNow)
			: intervalDue(state, tickNow);
		if (!due) return false;

		const jitterMs = state.entry.jitterMs ?? 0;
		if (jitterMs > 0) {
			state.armedAt = tickNow + random() * jitterMs;

			return tickNow >= state.armedAt;
		}

		return true;
	};

	const fireWake = async (state: EntryState) => {
		const entry = { ...state.entry };
		state.armedAt = undefined;
		// Anchor BEFORE invoking so a slow wake can't be double-fired by the
		// next tick. A throwing wake also waits for its next scheduled slot —
		// wakes are pokes, not jobs; there is no retry/backoff ladder here.
		state.lastFiredAt = now();
		// 0.4.0: per-firing span, matching the worker's queue.runJob idiom.
		const span = tracer.startSpan('queue.wake', {
			attributes: {
				[ABS_ATTRS.tenant]: entry.tenant,
				[WAKE_ID_ATTR]: entry.id
			}
		});
		firings += 1;
		const counters = tenantCounters(entry.tenant);
		counters.firings += 1;
		try {
			await wake(entry);
			span.setStatus({ code: 1 /* OK */ });
		} catch (error) {
			errors += 1;
			counters.errors += 1;
			const message =
				error instanceof Error ? error.message : String(error);
			span.recordException(error);
			span.setStatus({ code: 2 /* ERROR */, message });
			onError?.(error, entry);
		} finally {
			span.end();
		}
	};

	const tick = async () => {
		// Guard overlapping ticks: if a previous tick's wakes are still
		// settling, skip this pass (and count it) rather than double-firing.
		if (tickInFlight) {
			skippedTicks += 1;

			return 0;
		}
		tickInFlight = true;
		try {
			const tickStart = now();
			const due: EntryState[] = [];
			// While draining, stop evaluating schedules entirely — no new
			// wakes fire; in-flight wake promises settle on their own.
			if (!draining)
				for (const state of states.values())
					if (
						state.entry.enabled !== false &&
						isDue(state, tickStart)
					)
						due.push(state);

			// Fire concurrently — one tenant's failing (or hanging) wake
			// never blocks the rest of this tick's firings.
			await Promise.allSettled(due.map((state) => fireWake(state)));

			lastTickMs = now() - tickStart;

			return due.length;
		} finally {
			tickInFlight = false;
		}
	};

	const loop = async () => {
		if (!running) return;

		try {
			await tick();
		} catch (error) {
			onError?.(error);
		} finally {
			if (running) timer = setTimeout(loop, tickMs);
		}
	};

	const metrics = (): WakeSchedulerMetrics => {
		let enabled = 0;
		for (const state of states.values())
			if (state.entry.enabled !== false) enabled += 1;
		const perTenant: WakeSchedulerMetrics['byTenant'] = {};
		for (const [tenant, counters] of byTenant)
			perTenant[tenant] = { ...counters };

		return {
			byTenant: perTenant,
			draining,
			enabled,
			entries: states.size,
			errors,
			firings,
			lastTickMs,
			missedSkipped,
			skippedTicks
		};
	};

	return {
		add,
		disable: (id) => {
			const state = states.get(id);
			if (!state) return false;
			state.entry.enabled = false;
			state.armedAt = undefined;

			return true;
		},
		drain: () => {
			draining = true;
		},
		enable: (id) => {
			const state = states.get(id);
			if (!state) return false;
			if (state.entry.enabled !== false) return true;
			state.entry.enabled = true;
			// Re-anchor so a long-disabled entry doesn't read as downtime
			// backlog the moment it comes back.
			state.baselineAt = now();
			state.lastFiredAt = undefined;
			state.scannedThroughMinute = undefined;

			return true;
		},
		list: () => [...states.values()].map((state) => ({ ...state.entry })),
		metrics,
		remove: (id) => states.delete(id),
		// 0.4.0: same snapshot/restore idiom as InMemoryJobStore. The control
		// plane serializes this on rotation (cron, SIGTERM), persists it
		// wherever, and hands it back to the replacement process — a restart
		// neither double-fires nor loses schedules.
		restore: (snapshot) => {
			states.clear();
			for (const { entry, lastFiredAt } of snapshot.entries)
				states.set(entry.id, makeState(entry, lastFiredAt));

			return snapshot.entries.length;
		},
		snapshot: () => ({
			entries: [...states.values()].map((state) => ({
				entry: { ...state.entry },
				lastFiredAt: state.lastFiredAt
			})),
			exportedAt: now()
		}),
		start: () => {
			if (running) return;
			running = true;
			timer = setTimeout(loop, 0);
		},
		stop: async () => {
			running = false;
			if (timer) clearTimeout(timer);
			while (tickInFlight)
				await new Promise((resolve) =>
					setTimeout(resolve, STOP_POLL_MS)
				);
		},
		tick
	};
};

/**
 * Convenience wake action: POST to `entry.url`, treating a missing url or
 * any non-2xx response as an error (→ `onError` + the `errors` counter).
 * `wake` stays the single seam — this is just one implementation of it.
 * Added in 0.4.0.
 */
export const httpWake =
	(fetchImpl: typeof fetch = fetch) =>
	async (entry: WakeEntry) => {
		if (!entry.url)
			throw new Error(
				`Wake entry "${entry.id}" has no "url" — httpWake needs one to POST to`
			);
		const response = await fetchImpl(entry.url, { method: 'POST' });
		if (!response.ok)
			throw new Error(
				`Wake POST to ${entry.url} for "${entry.id}" failed: HTTP ${response.status}`
			);
	};
