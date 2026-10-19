/**
 * The durable run-scope state: restore semantics, lookup, and the retention
 * queue.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	WATCH_ENTRY_TYPE,
	addDelivery,
	arm,
	dropDeliveriesFor,
	emptyWatch,
	findJob,
	openDeliveries,
	patchDelivery,
	patchJob,
	pruneDeliveries,
	removePanes,
	restoreWatch,
	retainedJobs,
	retentionOverflow,
	retainPanes,
	reviveAutoRetained,
	upsertJob,
	watchedJobs,
} from '../src/registry.ts';
import { makeJob } from './fixtures.ts';
import type { JobRecord, WatchState } from '../src/registry.ts';

const state = (...jobs: JobRecord[]): WatchState => ({ ...emptyWatch(), jobs });
const entry = (data: unknown) => ({ customType: WATCH_ENTRY_TYPE, data });

test('the last readable entry wins, so a closed Job is never resurrected', () => {
	const first = entry({ jobs: [makeJob({ pane: 'w1:p1' }), makeJob({ pane: 'w1:p2', name: 'other' })], deliveries: [], armed: true });
	const second = entry({ jobs: [makeJob({ pane: 'w1:p1' })], deliveries: [], armed: true });
	const restored = restoreWatch([first, second]);
	assert.deepEqual(restored.jobs.map((job) => job.pane), ['w1:p1']);
	assert.equal(restored.armed, true);
});

test('a session with no watch entry restores to an empty, unarmed watch', () => {
	const restored = restoreWatch([]);
	assert.deepEqual(restored.jobs, []);
	assert.equal(restored.armed, false, 'an empty watch is reported, not assumed to mean nothing is open');
});

test('a Job is found by name, pane, workspace or tab', () => {
	const watch = state(makeJob({ name: 'fix-142', pane: 'w1:p1', workspace: 'w1', tab: 'w1:t1' }));
	assert.equal(findJob(watch, 'fix-142')?.pane, 'w1:p1');
	assert.equal(findJob(watch, 'w1:p1')?.name, 'fix-142');
	assert.equal(findJob(watch, 'w1')?.name, 'fix-142');
	assert.equal(findJob(watch, 'w1:t1')?.name, 'fix-142');
	assert.equal(findJob(watch, 'nope'), undefined);
});

test('only a Job in a workspace is removed with it, and its news goes too', () => {
	const watch = {
		...state(makeJob({ pane: 'w1:p1', workspace: 'w1' }), makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'other' })),
		deliveries: [
			{ id: 'd1', reason: 'x', panes: ['w1:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 },
			{ id: 'd2', reason: 'y', panes: ['w2:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 },
		],
	};
	const after = removePanes(watch, ['w1:p1']);
	assert.deepEqual(after.jobs.map((job) => job.pane), ['w2:p1']);
	assert.deepEqual(after.deliveries.map((delivery) => delivery.id), ['d2'], 'news about a Job that is gone is irrelevant');
});

test('a retained Job leaves the watch but stays listed, oldest first', () => {
	let watch = state(makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a' }), makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'b' }));
	watch = retainPanes(watch, ['w2:p1'], 'manual', () => 500);
	watch = retainPanes(watch, ['w1:p1'], 'auto', () => 100);
	assert.deepEqual(watchedJobs(watch), []);
	assert.deepEqual(retainedJobs(watch).map((job) => job.name), ['a', 'b'], 'the retention queue is ordered by when each was retained');
});

test('retention clears any hold, so a finished Job cannot stay suppressed', () => {
	const held = patchJob(state(makeJob({ pane: 'w1:p1', workspace: 'w1' })), 'w1:p1', { heldUntil: 9_999, heldNote: 'human' });
	const retained = retainPanes(held, ['w1:p1'], 'auto', () => 1);
	assert.equal(retained.jobs[0]?.heldUntil, 0);
	assert.equal(retained.jobs[0]?.heldNote, '');
});

test('the cap evicts only Retained windows, and only the oldest', () => {
	let watch = state(
		makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a' }),
		makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'b' }),
		makeJob({ pane: 'w3:p1', workspace: 'w3', name: 'c' }),
	);
	watch = retainPanes(watch, ['w1:p1'], 'auto', () => 10);
	watch = retainPanes(watch, ['w2:p1'], 'auto', () => 20);
	assert.deepEqual(retentionOverflow(watch, 2), []);
	assert.deepEqual(retentionOverflow(watch, 1).map((job) => job.name), ['a']);
	assert.deepEqual(retentionOverflow(watch, 0).map((job) => job.name), ['a', 'b']);
});

test('a working window is never evicted by the cap, however small it is', () => {
	let watch = state(makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'live' }), makeJob({ pane: 'w2:p1', workspace: 'w2', name: 'done' }));
	watch = retainPanes(watch, ['w2:p1'], 'auto', () => 10);
	assert.deepEqual(retentionOverflow(watch, 0).map((job) => job.name), ['done']);
	assert.equal(watch.jobs.length, 2, 'the cap bounds what is kept for inspection, never live work');
});

test('a Retained window that starts working again returns to the watch', () => {
	let watch = retainPanes(state(makeJob({ pane: 'w1:p1', workspace: 'w1' })), ['w1:p1'], 'auto', () => 1);
	const revived = reviveAutoRetained(watch, 'w1:p1');
	assert.equal(revived.revived, true);
	assert.equal(revived.state.jobs[0]?.retention, 'none');
});

test('a hand retain is not silently withdrawn by a later poll', () => {
	const watch = retainPanes(state(makeJob({ pane: 'w1:p1', workspace: 'w1' })), ['w1:p1'], 'manual', () => 1);
	const revived = reviveAutoRetained(watch, 'w1:p1');
	assert.equal(revived.revived, false, 'the operator asked for this one deliberately');
	assert.equal(revived.state.jobs[0]?.retention, 'manual');
});

test('arming is idempotent and recorded', () => {
	const armed = arm(emptyWatch());
	assert.equal(arm(armed), armed);
	assert.equal(armed.armed, true);
});

test('a delivery is added once per identity, whatever is raised again', () => {
	const delivery = { id: 'd1', reason: 'x', panes: ['w1:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 };
	const once = addDelivery(emptyWatch(), delivery);
	const twice = addDelivery(once, delivery);
	assert.equal(once, twice, 'the same identity is the same news');
	assert.equal(openDeliveries(twice).length, 1);
});

test('acknowledged news is history, and pruning only drops that', () => {
	let watch = emptyWatch();
	for (let index = 0; index < 5; index += 1) {
		watch = addDelivery(watch, { id: `d${index}`, reason: 'x', panes: [], createdAt: index, state: 'pending', attempts: 0 });
		watch = patchDelivery(watch, `d${index}`, { state: 'acknowledged' });
	}
	watch = addDelivery(watch, { id: 'open', reason: 'y', panes: [], createdAt: 9, state: 'injected', attempts: 1 });
	const pruned = pruneDeliveries(watch, 2);
	assert.equal(pruned.deliveries.length, 3);
	assert.ok(pruned.deliveries.some((delivery) => delivery.id === 'open'), 'unhandled news is never pruned');
});

test('dropping news for a window leaves every other identity alone', () => {
	const watch = {
		...emptyWatch(),
		deliveries: [
			{ id: 'd1', reason: 'x', panes: ['w1:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 },
			{ id: 'd2', reason: 'y', panes: ['w1:p1', 'w2:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 },
		],
	};
	assert.deepEqual(dropDeliveriesFor(watch, ['w1:p1']).deliveries, [], 'a coalesced cause naming the window goes with it');

	const unrelated = { ...watch, deliveries: [{ id: 'd3', reason: 'z', panes: ['w3:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 }] };
	assert.deepEqual(dropDeliveriesFor(unrelated, ['w1:p1']).deliveries.length, 1);
});

test('patching an unknown pane changes nothing', () => {
	const watch = state(makeJob({ pane: 'w1:p1' }));
	assert.equal(patchJob(watch, 'w9:p9', { name: 'other' }), watch);
});

test('upserting a Job keeps its position and never duplicates a pane', () => {
	const watch = state(makeJob({ pane: 'w1:p1', name: 'a' }), makeJob({ pane: 'w2:p1', name: 'b' }));
	const updated = upsertJob(watch, makeJob({ pane: 'w2:p1', name: 'b2' }));
	assert.deepEqual(updated.jobs.map((job) => `${job.pane}:${job.name}`), ['w1:p1:a', 'w2:p1:b2']);
});

test('retention and removal name one window, never its siblings in the same workspace', () => {
	// In tab mode every Job lives in the Orchestrator's own workspace, so a Job's
	// workspace identifies *all* of them. Both operations are therefore keyed by pane.
	const three = state(
		makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a' }),
		makeJob({ pane: 'w1:p2', workspace: 'w1', name: 'b' }),
		makeJob({ pane: 'w1:p3', workspace: 'w1', name: 'c' }),
	);
	const retained = retainPanes(three, ['w1:p2'], 'auto', () => 5);
	assert.deepEqual(retained.jobs.map((job) => job.retention), ['none', 'auto', 'none'], 'only the named Job is retained');

	const removed = removePanes(three, ['w1:p2']);
	assert.deepEqual(removed.jobs.map((job) => job.name), ['a', 'c'], 'only the named Job is dropped');
});

test('removal takes only the news that named the window it removed', () => {
	const shared = {
		...state(makeJob({ pane: 'w1:p1', workspace: 'w1', name: 'a' }), makeJob({ pane: 'w1:p2', workspace: 'w1', name: 'b' })),
		deliveries: [
			{ id: 'd1', reason: 'x', panes: ['w1:p1'], createdAt: 1, state: 'pending' as const, attempts: 0 },
			{ id: 'd2', reason: 'y', panes: ['w1:p2'], createdAt: 1, state: 'pending' as const, attempts: 0 },
		],
	};
	assert.deepEqual(removePanes(shared, ['w1:p1']).deliveries.map((delivery) => delivery.id), ['d2']);
});
