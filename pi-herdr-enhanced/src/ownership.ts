/**
 * Job ownership, and the generation that fences it.
 *
 * Two questions this module answers, and nothing else:
 *
 *   1. Which Orchestrator incarnation owns this run scope? A **generation** is a
 *      monotonic integer attached to an append-only scope claim. It is not a
 *      sample count, a retry number, or a freshness counter: it means "this is
 *      the Nth Orchestrator to own this scope". Together with the claiming
 *      session's identity, PID, host and process start time it is what
 *      distinguishes *the same owner is still alive* from *a new incarnation*
 *      — which a PID alone cannot do, because PIDs are recycled.
 *
 *   2. May I act on that window? Every Job window carries an ownership record
 *      naming its scope, generation and owner. Acting on a window owned by
 *      another live owner requires an explicit takeover whose *expected* owner
 *      and generation match the ledger's latest claim exactly, after which a new
 *      claim is appended that supersedes it. Everything else fails closed.
 *
 * The ledger is a JSONL file per scope rather than a Forge journal, because this
 * extension has no Forge. Semantics are identical — append-only, strictly
 * increasing, each claim naming the generation it supersedes — and only the
 * audit strength differs. That is a deliberate trade: it keeps the decision
 * *verifiable from the file alone* without dragging in a second source of truth.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { iso, opaqueId, type Clock } from './ids.ts';

/** Positive integer generation number, e.g. 1. */
export type Generation = number;

/** The owner facts a Job window records, plus the identity of the claim behind them. */
export interface OwnershipRecord {
	readonly workspace: string;
	readonly tab: string;
	readonly pane: string;
	readonly path: string;
	readonly branch: string;
	readonly label: string;
	readonly ticket: string;
	readonly name: string;
	/** How the window was created; `tab` windows share the Orchestrator's workspace. */
	readonly mode: 'tab' | 'worktree';
	readonly project: string;
	readonly scope: string;
	readonly generation: Generation;
	readonly orchestrator: string;
	readonly pid?: number;
	readonly host?: string;
	/** From `ps -o lstart=`, so a recycled PID is not mistaken for the original owner. */
	readonly startTime?: string;
	/** Guards this owner incarnation against a same-name restart. */
	readonly nonce?: string;
	readonly claimedAt?: string;
}

/** One appended scope claim. */
export interface ScopeClaim {
	readonly scope: string;
	readonly generation: Generation;
	readonly orchestrator: string;
	readonly nonce?: string;
	readonly pid?: number;
	/** The host the claim was made on, so another machine's session is never judged dead. */
	readonly host?: string;
	/** From `ps -o lstart=`, so a recycled PID is not mistaken for the original owner. */
	readonly startTime?: string;
	readonly supersedes?: Generation;
	readonly at: number;
}

/** The identity this process claims with. */
export interface Claimant {
	readonly scope: string;
	readonly orchestrator: string;
	readonly project: string;
	readonly pid?: number;
	readonly host?: string;
	readonly startTime?: string;
	readonly nonce?: string;
}

/** How the ledger was read: incomplete or ambiguous history authorizes nothing. */
export interface ClaimHistory {
	readonly claims: readonly ScopeClaim[];
	/** Durable content was present but could not be parsed faithfully. */
	readonly incomplete: boolean;
}

/** The outcome of asking for a generation. */
export interface GenerationClaim {
	/** The generation this process owns, or the incumbent's when it does not own the scope. */
	readonly generation: Generation;
	readonly owner: string;
	/**
	 * False when another live owner holds the scope and no valid takeover was
	 * supplied. A process in this state may read and report, never mutate.
	 */
	readonly authorized: boolean;
	/** Why the request was refused, when it was. */
	readonly reason?: string;
	/**
	 * True when the scope was taken from an owner whose process is provably gone.
	 *
	 * The generation still advances — the ledger is what fences two live sessions
	 * apart — but no human evidence was required, because there is no live process
	 * to fence against and a run scope that could never be claimed again would make
	 * the extension unusable after the first session.
	 */
	readonly inherited?: boolean;
}

export type OwnerLiveness = 'observed-live' | 'dead' | 'unknown';

export type WindowOwnershipCategory = 'current-session' | 'another-live-owner' | 'unowned' | 'ownership-unknown';

export interface EvaluatedOwnership {
	readonly record?: OwnershipRecord;
	readonly liveness: OwnerLiveness;
	readonly category: WindowOwnershipCategory;
	readonly reason: string;
}

/** Explicit takeover evidence. Without all of it, another owner's window is untouchable. */
export interface TakeoverSpec {
	readonly takeover?: boolean;
	readonly expectedOwner?: string;
	readonly expectedGeneration?: Generation;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The filesystem name an owner record is stored under, derived from its pane.
 *
 * The pane, not the workspace: `tab` windows share the Orchestrator's workspace, so
 * a workspace-named record could only ever describe one of the Jobs in it. Opening
 * a second Job overwrote the first's record and closing either removed it, which
 * left the survivor looking like it had no record at all.
 */
export function ownerRecordName(pane: string): string {
	return `${pane.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
}

/** One ownership record per Job window, named by its pane. */
export function ownerRecordPath(stateDir: string, pane: string): string {
	return join(stateDir, 'owners', ownerRecordName(pane));
}

/** An owner record on disk, with the name it was stored under. */
interface OwnerFile {
	readonly name: string;
	readonly record: OwnershipRecord;
}

/** Every readable owner record on disk. A torn or foreign file describes nothing. */
function ownerFiles(stateDir: string): readonly OwnerFile[] {
	const dir = join(stateDir, 'owners');
	let names: readonly string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: OwnerFile[] = [];
	for (const name of names) {
		if (!name.endsWith('.json') || name.startsWith('.')) continue;
		try {
			const record = parseOwnership(JSON.parse(readFileSync(join(dir, name), 'utf8')));
			if (record) files.push({ name, record });
		} catch {
			// A record that cannot be read authorizes nothing, and hiding the rest behind
			// it would turn one damaged file into a blind host.
		}
	}
	return files;
}

/**
 * The separator between a family root and the incarnation number of a scope.
 *
 * A session does not own one scope but a **family** of them: `<root>#0` is the
 * first incarnation, and a concurrent resume of the same session file derives
 * `<root>#1` rather than being refused. The root is the session id, so a forked
 * or cloned session is a different family by construction, while two processes
 * resuming the same file share one. `#` can never appear in a session id, so it
 * is the one unambiguous separator a scope name may carry.
 */
export const FAMILY_SEPARATOR = '#';

/** The scope id for the k-th incarnation of a session's family. */
export function familyScope(root: string, index: number): string {
	return `${root}${FAMILY_SEPARATOR}${index}`;
}

/** A scope id split into its family root and incarnation number, or `undefined` when it is not a family member. */
export function parseScope(scope: string): { readonly root: string; readonly index: number } | undefined {
	const at = scope.lastIndexOf(FAMILY_SEPARATOR);
	if (at <= 0) return undefined;
	const digits = scope.slice(at + 1);
	if (!/^\d+$/.test(digits)) return undefined;
	return { root: scope.slice(0, at), index: Number(digits) };
}

/** The filesystem name a scope's ledger is stored under. `#` is preserved as the family separator. */
export function scopeLedgerName(scope: string): string {
	return `${scope.replace(/[^A-Za-z0-9._#-]+/g, '-')}.jsonl`;
}

/** The append-only generation ledger for one scope. */
export function scopeLedgerPath(stateDir: string, scope: string): string {
	return join(stateDir, 'scopes', scopeLedgerName(scope));
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Owner records
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseOwnership(value: unknown): OwnershipRecord | undefined {
	if (!isRecord(value)) return undefined;
	const required = ['workspace', 'tab', 'pane', 'path', 'branch', 'label', 'ticket', 'name', 'project', 'scope', 'orchestrator'] as const;
	const strings: Record<string, string> = {};
	for (const key of required) {
		const field = value[key];
		if (typeof field !== 'string') return undefined;
		strings[key] = field;
	}
	const generation = value.generation;
	if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return undefined;
	const mode = value.mode === 'worktree' ? 'worktree' : value.mode === 'tab' ? 'tab' : undefined;
	if (!mode) return undefined;
	return {
		workspace: strings.workspace as string,
		tab: strings.tab as string,
		pane: strings.pane as string,
		path: strings.path as string,
		branch: strings.branch as string,
		label: strings.label as string,
		ticket: strings.ticket as string,
		name: strings.name as string,
		mode,
		project: strings.project as string,
		scope: strings.scope as string,
		generation,
		orchestrator: strings.orchestrator as string,
		...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
		...(typeof value.host === 'string' ? { host: value.host } : {}),
		...(typeof value.startTime === 'string' ? { startTime: value.startTime } : {}),
		...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}),
		...(typeof value.claimedAt === 'string' ? { claimedAt: value.claimedAt } : {}),
	};
}

/**
 * Every window this host recorded an owner for, one entry per pane.
 *
 * A pane-named file is the current layout; anything else was written by an earlier
 * build, which named the file by workspace. Where both describe one window the
 * pane-named file wins, so an upgrade never reports a stale duplicate.
 */
export function readOwners(stateDir: string): readonly OwnershipRecord[] {
	const byPane = new Map<string, OwnershipRecord>();
	for (const { name, record } of ownerFiles(stateDir)) {
		const existing = byPane.get(record.pane);
		if (existing === undefined || name === ownerRecordName(record.pane)) byPane.set(record.pane, record);
	}
	return [...byPane.values()];
}

/** The recorded owner of a window, or `undefined` when there is no readable record. */
export function readOwner(stateDir: string, pane: string): OwnershipRecord | undefined {
	try {
		const record = parseOwnership(JSON.parse(readFileSync(ownerRecordPath(stateDir, pane), 'utf8')));
		if (record) return record;
	} catch {
		// Fall through: the record may have been written by an earlier build.
	}
	return ownerFiles(stateDir).find((file) => file.record.pane === pane)?.record;
}

/**
 * Record or replace a window's owner.
 *
 * Written through a temp name and renamed, so a reader never sees a partial
 * record — the record is what authorizes cleanup, and half of it would be worse
 * than none.
 */
export function writeOwner(stateDir: string, record: OwnershipRecord): void {
	const dir = join(stateDir, 'owners');
	ensureDir(dir);
	// One window per Job: a replacement writes a record for its new pane, and the
	// record describing the pane it replaced is retired here rather than left behind
	// as a second window for a Job that has only one. Records are matched on the
	// session that owns them as well as the name, so two sessions may use one name.
	for (const file of ownerFiles(stateDir)) {
		if (file.record.pane === record.pane) continue;
		if (file.record.name !== record.name || file.record.orchestrator !== record.orchestrator) continue;
		rmSync(join(dir, file.name), { force: true });
	}
	const temp = join(dir, `.tmp-${opaqueId()}`);
	writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
	renameSync(temp, ownerRecordPath(stateDir, record.pane));
}

/** Forget a window's owner, because the window it described is gone. */
export function removeOwner(stateDir: string, pane: string): void {
	const dir = join(stateDir, 'owners');
	rmSync(ownerRecordPath(stateDir, pane), { force: true });
	// A record an earlier build named by workspace goes with the window it describes,
	// and only that one: its siblings in the same workspace have their own records now.
	for (const file of ownerFiles(stateDir)) {
		if (file.record.pane === pane && file.name !== ownerRecordName(pane)) rmSync(join(dir, file.name), { force: true });
	}
}

/** Forget every window recorded in one workspace, for a row that is being closed whole. */
export function removeOwnersInWorkspace(stateDir: string, workspace: string): void {
	const dir = join(stateDir, 'owners');
	for (const file of ownerFiles(stateDir)) {
		if (file.record.workspace === workspace) rmSync(join(dir, file.name), { force: true });
	}
}

// ---------------------------------------------------------------------------
// The generation ledger
// ---------------------------------------------------------------------------

function parseClaim(value: unknown): ScopeClaim | undefined {
	if (!isRecord(value)) return undefined;
	const { scope, orchestrator, at } = value;
	const generation = value.generation;
	if (typeof scope !== 'string' || scope.length === 0) return undefined;
	if (typeof orchestrator !== 'string' || orchestrator.length === 0) return undefined;
	if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return undefined;
	if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
	const supersedes = value.supersedes;
	if (supersedes !== undefined && (typeof supersedes !== 'number' || !Number.isInteger(supersedes) || supersedes < 1)) return undefined;
	return {
		scope,
		generation,
		orchestrator,
		...(typeof value.nonce === 'string' ? { nonce: value.nonce } : {}),
		...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
		...(typeof value.host === 'string' && value.host.length > 0 ? { host: value.host } : {}),
		...(typeof value.startTime === 'string' && value.startTime.length > 0 ? { startTime: value.startTime } : {}),
		...(supersedes !== undefined ? { supersedes } : {}),
		at,
	};
}

/**
 * Read a scope's claim history.
 *
 * A line that cannot be parsed makes the whole history **incomplete**, and
 * incomplete history authorizes nothing. This is the file equivalent of a torn
 * write: the one thing that must never happen is reading past damage and
 * concluding "no later claim exists, so I may proceed".
 */
export function readClaimHistory(stateDir: string, scope: string): ClaimHistory {
	let text: string;
	try {
		text = readFileSync(scopeLedgerPath(stateDir, scope), 'utf8');
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === 'ENOENT') return { claims: [], incomplete: false };
		return { claims: [], incomplete: true };
	}
	const claims: ScopeClaim[] = [];
	let incomplete = false;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			incomplete = true;
			continue;
		}
		const claim = parseClaim(parsed);
		if (!claim) {
			incomplete = true;
			continue;
		}
		claims.push(claim);
	}
	return { claims: claims.sort((left, right) => left.generation - right.generation), incomplete };
}

/**
 * True when the claims form one unbroken chain: generations 1..N, each after the
 * first naming the generation it supersedes, each superseding exactly its
 * predecessor.
 *
 * Anything else — a gap, a repeated generation, a supersession pointing
 * somewhere else — means two writers disagreed about who owns the scope, and no
 * ownership decision can be trusted from it.
 */
export function isCompleteClaimChain(claims: readonly ScopeClaim[]): boolean {
	if (claims.length === 0) return true;
	for (let index = 0; index < claims.length; index += 1) {
		const claim = claims[index];
		if (!claim) return false;
		if (claim.generation !== index + 1) return false;
		if (index > 0 && claim.supersedes !== index) return false;
		if (index === 0 && claim.supersedes !== undefined) return false;
	}
	return true;
}

function appendClaim(stateDir: string, claim: ScopeClaim): void {
	const dir = join(stateDir, 'scopes');
	ensureDir(dir);
	const path = scopeLedgerPath(stateDir, claim.scope);
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
	writeFileSync(path, `${existing}${separator}${JSON.stringify(claim)}\n`, { mode: 0o600 });
}

/**
 * Establish, continue, or take over this process's ownership of a run scope.
 *
 * The rules, in order, and each one fails closed:
 *
 *   - an empty ledger means this process is the first owner: generation 1.
 *   - the latest claim is already this process (same orchestrator and nonce)
 *     means the scope is ours: keep that generation, append nothing.
 *   - the latest claim is another owner's whose process is *provably gone* is
 *     inherited: the generation still advances, but no human evidence is needed,
 *     because there is no live process left to fence against. Without this, the
 *     first session to touch a run scope would own it forever, and every later
 *     session — including one that merely restarted after a crash — would be
 *     locked out of its own Jobs.
 *   - any other owner is a refusal *unless* an explicit takeover names that owner
 *     and that generation exactly, and the chain is complete. A takeover appends
 *     `generation + 1` with `supersedes` naming the incumbent — never a jump,
 *     never a same-generation rewrite.
 */
export function claimGeneration(
	stateDir: string,
	claimant: Claimant,
	spec: TakeoverSpec | undefined,
	clock: Clock = () => Date.now(),
	liveness: LivenessOptions = {},
): GenerationClaim {
	const history = readClaimHistory(stateDir, claimant.scope);
	if (history.incomplete) {
		return { generation: 1, owner: claimant.orchestrator, authorized: false, reason: `the claim ledger for scope '${claimant.scope}' is incomplete or unreadable; stale or damaged evidence authorizes no ownership` };
	}
	const claims = history.claims;
	if (claims.length === 0) {
		const claim: ScopeClaim = {
			scope: claimant.scope,
			generation: 1,
			orchestrator: claimant.orchestrator,
			...(claimant.nonce ? { nonce: claimant.nonce } : {}),
			...(claimant.pid !== undefined ? { pid: claimant.pid } : {}),
			...(claimant.host ? { host: claimant.host } : {}),
			...(claimant.startTime ? { startTime: claimant.startTime } : {}),
			at: clock(),
		};
		appendClaim(stateDir, claim);
		return { generation: 1, owner: claimant.orchestrator, authorized: true };
	}
	const latest = claims[claims.length - 1];
	if (!latest) {
		return { generation: 1, owner: claimant.orchestrator, authorized: false, reason: 'the claim ledger contains no readable claim' };
	}
	const sameIncarnation = latest.orchestrator === claimant.orchestrator && (claimant.nonce === undefined || latest.nonce === claimant.nonce);
	if (sameIncarnation) return { generation: latest.generation, owner: latest.orchestrator, authorized: true };

	// One process cannot be two incarnations at once. A claim carrying this
	// process's own identity but another nonce was left by an earlier
	// `session_start` in this process — a compaction, or a resume in place — and
	// that incarnation is dead by construction. It is therefore a gone owner, not a
	// live rival; reading it as the latter locks a resumed session out of the very
	// windows it opened before the compaction.
	const superseded = isOwnEarlierIncarnation(latest, claimant);

	if (spec?.takeover !== true) {
		// A gone owner is not an owner: inheriting is recorded exactly as a takeover is,
		// so the fencing token still advances and a third session still sees one
		// unbroken chain. An owner whose liveness *cannot* be established stays a
		// refusal, because "I cannot prove it is gone" is not "I may take its windows".
		const standing = superseded ? 'dead' : claimLiveness(latest, liveness);
		if (standing === 'dead' && isCompleteClaimChain(claims)) {
			const inherited: ScopeClaim = {
				scope: claimant.scope,
				generation: latest.generation + 1,
				orchestrator: claimant.orchestrator,
				...(claimant.nonce ? { nonce: claimant.nonce } : {}),
				...(claimant.pid !== undefined ? { pid: claimant.pid } : {}),
				...(claimant.host ? { host: claimant.host } : {}),
				...(claimant.startTime ? { startTime: claimant.startTime } : {}),
				supersedes: latest.generation,
				at: clock(),
			};
			appendClaim(stateDir, inherited);
			return {
				generation: inherited.generation,
				owner: claimant.orchestrator,
				authorized: true,
				inherited: true,
				reason: superseded
					? `inherited scope '${claimant.scope}' from an earlier incarnation of this session at generation ${latest.generation}, which this process has since replaced`
					: `inherited scope '${claimant.scope}' from ${latest.orchestrator} at generation ${latest.generation}, whose process is no longer running`,
			};
		}
		return {
			generation: latest.generation,
			owner: latest.orchestrator,
			authorized: false,
			reason:
				`scope '${claimant.scope}' is owned by ${latest.orchestrator} at generation ${latest.generation}` +
				(standing === 'observed-live' ? ', which is still running' : ', whose liveness cannot be established') +
				`; acting on its windows requires an explicit takeover naming expectedOwner '${latest.orchestrator}' and expectedGeneration ${latest.generation}`,
		};
	}
	if (!isCompleteClaimChain(claims)) {
		return { generation: latest.generation, owner: latest.orchestrator, authorized: false, reason: `the claim ledger for scope '${claimant.scope}' is not one unbroken chain; ambiguous history authorizes no takeover` };
	}
	if (spec.expectedOwner !== latest.orchestrator || spec.expectedGeneration !== latest.generation) {
		return {
			generation: latest.generation,
			owner: latest.orchestrator,
			authorized: false,
			reason:
				`takeover evidence does not match the recorded owner: expected '${spec.expectedOwner ?? '(missing)'}' at generation ` +
				`${spec.expectedGeneration ?? '(missing)'}, recorded '${latest.orchestrator}' at generation ${latest.generation}`,
		};
	}
	const claim: ScopeClaim = {
		scope: claimant.scope,
		generation: latest.generation + 1,
		orchestrator: claimant.orchestrator,
		...(claimant.nonce ? { nonce: claimant.nonce } : {}),
		...(claimant.pid !== undefined ? { pid: claimant.pid } : {}),
		...(claimant.host ? { host: claimant.host } : {}),
		...(claimant.startTime ? { startTime: claimant.startTime } : {}),
		supersedes: latest.generation,
		at: clock(),
	};
	appendClaim(stateDir, claim);
	return { generation: claim.generation, owner: claimant.orchestrator, authorized: true };
}

// ---------------------------------------------------------------------------
// Liveness and classification
// ---------------------------------------------------------------------------

/** The seams liveness needs, so the suite never has to signal a real process. */
export interface LivenessOptions {
	readonly isAlive?: (pid: number) => boolean;
	readonly getStartTime?: (pid: number) => string | undefined;
	readonly host?: string;
}

/** True when a process with this PID exists and is signalable. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists and belongs to someone else.
		return isRecord(error) && error.code === 'EPERM';
	}
}

/** A process's start time, used to detect a recycled PID. */
export function getProcessStartTime(pid: number): string | undefined {
	try {
		const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the process that made a claim is still running.
 *
 * `observed-live` requires a complete identity that matches: same host, a live
 * PID, and — when a start time was recorded — the same start time. A mismatch
 * or a missing field is `unknown`, never `dead`, because "I cannot prove this is
 * alive" and "I can prove this is gone" authorize very different things.
 */
/** The process identity a claim is compared against: a session, or one incarnation of it. */
export type ClaimIdentity = Pick<Claimant, 'orchestrator' | 'nonce' | 'pid' | 'host' | 'startTime'>;

/**
 * Whether the owner recorded on a claim may be treated as gone.
 *
 * Two ways, and no third: the process is provably dead, or the claim was left by
 * an earlier incarnation of this very process. A live process is never gone, and
 * an identity that cannot be established is not gone either.
 */
function ownerIsGone(claim: ScopeClaim, claimant: ClaimIdentity, liveness: LivenessOptions): boolean {
	return isOwnEarlierIncarnation(claim, claimant) || claimLiveness(claim, liveness) === 'dead';
}

/**
 * Whether a claim was left by an earlier incarnation of *this* process.
 *
 * A PID names one process, so a claim carrying this process's own pid, host and
 * start time — with a nonce this process no longer is — cannot be a live
 * concurrent owner. Comparing the whole identity rather than the pid alone is
 * what keeps a recycled PID from being mistaken for this process: a recycled pid
 * has a different start time, and a missing start time is never a match.
 */
export function isOwnEarlierIncarnation(claim: ScopeClaim, claimant: ClaimIdentity): boolean {
	if (claimant.nonce === undefined || claim.nonce === undefined) return false;
	if (claim.nonce === claimant.nonce) return false;
	// Same session family: a different orchestrator in one process is a different
	// session (an explicit scope override), not an earlier incarnation of this one.
	if (claim.orchestrator !== claimant.orchestrator) return false;
	if (claimant.pid === undefined || claim.pid !== claimant.pid) return false;
	if (claimant.host === undefined || claim.host !== claimant.host) return false;
	// The start time must agree *and* be present on both sides. A claim that
	// recorded one against a claimant that could not is not provably this process,
	// so it is not inherited — the fail-closed direction.
	return claim.startTime !== undefined && claim.startTime === claimant.startTime;
}

export function claimLiveness(claim: ScopeClaim, options: LivenessOptions = {}): OwnerLiveness {
	// A claim written before hosts were recorded cannot be attributed to a machine, so
	// it is judged on its PID alone. This is a migration rule for exactly those claims:
	// it can only turn a dead process into a handoff, never the reverse, and the next
	// claim written records the host — so a scope locked out by an earlier build is
	// inherited by this one instead of being abandoned forever.
	const identity =
		claim.host === undefined && claim.pid !== undefined
			? { pid: claim.pid, host: options.host ?? hostname() }
			: { pid: claim.pid, host: claim.host, startTime: claim.startTime };
	return identityLiveness(identity, options);
}

/** Whether the window owner recorded for a Job is still running. */
export function ownerLiveness(record: OwnershipRecord, options: LivenessOptions = {}): OwnerLiveness {
	return identityLiveness(record, options);
}

/** The one liveness rule, shared by a scope claim and a window owner record. */
function identityLiveness(
	identity: { readonly pid?: number; readonly host?: string; readonly startTime?: string },
	options: LivenessOptions,
): OwnerLiveness {
	const host = options.host ?? hostname();
	if (identity.pid === undefined || identity.host === undefined) return 'unknown';
	if (identity.host !== host) return 'unknown';
	const alive = options.isAlive ?? isProcessAlive;
	if (!alive(identity.pid)) return 'dead';
	if (identity.startTime !== undefined) {
		const startTime = (options.getStartTime ?? getProcessStartTime)(identity.pid);
		if (startTime === undefined) return 'unknown';
		if (startTime !== identity.startTime) return 'unknown';
	}
	return 'observed-live';
}

/** How a run scope stands relative to this session. */
export type ScopeOwnership = 'unclaimed' | 'current-session' | 'another-live-owner' | 'unowned' | 'ownership-unknown';

export interface ScopeStanding {
	readonly category: ScopeOwnership;
	readonly reason: string;
	/** The latest claim, when there was a readable one. */
	readonly latest?: ScopeClaim;
}

/**
 * What the ledger says about a run scope — read-only.
 *
 * This takes no generation and writes nothing. It exists so a session can *report*
 * the scope's standing without claiming it: a session that only reads has nothing
 * to fence, and a read that took ownership would be a surprise. It is also what
 * distinguishes the two cases that look alike from the outside — an owner that is
 * still running and one that is gone — before anyone tries to dispatch.
 */
export function classifyScopeOwnership(
	stateDir: string,
	current: { readonly scope: string; readonly orchestrator: string; readonly generation: Generation },
	options: LivenessOptions = {},
): ScopeStanding {
	const history = readClaimHistory(stateDir, current.scope);
	if (history.incomplete) {
		return { category: 'ownership-unknown', reason: `the claim ledger for run scope '${current.scope}' is incomplete or unreadable` };
	}
	const latest = history.claims[history.claims.length - 1];
	if (!latest) {
		return { category: 'unclaimed', reason: `no session has claimed run scope '${current.scope}'` };
	}
	if (latest.orchestrator === current.orchestrator && latest.generation === current.generation) {
		return { category: 'current-session', reason: `owned by this session at generation ${latest.generation}`, latest };
	}
	const standing = claimLiveness(latest, options);
	if (standing === 'observed-live') {
		return { category: 'another-live-owner', reason: `run scope '${current.scope}' is owned by ${latest.orchestrator} at generation ${latest.generation}, which is still running`, latest };
	}
	if (standing === 'dead') {
		if (!isCompleteClaimChain(history.claims)) {
			return { category: 'ownership-unknown', reason: `the claim ledger for run scope '${current.scope}' is not one unbroken chain`, latest };
		}
		return {
			category: 'unowned',
			reason: `run scope '${current.scope}' was owned by ${latest.orchestrator} at generation ${latest.generation}, whose process is gone; the first dispatch takes generation ${latest.generation + 1}`,
			latest,
		};
	}
	return { category: 'ownership-unknown', reason: `run scope '${current.scope}' is owned by ${latest.orchestrator} at generation ${latest.generation}, whose liveness cannot be established`, latest };
}

export interface ClassifyOptions extends LivenessOptions {
	readonly pane: string;
	readonly currentOrchestrator: string;
	readonly currentScope: string;
	readonly currentGeneration: Generation;
	readonly stateDir: string;
	/**
	 * Every scope this session holds, when it holds more than the primary one.
	 *
	 * A session absorbs the scopes of the dead incarnations in its family, so a
	 * window opened under `<root>#2` is this session's to dispose of even while the
	 * session calls itself `<root>#0`. Absent, the primary scope alone is held, which
	 * keeps every existing caller exact.
	 */
	readonly currentScopes?: readonly string[];
}

/**
 * Classify a window's ownership.
 *
 * Only `current-session` authorizes a lifecycle mutation. `unowned` is evidence a
 * human reads before deciding; it is never a licence for this extension to act,
 * because "the record proves the owner is gone" is still not "I may dispose of
 * someone else's work".
 */
export function classifyWindowOwnership(options: ClassifyOptions): EvaluatedOwnership {
	const record = readOwner(options.stateDir, options.pane);
	if (!record) {
		return { liveness: 'unknown', category: 'ownership-unknown', reason: 'no durable owner record exists for this window' };
	}
	if (record.orchestrator === options.currentOrchestrator && record.scope === options.currentScope && record.generation === options.currentGeneration) {
		return { record, liveness: 'observed-live', category: 'current-session', reason: `owned by this session at generation ${record.generation}` };
	}
	// A sibling scope this session absorbed is equally its own: the family is the
	// unit of ownership, and a window opened by a dead incarnation must not read as
	// somebody else's work forever.
	const held = options.currentScopes ?? [options.currentScope];
	if (record.orchestrator === options.currentOrchestrator && held.includes(record.scope)) {
		return { record, liveness: 'observed-live', category: 'current-session', reason: `held by this session's scope family at generation ${record.generation}` };
	}
	const liveness = ownerLiveness(record, options);
	if (liveness === 'observed-live') {
		return { record, liveness, category: 'another-live-owner', reason: `owned by ${record.orchestrator} at generation ${record.generation}, which is still running` };
	}
	if (liveness === 'dead') {
		const history = readClaimHistory(options.stateDir, record.scope);
		const latest = history.claims[history.claims.length - 1];
		const confirms = !history.incomplete && latest !== undefined && latest.orchestrator === record.orchestrator && latest.generation === record.generation;
		if (confirms) {
			return { record, liveness, category: 'unowned', reason: `owner ${record.orchestrator} at generation ${record.generation} is gone and the claim ledger confirms it was the latest owner` };
		}
		return {
			record,
			liveness,
			category: 'ownership-unknown',
			reason: 'the recorded owner is gone, but the claim ledger does not confirm it was the latest owner, so the window may already belong to someone else',
		};
	}
	return { record, liveness, category: 'ownership-unknown', reason: `the owner's liveness cannot be established (${record.host ?? 'no host'} / ${record.pid ?? 'no pid'})` };
}

/** An ownership record for a Job about to be opened. */
export function ownershipFor(input: {
	readonly address: { readonly workspace: string; readonly tab: string; readonly pane: string };
	readonly path: string;
	readonly branch: string;
	readonly label: string;
	readonly ticket: string;
	readonly name: string;
	readonly mode: 'tab' | 'worktree';
	readonly claimant: Claimant;
	readonly generation: Generation;
	readonly clock?: Clock;
}): OwnershipRecord {
	const at = (input.clock ?? (() => Date.now()))();
	return {
		workspace: input.address.workspace,
		tab: input.address.tab,
		pane: input.address.pane,
		path: resolve(input.path),
		branch: input.branch,
		label: input.label,
		ticket: input.ticket,
		name: input.name,
		mode: input.mode,
		project: input.claimant.project,
		scope: input.claimant.scope,
		generation: input.generation,
		orchestrator: input.claimant.orchestrator,
		...(input.claimant.pid !== undefined ? { pid: input.claimant.pid } : {}),
		...(input.claimant.host !== undefined ? { host: input.claimant.host } : {}),
		...(input.claimant.startTime !== undefined ? { startTime: input.claimant.startTime } : {}),
		...(input.claimant.nonce !== undefined ? { nonce: input.claimant.nonce } : {}),
		claimedAt: iso(at),
	};
}

// ---------------------------------------------------------------------------
// The scope family
//
// A session's run scope is not one name but a family. `<root>#0` is the first
// incarnation, and a concurrent resume of the same session file derives
// `<root>#1` rather than being refused. The family is discoverable from the
// ledger directory alone — the names carry the root and the incarnation — so a
// session that dies leaves its work reachable by the next incarnation without a
// central index.
//
// `claimFamily` is the one function that decides which scopes this process ends
// up holding. It fails closed on nothing: every conflict has a next number, so a
// dispatch is never refused merely because somebody else is already running.
// ---------------------------------------------------------------------------

/** The identity a family claim is made under. `orchestrator` is the family root. */
export interface FamilyClaimant {
	readonly root: string;
	readonly orchestrator: string;
	readonly project: string;
	readonly pid?: number;
	readonly host?: string;
	readonly startTime?: string;
	readonly nonce?: string;
}

/** A {@link Claimant} for one scope of a family. */
export function scopeClaimant(claimant: FamilyClaimant, scope: string): Claimant {
	return {
		scope,
		orchestrator: claimant.orchestrator,
		project: claimant.project,
		...(claimant.pid !== undefined ? { pid: claimant.pid } : {}),
		...(claimant.host !== undefined ? { host: claimant.host } : {}),
		...(claimant.startTime !== undefined ? { startTime: claimant.startTime } : {}),
		...(claimant.nonce !== undefined ? { nonce: claimant.nonce } : {}),
	};
}

/** One incarnation of a family, as the ledger directory describes it. */
export interface FamilyEntry {
	/** The root every member shares. */
	readonly root: string;
	/** The incarnation number, from the scope name. */
	readonly index: number;
	/** The full scope id, `<root>#<index>`. */
	readonly scope: string;
	readonly history: ClaimHistory;
	/** The latest claim, when the ledger has a readable one. */
	readonly latest?: ScopeClaim;
}

/** Every incarnation of a family that has a ledger, oldest first. */
export function familyScopes(stateDir: string, root: string): readonly FamilyEntry[] {
	const stem = scopeLedgerName(root).slice(0, -'.jsonl'.length);
	const prefix = `${stem}${FAMILY_SEPARATOR}`;
	let names: readonly string[];
	try {
		names = readdirSync(join(stateDir, 'scopes'));
	} catch {
		return [];
	}
	const entries: FamilyEntry[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
		const digits = name.slice(prefix.length, -'.jsonl'.length);
		if (!/^\d+$/.test(digits)) continue;
		const index = Number(digits);
		const scope = familyScope(root, index);
		const history = readClaimHistory(stateDir, scope);
		entries.push({ root, index, scope, history, ...(history.claims.length > 0 ? { latest: history.claims[history.claims.length - 1] as ScopeClaim } : {}) });
	}
	return entries.sort((left, right) => left.index - right.index);
}

/** One scope this process holds, and the generation it holds there. */
export interface HeldScope {
	readonly scope: string;
	readonly generation: Generation;
}

/** What a family claim resolved to. */
export interface FamilyClaim {
	/** The scope this process acts as for new work. */
	readonly scope: string;
	readonly generation: Generation;
	readonly root: string;
	/** Every scope the claim left this process holding. */
	readonly held: readonly HeldScope[];
	readonly authorized: boolean;
	readonly reason?: string;
	/** True when any scope was taken from an owner whose process is gone. */
	readonly inherited?: boolean;
}

/** The session entry type a family claim is recorded under, so a resume reads its own scope back. */
export const SCOPE_ENTRY_TYPE = 'pi-herdr-enhanced-scope';

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * The scope chain a session recorded, primary scope first.
 *
 * Read from the *branch*, not from every entry: two incarnations diverge into two
 * branches of one file, and each must read back the scope it held rather than a
 * sibling's. A missing or unreadable chain is an empty one — a fresh session
 * simply has no scope yet.
 */
export function restoreScopeChain(entries: readonly unknown[], root: string): readonly string[] {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecordValue(entry) || entry.customType !== SCOPE_ENTRY_TYPE || !isRecordValue(entry.data)) continue;
		const data = entry.data;
		if (data.root !== root) continue;
		const scopes: string[] = [];
		if (typeof data.scope === 'string' && data.scope.length > 0) scopes.push(data.scope);
		const held = Array.isArray(data.held) ? data.held : [];
		for (const member of held) {
			const scope = isRecordValue(member) && typeof member.scope === 'string' ? member.scope : undefined;
			if (scope !== undefined && !scopes.includes(scope)) scopes.push(scope);
		}
		if (scopes.length > 0) return scopes;
	}
	return [];
}

/** The family member this session held last, when it still has a ledger. */
function chainMine(family: readonly FamilyEntry[], chain: readonly string[], root: string): FamilyEntry | undefined {
	// The chain is primary first, so the first member that still has a ledger is the
	// scope this session should lead with; any later member is one it had absorbed.
	for (const member of chain) {
		const parsed = parseScope(member);
		if (!parsed || parsed.root !== root) continue;
		const found = family.find((entry) => entry.index === parsed.index);
		if (found) return found;
	}
	return undefined;
}

/** The scope an explicit takeover names: the chain tip, else the family's oldest incarnation. */
function takeoverTarget(family: readonly FamilyEntry[], chain: readonly string[], root: string): string {
	return chainMine(family, chain, root)?.scope ?? familyScope(root, family[0]?.index ?? 0);
}

/**
 * Establish, continue, or take over this process's place in a run scope family.
 *
 * The rules, in order:
 *
 *   1. the scope this session held last, when it still exists and no concurrent
 *      incarnation has taken it — a plain restart lands exactly where it left off;
 *   2. otherwise the lowest incarnation whose owner is provably gone, so a session
 *      that lost its own scope recovers the primary one instead of inventing a
 *      number;
 *   3. otherwise the next number. This is why a concurrent resume is never
 *      refused: a family always has room for one more incarnation.
 *
 * Every other incarnation whose owner is gone is then absorbed, so the highest
 * surviving incarnation ends up holding the whole dead history and its windows
 * stay disposable. A live sibling stays out of reach: its windows are visible to
 * `job status wider`, never silently taken.
 *
 * An explicit takeover bypasses all of this. The caller has named the owner and
 * generation it expects, and a refusal must stay a refusal rather than quietly
 * becoming a new incarnation.
 */
export function claimFamily(
	stateDir: string,
	claimant: FamilyClaimant,
	spec: TakeoverSpec | undefined,
	clock: Clock = () => Date.now(),
	liveness: LivenessOptions = {},
	chain: readonly string[] = [],
): FamilyClaim {
	const family = familyScopes(stateDir, claimant.root);
	const held: HeldScope[] = [];
	let inherited = false;
	const hold = (scope: string, claim: GenerationClaim): void => {
		held.push({ scope, generation: claim.generation });
		if (claim.inherited === true) inherited = true;
	};
	const claimFor = (scope: string, takeover?: TakeoverSpec): GenerationClaim =>
		claimGeneration(stateDir, scopeClaimant(claimant, scope), takeover, clock, liveness);

	if (spec?.takeover === true) {
		const target = takeoverTarget(family, chain, claimant.root);
		const claim = claimFor(target, spec);
		if (claim.authorized) hold(target, claim);
		return {
			root: claimant.root,
			scope: target,
			generation: claim.generation,
			held,
			authorized: claim.authorized,
			...(claim.reason !== undefined ? { reason: claim.reason } : {}),
			...(inherited ? { inherited } : {}),
		};
	}

	let mine = chainMine(family, chain, claimant.root);
	if (mine) {
		const claim = claimFor(mine.scope);
		if (claim.authorized) hold(mine.scope, claim);
		else mine = undefined;
	}

	if (!mine) {
		mine = family.find((entry) => entry.latest !== undefined && ownerIsGone(entry.latest, claimant, liveness) && isCompleteClaimChain(entry.history.claims));
		if (mine) {
			const claim = claimFor(mine.scope);
			if (claim.authorized) hold(mine.scope, claim);
			else mine = undefined;
		}
	}

	if (!mine) {
		const index = family.reduce((highest, entry) => Math.max(highest, entry.index), -1) + 1;
		const scope = familyScope(claimant.root, index);
		const claim = claimFor(scope);
		if (!claim.authorized) {
			return {
				root: claimant.root,
				scope,
				generation: claim.generation,
				held,
				authorized: false,
				...(claim.reason !== undefined ? { reason: claim.reason } : {}),
			};
		}
		hold(scope, claim);
	}

	for (const entry of familyScopes(stateDir, claimant.root)) {
		if (held.some((member) => member.scope === entry.scope)) continue;
		const claim = claimFor(entry.scope);
		if (claim.authorized) hold(entry.scope, claim);
	}

	const primary = held[0];
	return {
		root: claimant.root,
		scope: primary?.scope ?? familyScope(claimant.root, 0),
		generation: primary?.generation ?? 1,
		held,
		authorized: true,
		...(inherited ? { inherited } : {}),
	};
}
