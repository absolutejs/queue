# @absolutejs/queue

A durable, typed background-job queue for [Elysia](https://elysiajs.com) and the
AbsoluteJS ecosystem. Persists jobs, claims them safely across workers, retries with
backoff, dead-letters, and runs delayed one-shots.

It does **not** reinvent cron — pair it with
[`@elysiajs/cron`](https://elysiajs.com/plugins/cron) for recurring triggers. Cron
decides _when_; the queue guarantees the work _happens_ (once, surviving restarts).

> Status: early (`0.4.0`). In-memory store, schema-defined typed registry, worker,
> Elysia plugin, admin routes, standalone worker runner, a `runHandlerOnce`
> helper for manual triggers / tests, and a control-plane `createWakeScheduler`
> for waking idle-killed tenants. Production store:
> [`@absolutejs/queue-postgres`](https://github.com/absolutejs/queue-adapters).

## Install

```bash
bun add @absolutejs/queue elysia
```

## Usage

```ts
import { Elysia } from 'elysia';
import {
	createInMemoryJobStore,
	createJobRegistry,
	defineJobs,
	queue,
	t
} from '@absolutejs/queue';

// Define jobs once: kind -> payload schema. Payload types are inferred from this
// (no hand-written job map, no generics) and validated at enqueue + dequeue.
// Build schemas with `t` from this package so they share one TypeBox instance.
const jobs = defineJobs({
	'email.send': t.Object({ to: t.String(), subject: t.String() }),
	'webhook.deliver': t.Object({ url: t.String(), body: t.Unknown() })
});

const store = createInMemoryJobStore(jobs);
const registry = createJobRegistry(jobs)
	.on('email.send', async ({ to, subject }) => {
		// to: string, subject: string — inferred from the schema
	})
	.on('webhook.deliver', async ({ url, body }, { attempts }) => {
		// retried automatically; `attempts` is which try this is
	});

const app = new Elysia()
	.use(queue({ registry, store })) // in-process worker auto-starts
	.post('/welcome/:email', ({ params, queue }) =>
		queue.enqueue('email.send', {
			subject: 'Welcome',
			to: params.email
		})
	)
	.post('/notify', ({ body, queue }) =>
		// delayed one-shot: deliver the webhook in 1 hour
		queue.enqueue(
			'webhook.deliver',
			{ body, url: 'https://example.com/hook' },
			{ runAt: Date.now() + 60 * 60 * 1000 }
		)
	)
	.listen(3000);
```

### Recurring jobs (with `@elysiajs/cron`)

Pattern: keep the `store` at module scope so both the queue plugin's worker
and the cron triggers reference the same backing state. The cron `run`
callback doesn't receive an Elysia `Context`, so it can't reach the queue
via decorators — it closes over the imported `store` directly.

```ts
// src/jobs/index.ts
import {
	createInMemoryJobStore,
	createJobRegistry,
	defineJobs,
	queue,
	t
} from '@absolutejs/queue';
import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

const jobs = defineJobs({
	'email.send': t.Object({ to: t.String(), subject: t.String() })
});

// Module-scoped so cron + worker reference the same backing state.
export const store = createInMemoryJobStore(jobs);
export const registry = createJobRegistry(jobs).on(
	'email.send',
	async () => {}
);

export const backgroundJobs = new Elysia({ name: 'background-jobs' })
	.use(queue({ registry, store }))
	.use(
		cron({
			name: 'weekly-digest',
			pattern: '0 8 * * 1', // Mondays at 08:00
			run: () =>
				store.enqueue({
					idempotencyKey: `weekly-digest:${new Date().toISOString().slice(0, 10)}`,
					kind: 'email.send',
					payload: {
						subject: 'Weekly digest',
						to: 'team@example.com'
					}
				})
		})
	);
```

Tag enqueues with a per-day `idempotencyKey` so a misfire doesn't double-run.

### Waking idle-killed tenants (`createWakeScheduler`)

On a PaaS, tenant processes get idle-killed — and with them dies every
in-process timer. A customer cron that triggers every 6 hours won't fire if
the tenant has been asleep for 5 of them. The fix is architectural: the
**control plane** (which is never idle-killed) owns the schedule and pokes
the tenant awake; the tenant's own queue worker then does the actual work.

`createWakeScheduler` is that control-plane side: a durable scheduler that
fires per-tenant schedules (`every` interval or 5-field UTC cron) and calls
a caller-supplied `wake` action — an HTTP poke, `runtime.ensure(tenant)`,
whatever brings the tenant up.

```ts
import { createWakeScheduler, httpWake } from '@absolutejs/queue';

// Runs on the CONTROL PLANE (always-on), not in tenant processes.
const wakeScheduler = createWakeScheduler({
	entries: [
		// Exactly one of `every` (ms) or `cron` (5-field, UTC) per entry.
		{
			every: 6 * 60 * 60 * 1000,
			id: 'acme-digest',
			tenant: 'acme',
			url: 'https://acme.internal/wake'
		},
		{ cron: '0 8 * * 1', id: 'globex-report', tenant: 'globex' }
	],
	// The wake is the single seam. httpWake() POSTs entry.url and treats
	// non-2xx as an error...
	wake: httpWake(),
	onError: (error, entry) => console.error(entry?.id, error)
});
wakeScheduler.start();
```

Pairing with [`@absolutejs/runtime`](https://github.com/absolutejs/runtime),
the wake IS the process resurrection — `ensure` boots the tenant if it's
down, and the tenant's queue worker picks up its due jobs on startup:

```ts
const wakeScheduler = createWakeScheduler({
	entries: tenantSchedules,
	wake: async (entry) => {
		await runtime.ensure(entry.tenant);
	}
});
```

What the scheduler guarantees:

- **Restart safety** — `snapshot()` / `restore(snap)` persist the entries
  plus per-entry `lastFiredAt` (same idiom as the in-memory store's
  snapshot/restore), so a control-plane restart neither double-fires nor
  loses schedules. `catchUp: 'skip'` (default) drops firings missed during
  downtime and resumes the cadence; `catchUp: 'once'` fires a single
  compensating wake. Either way `metrics().missedSkipped` counts them.
- **Error isolation** — wakes fire concurrently; one tenant's failing wake
  hits `onError` + the `errors` counter and never blocks the rest. A failed
  wake waits for its next slot (a wake is a poke, not a job — no backoff
  ladder).
- **No double-fire** — a cron entry fires at most once per matching minute;
  overlapping ticks are skipped and counted, never run twice.
- **Operator surface** — `add` / `remove` / `enable` / `disable` / `list`,
  `metrics()` (`entries`, `enabled`, `firings`, `errors`, `missedSkipped`,
  `skippedTicks`, `lastTickMs`, `byTenant`), and `drain()` symmetric with
  `worker.drain()`. `tick()` is exposed for tests with an injected `now`;
  `jitterMs` spreads same-cadence fleets via an injectable `random`.
- **Tracing** — with a `tracerProvider`, every firing is a `queue.wake`
  span carrying `abs.tenant` + `abs.wake.id`, matching `queue.runJob`.

The in-repo cron parser is deliberately minimal: 5 fields
(`minute hour day-of-month month day-of-week`), `*`, numbers, comma lists,
ranges, `/n` steps on `*` or a range, day-of-week `0-7` (both `0` and `7`
are Sunday), standard either-day-field-matches semantics, **UTC only**. No
names (`MON`), no `L`/`W`/`#`, no seconds, no macros — if you need those,
run a real cron and call `wake` yourself.

### One-shot manual triggers (`runHandlerOnce`)

Sometimes you want to invoke a handler directly — manual backfills, admin
re-runs, unit tests, or `bun scripts/foo.ts` wrappers that share logic with
the cron. Use `runHandlerOnce`: it validates the payload through the
registry's schema and synthesises a `JobContext` for you, then runs the
handler — no worker, no store writes.

```ts
// scripts/runWeeklyDigest.ts
import { runHandlerOnce } from '@absolutejs/queue';
import { registry } from '../src/jobs/registry'; // direct import — see warning below

await runHandlerOnce(registry, 'email.send', {
	to: 'team@example.com',
	subject: 'Weekly digest (manual trigger)'
});
```

> **Don't import the barrel that re-exports `backgroundJobs`.** Importing the
> Elysia plugin pulls in `@elysiajs/cron`, which keeps timers alive and
> prevents your script from exiting. Either (a) split your jobs module so the
> `registry` is exported from a different file than `backgroundJobs`, or
> (b) `process.exit(0)` at the end of your script.

`runHandlerOnce` accepts an `options.context` override (for `attempts`,
`maxAttempts`, `id`, etc.) and an `options.validators` override (`false` to
skip validation, or a pre-compiled `JobValidators` for hot loops).

## How it works

- **Schema-defined jobs** — `defineJobs` is the single source of truth: payload
  types are inferred from TypeBox schemas (no hand-written job map, no `<Jobs>`
  generics), and payloads are validated at enqueue and dequeue.
- **Typed registry** — `kind → payload → handler`, checked end to end.
- **`JobStore` interface** — `enqueue`, `claimDue` (atomic), `complete`, `fail`,
  `reapStuck`, `listByKind`. Swap `createInMemoryJobStore` for a durable adapter in prod.
- **Worker** — claims due jobs up to a concurrency cap, runs handlers, retries with
  exponential backoff, dead-letters after `maxAttempts`, and reaps jobs whose worker
  died (lease + `reapStuck`).
- **Idempotency** — pass `idempotencyKey` to `enqueue` to dedupe.

## License

BSL-1.1 — see [LICENSE](./LICENSE). Converts to Apache 2.0 on the Change Date per the license terms.
