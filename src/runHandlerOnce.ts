import { createJobId } from './ids';
import type { JobContext, JobMap, JobRegistry } from './types';
import {
	assertValidPayload,
	compileJobValidators,
	type JobValidators
} from './validation';

export type RunHandlerOnceOptions<
	Jobs extends JobMap,
	Kind extends keyof Jobs
> = {
	// Pre-compiled validators to skip the per-call compile. Use this if you're
	// calling runHandlerOnce in a hot loop; otherwise the default behaviour
	// (validator inferred from the registry's schema, compiled lazily) is fine.
	// Pass `false` to skip payload validation entirely.
	validators?: JobValidators | false;
	// Override pieces of the synthetic JobContext. Defaults: id = randomUUID,
	// attempts = 1, maxAttempts = 1, signal = never-aborted. The handler
	// almost never reads these, but the type still requires them.
	context?: Partial<JobContext<Jobs, Kind>>;
};

// Invoke a registered handler once, without spinning up the worker or the
// queue plugin. Useful for:
//   1. Manual one-shot triggers (e.g. `bun scripts/run-x.ts` wrappers around
//      the same logic the cron drives) — avoids the worker keep-alive that
//      hangs a one-shot script.
//   2. Unit tests of handler logic.
//   3. Backfills or admin re-runs of a job that already happened.
//
// Validates the payload through the registry's schema (unless validators=false)
// so the same contract as enqueue/dequeue applies.
export const runHandlerOnce = async <
	Jobs extends JobMap,
	Kind extends keyof Jobs
>(
	registry: JobRegistry<Jobs>,
	kind: Kind,
	payload: Jobs[Kind],
	options: RunHandlerOnceOptions<Jobs, Kind> = {}
): Promise<void> => {
	const handler = registry.getHandler(kind);
	if (!handler) {
		throw new Error(`No handler registered for job kind "${String(kind)}"`);
	}

	if (options.validators !== false) {
		const validators =
			options.validators ??
			compileJobValidators(
				Object.fromEntries(
					registry.kinds().flatMap((k) => {
						const schema = registry.getSchema(k);

						return schema ? [[String(k), schema]] : [];
					})
				)
			);
		const validator = validators.get(String(kind));
		assertValidPayload(validator, String(kind), payload);
	}

	const context: JobContext<Jobs, Kind> = {
		attempts: 1,
		id: createJobId(),
		kind,
		maxAttempts: 1,
		signal: new AbortController().signal,
		...options.context
	};

	await handler(payload, context);
};
