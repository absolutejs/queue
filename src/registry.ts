import type {
	JobDefinition,
	JobHandler,
	JobMapFromDefinition,
	JobRegistry
} from './types';

export const createJobRegistry = <const Def extends JobDefinition>(
	definition: Def
): JobRegistry<JobMapFromDefinition<Def>> => {
	type Jobs = JobMapFromDefinition<Def>;
	const handlers = new Map<keyof Jobs, JobHandler<Jobs, keyof Jobs>>();

	const registry: JobRegistry<Jobs> = {
		getHandler: (kind) =>
			handlers.get(kind) as JobHandler<Jobs, typeof kind> | undefined,
		getSchema: (kind) => definition[kind as keyof Def],
		kinds: () => Object.keys(definition) as (keyof Jobs)[],
		on: (kind, handler) => {
			handlers.set(kind, handler as JobHandler<Jobs, keyof Jobs>);

			return registry;
		}
	};

	return registry;
};
