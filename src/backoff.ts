import {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_FACTOR,
	DEFAULT_BACKOFF_MAX_MS
} from './constants';
import type { BackoffStrategy } from './types';

export type ExponentialBackoffOptions = {
	baseMs?: number;
	factor?: number;
	maxMs?: number;
};

// `attempt` is 1-based: the first retry passes attempt = 1.
export const exponentialBackoff = ({
	baseMs = DEFAULT_BACKOFF_BASE_MS,
	factor = DEFAULT_BACKOFF_FACTOR,
	maxMs = DEFAULT_BACKOFF_MAX_MS
}: ExponentialBackoffOptions = {}): BackoffStrategy => {
	return (attempt) => {
		const delay = baseMs * factor ** Math.max(attempt - 1, 0);
		return Math.min(delay, maxMs);
	};
};
