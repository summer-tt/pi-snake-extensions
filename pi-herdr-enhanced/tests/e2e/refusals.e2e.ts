/**
 * The refusals, against a real Herdr.
 *
 * Every scenario here is about something that must *not* happen: no tab, no
 * worktree, no owner record, no Worker. Each one therefore asserts on the window
 * count as well as on the message, because a refusal that leaves a window behind
 * is not a refusal.
 *
 * The first suite shares one host on purpose. Every case in it is
 * zero-side-effect by construction, so a shared workspace is the strongest
 * possible setup: any tab that appears is proof that a refusal leaked.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkoutSource } from '../../src/herdr.ts';
import { scopeLedgerPath } from '../../src/ownership.ts';
import { ensureSpool } from '../../src/spool.ts';
import { ExtensionHost } from './host.ts';
import { createTab, gitOk, insideHerdr, paneAlive, run, runHerdrCommand, runInPane, tempDir, waitFor } from './herdr-e2e.ts';
import { seedJob } from './seeds.ts';

const skip = insideHerdr() ? false : 'not inside a Herdr-managed pane';

/** The text of a tool result, for assertions that only read the message. */
function text(result: { readonly content: readonly { readonly text?: string }[] }): string {
	return result.content.map((block) => block.text ?? '').join('\n');
}

test('outside a Herdr pane the extension registers nothing at all', { skip, timeout: 120_000 }, async () => {
	// It is not a degraded extension there, it is an absent one: half a Job
	// lifecycle is worse than none.
	const saved = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
	const blind = new ExtensionHost({ name: 'herdrless' });
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
	try {
		await blind.start();
		assert.deepEqual([...blind.tools.keys()], []);
		assert.deepEqual([...blind.flags.keys()], []);
	} finally {
		await blind.stop();
		if (saved.HERDR_ENV !== undefined) process.env.HERDR_ENV = saved.HERDR_ENV;
		if (saved.HERDR_PANE_ID !== undefined) process.env.HERDR_PANE_ID = saved.HERDR_PANE_ID;
	}

	const live = new ExtensionHost({ name: 'herdrfull' });
	await live.start();
	try {
		assert.deepEqual([...live.tools.keys()].sort(), ['job', 'job_watch']);
		assert.ok(live.flags.has('pi-herdr-enhanced-job'), 'without this flag a spawned Worker cannot start');
	} finally {
		await live.stop();
	}
});

test('the worktree lock holds in any scope and is never unlockable from below', { skip, timeout: 300_000 }, async () => {
	// A real repository, outside any host, so tearing a host down cannot take the
	// fixture with it.
	const root = tempDir('phe-repo');
	const repo = join(root, 'repo');
	await run('mkdir', ['-p', repo]);
	await gitOk(repo, ['init', '-b', 'main']);
	await gitOk(repo, ['config', 'user.email', 'e2e@example.com']);
	await gitOk(repo, ['config', 'user.name', 'e2e']);
	await gitOk(repo, ['commit', '--allow-empty', '-m', 'base']);

	try {
		const cases: readonly { readonly what: string; readonly build: () => Promise<ExtensionHost> }[] = [
			{
				what: 'a global lock alone',
				build: async () => {
					const host = new ExtensionHost({ name: 'lock-global', globalWorktreeLocked: true });
					await host.start();
					return host;
				},
			},
			{
				what: 'a project lock alone',
				build: async () => {
					const host = new ExtensionHost({ name: 'lock-project', projectWorktreeLocked: true });
					await host.start();
					return host;
				},
			},
			{
				what: 'a project file trying to unlock a global lock',
				build: async () => {
					const host = new ExtensionHost({ name: 'lock-union', globalWorktreeLocked: true });
					await host.open();
					host.writeProjectConfig({ worktree: { enabled: true, root: 'auto' } });
					await host.launch();
					return host;
				},
			},
		];

		for (const scenario of cases) {
			const host = await scenario.build();
			try {
				const before = await host.windowCount();
				const refusal = await host.refused('job', { action: 'open', name: 'locked', ticket: '#1', prompt: 'do it', worktree: true, repo, branch: 'locked', base: 'main' });
				assert.match(refusal, /worktree: true/, scenario.what);
				assert.match(refusal, /locked off by configuration/, scenario.what);
				assert.match(refusal, /Remove that setting to allow branch worktrees/, scenario.what);
				assert.match(refusal, /Nothing was provisioned/, scenario.what);
				assert.equal(await host.windowCount(), before, `${scenario.what} must not create a window`);
				assert.deepEqual(host.jobs(), [], `${scenario.what} must not register a Job`);
			} finally {
				await host.stop();
			}
		}

		// A misleading placement is reported rather than obeyed.
		const placement = new ExtensionHost({ name: 'placement' });
		await placement.open();
		placement.writeGlobalConfig({ placement: 'pane' });
		await placement.launch();
		try {
			assert.ok(
				placement.notifications.some((entry) => /only "tab" is implemented/.test(entry.message)),
				`an unsupported placement must be reported once: ${JSON.stringify(placement.notifications)}`,
			);
		} finally {
			await placement.stop();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a linked worktree is resolved to the primary checkout rather than trusted', { skip, timeout: 300_000 }, async () => {
	// `worktree create` is refused from a linked worktree, so the extension asks
	// Herdr for the repository behind a path instead of trusting the caller. That
	// resolution is what makes `repo` forgiving and `worktree create` legal.
	const root = tempDir('phe-linked');
	const repo = join(root, 'repo');
	await run('mkdir', ['-p', repo]);
	await gitOk(repo, ['init', '-b', 'main']);
	await gitOk(repo, ['config', 'user.email', 'e2e@example.com']);
	await gitOk(repo, ['config', 'user.name', 'e2e']);
	await gitOk(repo, ['commit', '--allow-empty', '-m', 'base']);
	const linked = join(root, 'linked-wt');
	await gitOk(repo, ['worktree', 'add', linked, '-b', 'side']);

	try {
		const source = await checkoutSource(runHerdrCommand(), linked);
		assert.equal(await realpath(source.repoRoot), await realpath(repo), 'a linked worktree must resolve to its primary checkout');
		assert.equal(source.repoName, 'repo');
		const entry = source.worktrees.find((candidate) => candidate.linked);
		assert.ok(entry, `Herdr should report the linked worktree: ${JSON.stringify(source.worktrees)}`);
		assert.equal(await realpath(entry.path), await realpath(linked));
		assert.equal(entry.branch, 'side');
		assert.equal(entry.openWorkspace, undefined, 'a checkout nobody opened has no workspace row');

		// And the primary checkout is the one an explicit `--path` is resolved against.
		const primary = await checkoutSource(runHerdrCommand(), repo);
		assert.equal(await realpath(primary.repoRoot), await realpath(repo));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('refusals create nothing', { skip, timeout: 600_000 }, async (t) => {
	const host = new ExtensionHost({ name: 'refusals', globalWorktreeLocked: true });
	await host.start();
	t.after(async () => {
		await host.stop();
	});

	const windowCount = () => host.windowCount();
	const nothingCreated = async (label: string, before: number) => {
		assert.equal(await windowCount(), before, `${label} must not create a window`);
		assert.deepEqual(host.jobs(), [], `${label} must not register a Job`);
	};

	await t.test('both tools and the reserved spawn flag are registered', () => {
		assert.deepEqual([...host.tools.keys()].sort(), ['job', 'job_watch']);
		assert.ok(host.flags.has('pi-herdr-enhanced-job'));
	});

	await t.test('a worktree request under a lock is refused with the reason and the remedy', async () => {
		const before = await windowCount();
		const refusal = await host.refused('job', { action: 'open', name: 'locked', ticket: '#3', prompt: 'do it', worktree: true, repo: host.dir, branch: 'locked', base: 'main' });
		assert.match(refusal, /worktree: true/);
		assert.match(refusal, /locked off by configuration/);
		await nothingCreated('a locked worktree refusal', before);
	});

	await t.test('neither task source, or both, is refused', async () => {
		const before = await windowCount();
		assert.match(await host.refused('job', { action: 'open', name: 'nothing', ticket: '#4' }), /neither prompt nor file/);
		await nothingCreated('a missing task source', before);
		assert.match(await host.refused('job', { action: 'open', name: 'both', ticket: '#5', prompt: 'a', file: 'b.md' }), /both prompt and file/);
		await nothingCreated('two task sources', before);
	});

	await t.test('an unreadable task file is refused before anything is provisioned', async () => {
		const before = await windowCount();
		const refusal = await host.refused('job', { action: 'open', name: 'missingfile', ticket: '#6', file: 'no-such-task.md' });
		assert.match(refusal, /could not be read/);
		assert.match(refusal, /Nothing was provisioned/);
		await nothingCreated('an unreadable task file', before);
	});

	await t.test('an unusable stall threshold is refused', async () => {
		const before = await windowCount();
		assert.match(await host.refused('job', { action: 'open', name: 'badstall', ticket: '#7', prompt: 'x', stallThresholdMs: -1 }), /positive number of milliseconds/);
		await nothingCreated('an unusable stall threshold', before);
	});

	await t.test('name and ticket are both required', async () => {
		assert.match(await host.refused('job', { action: 'open', ticket: '#8', prompt: 'x' }), /requires name/);
		assert.match(await host.refused('job', { action: 'open', name: 'noticket', prompt: 'x' }), /requires ticket/);
	});

	await t.test('an unknown action is refused rather than silently ignored', async () => {
		assert.match(await host.refused('job', { action: 'teleport' }), /Unknown action: teleport/);
		assert.match(await host.refused('job_watch', { action: 'teleport' }), /Unknown action: teleport/);
	});

	await t.test('an Orchestrator is told what complete is for', async () => {
		const answer = await host.ok('job', { action: 'complete' });
		assert.match(answer, /Worker signal/);
		assert.match(answer, /carries no Job capability/);
	});

	await t.test('an unknown target is refused by every action that needs one', async () => {
		// The hint matters: this refusal is where an operator lands right after its own
		// earlier call closed the Job, so it names both ways a Job goes away.
		for (const [action, params] of [
			['read', { target: 'ghost' }],
			['steer', { target: 'ghost', message: 'hi' }],
			['close', { workspace: 'ghost' }],
		] as const) {
			const refusal = await host.refused('job', { action, ...params });
			assert.match(refusal, /No open Job matches 'ghost'/);
			assert.match(refusal, /may already have been closed or dismissed/);
			assert.match(refusal, /`job status` lists the open set/);
		}
		// `retain` answers rather than fails: a partial match is worth reporting, and a
		// caller retaining three Jobs should learn which two it actually retained.
		assert.match(await host.ok('job', { action: 'retain', panes: ['ghost'] }), /Matched no open Job: ghost/);
		const dismiss = await host.refused('job_watch', { action: 'dismiss', panes: ['ghost'] });
		assert.match(dismiss, /No open Job matches 'ghost'/);
		assert.match(dismiss, /may already have been closed or dismissed/);
	});

	await t.test('a call missing its own required argument is refused', async () => {
		assert.match(await host.refused('job', { action: 'steer', target: 'x' }), /requires target and message/);
		assert.match(await host.refused('job', { action: 'read' }), /requires target/);
		assert.match(await host.refused('job', { action: 'retain', panes: [] }), /non-empty panes list/);
		assert.match(await host.refused('job', { action: 'close' }), /close requires workspace/);
		assert.match(await host.refused('job', { action: 'reclaim' }), /reclaim requires repo and path/);
		assert.match(await host.refused('job_watch', { action: 'hold' }), /non-empty panes list/);
		assert.match(await host.refused('job_watch', { action: 'release' }), /non-empty panes list/);
		assert.match(await host.refused('job_watch', { action: 'dismiss' }), /non-empty panes list/);
	});

	await t.test('a Worker refuses to tear down a window', async () => {
		const worker = new ExtensionHost({
			name: 'worker-refusal',
			capability: { name: 'w1', ticket: '#9', token: 'token-worker-refusal', scope: 'e2e-worker-refusal', spoolPath: join(host.dir, 'unused-spool') },
		});
		await worker.start();
		try {
			const close = await worker.call('job', { action: 'close', workspace: 'w1', reason: 'because' });
			assert.equal(close.isError, true);
			assert.match(text(close), /Refusing to close/);
			assert.match(text(close), /strands the watch/);
			assert.match(text(close), /action `complete`/);

			const retain = await worker.call('job', { action: 'retain', panes: ['w1'] });
			assert.equal(retain.isError, true);
			assert.match(text(retain), /Refusing to retain/);
			assert.match(text(retain), /hides the Job from the watch/);
		} finally {
			await worker.stop();
		}
	});

	await t.test('a Worker claims no Run scope and cannot dispatch', async () => {
		// A Worker reads its run scope from its own environment, not from the
		// capability, so claiming one would claim whatever scope its terminal happened
		// to be in — including the Orchestrator's own. A Worker that did that would put
		// itself in front of the session that launched it, and lock the Orchestrator out
		// of the ledger that authorizes its own windows.
		const worker = new ExtensionHost({
			name: 'worker-noscope',
			capability: { name: 'w4', ticket: '#13', token: 'token-worker-noscope', scope: 'e2e-worker-noscope', spoolPath: join(host.dir, 'unused-spool') },
		});
		await worker.start();
		try {
			assert.equal(existsSync(scopeLedgerPath(worker.stateDir, worker.scope)), false, 'a Worker leaves the Run scope ledger alone');

			const before = await worker.windowCount();
			const opened = await worker.call('job', { action: 'open', name: 'nested', ticket: '#14', prompt: 'this must not be dispatched' });
			assert.equal(opened.isError, true);
			assert.match(text(opened), /Refusing to open 'nested'/);
			assert.match(text(opened), /does not own run scope/);
			assert.match(text(opened), /dispatched Worker w4 \(#13\)/, 'the refusal names why this session cannot dispatch');
			assert.equal(await worker.windowCount(), before, 'a refused dispatch provisions nothing');
		} finally {
			await worker.stop();
		}
	});

	await t.test('a Worker writes no claim until it declares one', async () => {
		// The Orchestrator creates the spool when it opens a Job, which is what makes
		// the channel ready at spawn time; the Worker only ever verifies it.
		const spool = join(host.dir, 'worker-spool');
		ensureSpool(spool);
		const worker = new ExtensionHost({
			name: 'worker-claim',
			capability: { name: 'w2', ticket: '#10', token: 'token-worker-claim', scope: 'e2e-worker-claim', spoolPath: spool },
		});
		await worker.start();
		try {
			assert.deepEqual(readdirSync(spool).filter((name) => name.startsWith('claim-')), [], 'a Worker that has not declared completion has no claim');
			const answer = await worker.ok('job', { action: 'complete' });
			assert.match(answer, /Recorded the completion claim for w2 \(#10\)/);
			assert.match(answer, /does not prove success/);
			const claims = readdirSync(spool).filter((name) => name.startsWith('claim-'));
			assert.deepEqual(claims, ['claim-token-worker-claim.json']);
			assert.equal(statSync(join(spool, claims[0] as string)).mode & 0o777, 0o600, 'a claim is owner-only');
			const payload = JSON.parse(readFileSync(join(spool, claims[0] as string), 'utf8'));
			assert.equal(payload.token, 'token-worker-claim');
			assert.equal(payload.name, 'w2');
			assert.equal(payload.ticket, '#10');
			assert.equal(typeof payload.claimedAt, 'number');
		} finally {
			await worker.stop();
		}
	});

	await t.test('a Worker whose spool has vanished reports it instead of claiming success', async () => {
		const worker = new ExtensionHost({
			name: 'worker-nospool',
			capability: { name: 'w3', ticket: '#12', token: 'token-nospool', scope: 'e2e-worker-nospool', spoolPath: join(host.dir, 'absent-spool') },
		});
		await worker.start();
		try {
			const answer = await worker.ok('job', { action: 'complete' });
			assert.match(answer, /Could not record the completion claim/);
			assert.match(answer, /does not exist/);
			assert.match(answer, /still wakes the Orchestrator once this session settles/);
			assert.equal(existsSync(join(host.dir, 'absent-spool')), false, 'a failed claim must not conjure a spool');
		} finally {
			await worker.stop();
		}
	});

	await t.test('no refusal created a spool or an owner record', async () => {
		// The run scope is claimed at session start — that is not a refusal leaking —
		// but neither the spool nor an owner record exists until something is opened.
		assert.ok(existsSync(join(host.stateDir, 'scopes', `${host.scope}.jsonl`)), 'the run scope claim is the one thing a session start writes');
		assert.equal(existsSync(join(host.stateDir, 'spool')), false, 'refusals provision nothing, including the spool');
		assert.equal(existsSync(join(host.stateDir, 'owners')), false, 'refusals write no owner record');
	});

	await t.test('a refused close leaves the window alive; a justified one ends it', async () => {
		const guarded = new ExtensionHost({ name: 'close-guard' });
		await guarded.open();
		const address = await createTab(guarded.workspace, guarded.project, '#11 guarded');
		await runInPane(address.pane, 'sleep 600');
		guarded.seedJobs.push(seedJob({ name: 'guarded', ticket: '#11', scope: guarded.scope, address }));
		await guarded.launch();
		try {
			const refusal = await guarded.refused('job', { action: 'close', workspace: 'guarded' });
			assert.match(refusal, /neither declared completion nor is Retained/);
			assert.match(refusal, /Its observed state is/);
			assert.match(refusal, /Inspect it with `job read` first/);
			assert.equal(await paneAlive(address.pane), true, 'a refused close must leave the pane alive');

			const closed = await guarded.ok('job', { action: 'close', workspace: 'guarded', reason: 'the operator decided it is done' });
			assert.match(closed, /Reason recorded: the operator decided it is done/);
			await waitFor('the guarded tab to close', async () => !(await paneAlive(address.pane)));
			assert.deepEqual(guarded.jobs(), [], 'a closed Job leaves the watch');
		} finally {
			await guarded.stop();
		}
	});

	await t.test('the shared workspace gained no tab from any refusal', async () => {
		assert.equal(await windowCount(), 1);
	});
});
