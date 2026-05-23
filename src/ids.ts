import type { JobId } from './types';

export const createJobId = (): JobId => crypto.randomUUID();
