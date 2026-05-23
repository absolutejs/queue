# @absolutejs/queue — Package Build Plan

A durable, typed background-job queue for the AbsoluteJS ecosystem — built the
AbsoluteJS + Elysia + Bun way. Persists jobs, claims them safely across instances,
retries with backoff, dead-letters, and runs delayed one-shots. A **core package**
plus **storage adapters**.

> **Why `queue`, not `scheduler`:** `@elysiajs/cron` already owns the *time trigger*
> ("run every Monday 8am"). We don't rebuild that. The missing piece is the *durable
> work*: a job that survives a restart, runs exactly once across N workers, retries,
> and dead-letters. That's a queue. **They compose:** a cron tick calls
> `queue.enqueue(...)`; cron decides *when*, the queue guarantees the work *happens*.

> Fills gap **G1** in `~/onspark/absolutejs/dealroom/MIGRATION_PLAN.md`; onSpark adopts
> it via task `S0`.

Status: **building** — core in `src/` (in-memory store, registry, worker, plugin).

---

## 1. The grain to respect (ecosystem conventions)

Mirrors `@absolutejs/auth`:
- **Flat `src/`, one responsibility per file, named exports only** (no defaults).
- **Tabs (width 4), single quotes, semicolons, no trailing commas, 80 cols.**
- **`type` aliases (not `interface`); strict TS + `noUncheckedIndexedAccess`.**
- **Stores are an interface with multiple implementations** — `JobStore<Jobs>` with
  `createInMemoryJobStore` in core + a `createPostgresJobStore` adapter package, the
  same core + storage-adapter split as `@absolutejs/rag`.
- **Generics + a typed registry** (`JobMap`: kind → payload), checked end to end.
- **An Elysia plugin (`queue()`) is the integration surface** — decorates context with
  `enqueue`, optionally auto-starts an in-process worker. Bun-first, dependency-light
  (core has zero runtime deps; only `elysia` is a peer).

---

## 2. Core concepts

- **Job** — `{ id, kind, payload, status, runAt, attempts, maxAttempts,
  idempotencyKey?, lockedAt?, lockedBy?, lastError?, createdAt, updatedAt }`.
  Status: `pending → claimed → done | dead`, with `claimed → pending` on retry.
- **JobMap** — `kind → payload type`. Flows through `enqueue`, registry, handlers.
- **JobStore** — persistence + atomic claim (the seam). `enqueue`, `claimDue`,
  `complete`, `fail`, `reapStuck`, optional `listByKind`.
- **Registry** — `kind → handler`; the worker dispatches through it.
- **Worker** — claim → run → record loop; concurrency cap, retries+backoff,
  dead-letter, crash recovery via lease + `reapStuck`.

---

## 3. Package layout

Built (this commit):
- `src/types.ts` — `Job`, `JobMap`, `JobId`, `JobStore`, `JobRegistry`, handler/worker
  types.
- `src/constants.ts` — defaults (max attempts, concurrency, poll interval, lease,
  backoff).
- `src/ids.ts` — `createJobId()` (uuid).
- `src/backoff.ts` — `exponentialBackoff()` strategy.
- `src/registry.ts` — `createJobRegistry<Jobs>()`.
- `src/inMemoryJobStore.ts` — `createInMemoryJobStore<Jobs>()` (dev/test).
- `src/worker.ts` — `createQueueWorker()` (loop, retries, dead-letter, reaping).
- `src/plugin.ts` — `queue()` Elysia plugin (`ctx.queue.enqueue`, optional worker).
- `src/index.ts` — exports.
- `tests/queue.test.ts` — run / dedupe / retry→dead-letter (`bun test`).

Next:
- `src/routes.ts` — admin/observability routes (list / retry / cancel / dead-letter).
- `src/standaloneWorker.ts` — runner for `bun run worker.ts`.
- `@absolutejs/queue-postgres` — `createPostgresJobStore()` (Drizzle, `FOR UPDATE SKIP
  LOCKED`). Primary production store; matches onSpark.
- `@absolutejs/queue-sqlite` — single-instance / edge.

---

## 4. Public API (shipped shape)

```ts
type Jobs = {
	'email.recap': { accountId: string };
	'match.ping': { matchId: string };
};

const store = createInMemoryJobStore<Jobs>();
const registry = createJobRegistry<Jobs>()
	.on('email.recap', async ({ accountId }, ctx) => { /* … */ })
	.on('match.ping', async ({ matchId }) => { /* … */ });

app.use(queue({ registry, store }));            // in-process worker auto-starts
// handler: ctx.queue.enqueue('email.recap', { accountId }, { runAt });

// recurring (compose with @elysiajs/cron):
app.use(cron({ name: 'weekly-recap', pattern: '0 8 * * 1',
	run: () => store.enqueue({ kind: 'email.recap', payload: { accountId } }) }));
```

---

## 5. Out of v1 scope (named to avoid creep)

- In-house cron parser → use `@elysiajs/cron`.
- Workflow/DAG chaining, fan-out/fan-in → can layer on later.
- Redis/other backends → Postgres adapter first.
- Priorities beyond a simple optional int → `runAt` + FIFO for now.
- Instant cross-process wakeup → v1 short-polls `claimDue`; add Postgres `LISTEN/NOTIFY`
  later if latency demands it.

## 6. Acceptance

Durability, exactly-once-ish claim (Postgres `SKIP LOCKED` in the adapter), retries +
backoff, dead-letter, crash recovery (`reapStuck`), concurrency cap, observability
routes, `bun test` green (in-memory) + a Postgres integration test for the claim/lock
semantics.

## 7. Open decisions

- Cron recipe: ship a tiny `enqueueOnCron` helper, or just document the `@elysiajs/cron`
  pattern? (Leaning: document + maybe a 5-line helper.)
- Standalone worker registry sharing (shared module export) — settle when building it.
- Drizzle dialect parity: Postgres + SQLite to match the rag adapter set.
