import type { JobDefinition } from './types';

// Define a job map once: kind -> payload schema. The single source of truth for
// payload types (inferred) and runtime validation. Build the schemas with `t`
// re-exported from this package so they share one TypeBox instance. Pass the
// result to createJobRegistry and to your store factory.
export const defineJobs = <const Def extends JobDefinition>(definition: Def) =>
	definition;
