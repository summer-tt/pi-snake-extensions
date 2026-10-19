/**
 * The Job watch: what lets the Orchestrator stop working.
 *
 * The watch holds a blocking Herdr wait on every working Job and wakes an idle
 * session as soon as any open Job stops working — claimed or not — so a parallel
 * run announces each of its Jobs rather than only its last one. A one-minute poll
 * remains underneath as the safety net for what a wait cannot see: a vanished
 * pane, a held Job's deadline, a pane Herdr cannot classify.
 *
 * Four rules do most of the work, and each exists because its absence was a
 * concrete failure:
 *
 *   **One Wake per stall.** A cause is raised when a Job is observed not working,
 *   and only re-armed once that Job is observed working again. A Job sitting
 *   `blocked` on a human therefore does not wake the Orchestrator every minute.
 *
 *   **The watch classifies; it never concludes.** Herdr's `idle` and `done` are UI
 *   visibility states. A Job that finished in under a second is indistinguishable
 *   from one that never launched, so a Wake names states and the Orchestrator
 *   reads the pane. Gating the Wake on having once observed `working` was
 *   rejected for exactly that reason: it would strand a Job that failed to start.
 *
 *   **A claim does not wake anybody.** A Worker declares completion while it is
 *   still mid-turn writing its summary; waking there is the false Wake this
 *   design removes. The claim is *recorded*, the Wake follows settlement, and the
 *   cause is named `declared complete` so a silent settle is never mistaken for a
 *   delivered one.
 *
 *   **Delivery is identified and acknowledged separately.** See `wake.ts`.
 *
 * The watch lives in the Orchestrator process. It cannot wake a process that no
 * longer exists, and it says so rather than pretending otherwise: a killed
 * Orchestrator is discovered by the next session's `job status`. Jobs themselves
 * are unaffected — Herdr and the Workers outlive the Orchestrator — so what waits
 * is reconciliation, never work.
 */

import { consumeClaim, dropProgress, readClaims, readProgress, spoolExists, verifySpool, type ClaimRecord } from './spool.ts';
import { agentWait, isMissingPane, paneExists, type PaneStatus, type RunCommand } from './herdr.ts';
import type { ResolvedConfig } from './config.ts';
import { errorText, now as realNow, type Clock } from './ids.ts';
import {
	addDelivery,
	arm,
	emptyWatch,
	findJob,
	openDeliveries,
	patchDelivery,
	patchJob,
	pruneDeliveries,
	removePanes,
	retainedJobs,
	retentionOverflow,
	retainPanes,
	reviveAutoRetained,
	upsertJob,
	watchedJobs,
	type JobPatch,
	type JobRecord,
	type WakeDelivery,
	type WatchState,
} from './registry.ts';
import { makeWake, newCauseId, retryDelayFor, identitiesOf, isWakeMessage, type WakeCause, type WakeReport } from './wake.ts';

/** What the watch needs from its host: persistence, injection, and teardown. */
export interface WatchHost {
	/** Persist the new state. Called on every change; must not throw. */
	persist(state: WatchState): void;
	/** Deliver a Wake as a custom message. */
	inject(report: WakeReport): void;
	/** Tell the operator something. Best-effort. */
	notify(message: string, level: 'info' | 'warning' | 'error'): void;
	/** End a window the retention cap evicted. */
	close(job: JobRecord): Promise<void>;
}

export interface WatchOptions {
	readonly run: RunCommand;
	readonly config: ResolvedConfig;
	readonly spoolPath: string;
	readonly clock?: Clock;
	/** Timer seam, so the suite drives ticks and retries without waiting. */
	readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | number;
	readonly clearTimer?: (handle: never) => void;
}

/** One Job's observation for this round. */
interface Observation {
	readonly job: JobRecord;
	readonly status: PaneStatus;
	readonly present: boolean;
}

/** An active blocking wait, aborted when its Job stops being one we wait on. */
interface Waiter {
	readonly controller: AbortController;
}

/**
 * How often a Job that no blocking wait can say anything about is polled.
 *
 * A dispatched Job is idle until Pi takes its prompt, and a wait made on such a
 * pane would answer immediately rather than after the Job's first turn, so the
 * watch probes instead until it has seen the Job work. Short, because this is the
 * latency on the first Wake of every dispatch; not shorter, because each probe is
 * three Herdr processes.
 */
const PROBE_MS = 2_000;

export class Watch {
	private state: WatchState = emptyWatch();
	private readonly host: WatchHost;
	private readonly options: WatchOptions;
	private readonly clock: Clock;

	private tickTimer: { unref?: () => void } | number | undefined;
	private debounceTimer: { unref?: () => void } | number | undefined;
	private retryTimer: { unref?: () => void } | number | undefined;
	private probeTimer: { unref?: () => void } | number | undefined;
	private retryArmedFor?: number;

	private readonly waiters = new Map<string, Waiter>();
	private pending: WakeCause[] = [];
	private pendingWake?: WakeReport;

	/** True from `agent_start` to `agent_settled`: while Pi is inside a run. */
	private runActive = false;
	private inTurn = false;
	private lastTurnOutcome?: 'completed' | 'error' | 'aborted';
	private stopped = false;

	constructor(host: WatchHost, options: WatchOptions) {
		this.host = host;
		this.options = options;
		this.clock = options.clock ?? realNow;
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	/** The Job set, for `job status` and for the Job tool's own lookups. */
	get openJobs(): readonly JobRecord[] {
		return this.state.jobs;
	}

	get watchState(): WatchState {
		return this.state;
	}

	/** Replace the state wholesale, as a session restore does. */
	restore(state: WatchState): void {
		this.state = state;
	}

	/** Register a Job the moment its window exists, before any session step. */
	register(job: JobRecord): void {
		this.state = arm(upsertJob(this.state, job));
		this.commit();
		// A new Job revives a stopped watch: opening is the explicit signal that
		// there is something to watch again (a session restart does the same).
		this.stopped = false;
		this.start();
	}

	/** Patch one Job by pane. */
	patch(pane: string, patch: Partial<JobRecord>): void {
		this.state = patchJob(this.state, pane, patch);
		this.commit();
		// A patch can make a Job worth waiting on for the first time — a dispatch
		// records its delivered prompt this way — so the waits are re-decided here
		// rather than only on the next round.
		this.retune();
	}

	/**
	 * Forget the Jobs living in these panes.
	 *
	 * The unit of forget is the *window*, never the workspace. In tab mode every Job
	 * shares the Orchestrator's own workspace, so removing by workspace would drop
	 * every sibling Job the moment one of them closed.
	 */
	forget(panes: readonly string[]): void {
		if (panes.length === 0) return;
		this.state = removePanes(this.state, panes);
		this.dropQueued(panes);
		for (const pane of panes) {
			this.waiters.get(pane)?.controller.abort();
			this.waiters.delete(pane);
		}
		this.commit();
		this.retune();
	}

	/**
	 * Drop queued news naming any of these panes.
	 *
	 * A Wake raised mid-turn waits in the queue until the turn drains, which can be
	 * minutes. A Job can be closed inside that window, and a queue that kept the news
	 * would inject it about a window the operator has just ended — by then the delivery
	 * is gone, so the news cannot even be answered, and it reads as a stale
	 * notification that will not go away no matter what is called.
	 */
	private dropQueued(panes: readonly string[]): void {
		const report = this.pendingWake;
		if (!report) return;
		const targets = new Set(panes);
		const causes = report.causes.filter((cause) => !cause.panes.some((pane) => targets.has(pane)));
		if (causes.length === report.causes.length) return;
		this.pendingWake = causes.length > 0 ? makeWake(causes, this.clock) : undefined;
	}

	private commit(): void {
		try {
			this.host.persist(this.state);
		} catch (error) {
			this.host.notify(`Could not persist the Job watch state: ${errorText(error)}`, 'warning');
		}
	}

	// -------------------------------------------------------------------------
	// Run tracking — where a Wake may actually be delivered
	// -------------------------------------------------------------------------

	/**
	 * A run is live. A Wake is *held*, not injected.
	 *
	 * Pi drains its follow-up queue only where a run would otherwise end — at the
	 * end of a turn in which the model finished its response, or at settlement. A
	 * message injected anywhere else is not delivered sooner; it is delivered later,
	 * against a snapshot taken now. Holding loses no delivery time and keeps the
	 * delivered news current, and it stops a retry fired mid-run from queueing a
	 * second copy of a message the queue already holds.
	 */
	startRun(): void {
		this.runActive = true;
		this.lastTurnOutcome = undefined;
	}

	startTurn(): void {
		this.inTurn = true;
	}

	/**
	 * A turn ended. When the model finished its response, this is exactly where Pi
	 * drains its follow-up queue, so a held Wake is delivered here — the run stays
	 * live and the news is as current as it can be.
	 */
	endTurn(options: { readonly modelFinished?: boolean } = {}): void {
		this.inTurn = false;
		if (options.modelFinished !== false) this.flush();
	}

	endRun(): void {
		this.runActive = false;
		this.inTurn = false;
		this.flush();
	}

	/** Record Pi's own outcome for the turn that just ended. */
	noteTurnOutcome(outcome: unknown): void {
		if (outcome === 'completed' || outcome === 'error' || outcome === 'aborted') this.lastTurnOutcome = outcome;
	}

	private flush(): void {
		if (!this.pendingWake) return;
		const report = this.pendingWake;
		this.pendingWake = undefined;
		this.inject(report);
	}

	private inject(report: WakeReport): void {
		try {
			this.host.inject(report);
		} catch (error) {
			this.host.notify(`Could not inject the Job watch Wake: ${errorText(error)}`, 'error');
		}
	}

	/**
	 * Correlate a delivered message against the deliveries waiting on an identity.
	 *
	 * This is the only consumption signal, and it proves only that Pi handed the
	 * message to the run. It is deliberately not an acknowledgement: a run that
	 * goes on to end in `error` has still consumed the news without acting on it.
	 */
	observeWakeMessage(message: unknown): void {
		const identities = identitiesFrom(message);
		if (identities.length === 0) return;
		for (const cause of identities) {
			const delivery = this.state.deliveries.find((candidate) => candidate.id === cause);
			if (!delivery) continue;
			this.state = patchDelivery(this.state, delivery.id, { state: 'consumed' });
		}
		this.commit();
	}

	/**
	 * Pi has settled. This is the only acknowledgement point — after Pi's native
	 * retries and every continuation turn.
	 *
	 * A final `error` leaves the Wake unhandled so it is retried; an ambiguous
	 * `aborted` is never retried automatically, because nothing can tell a human
	 * cancellation from a failed one and re-injecting on a cancellation is noise.
	 */
	onAgentSettled(aborted: boolean): void {
		const outcome = aborted ? 'aborted' : (this.lastTurnOutcome ?? 'completed');
		this.lastTurnOutcome = undefined;
		const consumed = this.state.deliveries.filter((delivery) => delivery.state === 'consumed');
		for (const delivery of consumed) {
			if (outcome === 'error') {
				const attempts = delivery.attempts;
				this.state = patchDelivery(this.state, delivery.id, {
					state: 'failed',
					outcome: 'error',
					attempts,
					nextRetryAt: this.clock() + retryDelayFor(attempts),
				});
				continue;
			}
			if (outcome === 'aborted') {
				// The ladder rung armed at delivery is given up: this Wake is answered for
				// good as far as the watch is concerned, even though nothing acted on it.
				this.state = patchDelivery(this.state, delivery.id, { state: 'failed', outcome: 'aborted', nextRetryAt: undefined });
				continue;
			}
			this.state = patchDelivery(this.state, delivery.id, { state: 'acknowledged', outcome: 'completed' });
			this.retainDelivered(delivery);
		}
		this.state = pruneDeliveries(this.state);
		this.commit();
		this.retune();
	}

	/**
	 * Retain the Jobs named by news that has now been delivered.
	 *
	 * Retention is the normal end of a finished Job's life in the watch: the
	 * window stays open to read, and it leaves the Wake decision entirely. A hand
	 * retain is never overwritten — the operator asked for it deliberately.
	 */
	private retainDelivered(delivery: WakeDelivery): void {
		const panes = new Set(delivery.panes);
		for (const job of this.state.jobs) {
			if (!panes.has(job.pane)) continue;
			if (job.retention !== 'none') continue;
			if (job.lastStatus === '' || job.lastStatus === 'working') continue;
			this.state = retainPanes(this.state, [job.pane], 'auto', this.clock);
		}
	}

	// -------------------------------------------------------------------------
	// Hold and release
	// -------------------------------------------------------------------------

	/** Suppress ordinary Wake decisions for these windows, without hiding a dead pane. */
	hold(targets: readonly string[], note: string | undefined, ms: number): string {
		const now = this.clock();
		const held: string[] = [];
		for (const target of targets) {
			const job = findJob(this.state, target);
			if (!job) continue;
			this.state = patchJob(this.state, job.pane, { heldUntil: now + ms, heldNote: note ?? '' });
			held.push(job.name);
		}
		this.commit();
		return held.length > 0
			? `Held ${held.join(', ')} for ${Math.round(ms / 1000)}s. Ordinary Wake decisions for these Jobs are suppressed; a dead pane or the deadline still reports.`
			: `Nothing held: ${targets.join(', ')} matched no open Job.`;
	}

	/** End a hold. */
	release(targets: readonly string[]): string {
		const released: string[] = [];
		for (const target of targets) {
			const job = findJob(this.state, target);
			if (!job || job.heldUntil === 0) continue;
			this.state = patchJob(this.state, job.pane, { heldUntil: 0, heldNote: '' });
			released.push(job.name);
		}
		this.commit();
		return released.length > 0 ? `Released ${released.join(', ')}.` : `Nothing released: ${targets.join(', ')} were not held.`;
	}

	// -------------------------------------------------------------------------
	// The round
	// -------------------------------------------------------------------------

	/**
	 * One observation round: classify every watched Job, apply claims, and decide
	 * whether anything deserves a Wake.
	 *
	 * Exposed directly so `job_watch wake` can force a round without waiting for a
	 * timer, which is also what makes the whole decision testable.
	 */
	async poll(): Promise<WakeReport | undefined> {
		if (this.stopped) return undefined;
		this.state = arm(this.state);

		const observations = await this.observe();
		const causes: WakeCause[] = [];

		for (const observation of observations) {
			const cause = this.classify(observation);
			if (cause) causes.push(cause);
		}

		await this.retainAfterDelivery();

		this.commit();
		if (causes.length > 0) {
			const report = this.raise(causes);
			await this.retryDue();
			this.retune();
			return report;
		}
		await this.retryDue();
		this.retune();
		return undefined;
	}

	/**
	 * Take one snapshot of every open Job, and apply the cross-process channels.
	 *
	 * Claims are consumed here — on the poll that already runs — and a consumed
	 * claim marks its Job declared. Progress observations are read for the same
	 * reason: to know whether a Job's activity is *observable* at all, which is a
	 * different question from whether it is working.
	 */
	private async observe(): Promise<readonly Observation[]> {
		const observations: Observation[] = [];
		for (const job of this.state.jobs) {
			let present: boolean;
			let status: PaneStatus;
			try {
				present = await paneExists(this.options.run, job.pane);
				if (!present) {
					status = 'unknown';
				} else {
					const { agentGet } = await import('./herdr.ts');
					const agent = await agentGet(this.options.run, job.pane);
					status = agent?.status ?? 'unknown';
				}
			} catch (error) {
				status = 'unknown';
				present = true;
				this.host.notify(`Could not observe Job ${job.name} at ${job.pane}: ${errorText(error)}`, 'warning');
			}
			observations.push({ job, status: present ? status : 'unknown', present });
		}

		// The claim channel. `consumeClaim` authenticates on the Job's own token, so
		// a file belonging to somebody else is left alone.
		// An absent spool is the state of every Run scope before its first Job, not a
		// fault: there is nothing to read, and nothing to say about it.
		if (spoolExists(this.options.spoolPath)) {
			try {
				verifySpool(this.options.spoolPath);
				for (const job of this.state.jobs) {
					const claim = consumeClaim(this.options.spoolPath, job.token);
					if (claim) this.applyClaim(job, claim);
				}
				readClaims(this.options.spoolPath, undefined, this.clock);
				readProgress(this.options.spoolPath, undefined, this.clock);
			} catch (error) {
				this.host.notify(`The Job claim spool at ${this.options.spoolPath} is unusable: ${errorText(error)}`, 'warning');
			}
		}

		return observations;
	}

	private applyClaim(job: JobRecord, claim: ClaimRecord): void {
		if (claim.name !== job.name || claim.ticket !== job.ticket) {
			// A token that names a different Job is not this Job's claim. Do not record
			// it, and do not drop it either: the file belongs to whoever owns the token.
			return;
		}
		if (job.claimedComplete) return;
		this.state = patchJob(this.state, job.pane, { claimedComplete: true, claimedAt: claim.claimedAt });
	}

	/**
	 * Decide whether one observation is a Wake cause.
	 *
	 * The rule is "this Job is not working, and has not already been announced
	 * since it last was" — which covers a Job that settled, a Job that failed to
	 * launch, and a pane that vanished, without waking repeatedly for any of them.
	 */
	private classify(observation: Observation): WakeCause | undefined {
		const { job, status, present } = observation;
		const now = this.clock();
		const observed: JobPatch = { lastStatus: status, lastObservedAt: now };
		if (status === 'working') observed.announcedAt = 0;
		this.state = patchJob(this.state, job.pane, observed);
		const current = findJob(this.state, job.pane) ?? job;

		// A Retained window is inert to the watch, unless it is working again — real
		// work must not be hidden by retention.
		if (current.retention !== 'none') {
			if (status === 'working') {
				const revived = reviveAutoRetained(this.state, current.pane);
				if (revived.revived) {
					this.state = revived.state;
					this.host.notify(`Retained Job ${current.name} at ${current.pane} is working again; it returned to the Job watch.`, 'info');
				}
			}
			return undefined;
		}

		const held = current.heldUntil > 0 && current.heldUntil > now;
		if (held && present) return undefined;
		// A Job whose prompt has not been delivered yet has not started: `agent start`
		// is still waiting for Pi to become interactive. A Job that never gets that far
		// is reported by the open that started it, and again here once `provisioned`
		// records that its window carries no session at all.
		if (!current.promptDelivered && !current.provisioned) return undefined;
		if (status === 'working') {
			if (current.workedAt === 0) this.state = patchJob(this.state, current.pane, { workedAt: now });
			return undefined;
		}
		if (current.announcedAt > 0) return undefined;

		// "Not working" has to mean "stopped working". Only evidence that this Job ran,
		// or that Herdr says something a booting pane never says, or that the boot grace
		// has run out, makes it news. Without the first two, every dispatch would be
		// announced in the seconds before Pi took its prompt — and without the last, a
		// Worker that hung before its first token would be invisible forever.
		const ran = current.workedAt > 0 || current.lastStatus === 'working';
		const terminal = status === 'done' || status === 'blocked';
		const graceExpired = now - current.openedAt >= this.options.config.tickMs;
		if (!current.provisioned && !ran && !terminal && !graceExpired) return undefined;

		this.state = patchJob(this.state, current.pane, { announcedAt: now });

		const claimed = current.claimedComplete;
		// One sentence per Job, stating the evidence and nothing else: what the ask is
		// belongs to the Wake's closing line, not to every cause that lands in it.
		const reason = present
			? claimed
				? `Job ${current.name} (${current.ticket}) at ${current.pane} is ${status} and declared complete.`
				: `Job ${current.name} (${current.ticket}) at ${current.pane} is ${status} with no completion claim.`
			: `Job ${current.name} (${current.ticket}) at ${current.pane} is gone: its window no longer exists.`;
		const kind = present ? (claimed ? 'claim' : 'settle') : 'dead';
		return { id: newCauseId(), reason, panes: [current.pane], kind, ...(claimed ? { claimed: true } : {}) };
	}

	/**
	 * Raise causes into a Wake, and report what was raised.
	 *
	 * A claim bypasses the debounce and is delivered immediately: it is an explicit
	 * declaration that a Job is done, and holding it for 1.5 s to see whether a
	 * sibling lands at the same moment buys nothing. Everything else is coalesced,
	 * so Jobs that stop together produce one Wake rather than a stream. The report is
	 * returned either way — the caller asked what this round found, not when the
	 * message will be delivered.
	 */
	private raise(causes: readonly WakeCause[]): WakeReport {
		const report = makeWake(causes, this.clock);
		const urgent = causes.some((cause) => cause.claimed === true);
		this.pending.push(...causes);
		if (urgent) {
			this.flushPending();
			return report;
		}
		if (this.debounceTimer === undefined) {
			const arm = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
			const handle = arm(() => {
				this.debounceTimer = undefined;
				this.flushPending();
			}, this.options.config.debounceMs);
			unref(handle);
			this.debounceTimer = handle;
		}
		return report;
	}

	private flushPending(): void {
		if (this.pending.length === 0) return;
		const causes = this.pending;
		this.pending = [];
		let state = this.state;
		for (const cause of causes) {
			const delivery: WakeDelivery = {
				id: cause.id,
				reason: cause.reason,
				panes: cause.panes,
				createdAt: this.clock(),
				state: 'pending',
				attempts: 0,
				// The first rung of the ladder is armed at delivery, not at the first
				// failure: a Wake that Pi never hands to a run is exactly the "queued and
				// lost" case the identity exists for, and it would otherwise never be
				// retried at all.
				nextRetryAt: this.clock() + retryDelayFor(1),
				...(cause.claimed === true ? { claimed: true } : {}),
			};
			state = addDelivery(state, delivery);
		}
		this.state = state;
		const report = makeWake(causes, this.clock);
		for (const cause of causes) this.state = patchDelivery(this.state, cause.id, { state: 'injected', injectedAt: this.clock(), attempts: 1 });
		this.commit();
		// The delivery's ladder rung is armed now rather than at the next round: a Wake
		// the Orchestrator never sees must come back on time, and the round that could
		// arm it may be a minute away.
		this.retune();

		if (this.runActive || this.inTurn) {
			// Hold it: a follow-up queue is drained at a turn or run boundary, so
			// injecting now would deliver later against older news.
			this.pendingWake = report;
			return;
		}
		this.inject(report);
	}

	/**
	 * Re-inject Wakes that were consumed but never acknowledged.
	 *
	 * The identity is reused — never a replayed prompt — so a retry cannot be
	 * mistaken for new news, and a retry that arrives after the Orchestrator
	 * eventually handles the original is correlated away rather than acted on
	 * twice.
	 */
	private async retryDue(): Promise<void> {
		const now = this.clock();
		// Only news that nothing has picked up is retried, and there are three ways a
		// delivery has been picked up:
		//
		//   - it was consumed — Pi handed its message to a run, so the run owns it. A
		//     run that ends normally acknowledges it, an abort retires it, and an error
		//     leaves it `failed` with its rung, which is what the ladder is for.
		//   - it is still queued for a turn boundary: that is a queue, not a loss.
		//   - a run is live right now, so a rung that expires mid-run waits for the run
		//     to end rather than interrupting it with a copy of news it is working on.
		//
		// Retrying past any of those is what turns one reconciliation into a stream of
		// duplicate Wake texts for the same Job — and an `aborted` Wake is never
		// retried either: nothing can tell a human cancellation from a failed one, so
		// re-injecting on a cancellation is noise.
		if (this.runActive || this.inTurn) return;
		const queued = new Set((this.pendingWake?.causes ?? []).map((cause) => cause.id));
		const due = openDeliveries(this.state).filter(
			(delivery) =>
				delivery.outcome !== 'aborted' &&
				delivery.state !== 'consumed' &&
				!queued.has(delivery.id) &&
				delivery.nextRetryAt !== undefined &&
				delivery.nextRetryAt <= now,
		);
		if (due.length === 0) return;
		const causes: WakeCause[] = [];
		for (const delivery of due) {
			const attempts = delivery.attempts;
			this.state = patchDelivery(this.state, delivery.id, {
				state: 'injected',
				attempts: attempts + 1,
				injectedAt: now,
				nextRetryAt: now + retryDelayFor(attempts + 1),
			});
			// The kind is not stored with the delivery; a re-delivery of a claimed Job
			// still says so, which is the part of the headline that has to hold.
			causes.push({
				id: delivery.id,
				reason: delivery.reason,
				panes: delivery.panes,
				kind: delivery.claimed === true ? 'claim' : 'settle',
				attempt: attempts + 1,
				...(delivery.claimed === true ? { claimed: true } : {}),
			});
		}
		this.commit();
		this.inject(makeWake(causes, this.clock));
	}

	/**
	 * Answer the Wake news about these Jobs.
	 *
	 * `job retain` is exactly the reconciliation a Wake asks for — the window is
	 * captured and leaves the watch — so it answers the news that named it. Without
	 * this, an operator who has already handled a Job still reads "unanswered Wake
	 * news" on the next `job status` and is woken about it again on the ladder, which
	 * is how a handled Job starts to look like an ignored one.
	 */
	resolveNews(panes: readonly string[]): readonly string[] {
		const targets = new Set(panes);
		const answered = openDeliveries(this.state).filter((delivery) => delivery.panes.some((pane) => targets.has(pane)));
		// A queued copy of the same news has not been delivered yet, so answering the
		// deliveries has to answer it too; otherwise the operator retains a Job, reads
		// that it is handled, and then receives the Wake about it anyway.
		this.dropQueued([...targets]);
		if (answered.length === 0) return [];
		for (const delivery of answered) {
			this.state = patchDelivery(this.state, delivery.id, { state: 'acknowledged', outcome: 'completed', nextRetryAt: undefined });
		}
		this.state = pruneDeliveries(this.state);
		this.commit();
		this.retune();
		return answered.map((delivery) => delivery.id);
	}

	/**
	 * Enforce the retention cap, and re-arm the retry timer.
	 *
	 * The timer is always `unref`'d and cancelled when there is nothing left to
	 * wait for, so an idle Orchestrator can exit: a watch that keeps a process
	 * alive is a watch that costs tokens for nothing.
	 */
	private async retainAfterDelivery(): Promise<void> {
		const overflow = retentionOverflow(this.state, this.options.config.retentionCap);
		if (overflow.length === 0) return;
		const closed: string[] = [];
		const failed: string[] = [];
		for (const job of overflow) {
			try {
				await this.host.close(job);
				closed.push(job.name);
			} catch (error) {
				failed.push(`${job.name}: ${errorText(error)}`);
			}
		}
		if (closed.length > 0) {
			this.state = removePanes(this.state, overflow.filter((job) => closed.includes(job.name)).map((job) => job.pane));
		}
		if (failed.length > 0) {
			this.host.notify(`The retention cap could not evict ${failed.join('; ')}. End them with \`job close\`.`, 'warning');
		}
	}

	// -------------------------------------------------------------------------
	// Timing
	// -------------------------------------------------------------------------

	/** Start the tick, the blocking waits, and the retry timer. */
	start(): void {
		if (this.stopped) return;
		this.armTick();
		this.armWaiters();
		this.retune();
	}

	/** Stop the watch. A round already in flight continues, but re-arms nothing. */
	stop(): void {
		this.stopped = true;
		this.clear(this.tickTimer);
		this.tickTimer = undefined;
		this.clear(this.debounceTimer);
		this.debounceTimer = undefined;
		this.clear(this.retryTimer);
		this.retryTimer = undefined;
		this.retryArmedFor = undefined;
		this.clear(this.probeTimer);
		this.probeTimer = undefined;
		for (const waiter of this.waiters.values()) waiter.controller.abort();
		this.waiters.clear();
	}

	private armTick(): void {
		if (this.stopped || this.tickTimer !== undefined) return;
		const arm = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		const handle = arm(() => {
			this.tickTimer = undefined;
			void this.poll().catch((error) => this.host.notify(`The Job watch poll failed: ${errorText(error)}`, 'warning')).finally(() => this.armTick());
		}, this.options.config.tickMs);
		unref(handle);
		this.tickTimer = handle;
	}

	/**
	 * Hold one blocking Herdr wait per working Job.
	 *
	 * This is the difference between a watch that notices a settlement immediately
	 * and one that notices it within a minute. Only a *working* Job gets one: a wait
	 * is a blocking call, so a pane that is already idle answers it at once and a pane
	 * with no agent at all answers `agent not found` at once. Re-arming either after
	 * every round is not a wait, it is a spin, and a spin that spawns a Herdr process
	 * each time. `job_watch`'s probes cover the Jobs a wait cannot say anything about
	 * yet.
	 *
	 * A wait is aborted the moment its Job stops being one this watch waits on,
	 * because a waiting call outlives its Job and an abandoned waiter would hold a
	 * promise (and a socket) forever.
	 */
	private armWaiters(): void {
		if (this.stopped) return;
		const wanted = new Set(watchedJobs(this.state).filter((job) => job.lastStatus === 'working').map((job) => job.pane));
		for (const [pane, waiter] of this.waiters) {
			if (wanted.has(pane)) continue;
			waiter.controller.abort();
			this.waiters.delete(pane);
		}
		for (const job of watchedJobs(this.state)) {
			if (job.lastStatus !== 'working') continue;
			if (this.waiters.has(job.pane)) continue;
			const controller = new AbortController();
			this.waiters.set(job.pane, { controller });
			void agentWait(this.options.run, job.pane, ['idle', 'done', 'blocked', 'unknown'], undefined, controller.signal)
				.then(
					() => {
						this.waiters.delete(job.pane);
						if (this.stopped) return undefined;
						return this.poll().catch((error) => this.host.notify(`The Job watch poll failed: ${errorText(error)}`, 'warning'));
					},
					(error: unknown) => {
						this.waiters.delete(job.pane);
						// A wait that could not be made is not an observation of the Job. Polling
						// here would be the spin this gate exists to avoid, so the round that
						// re-decides the waits is left to the tick or to `job_watch`'s probes.
						if (controller.signal.aborted || isMissingPane(error)) return undefined;
						return undefined;
					},
				)
				.catch(() => {
					// A poll failure is reported by the poll itself; a wait failure must
					// never take the watch down, because the tick is still underneath it.
				});
		}
	}

	/**
	 * Poll a Job that no blocking wait can say anything about yet.
	 *
	 * A dispatched Job is idle until Pi takes its prompt, and a pane whose session
	 * died is idle too. Neither answers a blocking wait usefully, so this is a plain
	 * timer at a short cadence until the Job is observed working (and a wait takes
	 * over) or the boot grace runs out (and the round reports it).
	 */
	private armProbes(): void {
		if (this.stopped) return;
		const probing = watchedJobs(this.state).some(
			(job) =>
				job.lastStatus !== 'working' &&
				job.promptDelivered &&
				!job.provisioned &&
				job.workedAt === 0 &&
				this.clock() - job.openedAt < this.options.config.tickMs,
		);
		if (!probing) {
			this.clear(this.probeTimer);
			this.probeTimer = undefined;
			return;
		}
		if (this.probeTimer !== undefined) return;
		const arm = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		const handle = arm(() => {
			this.probeTimer = undefined;
			void this.poll().catch((error) => this.host.notify(`The Job watch probe failed: ${errorText(error)}`, 'warning'));
		}, PROBE_MS);
		unref(handle);
		this.probeTimer = handle;
	}

	/** Arm or cancel the timers for something worth waiting on, and for the earliest unhandled Wake. */
	private retune(): void {
		if (this.stopped) return;
		this.armWaiters();
		this.armProbes();
		const pending = openDeliveries(this.state).filter((delivery) => delivery.nextRetryAt !== undefined);
		const jobs = this.state.jobs.length > 0;
		if (pending.length === 0 && !jobs) {
			this.clear(this.retryTimer);
			this.retryTimer = undefined;
			this.retryArmedFor = undefined;
			return;
		}
		const next = pending.reduce<number | undefined>((earliest, delivery) => {
			const at = delivery.nextRetryAt;
			if (at === undefined) return earliest;
			return earliest === undefined || at < earliest ? at : earliest;
		}, undefined);
		if (next === undefined) return;
		if (this.retryTimer !== undefined && this.retryArmedFor !== undefined && this.retryArmedFor <= next) return;
		this.clear(this.retryTimer);
		const wait = Math.max(0, next - this.clock());
		const arm = this.options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		const handle = arm(() => {
			this.retryTimer = undefined;
			this.retryArmedFor = undefined;
			void this.poll().catch((error) => this.host.notify(`The Job watch retry failed: ${errorText(error)}`, 'warning'));
		}, wait);
		unref(handle);
		this.retryTimer = handle;
		this.retryArmedFor = next;
	}

	private clear(handle: { unref?: () => void } | number | undefined): void {
		if (handle === undefined) return;
		const clear = this.options.clearTimer ?? ((target: unknown) => clearTimeout(target as ReturnType<typeof setTimeout>));
		try {
			clear(handle as never);
		} catch {
			// Clearing a fired timer is not an error worth reporting.
		}
	}

	// -------------------------------------------------------------------------
	// Reporting
	// -------------------------------------------------------------------------

	/** A human-readable report of the open set, for `job status` and `job_watch status`. */
	describe(observations: ReadonlyMap<string, { readonly status: PaneStatus; readonly present?: boolean }>): string {
		if (this.state.jobs.length === 0) {
			return this.state.armed ? 'No open Jobs in this Run scope.' : 'No Job watch is armed, so nothing is watched. Open a Job to arm it.';
		}
		const lines: string[] = [];
		const active = watchedJobs(this.state);
		const retained = retainedJobs(this.state);
		lines.push(`${active.length} watched, ${retained.length} retained (cap ${this.options.config.retentionCap})`);
		for (const job of this.state.jobs) {
			const observation = observations.get(job.pane);
			// A window Herdr no longer has is reported as gone rather than as whatever it
			// happened to be doing when it died.
			const status = observation?.present === false ? 'dead' : observation?.status ?? job.lastStatus;
			const parts = [
				`- ${job.name} (${job.ticket})`,
				job.pane,
				`[${job.workspace}${job.mode === 'worktree' && job.branch ? ` ${job.branch}` : ''}]`,
				status ?? 'unknown',
			];
			if (job.retention === 'auto') parts.push('retained for inspection (automatic)');
			if (job.retention === 'manual') parts.push('retained for inspection');
			if (job.claimedComplete) parts.push('declared complete');
			if (job.provisioned) parts.push('provisioned (no session)');
			if (job.heldUntil > 0 && job.heldUntil > this.clock()) parts.push('held');
			if (job.promptFailure) parts.push('prompt delivery failed');
			lines.push(parts.join(' '));
		}
		const open = openDeliveries(this.state);
		if (open.length > 0) {
			lines.push('Wake news with no answer yet:');
			for (const delivery of open) {
				lines.push(`- delivery ${delivery.attempts} (${delivery.state}): ${delivery.reason}`);
			}
			lines.push('Answer each by reconciling its Job: `job read` for the evidence, then `job retain` to keep the window readable or `job close` to end it.');
		}
		return lines.join('\n');
	}
}

function identitiesFrom(message: unknown): readonly string[] {
	if (!isWakeMessage(message)) return [];
	return identitiesOf(message);
}

function unref(handle: { unref?: () => void } | number): void {
	if (typeof handle !== 'number' && handle.unref) handle.unref();
}

/** Drop a Job's progress file once its window is gone. */
export function forgetProgress(spoolPath: string, token: string | undefined): void {
	try {
		dropProgress(spoolPath, token);
	} catch {
		// The TTL sweep is the backstop.
	}
}
