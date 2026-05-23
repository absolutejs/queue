# @absolutejs/queue

A durable, typed background-job queue for [Elysia](https://elysiajs.com) and the
AbsoluteJS ecosystem. Persists jobs, claims them safely across workers, retries with
backoff, dead-letters, and runs delayed one-shots.

It does **not** reinvent cron — pair it with
[`@elysiajs/cron`](https://elysiajs.com/plugins/cron) for recurring triggers. Cron
decides *when*; the queue guarantees the work *happens* (once, surviving restarts).

> Status: early (`0.0.1`). Core (in-memory store, registry, worker, Elysia plugin) is
> in place; the Postgres adapter (`@absolutejs/queue-postgres`) and admin routes are
> next. See `PLAN.md`.

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
	queue
} from '@absolutejs/queue';

type Jobs = {
	'email.recap': { accountId: string };
	'match.ping': { matchId: string };
};

const store = createInMemoryJobStore<Jobs>();
const registry = createJobRegistry<Jobs>()
	.on('email.recap', async ({ accountId }) => {
		// send the recap…
	})
	.on('match.ping', async ({ matchId }, { attempts }) => {
		// nudge the match…
	});

const app = new Elysia()
	.use(queue({ registry, store })) // in-process worker auto-starts
	.post('/recap/:id', ({ params, queue }) =>
		queue.enqueue('email.recap', { accountId: params.id })
	)
	.post('/ping/:id', ({ params, queue }) =>
		// delayed one-shot: run in 14 days
		queue.enqueue(
			'match.ping',
			{ matchId: params.id },
			{ runAt: Date.now() + 14 * 24 * 60 * 60 * 1000 }
		)
	)
	.listen(3000);
```

### Recurring jobs (with `@elysiajs/cron`)

```ts
import { cron } from '@elysiajs/cron';

app.use(
	cron({
		name: 'weekly-recap',
		pattern: '0 8 * * 1', // Mondays at 08:00
		run: () => store.enqueue({ kind: 'email.recap', payload: { accountId } })
	})
);
```

## How it works

- **Typed registry** — `kind → payload → handler`, checked end to end.
- **`JobStore` interface** — `enqueue`, `claimDue` (atomic), `complete`, `fail`,
  `reapStuck`, `listByKind`. Swap `createInMemoryJobStore` for a durable adapter in prod.
- **Worker** — claims due jobs up to a concurrency cap, runs handlers, retries with
  exponential backoff, dead-letters after `maxAttempts`, and reaps jobs whose worker
  died (lease + `reapStuck`).
- **Idempotency** — pass `idempotencyKey` to `enqueue` to dedupe.

## License

CC BY-NC 4.0
