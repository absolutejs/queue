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
