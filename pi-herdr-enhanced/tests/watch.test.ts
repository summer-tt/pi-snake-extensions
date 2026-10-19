/**
 * The watch's decision rules.
 *
 * Every test drives one observation round directly and asserts on what the watch
 * decided, because those rules are the difference between a watch that is useful
 * and one that either wakes constantly or never wakes at all.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, type ResolvedConfig } from '../src/config.ts';
import { emptyWatch, type JobRecord, type WatchState } from '../src/registry.ts';
import { ensureSpool, writeClaim } from '../src/spool.ts';
import { Watch, type WatchHost } from '../src/watch.ts';
import type { WakeReport } from '../src/wake.ts';
import { FakeHerdr } from './fake-herdr.ts';
import { makeJob } from './fixtures.ts';

/** A timer seam that records the callbacks instead of scheduling them. */
class Timers {
	private next = 1;
	private readonly pending = new Map<number, { fn: () => void; ms: number }>();

	readonly set = (fn: () => void, ms: number): { unref: () => void; id: number } => {
		const id = this.next;
		this.next += 1;
		this.pending.set(id, { fn, ms });
		return { id, unref: () => {} };
	};

	readonly clear = (handle: { id?: number } | undefined): void => {
		if (handle?.id !== undefined) this.pending.delete(handle.id);
	};

	/** Run every outstanding callback. */
	fire(): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) entry.fn();
	}

	/** Run every outstanding callback, waiting for the asynchronous ones. */
	async fireAsync(): Promise<void> {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) await entry.fn();
	}

	get outstanding(): number {
		return this.pending.size;
	}

	/** The shortest delay currently scheduled, for asserting a retry ladder step. */
	get shortestDelay(): number | undefined {
		return [...this.pending.values()].map((entry) => entry.ms).sort((left, right) => left - right)[0];
	}
}

interface Harness {
	readonly watch: Watch;
	readonly herdr: FakeHerdr;
	readonly timers: Timers;
	readonly injected: WakeReport[];
	readonly persisted: WatchState[];
	readonly closed: JobRecord[];
	readonly notes: string[];
	readonly spoolPath: string;
	cleanup(): void;
}

function harness(
	options: {
		readonly jobs?: readonly JobRecord[];
		readonly config?: Partial<ResolvedConfig>;
		readonly herdr?: FakeHerdr;
		readonly at?: () => number;
		/** Leave the spool directory uncreated, as every Run scope is before its first Job. */
		readonly spoolMissing?: boolean;
	} = {},
): Harness {
	const root = mkdtempSync(join(tmpdir(), 'phe-watch-'));
	const spoolPath = join(root, 'spool');
	// The spool is created by the first `job open` that needs it, so a scope with no
	// Jobs yet has none — which is the state a fresh session's first poll sees.
	if (options.spoolMissing !== true) ensureSpool(spoolPath);
	const herdr = options.herdr ?? new FakeHerdr();
	const timers = new Timers();
	const injected: WakeReport[] = [];
	const persisted: WatchState[] = [];
	const closed: JobRecord[] = [];
	const notes: string[] = [];
	const config: ResolvedConfig = { ...DEFAULT_CONFIG, ...options.config };

	const host: WatchHost = {
		persist: (state) => persisted.push(state),
		inject: (report) => injected.push(report),
		notify: (message) => notes.push(message),
		close: async (job) => {
			closed.push(job);
		},
	};

	const watch = new Watch(host, {
		run: herdr.run,
		config,
		spoolPath,
		...(options.at ? { clock: options.at } : {}),
		setTimer: timers.set as never,
		clearTimer: timers.clear as never,
	});
	// Every Job's pane exists unless a test deliberately removes it: `paneExists`
	// answers for panes in either set, and a Job whose pane is absent is classified
	// `dead` rather than `idle`.
	for (const job of options.jobs ?? []) herdr.shells.add(job.pane);
	watch.restore({ ...emptyWatch(), jobs: options.jobs ?? [], armed: true });

	return {
		watch,
		herdr,
		timers,
		injected,
		persisted,
		closed,
		notes,
		spoolPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test('a working Job is never announced', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		assert.equal(await h.watch.poll(), undefined);
		assert.deepEqual(h.injected, []);
	} finally {
		h.cleanup();
	}
});

test('a settled Job is announced once, and not again until it works again', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		const first = await h.watch.poll();
		assert.ok(first, 'a Job that is not working is announced');
		assert.match(first.causes[0]?.reason ?? '', /no completion claim/);
		h.timers.fire();
		assert.equal(h.injected.length, 1, 'exactly one Wake');

		assert.equal(await h.watch.poll(), undefined, 'the same stall is not announced twice');
		h.timers.fire();
		assert.equal(h.injected.length, 1);

		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		h.herdr.setAgent('w1:p1', 'idle');
		const second = await h.watch.poll();
		assert.ok(second, 'a Job that worked again and then settled is a new stall');
	} finally {
		h.cleanup();
	}
});

test('Jobs that stop together produce one Wake, not a stream', async () => {
	const h = harness({
		jobs: [makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a' }), makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'b' })],
	});
	try {
		const report = await h.watch.poll();
		assert.equal(report?.causes.length, 2);
		assert.equal(h.injected.length, 0, 'nothing is delivered inside the debounce window');
		h.timers.fire();
		assert.equal(h.injected.length, 1, 'one Wake carries both causes');
		assert.equal(h.injected[0]?.causes.length, 2);
	} finally {
		h.cleanup();
	}
});

test('a pane that vanished is announced as dead', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p404' })] });
	try {
		h.herdr.shells.clear();
		const report = await h.watch.poll();
		assert.match(report?.causes[0]?.reason ?? '', /is gone: its window no longer exists/);
	} finally {
		h.cleanup();
	}
});

test('a claim is recorded and named, but the Wake follows settlement — and it bypasses the debounce', async () => {
	const job = makeJob({ pane: 'w1:p1', token: 'job-a', claimedComplete: false });
	const h = harness({ jobs: [job] });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		writeClaim(h.spoolPath, { name: job.name, ticket: job.ticket, scope: job.scope, token: job.token, claimedAt: 1 });
		assert.equal(await h.watch.poll(), undefined, 'a claim on a working Job does not wake anybody');
		assert.equal(h.watch.openJobs[0]?.claimedComplete, true, 'but it is recorded');

		h.herdr.setAgent('w1:p1', 'idle');
		const report = await h.watch.poll();
		assert.equal(report?.causes[0]?.claimed, true);
		assert.match(report?.causes[0]?.reason ?? '', /declared complete/);
		assert.equal(h.injected.length, 1, 'a claim does not wait for the debounce window');
	} finally {
		h.cleanup();
	}
});

test('one Job\'s token cannot claim another Job', async () => {
	const a = makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a', token: 'job-a' });
	const b = makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'b', token: 'job-b' });
	const h = harness({ jobs: [a, b] });
	try {
		writeClaim(h.spoolPath, { name: 'a', ticket: a.ticket, scope: a.scope, token: 'job-a', claimedAt: 1 });
		await h.watch.poll();
		assert.equal(h.watch.openJobs.find((job) => job.name === 'a')?.claimedComplete, true);
		assert.equal(h.watch.openJobs.find((job) => job.name === 'b')?.claimedComplete, false);
	} finally {
		h.cleanup();
	}
});

test('a hold suppresses the ordinary cause but never hides a dead pane', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		h.watch.hold(['w1:p1'], 'waiting on a human', 60_000);
		assert.equal(await h.watch.poll(), undefined, 'a held Job does not wake the Orchestrator');

		h.herdr.setAgent('w1:p1', 'idle');
		h.watch.release(['w1:p1']);
		const report = await h.watch.poll();
		assert.match(report?.causes[0]?.reason ?? '', /is idle/);

		// A dead pane is not an ordinary decision, so a hold does not mask it.
		const dead = harness({ jobs: [makeJob({ pane: 'w1:p404' })] });
		try {
			dead.herdr.shells.clear();
			dead.watch.hold(['w1:p404'], 'human', 60_000);
			const deadReport = await dead.watch.poll();
			assert.match(deadReport?.causes[0]?.reason ?? '', /is gone: its window no longer exists/);
		} finally {
			dead.cleanup();
		}
	} finally {
		h.cleanup();
	}
});

test('a consumed Wake is acknowledged only when the run ends normally', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		const report = await h.watch.poll();
		h.timers.fire();
		const identity = report?.causes[0]?.id as string;
		h.watch.observeWakeMessage({ customType: 'pi-herdr-enhanced-job-watch', details: { identities: [identity] } });
		assert.equal(h.watch.watchState.deliveries.find((delivery) => delivery.id === identity)?.state, 'consumed');

		h.watch.startRun();
		h.watch.noteTurnOutcome('completed');
		h.watch.onAgentSettled(false);
		assert.equal(h.watch.watchState.deliveries.find((delivery) => delivery.id === identity)?.state, 'acknowledged');
		assert.equal(h.watch.openJobs[0]?.retention, 'auto', 'delivered news is what retires a finished window into retention');
	} finally {
		h.cleanup();
	}
});

test('a Wake the run ended in error is retried with the same identity, never a new one', async () => {
	const at = 1_000;
	// A Job that has been seen working and then is not working is exactly what the
	// watch announces; the ladder only applies to how that news is retried.
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1', lastStatus: 'working', workedAt: at, openedAt: 0 })], at: () => at });
	try {
		const report = await h.watch.poll();
		h.timers.fire();
		const identity = report?.causes[0]?.id as string;
		h.watch.observeWakeMessage({ customType: 'pi-herdr-enhanced-job-watch', details: { identities: [identity] } });
		h.watch.startRun();
		h.watch.noteTurnOutcome('error');
		h.watch.onAgentSettled(false);

		const delivery = h.watch.watchState.deliveries.find((candidate) => candidate.id === identity);
		assert.equal(delivery?.state, 'failed');
		assert.equal(delivery?.outcome, 'error');
		assert.equal(delivery?.nextRetryAt, at + 60_000, 'the first ladder step');
		assert.equal(h.timers.shortestDelay, 60_000);
	} finally {
		h.cleanup();
	}
});

test('an aborted run is never retried automatically', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1', lastStatus: 'working', workedAt: 1, openedAt: 0 })] });
	try {
		const report = await h.watch.poll();
		h.timers.fire();
		const identity = report?.causes[0]?.id as string;
		h.watch.observeWakeMessage({ customType: 'pi-herdr-enhanced-job-watch', details: { identities: [identity] } });
		h.watch.startRun();
		h.watch.onAgentSettled(true);
		const delivery = h.watch.watchState.deliveries.find((candidate) => candidate.id === identity);
		assert.equal(delivery?.outcome, 'aborted');
		assert.equal(delivery?.nextRetryAt, undefined, 'a cancelled run is not a failed one, and nothing can tell them apart');
	} finally {
		h.cleanup();
	}
});

test('a Wake raised mid-run is held until a drain boundary, so the news is current', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		h.watch.startRun();
		h.watch.startTurn();
		await h.watch.poll();
		h.timers.fire();
		assert.deepEqual(h.injected, [], 'nothing is injected while a run is live');

		h.watch.endTurn({ modelFinished: true });
		assert.equal(h.injected.length, 1, 'the Wake flushes where Pi drains its follow-up queue');
	} finally {
		h.cleanup();
	}
});

test('a Retained window is inert, unless it is working again', async () => {
	const job = makeJob({ pane: 'w1:p1' });
	const h = harness({ jobs: [job] });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		h.herdr.setAgent('w1:p1', 'idle');
		await h.watch.poll();
		h.timers.fire();
		const identity = h.injected[0]?.causes[0]?.id as string;
		h.watch.observeWakeMessage({ customType: 'pi-herdr-enhanced-job-watch', details: { identities: [identity] } });
		h.watch.startRun();
		h.watch.noteTurnOutcome('completed');
		h.watch.onAgentSettled(false);
		assert.equal(h.watch.openJobs[0]?.retention, 'auto');

		assert.equal(await h.watch.poll(), undefined, 'a Retained window is out of the watch decision entirely');

		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		assert.equal(h.watch.openJobs[0]?.retention, 'none', 'real work in a Retained window must not be hidden');
	} finally {
		h.cleanup();
	}
});

test('the retention cap closes the oldest Retained windows and never a live one', async () => {
	const a = makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a', retention: 'auto', retainedAt: 10 });
	const b = makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'b', retention: 'auto', retainedAt: 20 });
	const live = makeJob({ pane: 'w3:p1', workspace: 'w3', name: 'c' });
	const h = harness({ jobs: [a, b, live], config: { retentionCap: 1 } });
	try {
		h.herdr.setAgent('w3:p1', 'working');
		await h.watch.poll();
		assert.deepEqual(h.closed.map((job) => job.name), ['a']);
		assert.equal(h.watch.openJobs.some((job) => job.name === 'c'), true, 'a live window is never evicted by a cap');
	} finally {
		h.cleanup();
	}
});

test('the retry timer is cancelled once nothing is left to watch, so an idle session can exit', async () => {
	const h = harness({ jobs: [] });
	try {
		await h.watch.poll();
		h.watch.stop();
		assert.equal(h.timers.outstanding, 0, 'a stopped watch holds no timer');
	} finally {
		h.cleanup();
	}
});

test('a status report says whether a watch is armed at all', async () => {
	const quiet = harness();
	try {
		assert.match(quiet.watch.describe(new Map()), /No open Jobs in this Run scope/);
	} finally {
		quiet.cleanup();
	}
	const unarmed = harness();
	try {
		unarmed.watch.restore(emptyWatch());
		assert.match(unarmed.watch.describe(new Map()), /No Job watch is armed/);
	} finally {
		unarmed.cleanup();
	}
});

test('a status report names what each Job is and what is still unhandled', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1', claimedComplete: true, provisioned: true })] });
	try {
		await h.watch.poll();
		const report = h.watch.describe(new Map([['w1:p1', { status: 'idle' as const }]]));
		assert.match(report, /fix-142 \(#142\)/);
		assert.match(report, /declared complete/);
		assert.match(report, /provisioned \(no session\)/);
		assert.match(report, /Wake news with no answer yet/);
	} finally {
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// "Not working" has to mean "stopped working"
//
// The rules below are what keep a dispatch from waking the Orchestrator about
// itself: a pane is idle for as long as Pi takes to accept its prompt, and a pane
// with no session yet reads as `unknown`, so both look exactly like a Job that
// finished. They are also what keeps the watch from spinning: a blocking wait only
// means something for a Job that is working.
// ---------------------------------------------------------------------------

/** A Job whose window exists and whose prompt was delivered, at a controllable instant. */
function dispatching(overrides: Partial<JobRecord> = {}): JobRecord {
	return makeJob({ pane: 'w1:p1', lastStatus: '', workedAt: 0, promptDelivered: true, provisioned: false, openedAt: 1_000_000, ...overrides });
}

test('a dispatched Job that has not been seen working is not announced, however idle its pane is', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching()], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'idle');
		assert.equal(await h.watch.poll(), undefined, 'the seconds before Pi takes its prompt are not a settle');
		at += 2_000;
		assert.equal(await h.watch.poll(), undefined, 'nor are the seconds after');
		assert.deepEqual(h.injected, [], 'nothing may be injected before the Job has run');
		assert.equal(h.watch.watchState.jobs[0]?.workedAt, 0, 'and no working observation is invented');
	} finally {
		h.cleanup();
	}
});

test('once the Job is seen working, stopping is announced exactly as before', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching()], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		assert.equal(await h.watch.poll(), undefined);
		assert.equal(h.watch.watchState.jobs[0]?.workedAt, at, 'the working observation is recorded');

		at += 5_000;
		h.herdr.setAgent('w1:p1', 'idle');
		const report = await h.watch.poll();
		assert.ok(report, 'a Job that ran and then stopped is the news the watch exists for');
		assert.match(String(report.causes[0]?.reason), /at w1:p1 is idle with no completion claim/);
	} finally {
		h.cleanup();
	}
});

test('the boot grace reports a Job that never worked, so a hung Worker cannot hide', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching()], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'idle');
		assert.equal(await h.watch.poll(), undefined);
		at += DEFAULT_CONFIG.tickMs;
		const report = await h.watch.poll();
		assert.ok(report, 'past the grace a Job that never worked has to be reported');
		assert.match(String(report.causes[0]?.reason), /no completion claim/);
	} finally {
		h.cleanup();
	}
});

test("Herdr's own done and blocked count without ever seeing the Job work", async () => {
	for (const status of ['done', 'blocked'] as const) {
		const at = 1_000_000;
		const h = harness({ jobs: [dispatching()], at: () => at });
		try {
			h.herdr.setAgent('w1:p1', status);
			const report = await h.watch.poll();
			assert.ok(report, `a booting pane never reports ${status}, so it is evidence on its own`);
			assert.match(String(report.causes[0]?.reason), new RegExp(`at w1:p1 is ${status} with no completion claim`));
		} finally {
			h.cleanup();
		}
	}
});

test('a Job whose prompt never reached the pane is not announced', async () => {
	const h = harness({ jobs: [dispatching({ promptDelivered: false, promptFailure: 'the pane died' })], at: () => 2_000_000 });
	try {
		h.herdr.setAgent('w1:p1', 'unknown');
		assert.equal(await h.watch.poll(), undefined, 'the open that failed already told the Orchestrator');
	} finally {
		h.cleanup();
	}
});

test('a window with no session at all is announced, and only once', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching({ promptDelivered: false, provisioned: true, promptFailure: 'pane not available' })], at: () => at });
	try {
		const first = await h.watch.poll();
		assert.ok(first, 'a window that will never run anything is worth saying');
		assert.match(String(first.causes[0]?.reason), /with no completion claim/);
		at += 2_000;
		assert.equal(await h.watch.poll(), undefined, 'and it is announced once');
	} finally {
		h.cleanup();
	}
});

test('an idle Job gets no blocking wait, so rounds cannot spin', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching()], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'idle');
		await h.watch.poll();
		at += 2_000;
		await h.watch.poll();
		// `agent wait` on an idle pane answers immediately, so arming one per round is
		// a spin that spawns a Herdr process each time rather than a wait.
		assert.deepEqual(
			h.herdr.calls.filter((call) => call[0] === 'agent' && call[1] === 'wait'),
			[],
			'an idle Job must not be waited on',
		);
		assert.ok(h.timers.shortestDelay !== undefined, 'it is probed on a timer instead');
	} finally {
		h.cleanup();
	}
});

test('a working Job does get a blocking wait', async () => {
	const h = harness({ jobs: [dispatching()] });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		const waits = h.herdr.calls.filter((call) => call[0] === 'agent' && call[1] === 'wait');
		assert.equal(waits.length, 1, 'this is the difference between noticing a settle at once and within a minute');
		assert.deepEqual(waits[0]?.slice(2, 3), ['w1:p1']);
	} finally {
		h.cleanup();
	}
});

test('a delivered Wake arms the first rung of the retry ladder', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching()], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		at += 1_000;
		h.herdr.setAgent('w1:p1', 'idle');
		const report = await h.watch.poll();
		h.timers.fire();
		const identity = report?.causes[0]?.id;
		const delivery = h.watch.watchState.deliveries.find((candidate) => candidate.id === identity);
		// A Wake that Pi never hands to a run is exactly the "queued and lost" case the
		// identity exists for, so the ladder starts at delivery rather than at the
		// first failure.
		assert.equal(delivery?.state, 'injected');
		assert.equal(delivery?.nextRetryAt, at + 60_000, 'one minute, the first rung');
		assert.equal(h.timers.shortestDelay, 60_000, 'and the timer for it is armed');

		// The retry is the same identity, so it can never be mistaken for fresh news.
		// The armed timer's callback is this same round, so driving the round directly
		// keeps the test deterministic while the arming above proves the timer is real.
		at += 60_000;
		await h.watch.poll();
		const retried = h.watch.watchState.deliveries.find((candidate) => candidate.id === identity);
		assert.equal(retried?.attempts, 2);
		assert.equal(retried?.nextRetryAt, at + 300_000, 'the second rung: five minutes');
		assert.equal(h.injected.length, 2, 'the same Wake was re-injected, not replaced');
		assert.equal(h.injected[1]?.causes[0]?.id, identity);
	} finally {
		h.cleanup();
	}
});

test('forget drops a replaced window and the news that named it', async () => {
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching({ workspace: 'w1', pane: 'w1:p1' })], at: () => at });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		at += 1_000;
		h.herdr.setAgent('w1:p1', 'idle');
		await h.watch.poll();
		h.timers.fire();
		assert.equal(h.watch.watchState.deliveries.length, 1);

		h.watch.forget(['w1:p1']);
		assert.deepEqual(h.watch.openJobs, [], 'a Job whose pane is gone is replaced, not kept beside its replacement');
		assert.deepEqual(
			h.watch.watchState.deliveries.filter((delivery) => delivery.state !== 'acknowledged'),
			[],
			'and the news it raised goes with it',
		);
	} finally {
		h.cleanup();
	}
});

test('forgetting one Job leaves its siblings in the same workspace alone', async () => {
	const at = 1_000_000;
	// Two Jobs sharing one workspace, which is what tab mode is.
	const h = harness({
		jobs: [dispatching({ name: 'a', pane: 'w1:p1', workspace: 'w1' }), dispatching({ name: 'b', pane: 'w1:p2', workspace: 'w1' })],
		at: () => at,
	});
	try {
		h.herdr.setAgent('w1:p1', 'working');
		h.herdr.setAgent('w1:p2', 'working');
		await h.watch.poll();
		h.watch.forget(['w1:p1']);
		assert.deepEqual(h.watch.openJobs.map((job) => job.name), ['b'], 'closing one Job must not unregister the other');
	} finally {
		h.cleanup();
	}
});

test('a Run scope with no spool yet is not a warning', async () => {
	const h = harness({ jobs: [dispatching()], spoolMissing: true });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		await h.watch.poll();
		assert.deepEqual(h.notes, [], 'nothing has been claimed yet, which is how every scope starts');
	} finally {
		h.cleanup();
	}
});

test('an unusable spool is still reported', async () => {
	// The silence above is about absence only: a spool that exists and is wrong has
	// to reach the Orchestrator, because a claim written into it would be readable
	// by anyone.
	const h = harness({ jobs: [dispatching()] });
	try {
		h.herdr.setAgent('w1:p1', 'working');
		chmodSync(h.spoolPath, 0o755);
		await h.watch.poll();
		assert.equal(h.notes.length, 1, `exactly one warning: ${JSON.stringify(h.notes)}`);
		assert.match(h.notes[0] ?? '', /spool at .* is unusable/);
		assert.match(h.notes[0] ?? '', /owner-only/);
	} finally {
		h.cleanup();
	}
});

test('news a live run has picked up is not re-sent while that run is working', async () => {
	// The bug this pins down: the Wake was consumed at delivery, the Orchestrator
	// started reconciling — reading panes, running checks, which takes minutes — and
	// the ladder fired again 60 seconds in, injecting the same news about the same
	// Job. Two Wake texts for one reconciliation is how a handled Job starts to look
	// like an ignored one.
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching({ lastStatus: 'working', workedAt: 1_000_000, openedAt: 0 })], at: () => at });
	try {
		const report = await h.watch.poll();
		h.timers.fire();
		const identity = report?.causes[0]?.id as string;
		h.watch.observeWakeMessage({ customType: 'pi-herdr-enhanced-job-watch', details: { identities: [identity] } });
		assert.equal(h.watch.watchState.deliveries[0]?.state, 'consumed');
		assert.equal(h.injected.length, 1);

		h.watch.startRun();
		at += 120_000;
		await h.watch.poll();
		assert.equal(h.injected.length, 1, 'a run that is working on the news owns it');
		assert.equal(h.watch.watchState.deliveries[0]?.attempts, 1, 'and its ladder rung is not spent');

		// A run that ends normally answers it; the ladder never fires for it at all.
		h.watch.noteTurnOutcome('completed');
		h.watch.onAgentSettled(false);
		assert.equal(h.watch.watchState.deliveries[0]?.state, 'acknowledged');
		at += 600_000;
		await h.watch.poll();
		assert.equal(h.injected.length, 1, 'answered news never comes back');
	} finally {
		h.cleanup();
	}
});

test('news still queued for a turn boundary is queued, not lost', async () => {
	// A Wake raised mid-turn is deliberately held until the turn drains. Holding it
	// past its rung is not a loss, so the ladder must not inject a second copy while
	// the first is waiting in the queue.
	let at = 1_000_000;
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1', lastStatus: 'working', workedAt: 1_000_000, openedAt: 0 })], at: () => at });
	try {
		h.watch.startRun();
		await h.watch.poll();
		h.timers.fire();
		assert.equal(h.injected.length, 0, 'the run is live, so delivery is held');

		at += 120_000;
		await h.watch.poll();
		assert.equal(h.injected.length, 0, 'and it is still only held, not re-sent');
		assert.equal(
			h.watch.watchState.deliveries.filter((delivery) => delivery.state !== 'acknowledged').length,
			1,
			'exactly one delivery exists for it',
		);
	} finally {
		h.cleanup();
	}
});

test('retaining a Job answers the news that named it', async () => {
	// `job retain` is the reconciliation a Wake asks for: the window is captured and
	// leaves the watch. Leaving the news open would keep `job status` complaining about
	// a Job the operator has just dealt with, and would re-send it on the ladder.
	let at = 1_000_000;
	const h = harness({ jobs: [dispatching({ lastStatus: 'working', workedAt: 1_000_000, openedAt: 0 })], at: () => at });
	try {
		await h.watch.poll();
		h.timers.fire();
		const identity = h.watch.watchState.deliveries.find((delivery) => delivery.state !== 'acknowledged')?.id as string;

		const answered = h.watch.resolveNews(['w1:p1']);
		assert.deepEqual([...answered], [identity]);
		assert.deepEqual(
			h.watch.watchState.deliveries.filter((delivery) => delivery.state !== 'acknowledged'),
			[],
			'nothing is left to nag about',
		);
		assert.equal(h.watch.watchState.deliveries.find((delivery) => delivery.id === identity)?.outcome, 'completed');

		at += 600_000;
		await h.watch.poll();
		assert.equal(h.injected.length, 1, 'and the answered news never comes back');
		assert.deepEqual(h.watch.resolveNews(['w9:p9']), [], 'a pane with no news answers nothing');
	} finally {
		h.cleanup();
	}
});

test('a Job closed while its Wake is still queued takes the queued news with it', async () => {
	// A Wake raised mid-turn waits in the queue for the turn to drain, which can be
	// minutes. In that window an operator can retain and close the Job — and a queue
	// that kept the news would then inject it about a window that no longer exists,
	// with its delivery already gone, so nothing the operator calls can answer it.
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		h.watch.startRun();
		await h.watch.poll();
		h.timers.fire();
		assert.deepEqual(h.injected, [], 'the news is queued, not delivered');

		h.watch.forget(['w1:p1']);
		h.watch.endRun();
		assert.deepEqual(h.injected, [], 'closing the Job takes its queued news with it');

		// A sibling in the same round keeps its own news: the queue is filtered, not
		// discarded wholesale.
		const sibling = harness({ jobs: [makeJob({ pane: 'w1:p1' }), makeJob({ pane: 'w1:p2' })] });
		try {
			sibling.watch.startRun();
			await sibling.watch.poll();
			sibling.timers.fire();
			sibling.watch.forget(['w1:p1']);
			sibling.watch.endRun();
			assert.deepEqual(
				sibling.injected.flatMap((report) => report.causes.map((cause) => cause.panes[0])),
				['w1:p2'],
				'only the closed pane drops out of the queued round',
			);
		} finally {
			sibling.cleanup();
		}
	} finally {
		h.cleanup();
	}
});

test('retaining a Job while its Wake is queued answers the queued copy too', async () => {
	const h = harness({ jobs: [makeJob({ pane: 'w1:p1' })] });
	try {
		h.watch.startRun();
		await h.watch.poll();
		h.timers.fire();
		assert.deepEqual(h.injected, []);

		h.watch.resolveNews(['w1:p1']);
		h.watch.endRun();
		assert.deepEqual(h.injected, [], 'the operator has already answered this news');
	} finally {
		h.cleanup();
	}
});
