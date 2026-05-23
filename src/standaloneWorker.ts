import { createQueueWorker } from './worker';
import type { CreateQueueWorkerOptions, JobMap, QueueWorker } from './types';

export type RunQueueWorkerOptions<Jobs extends JobMap> =
	CreateQueueWorkerOptions<Jobs> & {
		signals?: string[];
	};

type ProcessLike = {
	exit: (code?: number) => void;
	on: (event: string, listener: () => void) => void;
};

// Starts a worker and wires graceful shutdown on process signals. Intended for a
// standalone entrypoint scaled separately from the web server: `bun run worker.ts`.
export const runQueueWorker = <Jobs extends JobMap>({
	signals = ['SIGINT', 'SIGTERM'],
	...options
}: RunQueueWorkerOptions<Jobs>): QueueWorker => {
	const worker = createQueueWorker(options);
	worker.start();

	const runtime = (globalThis as { process?: ProcessLike }).process;
	if (runtime) {
		const shutdown = () => {
			void worker.stop().finally(() => runtime.exit(0));
		};
		for (const signal of signals) runtime.on(signal, shutdown);
	}

	return worker;
};
