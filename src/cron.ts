/**
 * Minimal in-repo 5-field cron parser — no cron dependency.
 *
 * Grammar: `minute hour day-of-month month day-of-week`, evaluated in UTC
 * with minute granularity. Each field supports `*`, single numbers, comma
 * lists (`0,30`), ranges (`9-17`), and `/n` steps on `*` or a range
 * (`0-30/10`). Day-of-week is `0-7` where both `0` and `7` mean Sunday.
 * Standard cron day semantics apply: when BOTH day-of-month and day-of-week
 * are restricted (not `*`), a match on either fires.
 *
 * Deliberately NOT supported (document the limits, keep the parser small):
 * names (`JAN`, `MON`), `L` / `W` / `#` extensions, `@hourly`-style macros,
 * a seconds field, steps on a bare number (`5/2`), and time zones other
 * than UTC.
 */
export type CronExpression = {
	daysOfMonth: ReadonlySet<number>;
	daysOfWeek: ReadonlySet<number>;
	/** `true` when the day-of-month field was not `*` (drives OR semantics). */
	domRestricted: boolean;
	/** `true` when the day-of-week field was not `*` (drives OR semantics). */
	dowRestricted: boolean;
	hours: ReadonlySet<number>;
	minutes: ReadonlySet<number>;
	months: ReadonlySet<number>;
	/** The original expression, kept for error messages and snapshots. */
	source: string;
};

const CRON_FIELD_COUNT = 5;
const SUNDAY_ALIAS = 7;

type FieldBounds = { max: number; min: number; name: string };

const FIELD_BOUNDS: readonly [
	FieldBounds,
	FieldBounds,
	FieldBounds,
	FieldBounds,
	FieldBounds
] = [
	{ max: 59, min: 0, name: 'minute' },
	{ max: 23, min: 0, name: 'hour' },
	{ max: 31, min: 1, name: 'day-of-month' },
	{ max: 12, min: 1, name: 'month' },
	{ max: SUNDAY_ALIAS, min: 0, name: 'day-of-week' }
];

// One comma-separated part: `*`, `a`, `a-b`, optionally followed by `/step`.
const PART_PATTERN = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

const parseField = (
	source: string,
	field: string,
	{ max, min, name }: FieldBounds
): Set<number> => {
	const invalid = (reason: string) =>
		new Error(
			`Invalid cron expression "${source}": ${name} field — ${reason}`
		);
	const values = new Set<number>();
	for (const part of field.split(',')) {
		const match = PART_PATTERN.exec(part);
		if (!match) throw invalid(`unparseable part "${part}"`);
		const [, fromRaw, toRaw, stepRaw] = match;
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (step < 1) throw invalid(`step must be >= 1 in "${part}"`);
		if (
			stepRaw !== undefined &&
			fromRaw !== undefined &&
			toRaw === undefined
		)
			throw invalid(`steps need "*" or a range, got "${part}"`);
		const from = fromRaw === undefined ? min : Number(fromRaw);
		const to =
			toRaw !== undefined
				? Number(toRaw)
				: fromRaw === undefined
					? max
					: from;
		if (from < min || to > max)
			throw invalid(`"${part}" is outside ${min}-${max}`);
		if (from > to) throw invalid(`range "${part}" is inverted`);
		for (let value = from; value <= to; value += step) values.add(value);
	}
	// Cron convention: day-of-week 7 is an alias for Sunday (0).
	if (name === 'day-of-week' && values.delete(SUNDAY_ALIAS)) values.add(0);

	return values;
};

export const parseCronExpression = (source: string): CronExpression => {
	const fields = source.trim().split(/\s+/);
	if (fields.length !== CRON_FIELD_COUNT)
		throw new Error(
			`Invalid cron expression "${source}": expected ${CRON_FIELD_COUNT} fields ` +
				`(minute hour day-of-month month day-of-week), got ${fields.length}`
		);
	const [
		minuteField = '',
		hourField = '',
		dayOfMonthField = '',
		monthField = '',
		dayOfWeekField = ''
	] = fields;
	const [minuteBounds, hourBounds, domBounds, monthBounds, dowBounds] =
		FIELD_BOUNDS;

	return {
		daysOfMonth: parseField(source, dayOfMonthField, domBounds),
		daysOfWeek: parseField(source, dayOfWeekField, dowBounds),
		domRestricted: dayOfMonthField !== '*',
		dowRestricted: dayOfWeekField !== '*',
		hours: parseField(source, hourField, hourBounds),
		minutes: parseField(source, minuteField, minuteBounds),
		months: parseField(source, monthField, monthBounds),
		source
	};
};

/**
 * Does the expression match the UTC minute containing `timestampMs`?
 * Seconds within the minute are ignored — cron has minute granularity.
 */
export const cronMatchesMinute = (
	expression: CronExpression,
	timestampMs: number
): boolean => {
	const date = new Date(timestampMs);
	if (!expression.minutes.has(date.getUTCMinutes())) return false;
	if (!expression.hours.has(date.getUTCHours())) return false;
	if (!expression.months.has(date.getUTCMonth() + 1)) return false;

	const domMatch = expression.daysOfMonth.has(date.getUTCDate());
	const dowMatch = expression.daysOfWeek.has(date.getUTCDay());

	// Standard cron day semantics: when both day fields are restricted,
	// either matching fires; otherwise the unrestricted field is always true
	// so this reduces to the restricted one (or `true && true`).
	return expression.domRestricted && expression.dowRestricted
		? domMatch || dowMatch
		: domMatch && dowMatch;
};
