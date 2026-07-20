import type { Static, TSchema } from '@sinclair/typebox';
import type { TracerProvider } from '@absolutejs/telemetry';

export type JobId = `${string}-${string}-${string}-${string}-${string}`;

export type JobStatus = 'canceled' | 'claimed' | 'dead' | 'done' | 'pending';

export type JobMap = Record<string, unknown>;

// A job definition maps each kind to a TypeBox schema for its payload. It is the
// single source of truth: payload types are inferred from it (JobMapFromDefinition)
// and payloads are validated against it at enqueue and dequeue.
export type JobDefinition = Record<string, TSchema>;

export type JobMapFromDefinition<Def extends JobDefinition> = {
	[Kind in keyof Def]: Static<Def[Kind]>;
};

export type Job<Jobs extends JobMap, Kind extends keyof Jobs = keyof Jobs> = {
	attempts: number;
	createdAt: number;
	id: JobId;
	idempotencyKey?: string;
	kind: Kind;
	lastError?: string;
	lockedAt?: number;
	lockedBy?: string;
	maxAttempts: number;
	payload: Jobs[Kind];
	runAt: number;
	status: JobStatus;
	updatedAt: number;
};

export type EnqueueInput<Jobs extends JobMap, Kind extends keyof Jobs> = {
	idempotencyKey?: string;
	kind: Kind;
	maxAttempts?: number;
	payload: Jobs[Kind];
	runAt?: number;
};

export type JobContext<Jobs extends JobMap, Kind extends keyof Jobs> = {
	attempts: number;
	id: JobId;
	kind: Kind;
	maxAttempts: number;
	signal: AbortSignal;
};

export type JobHandler<Jobs extends JobMap, Kind extends keyof Jobs> = (
	payload: Jobs[Kind],
	context: JobContext<Jobs, Kind>
) => Promise<void> | void;

export type ClaimDueOptions = {
	limit: number;
	now: number;
	workerId: string;
};

export type FailOptions = {
	dead?: boolean;
	error: string;
	retryAt?: number;
};

export type ListByKindOptions = {
	limit?: number;
	status?: JobStatus;
};

export type ListJobsOptions = {
	kind?: string;
	limit?: number;
	offset?: number;
	status?: JobStatus;
};

export type ReapStuckOptions = {
	leaseMs: number;
	now: number;
};

// Required methods are the worker contract. Optional methods power
// observability/admin tooling (createQueueRoutes) — stores may omit them.
export type JobStore<Jobs extends JobMap> = {
	cancel?: (id: JobId) => Promise<boolean>;
	claimDue: (options: ClaimDueOptions) => Promise<Job<Jobs>[]>;
	complete: (id: JobId) => Promise<void>;
	countByStatus?: () => Promise<Record<JobStatus, number>>;
	enqueue: <Kind extends keyof Jobs>(
		input: EnqueueInput<Jobs, Kind>
	) => Promise<JobId>;
	fail: (id: JobId, options: FailOptions) => Promise<void>;
	get?: (id: JobId) => Promise<Job<Jobs> | undefined>;
	list?: (options?: ListJobsOptions) => Promise<Job<Jobs>[]>;
	listByKind?: <Kind extends keyof Jobs>(
		kind: Kind,
		options?: ListByKindOptions
	) => Promise<Job<Jobs, Kind>[]>;
	reapStuck: (options: ReapStuckOptions) => Promise<number>;
	retry?: (id: JobId) => Promise<boolean>;
};

export type JobRegistry<Jobs extends JobMap> = {
	getHandler: <Kind extends keyof Jobs>(
		kind: Kind
	) => JobHandler<Jobs, Kind> | undefined;
	getSchema: (kind: keyof Jobs) => TSchema | undefined;
	kinds: () => (keyof Jobs)[];
	on: <Kind extends keyof Jobs>(
		kind: Kind,
		handler: JobHandler<Jobs, Kind>
	) => JobRegistry<Jobs>;
};

export type BackoffStrategy = (attempt: number) => number;

export type CreateQueueWorkerOptions<Jobs extends JobMap> = {
	backoff?: BackoffStrategy;
	concurrency?: number;
	/**
	 * Max wall-clock a handler may run before the worker aborts its `signal`
	 * and fails the job (retry / dead-letter via the normal path) — so a hung
	 * handler frees its worker slot instead of holding it for the full lease.
	 *
	 * A number applies to every kind; a function lets each kind set its own
	 * (e.g. 15s for emails, 5min for AI synthesis) — return `undefined` for no
	 * limit on that kind. Unset = no timeout (back-compat). The handler should
	 * still honor `signal` so its in-flight work actually stops; the timeout
	 * only bounds how long the WORKER waits.
	 */
	handlerTimeoutMs?:
		| number
		| ((kind: keyof Jobs & string) => number | undefined);
	leaseMs?: number;
	onError?: (error: unknown, job?: Job<Jobs>) => void;
	pollIntervalMs?: number;
	registry: JobRegistry<Jobs>;
	store: JobStore<Jobs>;
	workerId?: string;
	/**
	 * Optional OpenTelemetry tracer provider. When set, every job run
	 * is wrapped in a `queue.runJob` span with `abs.job.kind`,
	 * `abs.job.id`, `abs.job.attempt`, `abs.job.max_attempts`,
	 * `abs.worker.id` attributes. When absent, all tracing is a
	 * zero-allocation noop. Added in 0.2.0.
	 *
	 * Pass any `@opentelemetry/api`-compatible `TracerProvider`. See
	 * `@absolutejs/telemetry` for the type shape — queue re-uses its
	 * helpers but doesn't peer-dep `@opentelemetry/api` directly.
	 */
	tracerProvider?: TracerProvider;
};

export type QueueWorker = {
	runOnce: () => Promise<number>;
	resume: () => void;
	start: () => void;
	stop: () => Promise<void>;
	/**
	 * Operator-shaped snapshot of the worker's current state plus cumulative
	 * counters since `createQueueWorker()`. Scrape on a 30s interval and feed
	 * to `@absolutejs/metering` for per-worker cost/throughput attribution.
	 *
	 * - `active` / `capacity` — running handlers / configured concurrency.
	 * - `draining` — `true` after `drain()` was called and before `stop()`.
	 * - `runs` — handlers invoked (whether they completed, failed, or were
	 *   dead-lettered). Equal to `completed + failed` once every claim has
	 *   resolved.
	 * - `completed` / `failed` — terminal outcomes since start. `failed`
	 *   includes the dead-lettered tail; `deadLettered` is the subset that
	 *   exhausted `maxAttempts`.
	 * - `retried` — `fail()` calls that scheduled a retry (i.e. not
	 *   dead-lettered). A single job may retry several times.
	 * - `polls` — `tick()` invocations (whether claims were available or
	 *   not). `reaped` — stuck-lease reaps fired during polling.
	 * - `lastTickMs` — wall-clock duration of the most recent `tick()`. A
	 *   sudden climb here is the operator's signal that the store is
	 *   slowing down (PG locking, network jitter).
	 *
	 * Added in 0.1.0.
	 */
	metrics: () => QueueWorkerMetrics;
	/**
	 * Refuse to claim new jobs (claimDue is skipped); let in-flight handlers
	 * finish their current work. The polling loop continues so stuck-lease
	 * reaps keep running — `drain()` is "stop accepting new work" rather
	 * than "halt the worker." Call `stop()` afterwards to actually shut
	 * down. Symmetric with `@absolutejs/runtime`'s `drain()` and
	 * `@absolutejs/isolated-jsc`'s pool `drain()`. Added in 0.1.0.
	 */
	drain: () => void;
};

/**
 * Operator-shaped point-in-time snapshot returned by
 * {@link QueueWorker.metrics}. Cumulative counters reset on
 * `createQueueWorker()`. Added in 0.1.0.
 */
export type QueueWorkerMetrics = {
	active: number;
	capacity: number;
	draining: boolean;
	runs: number;
	completed: number;
	failed: number;
	retried: number;
	deadLettered: number;
	polls: number;
	reaped: number;
	lastTickMs: number;
};

/**
 * Serializable snapshot of an in-memory store's full state, produced by
 * {@link InMemoryJobStore.snapshot} and consumed by
 * {@link InMemoryJobStore.restore}. The host persists this on shard
 * rotation (cron, SIGTERM) and hands it back to the replacement worker so
 * pending + claimed jobs survive the restart.
 *
 * Stores backed by an external durable system (Postgres, Redis) don't
 * need this — the durable layer IS the snapshot. Added in 0.1.0.
 */
export type InMemoryJobStoreSnapshot<Jobs extends JobMap> = {
	jobs: ReadonlyArray<Job<Jobs>>;
	exportedAt?: number;
};

/**
 * Extends {@link JobStore} with snapshot/restore. The in-memory store
 * returned by `createInMemoryJobStore` implements this surface; external
 * stores typically don't (their durable layer handles persistence).
 *
 * Added in 0.1.0.
 */
export type InMemoryJobStore<Jobs extends JobMap> = JobStore<Jobs> & {
	snapshot: () => InMemoryJobStoreSnapshot<Jobs>;
	restore: (snapshot: InMemoryJobStoreSnapshot<Jobs>) => number;
};

/**
 * One per-tenant wake schedule for {@link WakeScheduler}. Exactly one of
 * `every` (fixed interval) or `cron` (5-field UTC expression — see
 * `parseCronExpression` for the supported grammar) must be set; `add()`
 * throws otherwise. Added in 0.4.0.
 */
export type WakeEntry = {
	/** 5-field UTC cron expression. Mutually exclusive with `every`. */
	cron?: string;
	/** Schedules default to enabled; `false` keeps the entry parked. */
	enabled?: boolean;
	/** Fixed interval in milliseconds. Mutually exclusive with `cron`. */
	every?: number;
	/** Unique schedule id — also the snapshot/restore key. */
	id: string;
	/**
	 * Random extra delay in `[0, jitterMs)` added to each firing so a fleet
	 * of same-cadence schedules doesn't wake every tenant on the same tick.
	 * Randomness comes from the scheduler's injectable `random` option.
	 */
	jitterMs?: number;
	/** Tenant identifier — becomes the `abs.tenant` span attribute. */
	tenant: string;
	/**
	 * Optional wake target. The scheduler never fetches it itself — pass
	 * `httpWake()` as the `wake` option (or read `entry.url` inside your own
	 * wake fn) to POST it.
	 */
	url?: string;
};

/**
 * What to do when a schedule comes back overdue after downtime (control-
 * plane restart, restored snapshot, suspended host): `'skip'` drops the
 * missed firings and resumes the cadence going forward; `'once'` fires a
 * single compensating wake immediately. Missed firings are counted in
 * `metrics().missedSkipped` under both modes. Added in 0.4.0.
 */
export type WakeCatchUpMode = 'once' | 'skip';

export type CreateWakeSchedulerOptions = {
	/** Downtime catch-up policy. Default `'skip'`. */
	catchUp?: WakeCatchUpMode;
	/** Initial schedules; equivalent to calling `add()` for each. */
	entries?: WakeEntry[];
	/** Injectable clock — tests advance it manually and call `tick()`. */
	now?: () => number;
	/**
	 * Called when a wake throws/rejects (with the entry) or when a tick
	 * itself fails (without one) — mirrors the worker's `onError`.
	 */
	onError?: (error: unknown, entry?: WakeEntry) => void;
	/** Injectable randomness for `jitterMs`. Default `Math.random`. */
	random?: () => number;
	/** Polling cadence for `start()`. Default 15_000. */
	tickMs?: number;
	/**
	 * Optional OpenTelemetry tracer provider. When set, every firing is
	 * wrapped in a `queue.wake` span with `abs.tenant` + `abs.wake.id`
	 * attributes, matching the worker's `queue.runJob` idiom. When absent,
	 * all tracing is a zero-allocation noop.
	 */
	tracerProvider?: TracerProvider;
	/**
	 * The wake action — the single seam. An HTTP poke (`httpWake()`),
	 * `runtime.ensure(entry.tenant)`, a cluster-bus message. A throw or
	 * rejection counts as an error and never blocks other entries.
	 */
	wake: (entry: WakeEntry) => Promise<void> | void;
};

/**
 * Operator-shaped point-in-time snapshot returned by
 * {@link WakeScheduler.metrics}. Cumulative counters reset on
 * `createWakeScheduler()`. Added in 0.4.0.
 */
export type WakeSchedulerMetrics = {
	byTenant: Record<string, { errors: number; firings: number }>;
	draining: boolean;
	enabled: number;
	entries: number;
	errors: number;
	firings: number;
	lastTickMs: number;
	missedSkipped: number;
	skippedTicks: number;
};

/**
 * Serializable snapshot of the scheduler's schedules plus per-entry
 * `lastFiredAt`, produced by {@link WakeScheduler.snapshot} and consumed by
 * {@link WakeScheduler.restore} — same idiom as `InMemoryJobStore`. The
 * control plane persists this on rotation (cron, SIGTERM) and hands it back
 * to the replacement process so a restart neither double-fires nor loses
 * schedules. Added in 0.4.0.
 */
export type WakeSchedulerSnapshot = {
	entries: ReadonlyArray<{ entry: WakeEntry; lastFiredAt?: number }>;
	exportedAt?: number;
};

/**
 * A control-plane-side durable scheduler that fires per-tenant schedules
 * and wakes tenants. Returned by `createWakeScheduler`. Added in 0.4.0.
 */
export type WakeScheduler = {
	/** Register a schedule. Throws on a duplicate id or an invalid entry. */
	add: (entry: WakeEntry) => void;
	/** Park a schedule without removing it. `false` when the id is unknown. */
	disable: (id: string) => boolean;
	/**
	 * Stop firing new wakes; in-flight wake promises settle on their own.
	 * Symmetric with `worker.drain()`. Call `stop()` afterwards to shut
	 * down the polling loop.
	 */
	drain: () => void;
	/**
	 * Un-park a schedule. Re-anchors the cadence at the current time so a
	 * long-disabled entry doesn't look like downtime backlog the moment it
	 * comes back. `false` when the id is unknown.
	 */
	enable: (id: string) => boolean;
	list: () => WakeEntry[];
	metrics: () => WakeSchedulerMetrics;
	remove: (id: string) => boolean;
	/** Replace all schedules + firing state with the snapshot's. Returns the entry count. */
	restore: (snapshot: WakeSchedulerSnapshot) => number;
	snapshot: () => WakeSchedulerSnapshot;
	start: () => void;
	stop: () => Promise<void>;
	/**
	 * One evaluation pass — exposed for tests (advance the injected `now`,
	 * then call `tick()`). Returns how many wakes fired. Overlapping ticks
	 * are skipped (and counted in `skippedTicks`) rather than double-fired.
	 */
	tick: () => Promise<number>;
};
