/**
 * The Wake: what the watch tells the Orchestrator, and how that message is
 * identified, consumed, and acknowledged.
 *
 * A Wake is a *custom message*, not a prompt. It is injected with
 * `{ triggerTurn: true, deliverAs: "followUp" }` so it queues behind an active
 * turn instead of interrupting it, and its `details` carry one opaque identity
 * per independent cause that was coalesced into it.
 *
 * Why identities at all: an injected message is not the same as a read message.
 * Pi may retry a run, a run may end in an error before its turn starts, and a
 * session may be resumed. Without an identity there is no way to tell "the
 * Orchestrator has seen this news" from "the message was queued and lost", and
 * the watch would either retry forever or drop news silently. So:
 *
 *   consumed       only when Pi actually delivers a message whose identity matches
 *   acknowledged   only at `agent_settled`, and only when the run ended normally
 *   retried        with the same identity, never as a replayed prompt
 *
 * Acknowledgement proves delivery of the news and nothing else. It is not a claim
 * that any Job succeeded — a Job's result is decided by reading its pane.
 */

import { opaqueId, type Clock } from './ids.ts';

/** The custom-message type every Wake is sent under. */
export const WAKE_CUSTOM_TYPE = 'pi-herdr-enhanced-job-watch';

/** The event a cause carries, which decides the Wake's headline. */
export type WakeKind = 'claim' | 'settle' | 'dead';

/** One independent reason a Wake fired. */
export interface WakeCause {
	/** One opaque identity per cause, so coalescing never loses any of them. */
	readonly id: string;
	/** What happened, in the Orchestrator's terms — one sentence, ending in a period. */
	readonly reason: string;
	readonly panes: readonly string[];
	/**
	 * The event behind this cause. The headline is composed from these rather than
	 * asserted, so a Wake cannot claim a classification none of its causes carries.
	 */
	readonly kind?: WakeKind;
	/** True when a Completion claim produced this cause rather than a silent settle. */
	readonly claimed?: boolean;
	/** Which delivery this is: absent on the first, `2` or more on a re-delivery. */
	readonly attempt?: number;
}

/** A Wake ready to be injected. */
export interface WakeReport {
	readonly causes: readonly WakeCause[];
	readonly text: string;
	readonly at: number;
}

/**
 * The retry ladder for an unhandled Wake, in milliseconds.
 *
 * An unhandled Wake is retried rather than lost: a run that never started its
 * turn, and a run that ended in `error` after Pi's own retries, each earn a
 * re-injection of the same identity. After the ladder is spent the interval sits
 * at its last value, so a Wake that nothing will ever handle cannot spin.
 */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000];

/** How long the watch coalesces non-urgent causes before delivering them. */
export const WAKE_DEBOUNCE_MS = 1_500;

/** One fresh cause identity. */
export function newCauseId(): string {
	return opaqueId('wake-');
}

/**
 * The delay before the next attempt, given how many attempts have been made.
 *
 * The ladder is indexed by attempts already made, so one injection waits a
 * minute, two wait five, three wait ten, and then the last entry repeats: "at
 * most once every 30 minutes while the Wake stays unhandled".
 */
export function retryDelayFor(attemptsMade: number, ladder: readonly number[] = WAKE_RETRY_DELAYS_MS): number {
	if (ladder.length === 0) return 30 * 60_000;
	const index = Math.max(0, Math.min(Math.max(1, attemptsMade) - 1, ladder.length - 1));
	return ladder[index] ?? 30 * 60_000;
}

/**
 * One sentence naming what fired, composed from the causes rather than asserted.
 *
 * The reason each Job is news is not a single thing — one declared completion, one
 * merely stopped working, one lost its window — so the headline counts the kinds
 * instead of describing them all with the least informative one.
 */
export function wakeHeadline(causes: readonly WakeCause[]): string {
	if (causes.length === 0) return 'No Job news.';
	const kindOf = (cause: WakeCause): WakeKind => cause.kind ?? (cause.claimed === true ? 'claim' : 'settle');
	const claimed = causes.filter((cause) => kindOf(cause) === 'claim').length;
	const dead = causes.filter((cause) => kindOf(cause) === 'dead').length;
	const stopped = causes.length - claimed - dead;
	const parts: string[] = [];
	if (claimed > 0) parts.push(`${claimed} ${claimed === 1 ? 'Job' : 'Jobs'} declared complete`);
	if (stopped > 0) parts.push(`${stopped} ${stopped === 1 ? 'job' : 'jobs'} stopped working`);
	if (dead > 0) parts.push(`${dead} Job ${dead === 1 ? 'window is' : 'windows are'} gone`);
	return parts.join(', ');
}

/** The message a Wake carries, given its causes. */
export function composeWakeText(causes: readonly WakeCause[]): string {
	const lines = ['## Job watch', '', wakeHeadline(causes), ''];
	for (const cause of causes) lines.push(`- ${cause.reason}${cause.panes.length > 0 ? ` [${cause.panes.join(', ')}]` : ''}`);

	// A re-delivery says so in its own words. Without that, the only sign that this is
	// the same news as before is a copy of the previous message, and the reader has no
	// way to tell "nothing answered this" from "this happened again".
	const attempts = causes.map((cause) => cause.attempt ?? 1);
	const delivery = Math.max(...attempts);
	if (delivery > 1) {
		lines.push('', `Re-sent (delivery ${delivery}): nothing has answered this news yet.`);
	}

	lines.push('', 'A Wake reports classification only: it never says a Job succeeded. Read the pane with `job read` before deciding anything.');
	if (causes.some((cause) => cause.claimed === true)) {
		lines.push('', 'A Job marked "declared complete" landed a Completion claim. That requests reconciliation; it does not prove success.');
	}
	lines.push('', 'Then `job retain` what you have captured — the window stays readable and stops waking you — or `job close` what should end.');
	return lines.join('\n');
}

/**
 * The metadata a Wake carries.
 *
 * `identities` is what the watch correlates a delivery against; `reasons` is
 * there so a human reading the transcript can see what fired without the watch
 * having to re-derive it.
 */
export function wakeDetails(causes: readonly WakeCause[]): Record<string, unknown> {
	return {
		identities: causes.map((cause) => cause.id),
		reasons: causes.map((cause) => ({ id: cause.id, reason: cause.reason, panes: cause.panes, ...(cause.claimed === true ? { claimed: true } : {}) })),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * The identities a delivered message carries, for correlation.
 *
 * Read from Pi's own message shape, defensively: a message that is not a Wake, or
 * a Wake whose metadata was lost, yields `[]` and correlates with nothing — the
 * safe direction, because a false correlation would acknowledge news nobody read.
 */
export function identitiesOf(message: unknown): readonly string[] {
	if (!isRecord(message)) return [];
	const candidates: unknown[] = [message.details, isRecord(message.message) ? message.message.details : undefined];
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const identities = candidate.identities;
		if (Array.isArray(identities)) return identities.filter((identity): identity is string => typeof identity === 'string' && identity.length > 0);
	}
	return [];
}

/** True when this message is a Wake this extension sent. */
export function isWakeMessage(message: unknown): boolean {
	if (!isRecord(message)) return false;
	return message.customType === WAKE_CUSTOM_TYPE;
}

/** Build a Wake from its causes. */
export function makeWake(causes: readonly WakeCause[], clock: Clock = () => Date.now()): WakeReport {
	return { causes, text: composeWakeText(causes), at: clock() };
}

/** A one-line summary for `job_watch status` and for a tool's own result. */
export function describeWake(report: WakeReport): string {
	if (report.causes.length === 0) return 'No Wake: no open Job has stopped working since the last one.';
	const lines = [`Wake: ${wakeHeadline(report.causes)}`];	for (const cause of report.causes) {
		const resent = (cause.attempt ?? 1) > 1 ? ` (re-sent, delivery ${cause.attempt})` : '';
		lines.push(`- ${cause.reason}${resent}`);
	}
	return lines.join('\n');
}
