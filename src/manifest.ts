import {
	defineImplementation,
	defineManifest,
	toolFactory
} from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { QueuePluginOptions } from './plugin';
import type { JobId, JobMap, JobStore } from './types';

const tool = toolFactory<JobStore<JobMap>>();

const MAX_LIST_LIMIT = 500;
const MAX_ATTEMPTS_CEILING = 100;
const MAX_CONCURRENCY = 1000;

/* Serializable subset of QueuePluginOptions: concurrency + runWorker only.
 * `registry` (the app's job handlers) and `backoff` are function/instance
 * valued → wiring concerns; `store` is instance-valued → the job-store slot.
 *
 * Convention for `queue/job-store` implementations: the default wiring
 * recipe declares a module-scope `jobs` binding (the defineJobs definition),
 * so adapter wiring snippets that need the job definition (the in-memory
 * built-in, @absolutejs/queue-postgres) may reference `jobs` by name. */
export const manifest = defineManifest<
	QueuePluginOptions<JobMap>,
	JobStore<JobMap>
>()({
	contract: 2,
	identity: {
		accent: '#8b5cf6',
		category: 'infrastructure',
		description:
			'Schema-defined background jobs for Elysia: `defineJobs` types and validates every payload, workers claim jobs atomically across processes, retry with exponential backoff, dead-letter after `maxAttempts`, and recover crashed workers via lease reaping. Stores are pluggable (`queue/job-store`): in-memory for development, Postgres or Redis for production.',
		docsUrl: 'https://github.com/absolutejs/queue',
		name: '@absolutejs/queue',
		tagline:
			'Run tasks in the background — emails, imports, scheduled work.'
	},
	implements: [
		defineImplementation<never>()({
			contract: 'queue/job-store',
			factory: 'createInMemoryJobStore',
			from: '@absolutejs/queue',
			title: 'In memory (development only — jobs are lost on restart)',
			wiring: {
				// `jobs` is the module-scope defineJobs binding declared by the
				// core package's default wiring recipe.
				code: 'createInMemoryJobStore(jobs)',
				imports: [
					{
						from: '@absolutejs/queue',
						names: ['createInMemoryJobStore']
					}
				]
			}
		})
	],
	requires: {
		peers: [{ name: 'elysia', range: '>= 1.4.26', reason: 'plugin host' }]
	},
	settings: Type.Object({
		concurrency: Type.Optional(
			Type.Integer({
				description:
					'How many jobs may run at the same time in one server. Default is 5.',
				maximum: MAX_CONCURRENCY,
				minimum: 1,
				title: 'Jobs running at once'
			})
		),
		runWorker: Type.Optional(
			Type.Boolean({
				description:
					'Leave on so this server also works through the job list. Turn off only when a separate worker process runs the jobs.',
				title: 'Process jobs in this server'
			})
		)
	}),
	slots: {
		store: {
			configPath: 'store',
			contract: 'queue/job-store',
			description: 'Where jobs wait, run, and are remembered',
			known: [
				'@absolutejs/queue#memory',
				'@absolutejs/queue-postgres',
				'@absolutejs/queue-redis'
			],
			required: true
		}
	},
	tools: {
		enqueue_job: tool.runtime({
			annotations: { idempotentHint: true },
			authorization: {
				approval: 'policy',
				audience: 'admin',
				effects: ['write'],
				idempotency: { mode: 'host' },
				requiredScopes: ['queue:write'],
				resource: { type: 'queue-job' },
				reversible: false
			},
			description:
				'Add a job to the queue. `kind` must be one of the job kinds this app defines; `payload` must match that kind’s schema (invalid payloads are rejected). Use `runAtMs` to delay the job and `idempotencyKey` to dedupe repeat enqueues.',
			handler: async (
				{ idempotencyKey, kind, maxAttempts, payload, runAtMs },
				store
			) => {
				const id = await store.enqueue({
					idempotencyKey,
					kind,
					maxAttempts,
					payload,
					runAt: runAtMs
				});

				return `enqueued ${kind} as ${id}`;
			},
			input: Type.Object({
				idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
				kind: Type.String({ minLength: 1 }),
				maxAttempts: Type.Optional(
					Type.Integer({ maximum: MAX_ATTEMPTS_CEILING, minimum: 1 })
				),
				payload: Type.Record(Type.String(), Type.Unknown()),
				runAtMs: Type.Optional(
					Type.Integer({
						description:
							'Unix epoch milliseconds to run at. Omit to run as soon as possible.',
						minimum: 0
					})
				)
			})
		}),
		job_stats: tool.runtime({
			annotations: { readOnlyHint: true },
			authorization: {
				approval: 'never',
				audience: 'admin',
				effects: ['read'],
				requiredScopes: ['queue:read']
			},
			description:
				'Count jobs by status (pending, claimed, done, dead, canceled). Not every store supports counting.',
			handler: async (_input, store) =>
				store.countByStatus
					? JSON.stringify(await store.countByStatus())
					: 'this job store does not support status counts',
			input: Type.Object({})
		}),
		list_jobs: tool.runtime({
			annotations: { readOnlyHint: true },
			authorization: {
				approval: 'never',
				audience: 'admin',
				effects: ['read'],
				requiredScopes: ['queue:read']
			},
			description:
				'List jobs, optionally filtered by kind and/or status. Not every store supports listing.',
			handler: async ({ kind, limit, status }, store) => {
				if (!store.list)
					return 'this job store does not support listing jobs';

				return JSON.stringify(
					await store.list({ kind, limit, status })
				);
			},
			input: Type.Object({
				kind: Type.Optional(Type.String({ minLength: 1 })),
				limit: Type.Optional(
					Type.Integer({ maximum: MAX_LIST_LIMIT, minimum: 1 })
				),
				status: Type.Optional(
					Type.Union([
						Type.Literal('canceled'),
						Type.Literal('claimed'),
						Type.Literal('dead'),
						Type.Literal('done'),
						Type.Literal('pending')
					])
				)
			})
		}),
		retry_job: tool.runtime({
			annotations: { idempotentHint: true },
			authorization: {
				approval: 'policy',
				audience: 'admin',
				effects: ['write'],
				idempotency: { mode: 'resource' },
				requiredScopes: ['queue:write'],
				resource: { idField: 'id', type: 'queue-job' },
				reversible: false
			},
			description:
				'Re-run one failed or dead-lettered job by id. Returns whether the job was requeued. Not every store supports retrying.',
			handler: async ({ id }, store) => {
				if (!store.retry)
					return 'this job store does not support retrying jobs';

				return (await store.retry(id as JobId))
					? `retried job ${id}`
					: `job ${id} not found or not retryable`;
			},
			input: Type.Object({ id: Type.String({ minLength: 1 }) })
		})
	},
	wiring: [
		{
			description:
				'Define job kinds and handlers, pick a store, and mount the queue plugin — the in-process worker starts with your server.',
			id: 'default',
			server: {
				code: [
					'// defineJobs is the single source of truth: payload types are',
					'// inferred from these schemas and validated at enqueue and dequeue.',
					'const jobs = defineJobs({',
					'\t// TODO: replace the example kind with your real jobs.',
					"\t'email.send': t.Object({ subject: t.String(), to: t.String() })",
					'});',
					'',
					"const registry = createJobRegistry(jobs).on('email.send', async (payload) => {",
					'\t// TODO: do the work for this job kind.',
					'});',
					'',
					'const jobStore = ${slot.store};',
					'',
					'// Mount with .use(backgroundJobs); enqueue via the `queue` decorator.',
					'const backgroundJobs = queue({ concurrency: ${settings.concurrency}, registry, runWorker: ${settings.runWorker}, store: jobStore });'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/queue',
						names: ['createJobRegistry', 'defineJobs', 'queue', 't']
					}
				],
				placement: 'module-scope'
			},
			title: 'Define jobs and start the queue'
		},
		{
			description:
				'Control-plane side: durable per-tenant schedules that poke idle-killed tenants awake, so a tenant cron still fires when its process is asleep. The wake action is yours — an HTTP poke (httpWake) or runtime.ensure(tenant).',
			id: 'wake-scheduler',
			server: {
				code: [
					'// Runs on the CONTROL PLANE (always-on), not in tenant processes.',
					'const wakeScheduler = createWakeScheduler({',
					'\tentries: [',
					'\t\t// TODO: one entry per tenant schedule — `every` (ms) or a 5-field UTC cron.',
					"\t\t{ every: 21_600_000, id: 'acme-cron', tenant: 'acme', url: 'https://acme.internal/wake' }",
					'\t],',
					'\twake: httpWake()',
					'});',
					'wakeScheduler.start();'
				].join('\n'),
				imports: [
					{
						from: '@absolutejs/queue',
						names: ['createWakeScheduler', 'httpWake']
					}
				],
				placement: 'module-scope'
			},
			title: 'Wake idle tenants on a schedule'
		}
	]
});
