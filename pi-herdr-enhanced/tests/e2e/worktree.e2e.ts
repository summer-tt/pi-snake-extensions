/**
 * A Job placed in a worktree.
 *
 * Worktree placement is the one part of a Job that owns something outside a tab:
 * a branch, a checkout, and a Herdr workspace of its own. So this is the scenario
 * that has to prove the ownership is real — the branch is a branch, the path is a
 * Git worktree and not a directory, closing the Job ends its *workspace* rather
 * than a tab, and reclaiming it goes through Git rather than through Herdr.
 *
 * Everything lives under a temporary directory: `worktree.root` is pointed at one,
 * so the run leaves nothing in `~/.herdr/worktrees`.
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitOk, tempDir, waitFor, workspaceAlive } from './herdr-e2e.ts';
import { ExtensionHost } from './host.ts';

const adjustments = { timeout: 900_000 } as const;

/**
 * Dispatch a Job and require that its session started.
 *
 * `agent start` can refuse a pane it has just created, and that outcome is part of
 * the contract rather than a failure: the workspace exists, the Job is registered,
 * and repeating the open restarts the session in place.
 */
async function dispatch(host: ExtensionHost, params: Record<string, unknown>, attempts = 3): Promise<string> {
	let answer = '';
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		answer = await host.ok('job', { action: 'open', ...params });
		if (!/its Pi session did not start/.test(answer)) return answer;
	}
	throw new Error(`the Job session never started after ${attempts} attempts. Last answer: ${answer}`);
}

test('a worktree Job owns a branch and a real checkout, and reclaiming it goes through Git', adjustments, async () => {
	const repo = tempDir('phe-worktree-repo');
	await gitOk(repo, ['init', '-b', 'main']);
	await gitOk(repo, ['config', 'user.email', 'e2e@example.com']);
	await gitOk(repo, ['config', 'user.name', 'e2e']);
	await gitOk(repo, ['commit', '--allow-empty', '-m', 'base']);

	const host = new ExtensionHost({ name: 'worktree', project: repo });
	await host.open();
	// `worktree.root` is what decides where a branch checkout is placed. Pointing it
	// at this scenario's temporary directory is what keeps a run out of the
	// operator's own `~/.herdr/worktrees`.
	const root = join(host.dir, 'worktrees');
	host.writeGlobalConfig({ worktree: { root } });
	await host.launch();

	const branch = 'job/worktree-1';
	try {
		const opened = await dispatch(host, {
			name: 'worktree-1',
			ticket: '#20',
			worktree: true,
			repo,
			branch,
			base: 'main',
			// A Worker that does nothing but answer keeps this scenario about the
			// checkout rather than about the model.
			prompt: 'Do not read or write any file. Reply with the single word: ok',
		});
		assert.match(opened, /Opened worktree-1 \(#20\) in /, opened);

		const job = host.jobs()[0];
		assert.ok(job, 'the Job is registered');
		assert.equal(job.mode, 'worktree', 'a worktree Job records how it was placed');
		assert.equal(job.branch, branch);
		assert.notEqual(job.workspace, host.workspace, 'a worktree Job has a workspace of its own');
		assert.ok(job.path.startsWith(root), `the checkout is under the configured root: ${job.path}`);
		assert.equal(existsSync(job.path), true, 'the checkout is a real directory');

		await test('the checkout is a Git worktree on the Job\u2019s own branch', async () => {
			assert.equal(await gitOk(job.path, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);
			// A real worktree, registered with the primary checkout — not merely a copy
			// of the files, which is the difference that makes a branch safe to land.
			assert.match(await gitOk(repo, ['worktree', 'list']), new RegExp(job.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
			assert.match(await gitOk(repo, ['branch', '--list', branch]), new RegExp(branch));
		});

		await test('status names the branch, so a Job is never confused with a tab', async () => {
			const status = await host.ok('job_watch', { action: 'status' });
			assert.match(status, new RegExp(`\\[${job.workspace} ${branch.replace('/', '\\/')}\\]`), status);
		});

		await test('closing a worktree Job ends its workspace, not a tab', async () => {
			await host.ok('job', { action: 'close', target: 'worktree-1', reason: 'the scenario is done with it' });
			await waitFor('the Job workspace to close', async () => !(await workspaceAlive(job.workspace)));
			assert.equal(await workspaceAlive(host.workspace), true, 'the Orchestrator\u2019s own workspace is untouched');
			assert.deepEqual(host.jobs(), [], 'a closed Job leaves the watch');
			// Closing a *window* is not reclaiming a *checkout*: the branch and the files
			// are still there, because unmerged work must survive a window closing.
			assert.equal(existsSync(job.path), true, 'the checkout outlives the window');
			assert.equal(await gitOk(job.path, ['rev-parse', '--abbrev-ref', 'HEAD']), branch);
		});

		await test('reclaim removes the checkout through Git', async () => {
			const reclaimed = await host.ok('job', { action: 'reclaim', repo, path: job.path });
			assert.match(reclaimed, /^Reclaimed /, reclaimed);
			assert.equal(existsSync(job.path), false, 'the checkout is gone');
			assert.doesNotMatch(await gitOk(repo, ['worktree', 'list']), new RegExp(job.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
			// The *branch* stays: it holds the work, and whether that work is worth
			// keeping is not a decision a reclaim gets to make. Removing the checkout
			// must never mean discarding commits.
			assert.equal(await gitOk(repo, ['branch', '--list', branch]), branch, 'the branch and its commits survive the checkout');
		});

		await test('reclaiming twice is the state the second call asked for', async () => {
			const again = await host.ok('job', { action: 'reclaim', repo, path: job.path });
			assert.match(again, /already removed/, again);
		});
	} finally {
		await host.stop();
		await gitOk(repo, ['worktree', 'prune']).catch(() => '');
		rmSync(host.dir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});
