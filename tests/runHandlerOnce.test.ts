import { Type as t } from '@sinclair/typebox';
import { describe, expect, it } from 'bun:test';
import { defineJobs } from '../src/defineJobs';
import { createJobRegistry } from '../src/registry';
import { runHandlerOnce } from '../src/runHandlerOnce';
import { QueuePayloadValidationError } from '../src/validation';

const jobs = defineJobs({
	greet: t.Object({ name: t.String() }),
	add: t.Object({ left: t.Number(), right: t.Number() })
});

describe('runHandlerOnce', () => {
	it('invokes the registered handler with the payload', async () => {
		const seen: string[] = [];
		const registry = createJobRegistry(jobs).on('greet', ({ name }) => {
			seen.push(name);
		});

		await runHandlerOnce(registry, 'greet', { name: 'alice' });

		expect(seen).toEqual(['alice']);
	});

	it('passes a synthetic JobContext to the handler', async () => {
		let observed: { id?: string; kind?: string } = {};
		const registry = createJobRegistry(jobs).on(
			'greet',
			(_, { id, kind }) => {
				observed = { id, kind };
			}
		);

		await runHandlerOnce(registry, 'greet', { name: 'bob' });

		expect(observed.kind).toBe('greet');
		// crypto.randomUUID() emits a v4 UUID
		expect(observed.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('respects context overrides', async () => {
		let attempts = 0;
		const registry = createJobRegistry(jobs).on('greet', (_, ctx) => {
			attempts = ctx.attempts;
		});

		await runHandlerOnce(
			registry,
			'greet',
			{ name: 'cara' },
			{ context: { attempts: 7 } }
		);

		expect(attempts).toBe(7);
	});

	it('throws when no handler is registered for the kind', async () => {
		const registry = createJobRegistry(jobs);

		await expect(
			runHandlerOnce(registry, 'greet', { name: 'x' })
		).rejects.toThrow(/no handler registered/i);
	});

	it('validates the payload through the registry schema', async () => {
		const registry = createJobRegistry(jobs).on('add', () => undefined);

		await expect(
			runHandlerOnce(
				registry,
				'add',
				// @ts-expect-error - missing `right`, caught at compile time and runtime
				{ left: 1 }
			)
		).rejects.toBeInstanceOf(QueuePayloadValidationError);
	});

	it('skips validation when validators=false', async () => {
		let calls = 0;
		const registry = createJobRegistry(jobs).on('add', () => {
			calls += 1;
		});

		await runHandlerOnce(
			registry,
			'add',
			// @ts-expect-error - intentionally bypassing validation
			{ left: 1 },
			{ validators: false }
		);

		expect(calls).toBe(1);
	});
});
