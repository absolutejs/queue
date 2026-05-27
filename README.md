# @absolutejs/queue

A durable, typed background-job queue for [Elysia](https://elysiajs.com) and the
AbsoluteJS ecosystem. Persists jobs, claims them safely across workers, retries with
backoff, dead-letters, and runs delayed one-shots.

It does **not** reinvent cron — pair it with
[`@elysiajs/cron`](https://elysiajs.com/plugins/cron) for recurring triggers. Cron
decides _when_; the queue guarantees the work _happens_ (once, surviving restarts).

> Status: early (`0.0.4`). In-memory store, schema-defined typed registry, worker,
> Elysia plugin, admin routes, standalone worker runner, and a `runHandlerOnce`
> helper for manual triggers / tests. Production store:
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

CC BY-NC 4.0
