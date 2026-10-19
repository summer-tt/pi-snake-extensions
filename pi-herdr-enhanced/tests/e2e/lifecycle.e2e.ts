/**
 * One real dispatch, end to end.
 *
 * This is the file that has to be believable. `job open` here starts a real Pi
 * process in a real Herdr tab with the real global settings; the Worker really
 * reads its capability from the flag it was spawned with; its completion claim
 * really travels through a file in an owner-only spool; and the Wake really
 * arrives because a blocking `herdr agent wait` returned. Nothing in this path is
 * polled by the test and nothing about it is simulated.
 *
 * The Worker's model is whatever the operator's default is, so the file costs a
 * small model call per dispatch. It earns that: the capability handoff is the one
 * thing in the extension that cannot be verified without a second process.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerRecordPath, readOwners, scopeLedgerPath } from '../../src/ownership.ts';
import { ExtensionHost } from './host.ts';
import { realpath } from 'node:fs/promises';
import { herdrJson, insideHerdr, paneAlive, tabAlive, waitFor } from './herdr-e2e.ts';

const skip = insideHerdr() ? false : 'not inside a Herdr-managed pane';

/** The task a Worker is given. Small on purpose: the point is the round trip, not the work. */
const TASK = 'Reply with the single word: acknowledged. Then declare completion as instructed.';

/** How long a dispatched Worker may take to boot Pi, run its turn, and declare. */
const WORKER_BUDGET_MS = 300_000;

test('a real Worker is dispatched, declares completion, and wakes this session', { skip, timeout: 900_000 }, async (t) => {
	const realAgentDir = join(homedir(), '.pi', 'agent');
	const startedAt = Date.now();
	const host = new ExtensionHost({ name: 'lifecycle' });
	await host.start();
	t.after(async () => {
		await host.stop();
		// Two artefacts land outside the temporary host, because a Worker is a real Pi
		// process reading the real agent directory: its session transcript, and the
		// run-scope ledger its own session start appends to. Both are swept.
		sweepWorkerSessions(realAgentDir, startedAt, ['lifecycle-1']);
		rmSync(scopeLedgerPath(join(realAgentDir, 'state', 'pi-herdr-enhanced'), host.scope), { force: true });
	});

	let pane = '';
	let tab = '';
	let token = '';

	await t.test('the dispatch establishes a real tab, a real owner record and a real Job', async () => {
		const answer = await dispatch(host, 'lifecycle-1', TASK);
		assert.match(answer, /Opened lifecycle-1 \(#100\) in /);
		assert.match(answer, /delivered the task prompt; the Job is registered with the Job watch/);

		const jobs = host.jobs();
		assert.equal(jobs.length, 1, `exactly one Job should be registered, got ${JSON.stringify(jobs)}`);
		const job = jobs[0]!;
		pane = job.pane;
		tab = job.tab;
		token = job.token;
		assert.equal(job.workspace, host.workspace);
		assert.equal(job.mode, 'tab');
		assert.equal(job.scope, host.scope);
		assert.equal(job.generation, 1);
		assert.equal(job.promptDelivered, true);
		assert.equal(job.provisioned, false, 'a session started, so the window is not "no session"');
		assert.equal(job.claimedComplete, false, 'nothing has claimed completion yet');
		assert.equal(await realpath(job.path), await realpath(host.project), 'a tab Job works in the project directory');
		assert.ok(token.length > 0, 'a Job carries a token that identifies its claims');
		// The recorded launch arguments carry no capability: the token is added at spawn
		// time from the Job's own record, so a resumed window is launched with the same
		// token without the token ever being duplicated into the arguments list.
		assert.deepEqual([...job.piArgs], ['--name', 'lifecycle-1']);
		assert.equal(job.token.length > 0, true);

		// The window is real, and its label is the Ticket behind the Job.
		const record = (await host.tabs()).find((candidate) => candidate.tabId === tab);
		assert.ok(record, `the tab must exist in Herdr: ${JSON.stringify(await host.tabs())}`);
		assert.equal(record.label, '#100 lifecycle-1');
		assert.deepEqual(record.paneIds, [pane]);

		// The owner record is real, and names this session and this generation.
		const owner = JSON.parse(readFileSync(ownerRecordPath(host.stateDir, pane), 'utf8'));
		assert.equal(owner.name, 'lifecycle-1');
		assert.equal(owner.ticket, '#100');
		assert.equal(owner.scope, host.scope);
		assert.equal(owner.generation, 1);
		assert.equal(owner.orchestrator, host.root, 'the orchestrator is the family root, not a per-process id');
		assert.equal(owner.mode, 'tab');
		assert.equal(owner.pane, pane);
		assert.equal(owner.label, '#100 lifecycle-1');

		// The spool the Worker will claim into was created by the open, owner-only.
		assert.equal(statSync(host.spoolPath).mode & 0o777, 0o700);
	});

	await t.test('the Worker declares completion through the capability it was spawned with', async () => {
		const claim = join(host.spoolPath, `claim-${token}.json`);
		await waitFor('the Worker to declare completion', async () => existsSync(claim), { timeoutMs: WORKER_BUDGET_MS, intervalMs: 500 });
		const payload = JSON.parse(readFileSync(claim, 'utf8'));
		assert.equal(payload.token, token, 'the claim carries the Job token, which only the spawn flag could have told the Worker');
		assert.equal(payload.name, 'lifecycle-1');
		assert.equal(payload.ticket, '#100');
		assert.equal(payload.scope, host.scope);
		assert.equal(typeof payload.claimedAt, 'number');
		assert.equal(statSync(claim).mode & 0o777, 0o600, 'a claim is owner-only');
	});

	await t.test('the Wake arrives by itself, from the blocking wait, and names the claim', async () => {
		// The claim file existing is not the same as the watch having read it, so this
		// waits for the round that consumed it. That round is the one the wait returned
		// from, which is the whole point of holding a blocking wait per Job.
		await waitFor('the watch to consume the claim', async () => (host.jobs()[0]?.claimedComplete === true ? true : undefined), { timeoutMs: 120_000, intervalMs: 500 });
		await waitFor('a Wake delivered by the watch', async () => (host.messages.length > 0 ? true : undefined), { timeoutMs: 120_000, intervalMs: 500 });
		const wake = host.lastWake();
		assert.equal(wake.details.identities?.length, 1, `one Job should produce one cause: ${wake.content}`);
		// The Wake says what happened, in the terms of the Job that made it news, and
		// closes with the ask. It never asserts a result: the pane decides that.
		assert.match(wake.content, /^## Job watch\n\n1 Job declared complete$/m);
		assert.match(wake.content, /- Job lifecycle-1 \(#100\) at \S+ is \w+ and declared complete\./);
		assert.match(wake.content, /never says a Job succeeded/);
		assert.match(wake.content, /`job retain` what you have captured/);
		assert.doesNotMatch(wake.content, /Re-sent/, 'a first delivery is not a re-delivery');
		assert.match(wake.content, /it never says a Job succeeded/);
		assert.match(wake.content, /That requests reconciliation; it does not prove success/);
		assert.equal(wake.details.reasons?.[0]?.panes.includes(pane), true);
		assert.equal(host.jobs()[0]!.claimedComplete, true, 'the claim was consumed before the cause was raised');
	});

	await t.test('a Job that has not been observed working is never announced', async () => {
		// The dispatch above must produce exactly one Wake, not one for the moment
		// before the Worker accepted its prompt. This is the assertion that would have
		// failed before the watch learned to wait for `promptDelivered`.
		const wakes = host.messages.filter((message) => message.customType === 'pi-herdr-enhanced-job-watch');
		assert.equal(wakes.length, 1, `one dispatch must produce one Wake, got ${wakes.length}: ${wakes.map((wake) => wake.content).join(' --- ')}`);
		assert.equal(host.openDeliveries().length, 1);
		assert.equal(host.openDeliveries()[0]!.state, 'injected');
	});

	await t.test('status reports the Job against Herdr\'s own observation of its pane', async () => {
		const status = await host.ok('job', { action: 'status' });
		assert.match(status, /1 watched, 0 retained \(cap 2\)/);
		assert.match(status, /- lifecycle-1 \(#100\) [^ ]+ \[[^\]]+\] (done|idle|working)/, status);
		assert.match(status, /declared complete/);
		assert.match(status, /Wake news with no answer yet:/);
		assert.match(await host.ok('job_watch', { action: 'status' }), /lifecycle-1/);
	});

	await t.test('read returns the Worker\'s own terminal, and changes nothing', async () => {
		const text = await host.ok('job', { action: 'read', target: 'lifecycle-1', lines: 200 });
		assert.match(text, /^Job lifecycle-1 \(#100\) at /, text.slice(0, 200));
		assert.ok(text.length > 60, `a live pane has a terminal stream: ${text}`);
		assert.equal(host.jobs()[0]!.pane, pane, 'reading must not disturb the Job');
	});

	await t.test('an aborted run leaves the Wake unanswered; a settled one acknowledges it and retains the Job', async () => {
		const identities = host.openDeliveries().map((delivery) => delivery.id);

		// A run that aborted consumed nothing anyone can be sure was acted on. It is
		// recorded as failed, and never retried automatically: nothing can tell a
		// human cancellation from a failed one.
		await host.beginRun();
		await host.messageEnters();
		await host.endTurn();
		await host.settleRun(true);
		assert.equal(host.openDeliveries().length, identities.length, 'an aborted run must leave the Wake unanswered');
		assert.equal(host.watchState().deliveries[0]!.outcome, 'aborted');
		assert.equal(host.watchState().deliveries[0]!.nextRetryAt, undefined, 'an aborted run is never retried automatically');
		assert.equal(host.jobs()[0]!.retention, 'none', 'an unanswered Wake retains nothing');

		// A run that ended normally did consume it, and retention is the normal end of
		// a finished Job's life in the watch.
		await host.beginRun();
		await host.messageEnters();
		await host.endTurn();
		await host.settleRun(false);
		assert.deepEqual(host.openDeliveries(), [], 'a settled run acknowledges the Wake');
		assert.equal(host.jobs()[0]!.retention, 'auto', 'acknowledging the news retains the finished Job');
		assert.match(await host.ok('job', { action: 'status' }), /retained for inspection \(automatic\)/);
	});

	await t.test('re-opening the same Job resumes it and creates nothing', async () => {
		const before = await host.windowCount();
		const answer = await host.ok('job', { action: 'open', name: 'lifecycle-1', ticket: '#100', prompt: 'a different task that must be ignored' });
		assert.match(answer, /Resumed lifecycle-1 \(#100\) at /);
		assert.match(answer, /Nothing was created/);
		assert.equal(await host.windowCount(), before, 'a resume must not add a tab');
		assert.equal(host.jobs().length, 1);
		assert.equal(host.jobs()[0]!.pane, pane, 'a resume must return to the same pane');
		assert.equal(host.jobs()[0]!.taskText, TASK, 'a resume must not replace the assigned task');
	});

	await t.test('re-opening a Job returns it to the watch', async () => {
		// Resuming is an explicit statement that the Job is live work again, so an
		// automatic retention — whose whole purpose was to end the Job's life in the
		// watch — must not survive it. Otherwise a continued Job would run unwatched.
		assert.equal(host.jobs()[0]!.retention, 'none', 'a resumed Job is watched again');
		assert.match(await host.ok('job_watch', { action: 'status' }), /1 watched/);
	});

	await t.test('steer reaches the live Worker', async () => {
		assert.match(await host.ok('job', { action: 'steer', target: 'lifecycle-1', message: 'Stand by; no further work is needed.' }), /lifecycle-1/);
	});

	await t.test('a Job whose window disappears is reported dead and then replaced', async () => {
		// A human closing the tab. The recorded Job is now stale, and the only honest
		// answer is that the pane is gone — not whatever it was last seen doing.
		await herdrJson(['tab', 'close', tab]);
		await waitFor('the Job tab to disappear', async () => !(await paneAlive(pane)));
		assert.equal(await tabAlive(tab), false);

		const status = await host.ok('job', { action: 'status' });
		assert.match(status, /- lifecycle-1 \(#100\) [^ ]+ \[[^\]]+\] dead/, `a vanished pane must be reported as dead: ${status}`);
		assert.match(status, /declared complete/, 'the claim survives its window');

		const answer = await dispatch(host, 'lifecycle-1', TASK);
		assert.match(answer, /Opened lifecycle-1/);
		const replacement = host.jobs()[0]!;
		assert.notEqual(replacement.pane, pane, 'a Job whose pane is gone must be replaced');
		assert.equal(replacement.token, token, 'a replacement session is still the same Job for claim purposes');
		assert.equal(replacement.workspace, host.workspace, 'the replacement lands in the same workspace');
		pane = replacement.pane;
		tab = replacement.tab;

		const replaced = await host.ok('job', { action: 'status' });
		assert.doesNotMatch(replaced, / dead/, `the replacement must be live: ${replaced}`);
	});

	await t.test('the replacement Job is watched, declares, and closes', async () => {
		// The replacement reuses the Job's token, so its claim arrives under the same
		// name as the original's — which is what makes it the *same* Job for claim
		// purposes rather than a new one.
		await waitFor('the replacement Worker to declare completion', async () => existsSync(join(host.spoolPath, `claim-${token}.json`)), { timeoutMs: WORKER_BUDGET_MS, intervalMs: 500 });
		await waitFor('the watch to consume the replacement claim', async () => (host.jobs()[0]?.claimedComplete === true ? true : undefined), { timeoutMs: 120_000, intervalMs: 500 });
		await waitFor('a Wake for the replacement', async () => (host.lastWakeIfAny()?.content.includes('lifecycle-1') ? true : undefined), { timeoutMs: 120_000, intervalMs: 500 });
		assert.equal(host.jobs().length, 1, 'the dead window must not linger beside its replacement');

		// `reason` is given because a Wake may have raised the cause before the claim
		// landed; the no-reason path is exercised where it is deterministic, in the
		// watch suite, on a Job that has already declared completion.
		const closed = await host.ok('job', { action: 'close', workspace: 'lifecycle-1', reason: 'the work is reconciled' });
		assert.match(closed, /^closed /, closed);
		assert.match(closed, /Reason recorded: the work is reconciled/);
		await waitFor('the replacement tab to close', async () => !(await paneAlive(pane)));
		assert.deepEqual(host.jobs(), [], 'a closed Job leaves the watch');
		assert.deepEqual(readOwners(host.stateDir), [], 'the owner record goes with the window');
	});

	await t.test('the reserved flag is registered as a string, so a resumed Worker without argv still resolves', () => {
		assert.deepEqual(host.flags.get('pi-herdr-enhanced-job'), { description: 'pi-herdr-enhanced Job capability delivered at spawn time (opaque)', type: 'string' });
	});
});

/**
 * Delete the Pi session transcripts a dispatch created.
 *
 * A Worker is a real Pi process reading the real agent directory, so it writes a
 * real session file there. The suite is a guest in that directory and leaves
 * nothing behind: every transcript newer than this run that mentions one of its
 * Job names is removed.
 */
function sweepWorkerSessions(agentDir: string, since: number, names: readonly string[]): void {
	const root = join(agentDir, 'sessions');
	let projects: readonly string[];
	try {
		projects = readdirSync(root);
	} catch {
		return;
	}
	for (const project of projects) {
		const dir = join(root, project);
		let files: readonly string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (statSync(path).mtimeMs < since) continue;
				const body = readFileSync(path, 'utf8');
				if (!names.some((name) => body.includes(name))) continue;
				rmSync(path, { force: true });
			} catch {
				// A transcript that cannot be read is not this suite's business.
			}
		}
	}
}

/**
 * Dispatch a Job, and require that its session actually started.
 *
 * `agent start` can refuse a pane it has just created — it is a real terminal
 * doing real terminal things — and that outcome is a documented part of the
 * contract rather than a test failure: the window exists, the Job is registered,
 * and repeating the open restarts the session in place. So this asserts the
 * contract and then does exactly what the contract says to do.
 */
async function dispatch(host: ExtensionHost, name: string, task: string, attempts = 3): Promise<string> {
	let answer = '';
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		answer = await host.ok('job', { action: 'open', name, ticket: '#100', prompt: task });
		if (!/its Pi session did not start/.test(answer)) return answer;
		const job = host.jobs().find((candidate) => candidate.name === name);
		assert.ok(job, 'a window whose session failed to start is still an addressable Job');
		assert.equal(job.provisioned, true, 'a window with no session is recorded as provisioned');
		assert.equal(job.promptDelivered, false);
		assert.match(answer, /repeating this open restarts the session in place/);
		assert.match(await host.ok('job', { action: 'status' }), new RegExp(`- ${name} \\(#100\\) [^ ]+ \\[[^\\]]+\\]`));
	}
	throw new Error(`the Job session never started after ${attempts} attempts. Last answer: ${answer}`);
}
