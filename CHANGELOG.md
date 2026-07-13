# Changelog

All notable changes to `@absolutejs/queue` are recorded here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package is pre-1.0 — minor bumps may carry breaking changes; we'll call
them out here.

## [0.4.0] — 2026-07-13

### Added — control-plane wake scheduler (`createWakeScheduler`)

Closes PaaS-guide gap 5.5: background jobs that survive process death.
A customer cron that triggers every 6h won't fire if their tenant
process is idle-killed — so the CONTROL PLANE (never idle-killed) runs
the schedule and pokes the tenant awake; the tenant's queue worker does
the actual work once it's up. Fully backwards-compatible additive
feature.

- **`createWakeScheduler(options)`** — durable host-side scheduler.
  Entries (`WakeEntry`) carry exactly one of `every` (interval ms) or
  `cron` (5-field UTC expression), plus `tenant`, optional `url` /
  `jitterMs` / `enabled`. The wake itself is the caller-supplied
  `wake(entry)` seam — HTTP poke, `runtime.ensure(tenant)`, anything.
- **API**: `start()` / `stop()`; `add` / `remove` / `enable` /
  `disable` / `list`; `tick()` exposed for tests (manual advance with
  the injectable `now`); `snapshot()` / `restore(snap)` persisting
  entries + per-entry `lastFiredAt` (same idiom as
  `InMemoryJobStore`) so a control-plane restart neither double-fires
  nor loses schedules; `metrics()` (`entries`, `enabled`, `firings`,
  `errors`, `missedSkipped`, `skippedTicks`, `lastTickMs`, `draining`,
  `byTenant`); `drain()` symmetric with `worker.drain()`.
- **Semantics**: wakes fire concurrently (`Promise.allSettled`) — a
  throwing wake hits `onError` + the `errors` counter and never blocks
  other entries; overlapping ticks are skipped and counted; a cron
  entry fires at most once per matching minute; `catchUp: 'skip'`
  (default) drops firings missed during downtime while `'once'` fires
  a single compensating wake — both count `missedSkipped`; `jitterMs`
  delays each firing by `random() * jitterMs` via the injectable
  `random` option.
- **`httpWake(fetchImpl?)`** — convenience wake action that POSTs to
  `entry.url` and treats non-2xx as an error. `wake` stays the single
  seam.
- **In-repo 5-field cron parser** (`parseCronExpression`,
  `cronMatchesMinute` — exported): `*`, numbers, comma lists, ranges,
  `/n` steps on `*` or a range, day-of-week `0-7` (`7` ≡ Sunday),
  standard either-day-field OR semantics, evaluated in UTC. No cron
  dependency; no names / `L` / `W` / seconds / macros / time zones.
- **OTel**: with a `tracerProvider`, every firing is a `queue.wake`
  span with `abs.tenant` + `abs.wake.id`, matching the `queue.runJob`
  idiom.
- **Manifest**: new `wake-scheduler` wiring recipe alongside the
  default queue recipe.
- New constant `DEFAULT_WAKE_TICK_MS` (15_000); new types `WakeEntry`,
  `WakeCatchUpMode`, `CreateWakeSchedulerOptions`, `WakeScheduler`,
  `WakeSchedulerMetrics`, `WakeSchedulerSnapshot`, `CronExpression`.

25 new tests in `tests/wakeScheduler.test.ts`: cron field types + UTC
boundaries + OR day semantics + malformed expressions, interval firing
with injected `now`, no double-fire within a minute, catch-up skip vs
once (interval + cron), snapshot/restore across a "restart", error
isolation + `onError`, enable/disable/remove, drain, overlap guard,
metrics, jitter with injected `random`, `httpWake` success / non-2xx /
missing url, and `queue.wake` span capture.

Test count: 29 → 54.

## [0.2.0] — 2026-05-30

### Added — OpenTelemetry tracing via @absolutejs/telemetry

Closes G2 from the deep-research audit for the queue worker. Customer
SREs investigating a flagged audit row (or a stuck tenant) now follow
one trace from the enqueuing HTTP request → the job's worker.runJob
span → any sync mutations / secret resolves the handler performs.

- **`CreateQueueWorkerOptions.tracerProvider?: TracerProvider`** — any
  `@opentelemetry/api`-compatible `TracerProvider`. When supplied,
  every `runJob` is wrapped in a `queue.runJob` span with `ABS_ATTRS`
  semantic attributes (`abs.job.id`, `abs.job.kind`,
  `abs.job.attempt`, `abs.job.max_attempts`, `abs.worker.id`). When
  omitted, all tracing is a zero-allocation noop.
- Span status `OK` on successful completion; `ERROR` with the
  exception recorded on handler throw (whether the failure dead-letters
  or retries — that distinction is in metrics, not the span).
- `@absolutejs/telemetry` added as a regular dep (250 LOC, zero
  transitive deps).

3 new tests in `tests/tracing.test.ts`: captures spans through a mock
`TracerProvider`, verifies success path / failure path / noop fallback.

Test count: 24 → 27.

## [0.1.0] — 2026-05-29

### Added — operator-shaped metrics, drain, in-memory snapshot/restore

The substrate-deepening pattern (already in `runtime` / `metering` / `router`
/ `secrets` / `deploy` / `sync` / `isolated-jsc`) lands on queue. A PaaS host
running multiple workers per tenant now has the introspection + lifecycle
hooks it needs without external wrappers.

- **`worker.metrics()`** returns `QueueWorkerMetrics`: point-in-time
  `active` / `capacity` / `draining` + cumulative counters
  (`runs`, `completed`, `failed`, `retried`, `deadLettered`, `polls`,
  `reaped`) + `lastTickMs`. Drop-in for `@absolutejs/metering` — a sudden
  climb in `lastTickMs` is the operator's signal that the store layer is
  slowing down (PG locking, network jitter).
- **`worker.drain()`** sets a flag that skips claiming new jobs while
  letting in-flight handlers complete. The polling loop continues so
  stuck-lease reaps keep running — `drain()` is "stop accepting new
  work" rather than "halt the worker." Symmetric with
  `runtime.drain()` / `HibernatingIsolatePool.drain()`.
- **`createInMemoryJobStore` now returns `InMemoryJobStore<Jobs>`** — adds
  `snapshot()` returning `InMemoryJobStoreSnapshot<Jobs>` and `restore(snapshot)`
  taking that shape. The PaaS host writes the snapshot to disk on
  `SIGTERM` and hands it back to the replacement process; pending +
  claimed jobs survive the restart. Stores backed by an external durable
  layer (Postgres, Redis) don't implement this surface — their durable
  layer IS the snapshot.

10 new tests in `tests/metrics.test.ts`:

- metrics starts zeroed,
- completed runs counted,
- retried distinct from deadLettered,
- `lastTickMs` updates after each tick,
- `drain()` refuses new claims but keeps polling for reaps,
- `drain()` lets in-flight handlers complete,
- snapshot round-trips pending + claimed jobs,
- replacement worker drains restored jobs,
- restore overwrites existing jobs,
- snapshot is a copy (shallow).

Test count: 14 → 24. Backwards-compatible — the existing `QueueWorker`
shape gains two methods; `JobStore<Jobs>` is unchanged; `InMemoryJobStore`
is a strict superset.

## [0.0.6] — earlier

Switch license to BSL-1.1 with package-specific PaaS carveout.

## [0.0.4] — earlier

`runHandlerOnce` + cron-pattern docs.

## [0.0.2] — earlier

Schema-defined jobs with full inference + payload validation.

## [0.0.1] — earlier

Initial preview — durable typed job queue: `defineJobs`, `createJobRegistry`,
`createInMemoryJobStore`, `createQueueWorker`, the `queue` Elysia plugin,
`createQueueRoutes`, `runHandlerOnce`, `runQueueWorker`.
