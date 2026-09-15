import type { Change } from '@absolutejs/changelog';
export const change: Change = {
	kind: 'added',
	summary:
		'Add atomic claim-fenced completion and failure, unique in-memory claim tokens and a strict worker capability gate so expired attempts cannot overwrite newer jobs',
	symbols: [
		'JobStore',
		'JobContext',
		'createQueueWorker',
		'createInMemoryJobStore'
	]
};
