# @absolutejs/queue

A durable, typed background-job queue for [Elysia](https://elysiajs.com) and the
AbsoluteJS ecosystem. Persists jobs, claims them safely across workers, retries with
backoff, dead-letters, and runs delayed one-shots.

It does **not** reinvent cron — pair it with
[`@elysiajs/cron`](https://elysiajs.com/plugins/cron) for recurring triggers. Cron
decides *when*; the queue guarantees the work *happens* (once, surviving restarts).

> Status: early (`0.0.2`). In-memory store, schema-defined typed registry, worker,
> Elysia plugin, admin routes, and a standalone worker runner. Production store:
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

```ts
import { cron } from '@elysiajs/cron';

app.use(
	cron({
		name: 'weekly-digest',
		pattern: '0 8 * * 1', // Mondays at 08:00
		run: () =>
			store.enqueue({
				kind: 'email.send',
				payload: { subject: 'Weekly digest', to: 'team@example.com' }
			})
	})
);
```

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
