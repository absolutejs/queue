import { t } from 'elysia';
import { describe, expect, test } from 'bun:test';
import {
	assertValidPayload,
	compileJobValidators,
	QueuePayloadValidationError
} from '../src/validation';

describe('queue payload validation', () => {
	test('supports TypeBox UUID formats for typed job payloads', () => {
		const validators = compileJobValidators({
			'notification.deliver': t.Object({
				deliveryId: t.String({ format: 'uuid' })
			})
		});

		expect(() =>
			assertValidPayload(
				validators.get('notification.deliver'),
				'notification.deliver',
				{ deliveryId: crypto.randomUUID() }
			)
		).not.toThrow();
		expect(() =>
			assertValidPayload(
				validators.get('notification.deliver'),
				'notification.deliver',
				{ deliveryId: 'not-a-uuid' }
			)
		).toThrow(QueuePayloadValidationError);
	});
});
