/** A permanent application failure. Preserves the error and ends this job immediately. */
export class NonRetryableJobError extends Error {
	readonly name = 'NonRetryableJobError';
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}
