/**
 * The Job capability: how a dispatched Worker learns which Job it *is*.
 *
 * A Worker is a separate Pi process, so it cannot be told about itself through
 * any shared object. Two mechanisms carry the identity, and neither is prompt
 * text:
 *
 *   spawn time  the Orchestrator appends {@link CAPABILITY_FLAG} to the Worker's
 *               Pi launch arguments. Pi's argument parser accepts the flag only
 *               because this extension registers it, and the Worker reads the
 *               value back from its own `argv`.
 *   first use   the capability is persisted as a session entry, so a resumed or
 *               compacted session still knows its Job without re-reading argv.
 *
 * Nothing here is model-visible: the model is never taught the flag's syntax, the
 * token, or the spool path, so a Worker cannot fabricate a claim for a Job it
 * does not hold, and an Orchestrator session simply has no capability at all.
 * That absence is the test for "is this session a Worker".
 *
 * The value is base64url-encoded JSON in one argument. A Single opaque argument
 * survives shells, spaces in paths, and Herdr's own argument passing without
 * quoting rules mattering — the encoding is about transport safety, not secrecy.
 */

import { opaqueId } from './ids.ts';

/** The Pi launch flag carrying a Job capability. Registered, never documented to the model. */
export const CAPABILITY_FLAG = 'pi-herdr-enhanced-job';

/** The session entry type a capability is persisted under, once something needs it. */
export const CAPABILITY_ENTRY_TYPE = 'pi-herdr-enhanced-job-capability';

/** Everything a Worker needs to act as one Job and nothing else. */
export interface JobCapability {
	/** The Job name, as the Orchestrator knows it. */
	readonly name: string;
	/** The Ticket or scope reference behind the Job. */
	readonly ticket: string;
	/** Per-Job secret. Names the claim file and authorizes its own Job's records. */
	readonly token: string;
	/** The run scope the Job belongs to. */
	readonly scope: string;
	/** Absolute spool directory the claim and progress files travel through. */
	readonly spoolPath: string;
}

/** A fresh capability for a Job about to be dispatched. */
export function newCapability(input: { readonly name: string; readonly ticket: string; readonly scope: string; readonly spoolPath: string }): JobCapability {
	return { ...input, token: opaqueId('job-') };
}

/** The additional Pi arguments that hand this capability to a Worker process. */
export function capabilityArgs(capability: JobCapability): readonly string[] {
	return [`--${CAPABILITY_FLAG}`, encodeCapability(capability)];
}

/** One opaque argument encoding a capability. */
export function encodeCapability(capability: JobCapability): string {
	return Buffer.from(JSON.stringify(capability), 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseCapability(value: unknown): JobCapability | undefined {
	if (!isRecord(value)) return undefined;
	const { name, ticket, token, scope, spoolPath } = value;
	for (const field of [name, ticket, token, scope, spoolPath]) {
		if (typeof field !== 'string' || field.length === 0) return undefined;
	}
	return { name: name as string, ticket: ticket as string, token: token as string, scope: scope as string, spoolPath: spoolPath as string };
}

/**
 * Decode a capability argument.
 *
 * A malformed or unknown value yields `undefined` rather than a partial
 * capability: a Worker whose identity cannot be read in full must behave like an
 * Orchestrator (no claim, no progress) rather than claim a Job it only half
 * matches.
 */
export function decodeCapability(encoded: string): JobCapability | undefined {
	let json: string;
	try {
		json = Buffer.from(encoded, 'base64url').toString('utf8');
	} catch {
		return undefined;
	}
	try {
		return parseCapability(JSON.parse(json));
	} catch {
		return undefined;
	}
}

/**
 * The capability this process was started with, read from its own `argv`.
 *
 * `--flag value` and `--flag=value` are both accepted because Pi's own flag
 * handling has varied between them.
 */
export function capabilityFromArgv(argv: readonly string[]): JobCapability | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === `--${CAPABILITY_FLAG}`) {
			const value = argv[index + 1];
			if (typeof value === 'string') return decodeCapability(value);
			return undefined;
		}
		if (typeof argument === 'string' && argument.startsWith(`--${CAPABILITY_FLAG}=`)) {
			return decodeCapability(argument.slice(CAPABILITY_FLAG.length + 3));
		}
	}
	return undefined;
}

/**
 * The capability persisted in the session, if any.
 *
 * Session entries are read defensively: this is Pi's own storage shape, and the
 * extension must keep working when it carries fields it does not know about.
 */
export function capabilityFromEntries(entries: readonly unknown[]): JobCapability | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		if (entry.type !== 'custom' && entry.customType !== CAPABILITY_ENTRY_TYPE) continue;
		const data = entry.customType === CAPABILITY_ENTRY_TYPE ? entry.data : entry.data;
		const parsed = parseCapability(data);
		if (parsed) return parsed;
	}
	return undefined;
}

/**
 * This session's capability, resolved once and persisted on first use.
 *
 * Resolution order is session entries first, then `argv`: a session that has
 * already recorded its Job keeps that identity even if it was resumed with
 * different arguments, and only a fresh process falls back to what it was
 * spawned with. The first successful resolution is appended so later reads do
 * not depend on `argv` — which a resumed session may not have at all.
 *
 * An Orchestrator session resolves to `undefined` and caches that, so it never
 * writes a capability entry.
 */
export function makeSessionCapability(
	appendEntry: (customType: string, data?: unknown) => void,
	argv: readonly string[] = process.argv,
): (ctx: unknown) => JobCapability | undefined {
	let cached: JobCapability | 'none' | undefined;
	return (ctx: unknown): JobCapability | undefined => {
		if (cached === 'none') return undefined;
		if (cached) return cached;
		const entries = readEntries(ctx);
		const found = capabilityFromEntries(entries) ?? capabilityFromArgv(argv);
		if (!found) {
			cached = 'none';
			return undefined;
		}
		cached = found;
		appendEntry(CAPABILITY_ENTRY_TYPE, found);
		return found;
	};
}

function readEntries(ctx: unknown): readonly unknown[] {
	if (!isRecord(ctx)) return [];
	const manager = ctx.sessionManager;
	if (!isRecord(manager) || typeof manager.getEntries !== 'function') return [];
	try {
		const entries = (manager.getEntries as () => unknown)();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
}

/**
 * True when the given arguments belong to a dispatched Worker.
 *
 * Used where an entry may not be readable yet — notably the very first tool call
 * of a Worker that has not persisted anything — so the Worker-only refusals do
 * not depend on a write having happened.
 */
export function isWorkerArgv(argv: readonly string[] = process.argv): boolean {
	return capabilityFromArgv(argv) !== undefined;
}
