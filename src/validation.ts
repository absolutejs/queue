import type { TSchema } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import type { JobDefinition } from './types';

export type JobValidators = Map<string, TypeCheck<TSchema>>;

export class QueuePayloadValidationError extends Error {
	readonly issues: string[];
	readonly kind: string;

	constructor(kind: string, issues: string[]) {
		super(`Invalid payload for job "${kind}": ${issues.join('; ')}`);
		this.name = 'QueuePayloadValidationError';
		this.issues = issues;
		this.kind = kind;
	}
}

/**
 * Thrown when a handler exceeds its configured `handlerTimeoutMs`. The worker
 * aborts the handler's `signal` and fails the job through the normal retry /
 * dead-letter path, so a hung handler frees its worker slot instead of holding
 * it for the full lease (the classic "stuck spinner" cause).
 */
export class QueueHandlerTimeoutError extends Error {
	readonly kind: string;
	readonly timeoutMs: number;

	constructor(kind: string, timeoutMs: number) {
		super(`Handler for job "${kind}" timed out after ${timeoutMs}ms`);
		this.name = 'QueueHandlerTimeoutError';
		this.kind = kind;
		this.timeoutMs = timeoutMs;
	}
}

// Compile one validator per kind up front (cheap to reuse, costly to redo).
export const compileJobValidators = (
	definition: JobDefinition
): JobValidators => {
	const validators: JobValidators = new Map();
	for (const kind of Object.keys(definition)) {
		const schema = definition[kind];
		if (schema) validators.set(kind, TypeCompiler.Compile(schema));
	}

	return validators;
};

export const collectPayloadIssues = (
	validator: TypeCheck<TSchema> | undefined,
	payload: unknown
): string[] | null => {
	if (!validator || validator.Check(payload)) return null;

	return [...validator.Errors(payload)].map(
		(error) => `${error.path || '/'} ${error.message}`
	);
};

export const assertValidPayload = (
	validator: TypeCheck<TSchema> | undefined,
	kind: string,
	payload: unknown
) => {
	const issues = collectPayloadIssues(validator, payload);
	if (issues) throw new QueuePayloadValidationError(kind, issues);
};
