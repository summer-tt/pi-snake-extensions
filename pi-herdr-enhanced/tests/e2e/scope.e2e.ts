/**
 * The run scope family: who owns it, how a concurrent incarnation is given room,
 * and what happens when a previous incarnation is gone.
 *
 * A session owns a **family** of scopes, `<root>#0`, `<root>#1`, …, fenced by one
 * append-only ledger per incarnation. A second process resuming the same session
 * derives a new incarnation rather than being refused, and a session that starts
 * after its siblings died absorbs their scopes, so their windows stay disposable.
 * These scenarios run that derivation, that absorption, and the one thing that is
 * still not taken: a *live* sibling's scope.
 *
 * The claim is taken at the first mutation rather than at session start, so every
 * scenario triggers it through a call that mutates: a `job open` missing its task
 * source is refused *after* authorization, which is exactly far enough to see the
 * claim without provisioning anything.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { familyScope, scopeLedgerPath, SCOPE_ENTRY_TYPE } from '../../src/ownership.ts';
import { paneAlive } from './herdr-e2e.ts';
import { ExtensionHost, makeTabRunning } from './host.ts';
import { seedJob } from './seeds.ts';

const adjustments = { timeout: 300_000 } as const;

/** Write a scope ledger entry by hand, as a previous session would have left it. */
function seedLedger(host: ExtensionHost, scope: string, claims: readonly Record<string, unknown>[]): void {
	const body = claims.map((claim) => `${JSON.stringify({ scope, ...claim })}\n`).join('');
	host.writeFile(scopeLedgerPath(host.stateDir, scope), body);
}

/** The claims recorded for one scope, newest last. */
function ledger(host: ExtensionHost, scope: string): readonly Record<string, unknown>[] {
	try {
		return readFileSync(scopeLedgerPath(host.stateDir, scope), 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

test('a session starting after its predecessor died silently inherits the run scope', adjustments, async () => {
	const host = new ExtensionHost({ name: 'inherit' });
	await host.open();
	const primary = familyScope(host.root, 0);
	// The recorded owner is on this host but is not running: a session that ended —
	// a crash, a closed terminal, an ordinary exit — leaves exactly this behind.
	seedLedger(host, primary, [{ generation: 1, orchestrator: host.root, nonce: 'inc-gone', pid: 999_999, host: hostname(), at: 1 }]);
	await host.launch();
	try {
		// Nothing claims the scope at startup, so there is nothing to warn about: a
		// session that only reads or reports has nothing to fence.
		assert.equal(host.notifications.length, 0, `startup must be silent: ${JSON.stringify(host.notifications)}`);
		assert.equal(ledger(host, primary).length, 1, 'and it must not have written to the ledger either');

		// The first mutation takes the scope. The task source is missing on purpose:
		// the call is refused after authorization, so nothing else is created.
		const refused = await host.refused('job', { action: 'open', name: 'scope-1', ticket: '#30' });
		assert.match(refused, /neither prompt nor file/, refused);

		const claims = ledger(host, primary);
		assert.equal(claims.length, 2, 'the handoff is appended, not assumed');
		assert.equal(claims[1]?.generation, 2);
		assert.equal(claims[1]?.supersedes, 1, 'a handoff advances the generation exactly as a takeover does');
		assert.equal(claims[1]?.orchestrator, host.root, 'the orchestrator is the family root, stable across restarts');
		assert.equal(claims[1]?.pid, process.pid);
		assert.equal(claims[1]?.host, hostname());

		const inherited = host.notifications.filter((note) => /Took over run scope/.test(note.message));
		assert.equal(inherited.length, 1, `the handoff is reported once: ${JSON.stringify(host.notifications)}`);
		assert.equal(inherited[0]?.level, 'info', 'it is news, not a warning: the session now owns its own scope');
		assert.match(inherited[0]?.message ?? '', /was absorbed/);

		// And the scope is genuinely ours: the same call now reports ownership rather
		// than a lock-out.
		const status = await host.ok('job_watch', { action: 'status' });
		assert.doesNotMatch(status, /does not own run scope|Run scope family/, status);
	} finally {
		await host.stop();
	}
});

test('every dead incarnation of the family is absorbed, so their windows stay disposable', adjustments, async () => {
	const host = new ExtensionHost({ name: 'absorb' });
	await host.open();
	// Two incarnations the session once derived, both left behind by processes that
	// are gone. The gap at `#1` is deliberate: each incarnation has its own ledger,
	// so absorption is by liveness, not by a contiguous chain across the family.
	seedLedger(host, familyScope(host.root, 0), [{ generation: 1, orchestrator: host.root, pid: 999_999, host: hostname(), at: 1 }]);
	seedLedger(host, familyScope(host.root, 2), [{ generation: 1, orchestrator: host.root, pid: 999_998, host: hostname(), at: 1 }]);
	await host.launch();
	try {
		await host.refused('job', { action: 'open', name: 'absorb-1', ticket: '#33' });
		const primary = ledger(host, familyScope(host.root, 0));
		const sibling = ledger(host, familyScope(host.root, 2));
		assert.equal(primary.length, 2, 'the session lands on the oldest dead incarnation');
		assert.equal(sibling.length, 2, 'and absorbs the other one');
		assert.equal(sibling[1]?.generation, 2, 'an absorbed scope advances exactly as a handoff does');
		assert.equal(sibling[1]?.supersedes, 1);
	} finally {
		await host.stop();
	}
});

test('a live incarnation does not lock the next one out: the family grows instead', adjustments, async () => {
	const owner = new ExtensionHost({ name: 'family-live' });
	await owner.open();
	const primary = familyScope(owner.root, 0);
	// The recorded owner is this very process and it is running, so its scope cannot
	// be taken — but that is no longer a refusal. Two sessions on one project are two
	// claimants, and the second is given the next incarnation.
	seedLedger(owner, primary, [{ generation: 1, orchestrator: owner.root, nonce: 'inc-live', pid: process.pid, host: hostname(), at: 1 }]);

	const second = new ExtensionHost({ name: 'family-second', project: owner.project, share: { stateDir: owner.stateDir, root: owner.root } });
	await second.start();
	try {
		const opened = await second.ok('job', {
			action: 'open',
			name: 'nested',
			ticket: '#31',
			prompt: 'Do not read or write any file. Reply with the single word: ok',
		});
		assert.match(opened, /Opened nested \(#31\)|did not start/, opened);

		const job = second.jobs().find((candidate) => candidate.name === 'nested');
		assert.equal(job?.scope, familyScope(owner.root, 1), 'the second incarnation takes the next scope, not the live one');
		assert.equal(ledger(owner, primary).length, 1, 'a live incarnation\'s ledger is never rewritten');
		assert.equal(ledger(owner, familyScope(owner.root, 1)).length, 1, 'the new incarnation has its own ledger');

		await second.ok('job', { action: 'close', target: 'nested', reason: 'the scenario is done with it' });
	} finally {
		await second.stop();
		await owner.stop();
	}
});

test('a takeover reaches the window\'s own scope, not the one this session leads with', adjustments, async () => {
	// The shape a compaction leaves behind: a previous incarnation of *this* session
	// opened a Job window under #0, the process then restarted and recorded #1 as the
	// scope it held, and #0 now belongs to a live process that is not this session.
	// Closing the window therefore needs the operator's takeover evidence — and that
	// evidence names #0, the scope the window is under, not #1, the one the session
	// leads with. Applying it to the chain instead silently spends it on a sibling.
	const host = new ExtensionHost({ name: 'takeover-window' });
	await host.open();
	const window = await makeTabRunning(host, '#40 takeover');
	const primary = familyScope(host.root, 0);
	const sibling = familyScope(host.root, 1);
	// #0: alive, but not this process.
	seedLedger(host, primary, [{ generation: 1, orchestrator: host.root, nonce: 'inc-other', pid: 1, host: hostname(), at: 1 }]);
	// #1: this session's own, left by a process that is gone.
	seedLedger(host, sibling, [{ generation: 1, orchestrator: host.root, nonce: 'inc-earlier', pid: 999_999, host: hostname(), at: 1 }]);
	// The chain this session reads back leads with #1, as the recorded entry said.
	host.entries.push({
		id: 'seed-scope',
		type: 'custom',
		customType: SCOPE_ENTRY_TYPE,
		data: { root: host.root, scope: sibling, generation: 1, held: [{ scope: sibling, generation: 1 }], at: 1 },
	});
	host.seedJobs.push(seedJob({ name: 'stale', ticket: '#40', address: window, scope: primary, orchestrator: host.root, claimedComplete: true }));

	await host.launch();
	try {
		// Without the evidence the window is untouchable: the guard is doing its job.
		const refused = await host.refused('job', { action: 'close', workspace: 'stale' });
		assert.match(refused, /another live incarnation of this session holds/, refused);
		assert.equal(await paneAlive(window.pane), true, 'a refusal closes nothing');

		// The evidence the refusal names is the evidence that must work.
		const closed = await host.ok('job', { action: 'close', workspace: 'stale', takeover: true, expectedOwner: host.root, expectedGeneration: 1 });
		assert.match(closed, /stale/, closed);
		assert.equal(await paneAlive(window.pane), false, 'the takeover disposed of the window it named');
		assert.equal(ledger(host, primary).length, 2, 'the evidence fenced the scope it named, and only once');
		assert.equal(ledger(host, primary)[1]?.supersedes, 1);
	} finally {
		await host.stop();
	}
});
