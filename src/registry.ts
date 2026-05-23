import type { JobHandler, JobMap, JobRegistry } from './types';

export const createJobRegistry = <Jobs extends JobMap>(): JobRegistry<Jobs> => {
	const handlers = new Map<keyof Jobs, JobHandler<Jobs, keyof Jobs>>();

	const registry: JobRegistry<Jobs> = {
		getHandler: (kind) =>
			handlers.get(kind) as JobHandler<Jobs, typeof kind> | undefined,
		kinds: () => [...handlers.keys()],
		on: (kind, handler) => {
			handlers.set(kind, handler as JobHandler<Jobs, keyof Jobs>);

			return registry;
		}
	};

	return registry;
};
