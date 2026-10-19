/**
 * The durable run-scope state: which Jobs are open, what each one is, and what
 * the watch has already told the Orchestrator.
 *
 * Persistence is Pi's own session entries. That choice is deliberate: the state a
 * watch needs to survive is exactly the state a *session* should carry, and it
 * gives restore-on-resume and restore-after-compaction for free. A Job itself
 * outlives the Orchestrator — Herdr and the Worker do not care that the
 * Orchestrator died — so what has to survive is the Orchestrator's *view* of its
 * Jobs, not the Jobs.
 *
 * Everything here is a pure state transition over plain data, so the rules that
 * matter (resume by name, retention eviction, delivery acknowledgement) are
 * exercised directly by the suite with no Pi and no Herdr in the loop.
 */

import type { PaneStatus } from './herdr.ts';
import { now as realNow, type Clock } from './ids.ts';

/** The session entry type the watch state is persisted under. */
export const WATCH_ENTRY_TYPE = 'pi-herdr-enhanced-job-watch';

/** How a finished Job is being kept open. */
export type Retention = 'none' | 'auto' | 'manual';

/**
 * One open Job, as the Orchestrator knows it.
 *
 * Every field that a patch may need to *clear* is a required value with a
 * neutral default (`0` or `''`) rather than an optional one. With
 * `exactOptionalPropertyTypes` an optional field cannot be explicitly set back
 * to `undefined`, and clearing state is exactly what resume, release and revival
 * all have to do — so the neutral default is the honest representation, not a
 * workaround.
 */
export interface JobRecord {
	readonly name: string;
	readonly ticket: string;
	readonly workspace: string;
	readonly tab: string;
	readonly pane: string;
	readonly path: string;
	readonly branch: string;
	readonly label: string;
	readonly mode: 'tab' | 'worktree';
	readonly scope: string;
	readonly generation: number;
	readonly orchestrator: string;
	/** The capability token this Job's Worker was launched with. */
	readonly token: string;
	/** The launch arguments, so a resumed window is restarted identically. */
	readonly piArgs: readonly string[];
	readonly openedAt: number;
	/** The task text, kept so a resume can restate it without the caller repeating it. */
	readonly taskText: string;
	readonly taskSource: 'text' | 'file';
	readonly taskPath: string;
	/** True once the task prompt reached the pane. */
	readonly promptDelivered: boolean;
	/** Why the prompt did not reach the pane, when it did not. */
	readonly promptFailure: string;
	/** Per-Job stall threshold in milliseconds; `0` keeps the configured default. */
	readonly stallThresholdMs: number;
	/** Set by the Worker's Completion claim, consumed by the watch. */
	readonly claimedComplete: boolean;
	readonly claimedAt: number;
	/** A classified Worker failure, recorded for the refusal path. */
	readonly lastFailure: string;
	readonly lastStatus: PaneStatus | '';
	readonly lastObservedAt: number;
	/**
	 * The last time this Job was *observed* working, or `0` when it never has been.
	 *
	 * This is what makes "not working" mean "stopped working". A pane that Pi has
	 * not taken the prompt in yet is idle, and a pane with no session yet reads as
	 * `unknown`: both look exactly like a Job that finished, and announcing either
	 * would wake the Orchestrator about every dispatch the moment it was made. Only
	 * a `working` observation, Herdr's own `done`/`blocked`, a window with no session
	 * at all, or the expiry of the boot grace make a non-working Job news.
	 */
	readonly workedAt: number;
	/**
	 * The round that announced this Job's settlement, or `0` when it is re-armed.
	 * Cleared when the Job is observed working, which is what makes a Wake
	 * "once per stall" rather than "once per tick".
	 */
	readonly announcedAt: number;
	readonly retention: Retention;
	readonly retainedAt: number;
	/** A human wait: ordinary Wake decisions are suppressed until this instant. `0` means no hold. */
	readonly heldUntil: number;
	readonly heldNote: string;
	/** True when the window was established but its session did not start. */
	readonly provisioned: boolean;
}

/** A patch over a Job record. Every field is optional and writable; values are never `undefined`. */
export type JobPatch = { -readonly [K in keyof JobRecord]?: JobRecord[K] };

/** One Wake this watch has produced, and how far it got. */
export interface WakeDelivery {
	/** The opaque identity carried in the Wake's metadata, one per coalesced cause. */
	readonly id: string;
	readonly reason: string;
	readonly panes: readonly string[];
	readonly createdAt: number;
	state: 'pending' | 'injected' | 'consumed' | 'acknowledged' | 'failed';
	attempts: number;
	injectedAt?: number;
	nextRetryAt?: number;
	outcome?: string;
	/** True when a Completion claim produced this cause rather than a silent settle. */
	readonly claimed?: boolean;
}

/** The whole watch state. */
export interface WatchState {
	readonly jobs: readonly JobRecord[];
	readonly deliveries: readonly WakeDelivery[];
	/** True until the first poll round completes. */
	readonly armed: boolean;
}

/** The state before anything is open. An empty watch is the one failure nothing else reports. */
export function emptyWatch(): WatchState {
	return { jobs: [], deliveries: [], armed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseJob(value: unknown): JobRecord | undefined {
	if (!isRecord(value)) return undefined;
	const strings: Record<string, string> = {};
	for (const key of ['name', 'ticket', 'workspace', 'tab', 'pane', 'path', 'branch', 'label', 'scope', 'orchestrator', 'token'] as const) {
		const field = value[key];
		if (typeof field !== 'string') return undefined;
		strings[key] = field;
	}
	const mode = value.mode === 'worktree' ? 'worktree' : value.mode === 'tab' ? 'tab' : undefined;
	if (!mode) return undefined;
	const generation = value.generation;
	if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return undefined;
	const openedAt = value.openedAt;
	if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return undefined;
	const piArgs = Array.isArray(value.piArgs) ? value.piArgs.filter((argument): argument is string => typeof argument === 'string') : [];
	const retention = value.retention === 'auto' || value.retention === 'manual' ? value.retention : 'none';
	const lastStatus = value.lastStatus;
	const num = (field: unknown): number => (typeof field === 'number' && Number.isFinite(field) ? field : 0);
	const str = (field: unknown): string => (typeof field === 'string' ? field : '');
	return {
		name: strings.name as string,
		ticket: strings.ticket as string,
		workspace: strings.workspace as string,
		tab: strings.tab as string,
		pane: strings.pane as string,
		path: strings.path as string,
		branch: strings.branch as string,
		label: strings.label as string,
		mode,
		scope: strings.scope as string,
		generation,
		orchestrator: strings.orchestrator as string,
		token: strings.token as string,
		piArgs,
		openedAt,
		taskText: str(value.taskText),
		taskSource: value.taskSource === 'file' ? 'file' : 'text',
		taskPath: str(value.taskPath),
		promptDelivered: value.promptDelivered === true,
		promptFailure: str(value.promptFailure),
		stallThresholdMs: num(value.stallThresholdMs),
		claimedComplete: value.claimedComplete === true,
		claimedAt: num(value.claimedAt),
		lastFailure: str(value.lastFailure),
		lastStatus: lastStatus === 'working' || lastStatus === 'idle' || lastStatus === 'done' || lastStatus === 'blocked' || lastStatus === 'unknown' ? lastStatus : '',
		lastObservedAt: num(value.lastObservedAt),
		workedAt: num(value.workedAt),
		announcedAt: num(value.announcedAt),
		retention,
		retainedAt: num(value.retainedAt),
		heldUntil: num(value.heldUntil),
		heldNote: str(value.heldNote),
		provisioned: value.provisioned === true,
	};
}

function parseDelivery(value: unknown): WakeDelivery | undefined {
	if (!isRecord(value)) return undefined;
	const { id, reason } = value;
	if (typeof id !== 'string' || typeof reason !== 'string') return undefined;
	if (typeof value.createdAt !== 'number') return undefined;
	const panes = Array.isArray(value.panes) ? value.panes.filter((pane): pane is string => typeof pane === 'string') : [];
	const state = value.state;
	if (state !== 'pending' && state !== 'injected' && state !== 'consumed' && state !== 'acknowledged' && state !== 'failed') return undefined;
	return {
		id,
		reason,
		panes,
		createdAt: value.createdAt,
		state,
		attempts: typeof value.attempts === 'number' ? value.attempts : 0,
		...(typeof value.injectedAt === 'number' ? { injectedAt: value.injectedAt } : {}),
		...(typeof value.nextRetryAt === 'number' ? { nextRetryAt: value.nextRetryAt } : {}),
		...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
		...(value.claimed === true ? { claimed: true } : {}),
	};
}

/**
 * Rebuild the watch state from session entries.
 *
 * The **last** readable entry wins. A later entry always represents a later
 * belief about the same Job set, so merging older entries into newer ones would
 * resurrect Jobs the Orchestrator already closed — the exact stale-window
 * mistake this state exists to prevent.
 */
export function restoreWatch(entries: readonly unknown[]): WatchState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		if (entry.customType !== WATCH_ENTRY_TYPE && entry.type !== WATCH_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		const jobs = Array.isArray(data.jobs) ? data.jobs.map(parseJob).filter((job): job is JobRecord => job !== undefined) : [];
		const deliveries = Array.isArray(data.deliveries)
			? data.deliveries.map(parseDelivery).filter((delivery): delivery is WakeDelivery => delivery !== undefined)
			: [];
		return { jobs, deliveries, armed: data.armed === true };
	}
	return emptyWatch();
}

/** Replace one Job by pane, preserving position; append when it is new. */
export function upsertJob(state: WatchState, job: JobRecord): WatchState {
	const jobs = state.jobs.filter((existing) => existing.pane !== job.pane);
	return { ...state, jobs: [...jobs, job] };
}

/** Patch one Job, keyed by pane. A patch for an unknown pane changes nothing. */
export function patchJob(state: WatchState, pane: string, patch: JobPatch): WatchState {
	let changed = false;
	const jobs = state.jobs.map((job) => {
		if (job.pane !== pane) return job;
		changed = true;
		return { ...job, ...patch };
	});
	return changed ? { ...state, jobs } : state;
}

/**
 * Drop the Jobs living in these panes, and any delivery news that named them.
 *
 * Keyed by pane rather than by workspace, because in tab mode every Job shares the
 * Orchestrator's workspace: removing by workspace would drop a Job's siblings, and
 * retaining by workspace would retain them.
 */
export function removePanes(state: WatchState, panes: readonly string[]): WatchState {
	const removed = new Set(panes);
	const jobs = state.jobs.filter((job) => !removed.has(job.pane));
	const deliveries = state.deliveries.filter((delivery) => !delivery.panes.some((pane) => removed.has(pane)));
	return { jobs, deliveries, armed: state.armed };
}

/**
 * Find one Job by the several names a caller may use for it.
 *
 * Pane prefix matching is what makes a workspace or tab id usable as a target:
 * `w6` names a workspace and `w6:p1` a pane, and a caller that only has one of
 * them should not have to know which the tool wants.
 */
export function findJob(state: WatchState, target: string): JobRecord | undefined {
	const exact = state.jobs.find((job) => job.pane === target || job.workspace === target || job.name === target);
	if (exact) return exact;
	return state.jobs.find((job) => job.pane.startsWith(`${target}:`) || job.tab === target);
}

/** Every Job in a workspace, whatever it was called. */
export function jobsInWorkspace(state: WatchState, workspace: string): readonly JobRecord[] {
	return state.jobs.filter((job) => job.workspace === workspace);
}

/** Jobs the watch still waits on: open, and not Retained. */
export function watchedJobs(state: WatchState): readonly JobRecord[] {
	return state.jobs.filter((job) => job.retention === 'none');
}

/** Retained Jobs, oldest first — the retention queue's order. */
export function retainedJobs(state: WatchState): readonly JobRecord[] {
	return state.jobs.filter((job) => job.retention !== 'none').sort((left, right) => left.retainedAt - right.retainedAt);
}

/**
 * Mark a Job Retained.
 *
 * Retention is the normal end of a finished Job's life in the watch: the window
 * stays open to read, but it leaves the Wake decision entirely, so a finished Job
 * cannot keep waking the Orchestrator. A hand retain supersedes an automatic one.
 */
export function retainPanes(state: WatchState, panes: readonly string[], mode: Exclude<Retention, 'none'>, clock: Clock = realNow): WatchState {
	const at = clock();
	const targets = new Set(panes);
	const jobs = state.jobs.map((job) =>
		targets.has(job.pane) ? { ...job, retention: mode, retainedAt: at, heldUntil: 0, heldNote: '' } : job,
	);
	return { ...state, jobs };
}

/**
 * Withdraw retention when a Retained window starts working again.
 *
 * A Retained window is inert to the watch, not abandoned: if its pane is observed
 * `working`, real work is happening in it, and retention must not be allowed to
 * hide that from the Orchestrator. A hand retain is not withdrawn — the operator
 * asked for it and a later poll must not silently undo it.
 */
export function reviveAutoRetained(state: WatchState, pane: string): { readonly state: WatchState; readonly revived: boolean } {
	const job = state.jobs.find((candidate) => candidate.pane === pane);
	if (!job || job.retention !== 'auto') return { state, revived: false };
	return { state: patchJob(state, pane, { retention: 'none', retainedAt: 0 }), revived: true };
}

/**
 * Which Retained windows must close to keep the retention queue within its cap.
 *
 * Only Retained windows are candidates: a working window is never closed by a
 * cap, however many Jobs are open, because retention bounds what is kept *for
 * inspection* and never live work.
 */
export function retentionOverflow(state: WatchState, cap: number): readonly JobRecord[] {
	const retained = retainedJobs(state);
	if (retained.length <= cap) return [];
	return retained.slice(0, retained.length - cap);
}

/** Arm the watch, so `job status` can distinguish "nothing open" from "never polled". */
export function arm(state: WatchState): WatchState {
	return state.armed ? state : { ...state, armed: true };
}

// ---------------------------------------------------------------------------
// Wake deliveries
// ---------------------------------------------------------------------------

/** Unacknowledged deliveries, oldest first. */
export function openDeliveries(state: WatchState): readonly WakeDelivery[] {
	return state.deliveries.filter((delivery) => delivery.state === 'pending' || delivery.state === 'injected' || delivery.state === 'consumed' || delivery.state === 'failed');
}

/** Add a delivery, or return the state unchanged when its identity is already known. */
export function addDelivery(state: WatchState, delivery: WakeDelivery): WatchState {
	if (state.deliveries.some((existing) => existing.id === delivery.id)) return state;
	return { ...state, deliveries: [...state.deliveries, delivery] };
}

/** Patch one delivery by identity. */
export function patchDelivery(state: WatchState, id: string, patch: Partial<WakeDelivery>): WatchState {
	return { ...state, deliveries: state.deliveries.map((delivery) => (delivery.id === id ? { ...delivery, ...patch } : delivery)) };
}

/**
 * Drop delivery news that the Orchestrator's own cleanup made irrelevant.
 *
 * Closing or retaining a Job ends the question that the Wake was asking, so a
 * retry for it would wake the Orchestrator about a Job it has already dealt
 * with. Only news naming a dropped window is removed.
 */
export function dropDeliveriesFor(state: WatchState, panes: readonly string[]): WatchState {
	const targets = new Set(panes);
	return { ...state, deliveries: state.deliveries.filter((delivery) => !delivery.panes.some((pane) => targets.has(pane))) };
}

/** Keep the delivery log bounded; acknowledged news is history, not state. */
export function pruneDeliveries(state: WatchState, cap = 50): WatchState {
	const acknowledged = state.deliveries.filter((delivery) => delivery.state === 'acknowledged');
	if (acknowledged.length <= cap) return state;
	const drop = new Set(acknowledged.slice(0, acknowledged.length - cap).map((delivery) => delivery.id));
	return { ...state, deliveries: state.deliveries.filter((delivery) => !drop.has(delivery.id)) };
}
