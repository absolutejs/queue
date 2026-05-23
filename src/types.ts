import type { Static, TSchema } from '@sinclair/typebox';

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
	leaseMs?: number;
	onError?: (error: unknown, job?: Job<Jobs>) => void;
	pollIntervalMs?: number;
	registry: JobRegistry<Jobs>;
	store: JobStore<Jobs>;
	workerId?: string;
};

export type QueueWorker = {
	runOnce: () => Promise<number>;
	start: () => void;
	stop: () => Promise<void>;
};
