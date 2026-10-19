/**
 * The transport's two load-bearing rules: the error envelope is read from
 * stderr, and Herdr's codes survive as typed errors.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	HerdrError,
	agentGet,
	agentList,
	agentRead,
	checkoutRows,
	herdrAvailable,
	herdrJson,
	herdrText,
	isNotIdle,
	isDubiousOwnership,
	isGroupCloseRequired,
	isLinkedWorktreeSource,
	isMissingAgent,
	isMissingPane,
	isMissingWorkspace,
	paneExists,
	workspaceClose,
} from '../src/herdr.ts';
import type { CommandResult, RunCommand } from '../src/herdr.ts';

const success = (result: unknown): CommandResult => ({ stdout: JSON.stringify({ id: 'x', result }), stderr: '', code: 0 });
/** Exactly how herdr 0.9.4 reports a failure: empty stdout, envelope on stderr, exit 1. */
const failure = (code: string, message = code): CommandResult => ({ stdout: '', stderr: JSON.stringify({ error: { code, message }, id: 'x' }), code: 1 });

function once(result: CommandResult): { run: RunCommand; calls: string[][] } {
	const calls: string[][] = [];
	return {
		run: async (args) => {
			calls.push([...args]);
			return result;
		},
		calls,
	};
}

test('a failure envelope on stderr becomes a typed error, never a silent success', async () => {
	const { run } = once(failure('pane_not_found', 'pane w1:p9 not found'));
	await assert.rejects(
		() => herdrJson(run, ['pane', 'get', 'w1:p9']),
		(error: unknown) => {
			assert.ok(error instanceof HerdrError);
			assert.equal(error.code, 'pane_not_found');
			assert.match(error.message, /not found/);
			return true;
		},
	);
});

test('a success payload is the JSON on stdout', async () => {
	const { run } = once(success({ type: 'ok' }));
	assert.deepEqual(await herdrJson(run, ['tab', 'rename', 't', 'label']), { type: 'ok' });
});

test('an unparseable body is a typed failure rather than an empty result', async () => {
	const { run } = once({ stdout: '', stderr: 'boom', code: 1 });
	await assert.rejects(() => herdrJson(run, ['workspace', 'list']), /boom/);
});

test('an error body with a zero exit is still a failure', async () => {
	const { run } = once({ stdout: JSON.stringify({ error: { code: 'weird', message: 'odd' } }), stderr: '', code: 0 });
	await assert.rejects(() => herdrJson(run, ['workspace', 'list']), (error: unknown) => error instanceof HerdrError && error.code === 'weird');
});

test('a missing pane is reported as absent, not thrown', async () => {
	const { run } = once(failure('pane_not_found'));
	assert.equal(await paneExists(run, 'w1:p9'), false);
});

test('closing an already-gone workspace is idempotent', async () => {
	const { run } = once(failure('workspace_not_found'));
	await workspaceClose(run, 'w9');
});

test('the codes the lifecycle branches on are recognized', () => {
	const linked = new HerdrError('linked_worktree_source', 'New and open worktree actions start from the repo parent workspace.');
	const group = new HerdrError('workspace_group_close_required', 'close the children first');
	assert.ok(isLinkedWorktreeSource(linked));
	assert.ok(isGroupCloseRequired(group));
	assert.ok(isMissingPane(new HerdrError('pane_not_found', '')));
	assert.ok(isMissingWorkspace(new HerdrError('workspace_not_found', '')));
	assert.equal(isMissingPane(group), false);
});

test('a group-only close is refused rather than escalated to the whole group', async () => {
	// `--group` is Herdr's answer for this, and for a Job it would take the
	// Orchestrator's own workspace with it. Closing more than the window that was
	// asked about is not this extension's decision.
	const refused = once(failure('workspace_group_close_required', 'workspace has linked worktree workspaces; use --group'));
	await assert.rejects(() => workspaceClose(refused.run, 'w1'), (error: unknown) => {
		assert.ok(error instanceof HerdrError);
		assert.equal(error.code, 'workspace_group_close_required');
		assert.match(error.message, /would close the whole group/);
		assert.doesNotMatch(error.message, /--group\b(?!.*would close)/);
		return true;
	});
	assert.deepEqual(refused.calls, [['workspace', 'close', 'w1']], 'no second call is made: nothing is escalated behind the caller');

	// A workspace that is simply gone is still the state the caller asked for.
	const gone = once(failure('workspace_not_found'));
	await workspaceClose(gone.run, 'w1');
});

test("Git's ownership refusal is recognized from the message text", () => {
	assert.ok(isDubiousOwnership('fatal: detected dubious ownership in repository at /repo'));
	assert.equal(isDubiousOwnership('fatal: not a git repository'), false);
});

test('agent list is keyed by pane and defaults an unknown state to unknown', async () => {
	const { run } = once(success({ agents: [{ pane_id: 'w1:p1', agent_status: 'weird' }, { pane_id: 'w1:p2', agent_status: 'working' }, {}] }));
	const agents = await agentList(run);
	assert.equal(agents.size, 2, 'an entry with no pane id is dropped rather than keyed by undefined');
	assert.equal(agents.get('w1:p1')?.status, 'unknown');
	assert.equal(agents.get('w1:p2')?.status, 'working');
});

test('checkout rows match on Git provenance, not on a pane standing in a directory', async () => {
	const { run } = once(
		success({
			workspaces: [
				{ workspace_id: 'w1', worktree: { checkout_path: '/repo/.worktrees/a' } },
				{ workspace_id: 'w2', worktree: { checkout_path: '/elsewhere' } },
				{ workspace_id: 'w3' },
			],
		}),
	);
	assert.deepEqual(await checkoutRows(run, '/repo/.worktrees/a'), ['w1']);
});

test('Herdr is unavailable when Pi is not inside a Herdr pane', () => {
	assert.equal(herdrAvailable({}), false);
	assert.equal(herdrAvailable({ HERDR_ENV: '1' }), false);
	assert.equal(herdrAvailable({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }), true);
});

test('a text-answering call returns its text, not a parse failure about its text', async () => {
	// `agent read` prints the pane's rows on stdout and only its failure is an
	// envelope. Reading it as an envelope turns every successful capture into an
	// error whose message is the screen itself — which is exactly what `job read`
	// used to hand back.
	const { run } = once({ stdout: 'line one\nline two\n', stderr: '', code: 0 });
	assert.equal(await herdrText(run, ['agent', 'read', 'w1:p1']), 'line one\nline two\n');
});

test('a text-answering call still honours an error envelope, and an envelope-shaped success', async () => {
	const bad = await herdrText(once(failure('agent_not_idle', 'cannot read while working')).run, ['agent', 'read', 'w1:p1']).catch((error: unknown) => error);
	assert.ok(bad instanceof HerdrError);
	assert.equal((bad as HerdrError).code, 'agent_not_idle');
	assert.equal(isNotIdle(bad), true, 'the refusal is recognizable, so a caller can fall back');

	const wrapped = await herdrText(once(success({ text: 'wrapped rows' })).run, ['agent', 'read', 'w1:p1']);
	assert.equal(wrapped, 'wrapped rows', 'a version that wraps the rows is unwrapped too');
});

test('agent read asks for scrollback, and a working pane answers with its visible screen', async () => {
	const { run, calls } = once({ stdout: 'rows\n', stderr: '', code: 0 });
	assert.equal(await agentRead(run, 'w1:p1', 60), 'rows\n');
	assert.deepEqual(calls[0], ['agent', 'read', 'w1:p1', '--lines', '60', '--source', 'recent-unwrapped']);

	const visible = once({ stdout: 'visible rows\n', stderr: '', code: 0 });
	assert.equal(await agentRead(visible.run, 'w1:p1', 60, 'visible'), 'visible rows\n');
	assert.deepEqual(visible.calls[0], ['agent', 'read', 'w1:p1', '--lines', '60', '--source', 'visible']);
});

test('a pane with no session is not a missing pane', async () => {
	// Herdr distinguishes the two, and so must anything that asks about a Job's
	// session: a pane whose session exited is still there to be read, restarted and
	// closed, and asking about its agent is a question with an answer of "nothing"
	// rather than a failure.
	const absent = once(failure('agent_not_found', 'agent target w1:p1 not found'));
	assert.equal(await agentGet(absent.run, 'w1:p1'), undefined, 'a pane hosting no agent answers with nothing');
	assert.equal(isMissingAgent(new HerdrError('agent_not_found', 'agent target w1:p1 not found')), true);
	assert.equal(isMissingAgent(new HerdrError('pane_not_found', 'pane w1:p1 not found')), false, 'the two are not interchangeable');

	const gone = once(failure('pane_not_found'));
	assert.equal(await agentGet(gone.run, 'w1:p1'), undefined, 'so does a pane that no longer exists');

	const broken = once(failure('internal_error', 'the socket closed'));
	await assert.rejects(() => agentGet(broken.run, 'w1:p1'), /internal_error|socket closed/, 'any other failure is still a failure');
});
