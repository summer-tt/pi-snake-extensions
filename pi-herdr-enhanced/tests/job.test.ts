/**
 * The Job lifecycle: refusals that create nothing, resume that never duplicates,
 * and a window that survives a failed launch.
 *
 * Every test here asserts on the *side effects* as well as the message, because
 * the point of most of these rules is that nothing happened.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { closeWindow, openJob, piArgsFor, readJob, reclaimWorktree, resolveTaskSource, steerJob, type OpenSpec } from '../src/job.ts';
import { readOwner } from '../src/ownership.ts';
import { jobFixture, makeClaimant, makeJob } from './fixtures.ts';
import { FakeHerdr } from './fake-herdr.ts';

/** An open spec for tab placement, as the tool would build it. */
function spec(overrides: Partial<OpenSpec> = {}): OpenSpec {
	return {
		name: 'fix-142',
		ticket: '#142',
		task: { text: 'fix the thing', source: 'text' },
		capability: {
			name: 'fix-142',
			ticket: '#142',
			token: 'job-token',
			scope: 's1',
			spoolPath: '/spool',
		},
		worktree: false,
		...overrides,
	};
}

test('both task sources are refused before anything is provisioned', () => {
	assert.throws(
		() => resolveTaskSource({ targetCheckout: '/repo', prompt: 'a', file: 'b.md' }),
		(error: unknown) => error instanceof Error && /both prompt and file/.test(error.message) && /Nothing was provisioned/.test(error.message),
	);
});

test('neither task source is refused', () => {
	assert.throws(
		() => resolveTaskSource({ targetCheckout: '/repo' }),
		(error: unknown) => error instanceof Error && /neither prompt nor file/.test(error.message),
	);
});

test('a relative task file resolves against the Job checkout', () => {
	const dir = mkdtempSync(join(tmpdir(), 'phe-task-'));
	try {
		writeFileSync(join(dir, 'task.md'), 'do the thing');
		const task = resolveTaskSource({ targetCheckout: dir, file: 'task.md' });
		assert.equal(task.source, 'file');
		assert.equal(task.path, join(dir, 'task.md'));
		assert.equal(task.text, 'do the thing');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unreadable task file is refused with nothing provisioned', () => {
	assert.throws(
		() => resolveTaskSource({ targetCheckout: '/nope', file: 'missing.md' }),
		(error: unknown) => error instanceof Error && /could not be read/.test(error.message),
	);
});

test('an empty task file is refused', () => {
	const dir = mkdtempSync(join(tmpdir(), 'phe-task-'));
	try {
		writeFileSync(join(dir, 'empty.md'), '   \n');
		assert.throws(() => resolveTaskSource({ targetCheckout: dir, file: 'empty.md' }), /is empty/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a locked worktree is refused and no window is created', async () => {
	const fixture = jobFixture({ config: { worktreeEnabled: false, worktreeLocked: true } });
	try {
		await assert.rejects(
			() => openJob(fixture.deps, spec({ worktree: true, repo: '/repo', branch: 'b', base: 'main' }), { onEstablished: () => {} }),
			(error: unknown) => error instanceof Error && /locked off by configuration/.test(error.message) && /Nothing was provisioned/.test(error.message),
		);
		assert.equal(fixture.herdr.calls.filter((call) => call[0] === 'worktree' || call[0] === 'tab').length, 0, 'no Herdr command was issued at all');
	} finally {
		fixture.cleanup();
	}
});

test('tab placement creates one tab, starts the Worker with its capability, and registers before prompting', async () => {
	const fixture = jobFixture();
	try {
		const registered: string[] = [];
		const outcome = await openJob(fixture.deps, spec(), {
			onEstablished: (job) => {
			registered.push(job.pane);
		},
		});
		assert.equal(outcome.ok, true);
		assert.match(outcome.text, /Opened fix-142 \(#142\)/);
		assert.deepEqual(registered, [outcome.job.pane], 'the Job is registered with the watch exactly once');
		const start = fixture.herdr.calls.find((call) => call[0] === 'agent' && call[1] === 'start');
		assert.ok(start, 'the Worker was started');
		assert.ok(start.includes('--pi-herdr-enhanced-job'), 'the capability rides the spawn arguments');
		assert.equal(fixture.herdr.prompts.length, 1);
		assert.match(fixture.herdr.prompts[0]?.text ?? '', /fix the thing/);
		assert.match(fixture.herdr.prompts[0]?.text ?? '', /Completion declaration/, 'the Worker is told its duty, not its transport');
		assert.equal(fixture.herdr.prompts[0]?.text.includes('pi-herdr-enhanced-job'), false, 'the model is never taught the capability flag');
		assert.equal(outcome.job.mode, 'tab');
	} finally {
		fixture.cleanup();
	}
});

test('worktree placement with the auto root omits --path and reads the checkout back', async () => {
	const fixture = jobFixture();
	try {
		const outcome = await openJob(
			fixture.deps,
			spec({ worktree: true, repo: '/repo', branch: 'fix-142', base: 'main' }),
			{ onEstablished: () => {} },
		);
		const create = fixture.herdr.calls.find((call) => call[0] === 'worktree' && call[1] === 'create');
		assert.ok(create, 'the worktree was created');
		assert.equal(create.includes('--path'), false, 'auto lets Herdr choose the checkout location');
		assert.equal(outcome.job.mode, 'worktree');
		assert.equal(outcome.job.branch, 'fix-142');
		assert.equal(outcome.job.path, '/worktrees/repo/fix-142', 'the path Herdr chose is read back, because reclaim needs it');
		const owner = readOwner(fixture.stateDir, outcome.job.pane);
		assert.equal(owner?.path, '/worktrees/repo/fix-142');
		assert.equal(owner?.generation, 1);
	} finally {
		fixture.cleanup();
	}
});

test('an explicit root is passed through as --path', async () => {
	const fixture = jobFixture({ config: { worktreeRoot: '.worktrees' } });
	try {
		const outcome = await openJob(
			fixture.deps,
			spec({ worktree: true, repo: '/repo', branch: 'fix-142', base: 'main' }),
			{ onEstablished: () => {} },
		);
		const create = fixture.herdr.calls.find((call) => call[0] === 'worktree' && call[1] === 'create');
		assert.equal(create?.[create.indexOf('--path') + 1], '/repo/.worktrees/fix-142');
		assert.equal(outcome.job.path, '/repo/.worktrees/fix-142');
	} finally {
		fixture.cleanup();
	}
});

test('a linked worktree as the source is explained, and nothing is created', async () => {
	const herdr = new FakeHerdr({ worktreeCreateError: { code: 'linked_worktree_source', message: 'New and open worktree actions start from the repo parent workspace.' } });
	const fixture = jobFixture({ herdr });
	try {
		await assert.rejects(
			() => openJob(fixture.deps, spec({ worktree: true, repo: '/repo/.worktrees/other', branch: 'b', base: 'main' }), { onEstablished: () => {} }),
			(error: unknown) => error instanceof Error && /primary checkout/.test(error.message),
		);
	} finally {
		fixture.cleanup();
	}
});

test("Git's ownership refusal names the flag a human must set, and never sets it itself", async () => {
	const herdr = new FakeHerdr({ dubiousOwnership: true });
	const fixture = jobFixture({ herdr });
	try {
		await assert.rejects(
			() => openJob(fixture.deps, spec({ worktree: true, repo: '/repo', branch: 'b', base: 'main' }), { onEstablished: () => {} }),
			(error: unknown) => error instanceof Error && /trustRepository: true/.test(error.message) && /never changes your Git configuration/.test(error.message),
		);
		assert.equal(
			fixture.herdr.calls.some((call) => call.includes('--trust-repository')),
			false,
			'the extension never passes the flag on its own',
		);
		const explicit = jobFixture({ herdr: new FakeHerdr() });
		try {
			const outcome = await openJob(explicit.deps, spec({ worktree: true, repo: '/repo', branch: 'b', base: 'main', trustRepository: true }), { onEstablished: () => {} });
			assert.equal(outcome.ok, true);
			assert.ok(explicit.herdr.calls.find((call) => call.includes('--trust-repository')), 'and passes it when the caller asked');
		} finally {
			explicit.cleanup();
		}
	} finally {
		fixture.cleanup();
	}
});

test('a working Job is never disturbed by a repeated open', async () => {
	const fixture = jobFixture();
	try {
		const existing = makeJob({ pane: 'w1:p7', workspace: 'w1', name: 'fix-142', promptDelivered: true });
		fixture.herdr.setAgent('w1:p7', 'working');
		const outcome = await openJob(fixture.deps, spec(), { existing, onEstablished: () => {} });
		assert.match(outcome.text, /already open .* still working/);
		assert.equal(outcome.job.pane, 'w1:p7');
		assert.deepEqual(fixture.herdr.prompts, [], 'no prompt was sent to a working Worker');
		assert.equal(fixture.herdr.calls.some((call) => call[0] === 'tab'),
			false,
			'no window was created',
		);
	} finally {
		fixture.cleanup();
	}
});

test('a resumed session that already holds the prompt is continued, not re-dispatched', async () => {
	const fixture = jobFixture();
	try {
		const existing = makeJob({ pane: 'w1:p7', workspace: 'w1', name: 'fix-142', promptDelivered: true });
		fixture.herdr.setAgent('w1:p7', 'idle');
		const outcome = await openJob(fixture.deps, spec(), { existing, onEstablished: () => {} });
		assert.equal(outcome.ok, true);
		assert.equal(fixture.herdr.calls.some((call) => call[0] === 'agent' && call[1] === 'start'), false, 'the live session is reused in place');
		assert.equal(fixture.herdr.prompts.length, 1);
		assert.match(fixture.herdr.prompts[0]?.text ?? '', /Continue the assigned task/);
	} finally {
		fixture.cleanup();
	}
});

test('a pane that is alive without a session is restarted in place', async () => {
	const fixture = jobFixture();
	try {
		const existing = makeJob({ pane: 'w1:p9', workspace: 'w1', name: 'fix-142', promptDelivered: false });
		fixture.herdr.shells.add('w1:p9');
		const outcome = await openJob(fixture.deps, spec(), { existing, onEstablished: () => {} });
		assert.equal(outcome.ok, true);
		assert.equal(outcome.job.pane, 'w1:p9', 'the same pane is used');
		assert.ok(fixture.herdr.calls.find((call) => call[0] === 'agent' && call[1] === 'start'));
		assert.equal(fixture.herdr.calls.some((call) => call[0] === 'tab'), false, 'nothing was created');
	} finally {
		fixture.cleanup();
	}
});

test('a pane confirmed gone earns exactly one replacement window', async () => {
	const fixture = jobFixture();
	try {
		const existing = makeJob({ pane: 'w1:pZZ', workspace: 'w1', name: 'fix-142' });
		const created: string[] = [];
		const outcome = await openJob(fixture.deps, spec(), {
			existing,
			onEstablished: (job) => {
				created.push(job.pane);
			},
		});
		assert.equal(created.length, 1);
		assert.notEqual(outcome.job.pane, 'w1:pZZ');
		assert.equal(fixture.herdr.calls.filter((call) => call[0] === 'tab' && call[1] === 'create').length, 1, 'one replacement, never two');
	} finally {
		fixture.cleanup();
	}
});

test('a session that fails to start still leaves an addressable, registered Job', async () => {
	const herdr = new FakeHerdr();
	const fixture = jobFixture({ herdr });
	try {
		// The tab's root pane is present but will be made unavailable: the session
		// start then fails while the window itself exists.
		const registered: string[] = [];
		const outcome = await openJob(fixture.deps, spec(), {
			onEstablished: (job) => {
				registered.push(job.pane);
				herdr.shells.delete(job.pane);
				herdr.agents.delete(job.pane);
			},
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.text, /did not start/);
		assert.match(outcome.text, /repeating this open restarts the session in place/);
		assert.deepEqual(registered, [outcome.job.pane], 'the window was registered before the session step');
		assert.equal(outcome.job.provisioned, true);
		assert.equal(outcome.job.promptDelivered, false);
	} finally {
		fixture.cleanup();
	}
});

test('a failure to submit the prompt is reported without losing the window', async () => {
	const herdr = new FakeHerdr({ promptFails: true });
	const fixture = jobFixture({ herdr });
	try {
		const outcome = await openJob(fixture.deps, spec(), { onEstablished: () => {} });
		assert.equal(outcome.ok, false);
		assert.match(outcome.text, /could not be submitted/);
		assert.equal(outcome.job.promptDelivered, false);
		assert.ok(outcome.job.promptFailure.length > 0);
	} finally {
		fixture.cleanup();
	}
});

test('closing a tab window closes the tab and forgets the owner record', async () => {
	const fixture = jobFixture();
	try {
		const outcome = await openJob(fixture.deps, spec(), { onEstablished: () => {} });
		assert.ok(readOwner(fixture.stateDir, outcome.job.pane));
		const message = await closeWindow(fixture.deps, outcome.job);
		assert.match(message, /closed/);
		assert.ok(fixture.herdr.closed.includes(outcome.job.tab), 'a tab Job is closed as a tab');
		assert.equal(readOwner(fixture.stateDir, outcome.job.pane), undefined);
	} finally {
		fixture.cleanup();
	}
});

test('closing a worktree window closes the workspace, not a tab', async () => {
	const fixture = jobFixture();
	try {
		const outcome = await openJob(fixture.deps, spec({ worktree: true, repo: '/repo', branch: 'b', base: 'main' }), { onEstablished: () => {} });
		await closeWindow(fixture.deps, outcome.job);
		assert.ok(fixture.herdr.closed.includes(outcome.job.workspace), 'the workspace row is what ends');
	} finally {
		fixture.cleanup();
	}
});

test('reclaim removes the checkout through Git and closes the rows it leaves behind', async () => {
	const fixture = jobFixture();
	try {
		const outcome = await openJob(fixture.deps, spec({ worktree: true, repo: '/repo', branch: 'b', base: 'main' }), { onEstablished: () => {} });
		const message = await reclaimWorktree(fixture.deps, { repo: '/repo', path: outcome.job.path });
		assert.match(message, /Reclaimed/);
		assert.ok(fixture.herdr.calls.find((call) => call[0] === 'git' && call.includes('worktree') && call.includes('remove')));
		assert.ok(fixture.herdr.closed.includes(outcome.job.workspace), 'the row whose checkout is gone is closed too');
	} finally {
		fixture.cleanup();
	}
});

test('a reclaim that Git refuses is reported, and a dirty checkout is never forced by default', async () => {
	const herdr = new FakeHerdr({ gitRefusesRemove: true });
	const fixture = jobFixture({ herdr });
	try {
		// The path must exist, so this is a refusal rather than an already-removed state.
		const refused = await reclaimWorktree(fixture.deps, { repo: '/repo', path: process.cwd() }).catch((error: unknown) => error);
		assert.ok(refused instanceof Error, 'a dirty checkout is a refusal, not a silent success');
		assert.match((refused as Error).message, /git worktree remove exited/);
		assert.equal(herdr.calls.some((call) => call.includes('--force')), false, 'nothing forced it on its own');

		const forced = await reclaimWorktree(fixture.deps, { repo: '/repo', path: process.cwd(), force: true });
		assert.match(forced, /Reclaimed/);
		assert.ok(herdr.calls.some((call) => call.includes('--force')), 'and forcing happens only when the caller asked');
	} finally {
		fixture.cleanup();
	}
});

test('steering goes to the pane the Job actually holds', async () => {
	const fixture = jobFixture();
	try {
		const job = makeJob({ pane: 'w1:p3' });
		fixture.herdr.setAgent('w1:p3', 'working');
		assert.match(await steerJob(fixture.deps, job, 'try the other approach'), /Steered fix-142/);
		assert.equal(fixture.herdr.prompts.at(-1)?.target, 'w1:p3');
	} finally {
		fixture.cleanup();
	}
});

test('launch arguments carry the model, thinking level and name, with the name last', () => {
	const args = piArgsFor({ name: 'x', model: 'm', thinking: 'high' });
	assert.equal(args.at(-2), '--name');
	assert.equal(args.at(-1), 'x');
	assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'm');
	assert.ok(args.includes('--thinking') && args[args.indexOf('--thinking') + 1] === 'high');
	assert.deepEqual(piArgsFor({ name: 'x' }), ['--name', 'x']);
});

test('a bad stall threshold is refused before any side effect', async () => {
	const fixture = jobFixture();
	try {
		await assert.rejects(
			() => openJob(fixture.deps, spec({ stallThresholdMs: -1 }), { onEstablished: () => {} }),
			(error: unknown) => error instanceof Error && /positive number of milliseconds/.test(error.message),
		);
		assert.equal(fixture.herdr.calls.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test('reading a working Job falls back to the visible screen and says so', async () => {
	// Herdr will not scroll a working pane to capture its history, and the Job an
	// Orchestrator most wants to read is the busy one. The refusal must not become
	// the answer: the rows Herdr can always give are, with a note that they are
	// only the visible screen.
	const herdr = new FakeHerdr({ agentNotIdle: true });
	herdr.agents.set('w1:p1', { pane: 'w1:p1', name: 'fix-142', status: 'working' });
	const deps = { run: herdr.run, runGit: herdr.runGit, config: DEFAULT_CONFIG, stateDir: '/state', claimant: makeClaimant(), generation: 1, clock: () => 5_000 };
	const text = await readJob(deps, makeJob({ pane: 'w1:p1' }), 200);
	assert.match(text, /the Job is working, so Herdr could not capture scrollback; this is the visible screen/);
	assert.match(text, /worker output/);
	assert.deepEqual(herdr.reads.map((read) => read.source), ['recent-unwrapped', 'visible'], 'the fallback is a second read, not a guess');

	// A pane whose session has exited has no agent to read through at all, which is
	// the other normal way a read has to fall back: the window outlives its Worker,
	// and its last screen is exactly what an Orchestrator reconciling it wants.
	const orphaned = new FakeHerdr();
	orphaned.shells.add('w1:p1');
	const orphanText = await readJob({ ...deps, run: orphaned.run }, makeJob({ pane: 'w1:p1' }), 200);
	assert.match(orphanText, /the pane has no session to read through; this is the visible screen/);
	assert.match(orphanText, /pane rows/, 'the rows come from the pane, not from a session that is not there');

	// And with a readable pane there is no note at all.
	const calm = new FakeHerdr();
	calm.agents.set('w1:p1', { pane: 'w1:p1', name: 'fix-142', status: 'idle' });
	const plain = await readJob({ ...deps, run: calm.run }, makeJob({ pane: 'w1:p1' }), 200);
	assert.doesNotMatch(plain, /could not capture scrollback/);
	assert.match(plain, /^Job fix-142 \(#142\) at w1:p1:\n/);
});
