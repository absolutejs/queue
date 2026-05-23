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
