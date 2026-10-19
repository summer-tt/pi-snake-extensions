/**
 * The watch against real windows.
 *
 * Everything a Wake decides is decided from a real Herdr pane, and everything the
 * watch does about a finished Job — retaining it, evicting it past the cap,
 * holding it, dismissing it, closing it — is a real Herdr operation on a real tab.
 * These scenarios therefore seed Job records for real windows instead of
 * dispatching Workers: the window, the pane, the ownership record and the closing
 * are production objects, and only the Pi session inside is omitted, because no
 * scenario here is about the session.
 *
 * Each scenario keeps its Job set as small as its claim allows. In tab mode a Job's
 * workspace is the Orchestrator's own workspace — every Job shares it — so the
 * scenarios that touch one window always have a sibling beside it and assert the
 * sibling survives; that shared workspace is the setup the watch has to get right,
 * not a convenience.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { ownershipFor, writeOwner } from '../../src/ownership.ts';
import { closeTab, closeWorkspace, createTab, createWorkspace, paneAlive, runInPane, tempDir, waitFor, workspaceAlive } from './herdr-e2e.ts';
import { ExtensionHost, makeTabRunning } from './host.ts';
import { seedJob } from './seeds.ts';

const adjustments = { timeout: 600_000 } as const;

/**
 * Force one observation round, and return the Wake it raised — or `undefined` for a
 * round that raised none.
 *
 * `job_watch wake` runs the round, but the Wake goes out through the same debounce
 * the tick uses, so it arrives shortly *after* the call returns. A scenario that
 * asserted on the absence of a Wake without waiting past that debounce would be
 * asserting on nothing at all, which is why the absence here is confirmed by
 * waiting for it.
 */
async function forcedRound(host: ExtensionHost): Promise<string | undefined> {
	const before = host.messages.length;
	await host.ok('job_watch', { action: 'wake' });
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (host.messages.length > before) return host.lastWake().content;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return undefined;
}

test('the retention cap evicts the oldest Retained window for real', { ...adjustments, ...{ name: 'retention' } }, async () => {
	const host = new ExtensionHost({ name: 'retention', retentionCap: 1, debounceMs: 50, tickMs: 400 });
	await host.open();
	const now = Date.now();
	// `older` was retained by hand long ago and is counted against the cap already;
	// `later` has just stopped working and will be retained automatically. Giving the
	// two different retention times is what makes "the oldest is evicted" a claim
	// about the queue rather than about which record happened to be written first.
	const older = await makeTabRunning(host, '#7 older');
	const later = await makeTabRunning(host, '#8 later');
	host.seedJobs.push(
		seedJob({ name: 'older', ticket: '#7', address: older, scope: host.scope, claimedComplete: true, lastStatus: 'idle', retention: 'manual', openedAt: now - 600_000 }),
		seedJob({ name: 'later', ticket: '#8', address: later, scope: host.scope, claimedComplete: true, lastStatus: 'idle', openedAt: now - 300_000 }),
	);
	await host.launch();
	try {
		const before = await host.ok('job_watch', { action: 'status' });
		assert.match(before, /^1 watched, 1 retained \(cap 1\)$/m, before);
		assert.match(before, /- older \(#7\) [^\n]*retained for inspection /, before);

		// A forced round is the same code path the tick takes.
		const raised = await forcedRound(host);
		assert.match(String(raised), /- Job later \(#8\)/, 'the Job that stopped working is the news');

		// The Wake is then consumed the way Pi consumes it: a run, the message in the
		// transcript, and the run settling. Acknowledging the news retains the Job it
		// named, and retention past the cap closes a window.
		await host.beginRun();
		await host.messageEnters();
		await host.settleRun();

		await waitFor('the evicted window to close', async () => !(await paneAlive(older.pane)));
		assert.equal(await paneAlive(later.pane), true, 'the newly Retained window stays readable');
		assert.deepEqual(
			host.jobs().map((job) => job.name),
			['later'],
			'an evicted Job leaves the watch entirely',
		);
		const after = await host.ok('job_watch', { action: 'status' });
		assert.match(after, /^0 watched, 1 retained \(cap 1\)$/m, after);
		assert.match(after, /retained for inspection \(automatic\)/, after);
	} finally {
		await host.stop();
	}
});

test('a held Job raises no Wake, and releasing it returns it to the watch', { ...adjustments, ...{ name: 'hold' } }, async () => {
	const host = new ExtensionHost({ name: 'hold', debounceMs: 50, tickMs: 400 });
	await host.open();
	const job = await makeTabRunning(host, '#9 held');
	// Never observed working and long past its boot grace: this Job *would* be
	// announced, which is what makes its silence while held mean something.
	host.seedJobs.push(seedJob({ name: 'held', ticket: '#9', address: job, scope: host.scope, lastStatus: 'idle', openedAt: Date.now() - 600_000 }));
	await host.launch();
	try {
		// The hold goes on first, so the silence that follows is the hold's and not the
		// silence of news that has already been raised.
		const held = await host.ok('job_watch', { action: 'hold', panes: [job.pane], note: 'a human is answering a question' });
		assert.match(held, /^Held held for \d+s\./, held);
		assert.equal(await forcedRound(host), undefined, 'an ordinary Wake decision is suppressed while held');
		assert.equal(host.messages.length, 0, 'and nothing was delivered behind the round');

		const status = await host.ok('job_watch', { action: 'status' });
		assert.match(status, /- held \(#9\) [^\n]*held/, 'the hold is visible on the Job, not invisible');
		assert.equal(host.jobs().length, 1, 'a hold narrows the watch; it never removes a Job from it');

		const released = await host.ok('job_watch', { action: 'release', panes: [job.pane] });
		assert.match(released, /^Released held\.$/);
		assert.match(String(await forcedRound(host)), /- Job held \(#9\)/, 'the decision is raised again');
		assert.equal(host.messages.length, 1, 'exactly once');
		assert.equal(await forcedRound(host), undefined, 'and the same stall is still announced only once');

		// A hold is a narrowing of the watch, never a licence to forget: the window is
		// still watched the whole time it is held.
		assert.equal(host.jobs().length, 1);
	} finally {
		await host.stop();
	}
});

test('a window that vanished underneath the watch is reported dead and dismissed once', { ...adjustments, ...{ name: 'dismiss' } }, async () => {
	const host = new ExtensionHost({ name: 'dismiss', debounceMs: 50, tickMs: 400 });
	await host.open();
	const gone = await makeTabRunning(host, '#10 gone');
	const sibling = await makeTabRunning(host, '#11 sibling');
	host.seedJobs.push(
		seedJob({ name: 'gone', ticket: '#10', address: gone, scope: host.scope, claimedComplete: true, lastStatus: 'idle', openedAt: Date.now() - 600_000 }),
		seedJob({ name: 'sibling', ticket: '#11', address: sibling, scope: host.scope, claimedComplete: true, lastStatus: 'idle', openedAt: Date.now() - 600_000 }),
	);
	await host.launch();
	try {
		// Whatever took the window away has already closed it, so `dismiss` closes a
		// window that is not there: the close has to be idempotent for that to work.
		await closeTab(gone.tab);
		await waitFor('the tab to disappear', async () => !(await paneAlive(gone.pane)));

		const status = await host.ok('job_watch', { action: 'status' });
		assert.match(status, /- gone \(#10\) [^\n]*dead/, 'a window Herdr no longer has is dead, not idle');

		const dismissed = await host.ok('job_watch', { action: 'dismiss', panes: [gone.pane] });
		assert.match(dismissed, /^Dismissed /, dismissed);
		assert.deepEqual(
			host.jobs().map((job) => job.name),
			['sibling'],
			'a dismissed Job leaves the watch and its sibling does not',
		);
		assert.equal(await paneAlive(sibling.pane), true);
	} finally {
		await host.stop();
	}
});

test('closing one Job leaves its sibling in the same workspace watched and open', { ...adjustments, ...{ name: 'siblings' } }, async () => {
	const host = new ExtensionHost({ name: 'siblings', debounceMs: 50, tickMs: 400 });
	await host.open();
	const first = await makeTabRunning(host, '#12 first');
	const second = await makeTabRunning(host, '#13 second');
	host.seedJobs.push(
		seedJob({ name: 'first', ticket: '#12', address: first, scope: host.scope, claimedComplete: true, lastStatus: 'idle', openedAt: Date.now() - 600_000 }),
		seedJob({ name: 'second', ticket: '#13', address: second, scope: host.scope, claimedComplete: true, lastStatus: 'idle', openedAt: Date.now() - 600_000 }),
	);
	await host.launch();
	try {
		// Both Jobs share the Orchestrator's workspace, so a close keyed on the
		// workspace rather than on the window would take the sibling with it. A Job
		// that declared completion needs no reason.
		const closed = await host.ok('job', { action: 'close', target: 'first' });
		assert.match(closed, /^closed /, closed);
		assert.doesNotMatch(closed, /Reason recorded/, 'a Job that declared completion needs no reason');

		await waitFor('the closed tab to disappear', async () => !(await paneAlive(first.pane)));
		assert.equal(await paneAlive(second.pane), true, 'the sibling window must still be there');
		assert.deepEqual(
			host.jobs().map((job) => job.name),
			['second'],
			'the sibling must still be watched',
		);
		assert.match(await host.ok('job_watch', { action: 'status' }), /^1 watched, 0 retained \(cap 2\)$/m);
	} finally {
		await host.stop();
	}
});

test('wider inspection names windows this session does not own, and never touches them', { ...adjustments, ...{ name: 'wider' } }, async () => {
	const host = new ExtensionHost({ name: 'wider' });
	await host.start();
	// A window that belongs to somebody else: a workspace of its own, labelled like a
	// Job, with no owner record this session ever wrote.
	const foreignDir = tempDir('phe-wider-foreign');
	const foreign = await createWorkspace('foreign-Job-workspace', foreignDir);
	const foreignTab = await createTab(foreign.workspace, foreignDir, '#900 foreign-Job');
	await runInPane(foreignTab.pane, 'sleep 600');
	try {
		const own = await host.ok('job_watch', { action: 'status' });
		assert.doesNotMatch(own, new RegExp(foreign.workspace), 'the default view is this Run scope only');

		const wider = await host.ok('job_watch', { action: 'status', wider: true });
		assert.match(wider, /^Job windows on this host:$/m, wider);
		assert.match(wider, new RegExp(`${foreign.workspace} 'foreign-Job-workspace'`), wider);
		assert.match(wider, /no owner record — ownership-unknown/, 'a window nobody recorded an owner for says so, and is not claimed');
		assert.match(wider, /no durable owner record exists for this window/, 'and the reason is stated, not implied');
		// Classification is evidence a human reads, never authority to dispose of
		// someone else's window.
		assert.equal(await paneAlive(foreignTab.pane), true);
		assert.equal(await workspaceAlive(foreign.workspace), true);
	} finally {
		await closeWorkspace(foreign.workspace);
		await host.stop();
		rmSync(foreignDir, { recursive: true, force: true });
	}
});

test('dismiss refuses a live window, and retaining it answers the Wake', { ...adjustments, ...{ name: 'dismiss-live' } }, async () => {
	const host = new ExtensionHost({ name: 'dismiss-live', debounceMs: 50, tickMs: 400 });
	await host.open();
	const job = await makeTabRunning(host, '#14 reconciling');
	host.seedJobs.push(seedJob({ name: 'reconciling', ticket: '#14', address: job, scope: host.scope, lastStatus: 'idle', openedAt: Date.now() - 600_000 }));
	await host.launch();
	try {
		// The trap this pins down: `dismiss` reads like "dismiss the news", so an
		// operator with a live window in hand reaches for it and silently closes the
		// window it was still reconciling. It refuses instead, and names both verbs.
		const refused = await host.refused('job_watch', { action: 'dismiss', panes: [job.pane] });
		assert.match(refused, /the window \S+ is still there/, refused);
		assert.match(refused, /`job retain` to keep it readable and stop its Wake/);
		assert.match(refused, /`job close` to end it/);
		assert.equal(await paneAlive(job.pane), true, 'a refused dismiss closes nothing');
		assert.deepEqual(
			host.jobs().map((candidate) => candidate.name),
			['reconciling'],
			'and it does not unregister the Job',
		);

		// A Job that has stopped working is announced, so there is news to answer.
		const raised = await forcedRound(host);
		assert.match(String(raised), /- Job reconciling \(#14\) at \S+ is \w+ with no completion claim\./);
		assert.match(await host.ok('job_watch', { action: 'status' }), /Wake news with no answer yet:/);

		// Retaining *is* the reconciliation the Wake asked for: the window stays
		// readable, leaves the watch, and the news that named it is answered.
		const retained = await host.ok('job', { action: 'retain', panes: [job.pane] });
		assert.match(retained, /^Retained reconciling for inspection/, retained);
		assert.equal(await paneAlive(job.pane), true, 'retention never closes the window it captures');
		const status = await host.ok('job_watch', { action: 'status' });
		assert.doesNotMatch(status, /Wake news with no answer yet:/, status);
		assert.match(status, /- reconciling \(#14\) [^\n]*retained for inspection/, status);
	} finally {
		await host.stop();
	}
});

test('wider lists every Job in one shared workspace, not only the last one recorded', { ...adjustments, ...{ name: 'wider-sharing' } }, async () => {
	// The trap: `tab` Jobs share the Orchestrator's own workspace, and the owner record
	// used to be named by that workspace. Opening a second Job overwrote the first's
	// record, and a retained Job that shares the workspace with a live sibling then had
	// no record of its own. `job status wider: true` — the one view a refusal tells an
	// operator to read — could not see the window it was asked about.
	const host = new ExtensionHost({ name: 'wider-sharing' });
	await host.open();
	const first = await makeTabRunning(host, '#21 first-Job');
	const second = await makeTabRunning(host, '#22 second-Job');
	const claimant = { scope: host.scope, orchestrator: host.root, project: host.project, pid: process.pid, host: hostname(), nonce: 'inc-e2e' };
	for (const [address, name, ticket] of [[first, 'first-Job', '#21'], [second, 'second-Job', '#22']] as const) {
		writeOwner(host.stateDir, ownershipFor({ address, path: host.project, branch: '', label: `${ticket} ${name}`, ticket, name, mode: 'tab', claimant, generation: 1 }));
	}
	host.seedJobs.push(
		seedJob({ name: 'first-Job', ticket: '#21', address: first, scope: host.scope, orchestrator: host.root, claimedComplete: true, lastStatus: 'idle', retention: 'manual' }),
		seedJob({ name: 'second-Job', ticket: '#22', address: second, scope: host.scope, orchestrator: host.root, lastStatus: 'idle' }),
	);
	await host.launch();
	try {
		const wider = await host.ok('job_watch', { action: 'status', wider: true });
		assert.match(wider, new RegExp(`${first.pane} '#21 first-Job' first-Job \\(#21\\)`), wider);
		assert.match(wider, new RegExp(`${second.pane} '#22 second-Job' second-Job \\(#22\\)`), wider);
		assert.equal(wider.match(/current-session/g)?.length, 2, `both windows are this session's to act on: ${wider}`);
	} finally {
		await host.stop();
	}
});
