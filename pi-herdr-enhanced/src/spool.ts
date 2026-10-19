/**
 * The cross-process file channel: a Worker's Completion claim, and its
 * content-free activity observation.
 *
 * A Worker and its Orchestrator share no memory, so the two facts a Worker must
 * report travel as files in one owner-only spool directory:
 *
 *   `claim-<token>.json`     "my bounded work is concluded"
 *   `progress-<token>.json`  "I was active at this instant" (identity + time only)
 *
 * The discipline is borrowed from `pi-peer` and kept deliberately narrow: create
 * the directory owner-only, verify it before every read and write, write to a
 * temp name and rename into place so a reader never sees a partial record, bound
 * every record's size, and sweep stale files on a TTL. A claim is a **routing
 * signal** that requests reconciliation — never proof of success, and never a
 * durable record — so it may expire, and the watch's own status fallback still
 * wakes the Orchestrator for a Job that never claimed.
 *
 * Authentication is the capability token: the file's name carries it, and the
 * consumer applies a record only when every identity field matches the Job that
 * token belongs to. One Worker can therefore never update another Job's
 * activity, and a file with an unknown token is ignored rather than trusted.
 *
 * The progress record is deliberately almost empty. It carries a Job's identity
 * and one timestamp — never conversation, tool arguments, or tool output — so
 * no session content crosses into a second channel while the evidence the watch
 * needs (is this Job's activity observable?) still arrives.
 *
 * This module holds no Pi imports and no timers: `now` is injected, so the TTL
 * sweep and the streaming rate limit are exercised directly by the suite.
 */

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now as realNow, opaqueId, type Clock } from './ids.ts';

/** A claim file's final name always starts with this, so a temp name is never read. */
export const CLAIM_PREFIX = 'claim-';
/** A progress file's final name always starts with this. */
export const PROGRESS_PREFIX = 'progress-';
const SUFFIX = '.json';
/** The in-progress name a record is written under before its atomic rename. */
const TEMP_PREFIX = '.tmp-';

/** The largest record the consumer will read. The schemas are a few small fields. */
export const MAX_RECORD_BYTES = 8 * 1024;

/**
 * How long a claim file may sit unread before it is swept.
 *
 * A claim is a routing signal, and the watch reports any Job that never claimed
 * on its own, so a stale file is discarded rather than honoured late — a claim
 * that arrives after the Orchestrator already reconciled its Job would otherwise
 * request a second reconciliation for work nobody is waiting on.
 */
export const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60_000;

/** How long an activity observation is useful. */
export const DEFAULT_PROGRESS_TTL_MS = 6 * 60 * 60_000;

/**
 * The streaming rate limit for progress writes.
 *
 * A Worker that streams a long answer emits an update per token; the watch needs
 * to know *that* activity happened, not how fast. One write every few seconds is
 * the same evidence at a fraction of the syscalls.
 */
export const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 5_000;

/** One Worker declaration of concluded work, as it travels on disk. */
export interface ClaimRecord {
	readonly name: string;
	readonly ticket: string;
	readonly scope: string;
	readonly token: string;
	readonly claimedAt: number;
}

/** One content-free activity observation. */
export interface ProgressRecord {
	readonly name: string;
	readonly ticket: string;
	readonly token: string;
	readonly observedAt: number;
}

/** Raised when the spool directory is not the owner-only directory it must be. */
export class SpoolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SpoolError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Create the spool directory if it does not exist, and refuse it if it is not
 * owner-only.
 *
 * A world-writable directory beside a channel that authenticates on a token
 * would let any local process inject a claim or read one, so the mode is checked
 * rather than assumed — and creation is the only path that sets it.
 */
export function ensureSpool(dir: string): void {
	try {
		const existing = lstatSync(dir);
		if (!existing.isDirectory()) throw new SpoolError(`the spool path ${dir} exists and is not a directory`);
		assertOwnerOnly(dir, existing.mode);
		return;
	} catch (error) {
		if (error instanceof SpoolError) throw error;
		const code = isRecord(error) ? error.code : undefined;
		if (code !== 'ENOENT') {
			throw new SpoolError(`could not inspect the spool directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	assertOwnerOnly(dir, statSync(dir).mode);
}

/** Verify an existing spool directory without creating it. */
/**
 * Whether a spool directory is there at all.
 *
 * "Not there yet" is a normal state rather than a fault: the spool is created by
 * the first `job open` that needs it, so every Run scope is without one until it
 * has its first Job. This answers *only* that question, and deliberately reports
 * anything it cannot inspect as present, so a real fault still reaches
 * `verifySpool` and is reported as one.
 */
export function spoolExists(dir: string): boolean {
	try {
		lstatSync(dir);
		return true;
	} catch (error) {
		return !(isRecord(error) && error.code === 'ENOENT');
	}
}

export function verifySpool(dir: string): void {
	let stats;
	try {
		stats = lstatSync(dir);
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === 'ENOENT') throw new SpoolError(`the spool directory ${dir} does not exist`);
		throw new SpoolError(`could not inspect the spool directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!stats.isDirectory()) throw new SpoolError(`the spool path ${dir} is not a directory`);
	assertOwnerOnly(dir, stats.mode);
}

function assertOwnerOnly(dir: string, mode: number): void {
	const group = mode & 0o077;
	if (group !== 0) {
		throw new SpoolError(
			`the spool directory ${dir} is accessible to group or other (mode ${(mode & 0o777).toString(8)}); it must be owner-only. ` +
				'Refusing to read or write claims through it.',
		);
	}
}

function tempName(dir: string, prefix: string): string {
	return join(dir, `${TEMP_PREFIX}${prefix}${opaqueId()}`);
}

/**
 * Write one record atomically under its final name.
 *
 * The temp name starts with a dot and never matches either prefix, so a reader
 * that filters by prefix can never observe a half-written record, however
 * unlucky its timing.
 */
function writeRecord(dir: string, prefix: string, token: string, payload: unknown): string {
	ensureSpool(dir);
	const body = JSON.stringify(payload);
	if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
		throw new SpoolError(`the record exceeds the ${MAX_RECORD_BYTES}-byte bound; refusing to write it`);
	}
	const temp = tempName(dir, prefix);
	const final = join(dir, `${prefix}${token}${SUFFIX}`);
	writeFileSync(temp, body, { mode: 0o600 });
	renameSync(temp, final);
	return final;
}

/**
 * Read one record, bounded on the consumer's side.
 *
 * The byte bound is applied to the read, not only to the writer, so a file that
 * grew past the bound by some other hand never becomes this process's
 * allocation.
 */
function readRecord(path: string): unknown {
	const fd = openSync(path, 'r');
	try {
		const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		if (read > MAX_RECORD_BYTES) return undefined;
		const text = buffer.subarray(0, read).toString('utf8');
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	} finally {
		closeSync(fd);
	}
}

function listRecords(dir: string, prefix: string): readonly string[] {
	let entries: readonly string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((name) => name.startsWith(prefix) && name.endsWith(SUFFIX) && !name.startsWith(TEMP_PREFIX))
		.map((name) => join(dir, name))
		.sort();
}

/** Remove one record; a file already gone is the state the caller wanted. */
function removeRecord(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Removal is best-effort: the TTL sweep will try again, and a record that
		// outlives its read is ignored by the next consumer.
	}
}

// ---------------------------------------------------------------------------
// Completion claims
// ---------------------------------------------------------------------------

/** Write a Worker's Completion claim. Returns the file it landed in. */
export function writeClaim(dir: string, claim: ClaimRecord): string {
	return writeRecord(dir, CLAIM_PREFIX, claim.token, claim);
}

function parseClaim(value: unknown): ClaimRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { name, ticket, scope, token, claimedAt } = value;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	if (typeof ticket !== 'string') return undefined;
	if (typeof scope !== 'string') return undefined;
	if (typeof token !== 'string' || token.length === 0) return undefined;
	if (typeof claimedAt !== 'number' || !Number.isFinite(claimedAt)) return undefined;
	return { name, ticket, scope, token, claimedAt };
}

/**
 * Every readable claim file, oldest first.
 *
 * A claim whose bytes do not parse as its schema is discarded rather than
 * guessed at: a malformed claim must never be read as a claim by some other Job.
 */
export function readClaims(dir: string, ttlMs: number = DEFAULT_CLAIM_TTL_MS, clock: Clock = realNow): readonly (ClaimRecord & { readonly path: string })[] {
	const at = clock();
	const claims: (ClaimRecord & { readonly path: string })[] = [];
	for (const path of listRecords(dir, CLAIM_PREFIX)) {
		const parsed = parseClaim(readRecord(path));
		if (!parsed) {
			removeRecord(path);
			continue;
		}
		if (at - parsed.claimedAt > ttlMs) {
			removeRecord(path);
			continue;
		}
		claims.push({ ...parsed, path });
	}
	return claims.sort((left, right) => left.claimedAt - right.claimedAt);
}

/**
 * Consume the claim belonging to one Job, once.
 *
 * The token is the whole authorization: a file named for a different Job, or
 * carrying a different token, is left alone — it belongs to somebody else. The
 * file is removed only after it has been returned, so a crash between the two
 * leaves a claim that is read again rather than one that is lost.
 */
export function consumeClaim(dir: string, token: string): ClaimRecord | undefined {
	const path = join(dir, `${CLAIM_PREFIX}${token}${SUFFIX}`);
	let parsed: ClaimRecord | undefined;
	try {
		parsed = parseClaim(readRecord(path));
	} catch {
		return undefined;
	}
	if (!parsed || parsed.token !== token) return undefined;
	removeRecord(path);
	return parsed;
}

// ---------------------------------------------------------------------------
// Progress observations
// ---------------------------------------------------------------------------

/** Write a content-free activity observation for one Job. */
export function writeProgress(dir: string, observation: ProgressRecord): string {
	return writeRecord(dir, PROGRESS_PREFIX, observation.token, observation);
}

function parseProgress(value: unknown): ProgressRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { name, ticket, token, observedAt } = value;
	if (typeof name !== 'string' || name.length === 0) return undefined;
	if (typeof ticket !== 'string') return undefined;
	if (typeof token !== 'string' || token.length === 0) return undefined;
	if (typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return undefined;
	return { name, ticket, token, observedAt };
}

/**
 * The latest observation per Job token.
 *
 * Keyed by token rather than by name so a record can only ever describe the Job
 * whose capability wrote it: a Worker cannot announce activity for a sibling.
 */
export function readProgress(
	dir: string,
	ttlMs: number = DEFAULT_PROGRESS_TTL_MS,
	clock: Clock = realNow,
): ReadonlyMap<string, ProgressRecord> {
	const at = clock();
	const byToken = new Map<string, ProgressRecord>();
	for (const path of listRecords(dir, PROGRESS_PREFIX)) {
		const parsed = parseProgress(readRecord(path));
		if (!parsed) {
			removeRecord(path);
			continue;
		}
		if (at - parsed.observedAt > ttlMs) {
			removeRecord(path);
			continue;
		}
		const existing = byToken.get(parsed.token);
		if (!existing || existing.observedAt < parsed.observedAt) byToken.set(parsed.token, parsed);
	}
	return byToken;
}

/** Remove a Job's observation file, once the Job it describes is gone. */
export function dropProgress(dir: string, token: string | undefined): void {
	if (!token) return;
	removeRecord(join(dir, `${PROGRESS_PREFIX}${token}${SUFFIX}`));
}

/** Read a file's text through the same owner-only boundary. Used by capability tests. */
export function readSpoolText(dir: string, file: string): string {
	verifySpool(dir);
	return readFileSync(join(dir, file), 'utf8');
}
