/**
 * Small shared primitives: identifiers, tokens, slugs, and the clock seam.
 *
 * Everything here is pure, so the suite can drive any timing or naming rule
 * deterministically. A `Clock` is injected wherever a timestamp matters — no
 * module in this extension reads `Date.now()` for a decision it must be able to
 * test.
 */

import { randomBytes } from 'node:crypto';

/** The source of "now" for every decision this extension makes. */
export type Clock = () => number;

/** The default clock: the real one. */
export const now: Clock = () => Date.now();

/**
 * An opaque, unguessable identifier.
 *
 * Used for Wake identities and Job capability tokens. It is never parsed: the
 * only operation on it is equality, so a correlation cannot be forged by
 * construction and a leaked identity proves nothing about the Job.
 */
export function opaqueId(prefix = ''): string {
	return `${prefix}${randomBytes(12).toString('hex')}`;
}

/**
 * A filesystem- and branch-safe slug for a Job name.
 *
 * Job names are chosen by the caller and may carry a Ticket reference, spaces,
 * or a slash; the slug is what reaches a branch name or a directory, so
 * everything outside `[A-Za-z0-9._-]` collapses to a single `-`.
 */
export function slug(value: string): string {
	const collapsed = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return collapsed.length > 0 ? collapsed.slice(0, 80) : 'job';
}

/** True for a non-empty string, i.e. a value worth using. */
export function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/** A positive, finite integer, or `undefined` for anything else. */
export function positiveInt(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	if (!Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

/** A positive, finite duration in milliseconds, or `undefined`. */
export function positiveMs(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

/** An ISO timestamp for a recorded fact. */
export function iso(at: number): string {
	return new Date(at).toISOString();
}

/**
 * The error text of an unknown thrown value, never empty.
 *
 * Every refusal this extension writes is read by a model that must decide what
 * to do next, so a thrown non-Error (a string, a rejected object) must not
 * become the literal "undefined" in a refusal message.
 */
export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string' && error.length > 0) return error;
	try {
		const rendered = JSON.stringify(error);
		return nonEmpty(rendered) ? rendered : String(error);
	} catch {
		return String(error);
	}
}
