# Changelog

All notable changes to `@absolutejs/queue` are recorded here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This package is pre-1.0 — minor bumps may carry breaking changes; we'll call
them out here.

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
