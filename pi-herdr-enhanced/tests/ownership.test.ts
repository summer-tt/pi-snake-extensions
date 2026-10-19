/**
 * Ownership and generation: the fencing token, the takeover gate, and the
 * liveness evidence that decides what may be touched.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	claimFamily,
	claimGeneration,
	classifyScopeOwnership,
	classifyWindowOwnership,
	familyScope,
	familyScopes,
	isCompleteClaimChain,
	ownerLiveness,
	parseScope,
	readClaimHistory,
	readOwner,
	readOwners,
	removeOwner,
	removeOwnersInWorkspace,
	restoreScopeChain,
	scopeClaimant,
	scopeLedgerPath,
	writeOwner,
	SCOPE_ENTRY_TYPE,
	type Claimant,
	type FamilyClaimant,
	type OwnershipRecord,
} from '../src/ownership.ts';

function state(): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), 'phe-own-'));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const claimant = (orchestrator: string, nonce?: string): Claimant => ({ scope: 's1', orchestrator, project: '/repo', pid: 41, host: 'h', nonce });

const owner = (overrides: Partial<OwnershipRecord> = {}): OwnershipRecord => ({
	workspace: 'w1',
	tab: 'w1:t1',
	pane: 'w1:p1',
	path: '/repo',
	branch: 'fix-142',
	label: '#142 fix-142',
	ticket: '#142',
	name: 'fix-142',
	mode: 'tab',
	project: '/repo',
	scope: 's1',
	generation: 1,
	orchestrator: 'orch-a',
	pid: 41,
	host: 'h',
	...overrides,
});

test('the first owner of a scope takes generation 1', () => {
	const d = state();
	try {
		const claim = claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		assert.equal(claim.authorized, true);
		assert.equal(claim.generation, 1);
		assert.deepEqual(readClaimHistory(d.path, 's1').claims.map((c) => c.generation), [1]);
	} finally {
		d.cleanup();
	}
});

test('the same incarnation reuses its generation and appends nothing', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		const again = claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 2);
		assert.equal(again.generation, 1);
		assert.equal(readClaimHistory(d.path, 's1').claims.length, 1, 'a claim is a transition, not a heartbeat');
	} finally {
		d.cleanup();
	}
});

test('another owner cannot act on a scope without a takeover', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		const other = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2);
		assert.equal(other.authorized, false);
		assert.equal(other.generation, 1, 'the incumbent generation is reported, not adopted');
		assert.match(other.reason ?? '', /explicit takeover/);
		assert.equal(readClaimHistory(d.path, 's1').claims.length, 1, 'a refused claim writes nothing');
	} finally {
		d.cleanup();
	}
});

test('a takeover requires the exact expected owner and generation', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		const wrongOwner = claimGeneration(d.path, claimant('orch-b', 'n2'), { takeover: true, expectedOwner: 'orch-c', expectedGeneration: 1 }, () => 2);
		assert.equal(wrongOwner.authorized, false);
		const wrongGeneration = claimGeneration(d.path, claimant('orch-b', 'n2'), { takeover: true, expectedOwner: 'orch-a', expectedGeneration: 7 }, () => 2);
		assert.equal(wrongGeneration.authorized, false);
		const none = claimGeneration(d.path, claimant('orch-b', 'n2'), { takeover: true }, () => 2);
		assert.equal(none.authorized, false);
		assert.equal(readClaimHistory(d.path, 's1').claims.length, 1);
	} finally {
		d.cleanup();
	}
});

test('a matched takeover appends the next generation and names what it supersedes', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		const taken = claimGeneration(d.path, claimant('orch-b', 'n2'), { takeover: true, expectedOwner: 'orch-a', expectedGeneration: 1 }, () => 5);
		assert.equal(taken.authorized, true);
		assert.equal(taken.generation, 2);
		const claims = readClaimHistory(d.path, 's1').claims;
		assert.deepEqual(claims.map((c) => [c.generation, c.supersedes]), [[1, undefined], [2, 1]]);
		assert.ok(isCompleteClaimChain(claims));
	} finally {
		d.cleanup();
	}
});

test('a damaged ledger fails closed', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		mkdirSync(join(d.path, 'scopes'), { recursive: true });
		writeFileSync(join(d.path, 'scopes', 's1.jsonl'), `${JSON.stringify({ scope: 's1', generation: 1, orchestrator: 'orch-a', at: 1 })}\n{ torn`, { mode: 0o600 });
		const history = readClaimHistory(d.path, 's1');
		assert.equal(history.incomplete, true);
		const claim = claimGeneration(d.path, claimant('orch-b', 'n2'), { takeover: true, expectedOwner: 'orch-a', expectedGeneration: 1 }, () => 2);
		assert.equal(claim.authorized, false);
		assert.match(claim.reason ?? '', /incomplete or unreadable/);
	} finally {
		d.cleanup();
	}
});

test('a chain with a gap is not a chain', () => {
	assert.ok(isCompleteClaimChain([]));
	assert.ok(isCompleteClaimChain([{ scope: 's', generation: 1, orchestrator: 'a', at: 0 }]));
	assert.equal(isCompleteClaimChain([
		{ scope: 's', generation: 1, orchestrator: 'a', at: 0 },
		{ scope: 's', generation: 3, orchestrator: 'b', supersedes: 1, at: 0 },
	]), false, 'a skipped generation is ambiguity, not progress');
	assert.equal(isCompleteClaimChain([
		{ scope: 's', generation: 1, orchestrator: 'a', at: 0 },
		{ scope: 's', generation: 2, orchestrator: 'b', supersedes: undefined, at: 0 },
	]), false, 'a later claim must name what it superseded');
});

test('a recorded owner round-trips through the store', () => {
	const d = state();
	try {
		writeOwner(d.path, owner());
		assert.deepEqual(readOwner(d.path, 'w1:p1')?.name, 'fix-142');
		removeOwner(d.path, 'w1:p1');
		assert.equal(readOwner(d.path, 'w1:p1'), undefined);
	} finally {
		d.cleanup();
	}
});

test('liveness requires a complete identity, and a recycled PID stays unknown', () => {
	const alive = { isAlive: () => true, getStartTime: () => 'START-A', host: 'h' };
	assert.equal(ownerLiveness(owner({ startTime: 'START-A' }), alive), 'observed-live');
	assert.equal(ownerLiveness(owner({ startTime: 'START-B' }), alive), 'unknown', 'the PID was recycled');
	assert.equal(ownerLiveness(owner({ startTime: undefined }), alive), 'observed-live', 'no recorded start time is not evidence of death');
	assert.equal(ownerLiveness(owner({ host: 'other' }), alive), 'unknown', 'another host cannot be judged from here');
	assert.equal(ownerLiveness(owner({ pid: undefined }), alive), 'unknown');
	assert.equal(ownerLiveness(owner(), { isAlive: () => false, host: 'h' }), 'dead');
});

test('only the current session authorizes a mutation', () => {
	const d = state();
	try {
		writeOwner(d.path, owner({ generation: 1, orchestrator: 'orch-a' }));
		const mine = classifyWindowOwnership({ pane: 'w1:p1', currentOrchestrator: 'orch-a', currentScope: 's1', currentGeneration: 1, stateDir: d.path, host: 'h', isAlive: () => true });
		assert.equal(mine.category, 'current-session');

		const stale = classifyWindowOwnership({
			pane: 'w1:p1',
			currentOrchestrator: 'orch-b',
			currentScope: 's1',
			currentGeneration: 2,
			stateDir: d.path,
			host: 'h',
			isAlive: () => true,
		});
		assert.notEqual(stale.category, 'current-session');
		assert.equal(stale.category, 'another-live-owner', 'a live owner is never quietly reclassified');
	} finally {
		d.cleanup();
	}
});

test('a gone owner is unowned only when the ledger confirms it was the latest', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		writeOwner(d.path, owner({ generation: 1, orchestrator: 'orch-a' }));
		const confirmed = classifyWindowOwnership({
			pane: 'w1:p1',
			currentOrchestrator: 'orch-b',
			currentScope: 's1',
			currentGeneration: 2,
			stateDir: d.path,
			host: 'h',
			isAlive: () => false,
		});
		assert.equal(confirmed.category, 'unowned');

		// A later claim by somebody else means this record is not the latest owner,
		// so "the owner is gone" no longer implies "nobody owns this".
		claimGeneration(d.path, claimant('orch-c', 'n3'), { takeover: true, expectedOwner: 'orch-a', expectedGeneration: 1 }, () => 2);
		const superseded = classifyWindowOwnership({
			pane: 'w1:p1',
			currentOrchestrator: 'orch-b',
			currentScope: 's1',
			currentGeneration: 3,
			stateDir: d.path,
			host: 'h',
			isAlive: () => false,
		});
		assert.equal(superseded.category, 'ownership-unknown');
	} finally {
		d.cleanup();
	}
});

test('a window with no record is unknown, never unowned', () => {
	const d = state();
	try {
		const classification = classifyWindowOwnership({ pane: 'w9:p1', currentOrchestrator: 'orch-a', currentScope: 's1', currentGeneration: 1, stateDir: d.path });
		assert.equal(classification.category, 'ownership-unknown');
		assert.equal(classification.record, undefined);
	} finally {
		d.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Inheriting a scope whose owner is gone
//
// Without this, the first session to touch a run scope would own it forever: the
// orchestrator id changes with every pi process, so every later session — even
// one that simply restarted after a crash — would be refused its own Jobs.
// ---------------------------------------------------------------------------

test('a scope whose owner is provably gone is inherited, and recorded as a handoff', () => {
	const d = state();
	try {
		assert.equal(claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1).authorized, true);
		const next = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => false, host: 'h' });
		assert.equal(next.authorized, true, 'the session after the owner died has to be able to claim the scope');
		assert.equal(next.inherited, true, 'so the caller can say why it now owns a scope it never claimed');
		assert.equal(next.generation, 2);
		assert.match(String(next.reason), /whose process is no longer running/);
		assert.deepEqual(
			readClaimHistory(d.path, 's1').claims.map((claim) => [claim.generation, claim.orchestrator, claim.supersedes]),
			[
				[1, 'orch-a', undefined],
				[2, 'orch-b', 1],
			],
			'a handoff advances the generation exactly as a takeover does: the ledger is the fence',
		);
	} finally {
		d.cleanup();
	}
});

test('a live owner is never inherited', () => {
	const d = state();
	try {
		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		const refused = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => true, host: 'h' });
		assert.equal(refused.authorized, false, 'a running session keeps its scope');
		assert.equal(refused.generation, 1, 'and the generation is not advanced behind its back');
		assert.match(String(refused.reason), /which is still running/);
		assert.match(String(refused.reason), /explicit takeover naming expectedOwner 'orch-a' and expectedGeneration 1/);
		assert.deepEqual(readClaimHistory(d.path, 's1').claims.map((claim) => claim.generation), [1], 'nothing was appended');
	} finally {
		d.cleanup();
	}
});

test('an owner on another machine is not inherited', () => {
	const d = state();
	try {
		// A recorded host that is not this one is a claim this process cannot judge:
		// "cannot prove it is gone" is not "it is gone".
		claimGeneration(d.path, { ...claimant('orch-a', 'n1'), host: 'another-machine' }, undefined, () => 1);
		const refused = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => false, host: 'h' });
		assert.equal(refused.authorized, false);
		assert.match(String(refused.reason), /whose liveness cannot be established/);
		assert.deepEqual(readClaimHistory(d.path, 's1').claims.map((claim) => claim.generation), [1]);
	} finally {
		d.cleanup();
	}
});

test('a claim from before hosts were recorded is judged on its PID', () => {
	// The pre-release ledger recorded a PID and no host, so there is nothing to
	// attribute it to. Judging it on the PID alone can only turn a *dead* process into
	// a handoff — never a live one — and the claim written by that handoff records the
	// host, so the ambiguity is never written again.
	const d = state();
	try {
		claimGeneration(d.path, { scope: 's1', orchestrator: 'orch-a', project: '/repo', pid: 999_999, nonce: 'n1' }, undefined, () => 1);
		const inherited = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => false, host: 'h' });
		assert.equal(inherited.authorized, true, 'an old ledger must not lock a scope out forever');
		assert.equal(inherited.inherited, true);
		assert.equal(readClaimHistory(d.path, 's1').claims[1]?.host, 'h', 'and the ambiguity is gone from what it writes');

		const alive = state();
		try {
			claimGeneration(alive.path, { scope: 's1', orchestrator: 'orch-a', project: '/repo', pid: 4242, nonce: 'n1' }, undefined, () => 1);
			const refused = claimGeneration(alive.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => true, host: 'h' });
			assert.equal(refused.authorized, false, 'a live PID of the same shape still fences the scope');
			assert.match(String(refused.reason), /which is still running/);
		} finally {
			alive.cleanup();
		}
	} finally {
		d.cleanup();
	}
});

test('a recycled PID is not a dead owner', () => {
	const d = state();
	try {
		claimGeneration(d.path, { ...claimant('orch-a', 'n1'), startTime: 'Mon Jan  1 00:00:00 2024' }, undefined, () => 1);
		// The PID is alive but its start time differs, so it is somebody else now.
		const refused = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, {
			isAlive: () => true,
			getStartTime: () => 'Tue Jan  2 00:00:00 2024',
			host: 'h',
		});
		assert.equal(refused.authorized, false, 'a recycled PID authorizes nothing');
		assert.match(String(refused.reason), /liveness cannot be established/);
	} finally {
		d.cleanup();
	}
});

test('an ambiguous ledger is not inherited even when the owner is gone', () => {
	const d = state();
	try {
		// Generation 3 with nothing before it: the chain is broken, so no history here
		// can be trusted to say who owned the scope last.
		mkdirSync(join(d.path, 'scopes'), { recursive: true });
		writeFileSync(join(d.path, 'scopes', 's1.jsonl'), `${JSON.stringify({ scope: 's1', generation: 3, orchestrator: 'orch-a', pid: 41, host: 'h', at: 1 })}\n`);
		const refused = claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => false, host: 'h' });
		assert.equal(refused.authorized, false);
		assert.match(String(refused.reason), /still running|liveness cannot be established|unbroken chain/);
		assert.equal(readClaimHistory(d.path, 's1').claims.length, 1, 'nothing was appended');
	} finally {
		d.cleanup();
	}
});

test('the standing of a scope is reported without claiming it', () => {
	const d = state();
	try {
		const current = { scope: 's1', orchestrator: 'orch-b', generation: 1 };
		assert.equal(classifyScopeOwnership(d.path, current).category, 'unclaimed');

		claimGeneration(d.path, claimant('orch-a', 'n1'), undefined, () => 1);
		assert.equal(classifyScopeOwnership(d.path, current, { isAlive: () => true, host: 'h' }).category, 'another-live-owner');
		assert.equal(classifyScopeOwnership(d.path, current, { isAlive: () => false, host: 'h' }).category, 'unowned');
		assert.match(classifyScopeOwnership(d.path, current, { isAlive: () => false, host: 'h' }).reason, /the first dispatch takes generation 2/);
		assert.equal(classifyScopeOwnership(d.path, current, { isAlive: () => false, host: 'otherhost' }).category, 'ownership-unknown');

		// Our own claim, at the generation we hold.
		claimGeneration(d.path, claimant('orch-b', 'n2'), undefined, () => 2, { isAlive: () => false, host: 'h' });
		assert.equal(classifyScopeOwnership(d.path, { scope: 's1', orchestrator: 'orch-b', generation: 2 }, { isAlive: () => true, host: 'h' }).category, 'current-session');
		assert.equal(readClaimHistory(d.path, 's1').claims.length, 2, 'reporting a standing never appends');
	} finally {
		d.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The scope family
//
// A session owns a family of scopes (`<root>#0`, `<root>#1`, …) rather than one
// name. A concurrent resume of the same session file derives the next number
// instead of being refused, and a dead incarnation's scopes are absorbed so its
// windows stay disposable.
// ---------------------------------------------------------------------------

const fam = (root: string, nonce?: string): FamilyClaimant => ({ root, orchestrator: root, project: '/repo', pid: process.pid, host: 'h', nonce });

/** This process, with the start time its own earlier incarnation would have recorded. */
const self = (root: string, nonce: string): FamilyClaimant => ({ ...fam(root, nonce), startTime: 'start' });

/** Seed one incarnation's ledger as a previous session would have left it. */
function seedScope(
	stateDir: string,
	scope: string,
	options: { readonly pid: number; readonly generation?: number; readonly orchestrator?: string; readonly nonce?: string; readonly supersedes?: number } = { pid: 999_999 },
): void {
	const generation = options.generation ?? 1;
	const claim: Record<string, unknown> = {
		scope,
		generation,
		orchestrator: options.orchestrator ?? 'x',
		nonce: options.nonce ?? 'seed',
		pid: options.pid,
		host: 'h',
		at: 1,
	};
	if (options.supersedes !== undefined) claim.supersedes = options.supersedes;
	mkdirSync(join(stateDir, 'scopes'), { recursive: true });
	writeFileSync(scopeLedgerPath(stateDir, scope), `${JSON.stringify(claim)}\n`, { mode: 0o600 });
}

test('a scope name splits into a family root and an incarnation, and only then', () => {
	assert.deepEqual(parseScope('x#0'), { root: 'x', index: 0 });
	assert.deepEqual(parseScope('a-b#12'), { root: 'a-b', index: 12 });
	assert.equal(parseScope('x'), undefined, 'a scope with no incarnation is not a family member');
	assert.equal(parseScope('#0'), undefined, 'a missing root is not a root');
	assert.equal(parseScope('x#'), undefined);
	assert.equal(parseScope('x#nope'), undefined);
	assert.equal(parseScope('x#-1'), undefined);
	assert.equal(familyScope('x', 3), 'x#3');
});

test('a scope ledger keeps the family separator in its filename', () => {
	const d = state();
	try {
		assert.equal(scopeLedgerPath(d.path, 'x#3'), join(d.path, 'scopes', 'x#3.jsonl'));
	} finally {
		d.cleanup();
	}
});

test('a family is discovered from the ledger directory alone, and only its own members', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 41 });
		seedScope(d.path, 'x#2', { pid: 42 });
		seedScope(d.path, 'x0', { pid: 43 });
		seedScope(d.path, 'xy#1', { pid: 44 });
		seedScope(d.path, 'x#nope', { pid: 45 });
		const found = familyScopes(d.path, 'x');
		assert.deepEqual(found.map((entry) => entry.scope), ['x#0', 'x#2'], 'ordered by incarnation, and never a foreign name');
		assert.equal(found[0]?.latest?.orchestrator, 'x');
	} finally {
		d.cleanup();
	}
});

test('the first incarnation of an empty family is #0', () => {
	const d = state();
	try {
		const claim = claimFamily(d.path, fam('x', 'n1'), undefined, () => 1);
		assert.equal(claim.authorized, true);
		assert.equal(claim.scope, 'x#0');
		assert.equal(claim.generation, 1);
		assert.deepEqual(claim.held.map((member) => member.scope), ['x#0']);
		assert.equal(claim.inherited, undefined, 'nothing was taken from anyone');
	} finally {
		d.cleanup();
	}
});

test('a concurrent incarnation derives the next number instead of being refused', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 4242 });
		const live = { isAlive: (pid: number) => pid === 4242, host: 'h' };
		const first = claimFamily(d.path, fam('x', 'n1'), undefined, () => 1, live, ['x#0']);
		assert.equal(first.authorized, true, 'a live sibling never refuses a dispatch');
		assert.equal(first.scope, 'x#1', 'it takes a new incarnation');
		assert.deepEqual(first.held.map((member) => member.scope), ['x#1'], 'the live sibling stays untouchable');
		assert.equal(readClaimHistory(d.path, 'x#0').claims.length, 1, 'and its ledger is never rewritten');
	} finally {
		d.cleanup();
	}
});

test('a session that held a scope reuses it when no sibling has taken it', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 999_999 });
		const claim = claimFamily(d.path, fam('x', 'n1'), undefined, () => 2, { isAlive: () => false, host: 'h' }, ['x#0']);
		assert.equal(claim.scope, 'x#0', 'a plain restart lands exactly where it left off');
		assert.equal(claim.generation, 2, 'inherited, so the generation advances');
		assert.equal(claim.inherited, true);
	} finally {
		d.cleanup();
	}
});

test('every dead incarnation is absorbed, and a live one stays out of reach', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 999_999 });
		seedScope(d.path, 'x#1', { pid: 4242 });
		seedScope(d.path, 'x#2', { pid: 999_998 });
		const live = { isAlive: (pid: number) => pid === 4242, host: 'h' };
		const claim = claimFamily(d.path, fam('x', 'n1'), undefined, () => 3, live);
		assert.equal(claim.scope, 'x#0', 'with no chain, the oldest dead incarnation is the primary one');
		assert.deepEqual(claim.held.map((member) => member.scope), ['x#0', 'x#2'], 'the live sibling is not held');
		assert.equal(claim.inherited, true);
		assert.equal(readClaimHistory(d.path, 'x#1').claims.length, 1, 'a live sibling is named, never disposed of');
	} finally {
		d.cleanup();
	}
});

test('with no dead incarnation and no free number, the next one is taken', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 4242 });
		seedScope(d.path, 'x#1', { pid: 4243 });
		const live = { isAlive: () => true, host: 'h' };
		const claim = claimFamily(d.path, fam('x', 'n9'), undefined, () => 4, live);
		assert.equal(claim.authorized, true);
		assert.equal(claim.scope, 'x#2');
		assert.deepEqual(claim.held.map((member) => member.scope), ['x#2']);
	} finally {
		d.cleanup();
	}
});

test('an explicit takeover names one scope and never quietly becomes a new incarnation', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 4242, orchestrator: 'x' });
		const live = { isAlive: () => true, host: 'h' };
		const refused = claimFamily(d.path, fam('x', 'n9'), { takeover: true, expectedOwner: 'x', expectedGeneration: 7 }, () => 5, live, ['x#0']);
		assert.equal(refused.authorized, false, 'a takeover that does not match is a refusal, not a new number');
		assert.equal(readClaimHistory(d.path, 'x#0').claims.length, 1);

		const taken = claimFamily(d.path, fam('x', 'n9'), { takeover: true, expectedOwner: 'x', expectedGeneration: 1 }, () => 5, live, ['x#0']);
		assert.equal(taken.authorized, true);
		assert.equal(taken.scope, 'x#0');
		assert.equal(taken.generation, 2);
		assert.deepEqual(taken.held.map((member) => member.scope), ['x#0']);
	} finally {
		d.cleanup();
	}
});

test('the scope chain is read back from the session, news first', () => {
	const entry = (root: string, scope: string, held: readonly string[]): unknown => ({
		type: 'custom',
		customType: SCOPE_ENTRY_TYPE,
		data: { root, scope, generation: 1, held: held.map((member) => ({ scope: member, generation: 1 })) },
	});
	const entries = [
		entry('x', 'x#0', ['x#0']),
		entry('x', 'x#1', ['x#0', 'x#1']),
		entry('y', 'y#0', ['y#0']),
	];
	assert.deepEqual(restoreScopeChain(entries, 'x'), ['x#1', 'x#0'], 'the newest entry on the branch, primary first');
	assert.deepEqual(restoreScopeChain(entries, 'y'), ['y#0']);
	assert.deepEqual(restoreScopeChain(entries, 'z'), []);
	assert.deepEqual(restoreScopeChain([{ type: 'custom', customType: 'other', data: { root: 'x', scope: 'x#1' } }], 'x'), []);
});

test('a window in an absorbed sibling scope is this session to dispose of', () => {
	const d = state();
	try {
		writeOwner(d.path, owner({ scope: 'x#1', orchestrator: 'x', generation: 1, pid: 999_999 }));
		const held = classifyWindowOwnership({
			pane: 'w1:p1',
			currentOrchestrator: 'x',
			currentScope: 'x#0',
			currentGeneration: 1,
			currentScopes: ['x#0', 'x#1'],
			stateDir: d.path,
			host: 'h',
			isAlive: () => false,
		});
		assert.equal(held.category, 'current-session', 'an absorbed scope belongs to the family');

		const unheld = classifyWindowOwnership({
			pane: 'w1:p1',
			currentOrchestrator: 'x',
			currentScope: 'x#0',
			currentGeneration: 1,
			stateDir: d.path,
			host: 'h',
			isAlive: () => false,
		});
		assert.notEqual(unheld.category, 'current-session', 'without the held set it is the dead owner\'s, as before');
	} finally {
		d.cleanup();
	}
});

test('a resumed session leads with the scope it was primary on, not an absorbed sibling', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 999_999, generation: 1, orchestrator: 'x' });
		seedScope(d.path, 'x#2', { pid: 999_998, generation: 1, orchestrator: 'x' });
		const claim = claimFamily(d.path, fam('x', 'n1'), undefined, () => 3, { isAlive: () => false, host: 'h' }, ['x#0', 'x#2']);
		assert.equal(claim.scope, 'x#0', 'the chain is primary first, so the session returns to its own scope');
		assert.deepEqual(claim.held.map((member) => member.scope), ['x#0', 'x#2']);
		assert.equal(claim.generation, 2, 'the primary scope advances exactly as a handoff does');
	} finally {
		d.cleanup();
	}
});

test('a live primary lets the session fall back to a dead sibling instead of inventing a number', () => {
	const d = state();
	try {
		seedScope(d.path, 'x#0', { pid: 4242, generation: 1 });
		seedScope(d.path, 'x#2', { pid: 999_999, generation: 1 });
		const live = { isAlive: (pid: number) => pid === 4242, host: 'h' };
		const claim = claimFamily(d.path, fam('x', 'n1'), undefined, () => 3, live, ['x#0', 'x#2']);
		assert.equal(claim.scope, 'x#2', 'the dead sibling is recovered rather than a new number invented');
		assert.deepEqual(claim.held.map((member) => member.scope), ['x#2']);
	} finally {
		d.cleanup();
	}
});

// ---------------------------------------------------------------------------
// A second incarnation inside one live process
//
// `session_start` runs again in the same process when a session is compacted or
// resumed, and it mints a fresh nonce. The first incarnation's claim therefore
// reads as *another live owner* — its pid and start time are this very process —
// even though it is a dead incarnation in a live process. Two things go wrong
// from there, and both are reproduced below from the ledger shape observed in
// the wild (session 01a14f39, scopes #0 and #1, both pid 66358).
// ---------------------------------------------------------------------------

/** Two claims from one still-running process, as a compaction leaves them behind. */
function seedTwoIncarnations(stateDir: string, root: string): void {
	const at = 1;
	for (const index of [0, 1]) {
		const scope = familyScope(root, index);
		mkdirSync(join(stateDir, 'scopes'), { recursive: true });
		writeFileSync(
			scopeLedgerPath(stateDir, scope),
			`${JSON.stringify({ scope, generation: 1, orchestrator: root, nonce: `inc-${index}`, pid: process.pid, host: 'h', startTime: 'start', at })}\n`,
			{ mode: 0o600 },
		);
	}
}

/** This process is alive, at the start time its own earlier incarnation recorded. */
const sameProcess = { isAlive: () => true, getStartTime: () => 'start', host: 'h' };

test('an earlier incarnation of this same live process is not another live owner', () => {
	const d = state();
	const root = 'sess';
	try {
		seedTwoIncarnations(d.path, root);
		const claim = claimFamily(d.path, self(root, 'inc-new'), undefined, () => 2, sameProcess, []);
		assert.equal(claim.authorized, true);
		assert.equal(claim.scope, familyScope(root, 0), 'the live process absorbs its own dead incarnation');
		assert.deepEqual(claim.held.map((member) => member.scope).sort(), [familyScope(root, 0), familyScope(root, 1)], 'both of its own incarnations are held');
		assert.equal(readClaimHistory(d.path, familyScope(root, 0)).claims.length, 2, 'and the fence advances on the one it leads with');
	} finally {
		d.cleanup();
	}
});

test('a takeover reaches the scope the window is under, not just the one this session leads with', () => {
	const d = state();
	const root = 'sess';
	try {
		// #0 belongs to another live process of this same session family — the one case
		// that genuinely needs operator evidence. #1 is this session's own, so the chain
		// it leads with is #1 while the window to dispose of sits under #0.
		mkdirSync(join(d.path, 'scopes'), { recursive: true });
		writeFileSync(
			scopeLedgerPath(d.path, familyScope(root, 0)),
			`${JSON.stringify({ scope: familyScope(root, 0), generation: 1, orchestrator: root, nonce: 'inc-other', pid: 4242, host: 'h', startTime: 'other', at: 1 })}\n`,
			{ mode: 0o600 },
		);
		writeFileSync(
			scopeLedgerPath(d.path, familyScope(root, 1)),
			`${JSON.stringify({ scope: familyScope(root, 1), generation: 1, orchestrator: root, nonce: 'inc-new', pid: process.pid, host: 'h', startTime: 'start', at: 1 })}\n`,
			{ mode: 0o600 },
		);
		const otherAlive = { isAlive: (pid: number) => pid === 4242 || pid === process.pid, getStartTime: (pid: number) => (pid === 4242 ? 'other' : 'start'), host: 'h' };

		const mine = self(root, 'inc-new');
		const claim = claimFamily(d.path, mine, undefined, () => 2, otherAlive, [familyScope(root, 1)]);
		assert.equal(claim.scope, familyScope(root, 1), 'the chain decides where this session lands');

		// Without evidence the window is untouchable — that is the guard working.
		const refused = claimGeneration(d.path, scopeClaimant(mine, familyScope(root, 0)), undefined, () => 2, otherAlive);
		assert.equal(refused.authorized, false);

		// With the evidence the operator supplied, the window's own scope is taken, which
		// is what `job close` needs to dispose of it.
		const spec = { takeover: true, expectedOwner: root, expectedGeneration: 1 } as const;
		const taken = claimGeneration(d.path, scopeClaimant(mine, familyScope(root, 0)), spec, () => 2, otherAlive);
		assert.equal(taken.authorized, true, 'the takeover reaches the window\'s scope');
		assert.equal(taken.generation, 2, 'and it fences that scope rather than a sibling\'s');
	} finally {
		d.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Owner records belong to a window, not to the workspace it shares
//
// `tab` Jobs share the Orchestrator's workspace, so a workspace-named record
// could only ever describe one of them: opening a second Job overwrote the
// first's record, and closing either removed it. The survivor then read as a
// window nobody had ever recorded an owner for — invisible to `job status
// wider: true`, which is exactly what a refusal tells an operator to inspect.
// ---------------------------------------------------------------------------

const window = (pane: string, overrides: Partial<OwnershipRecord> = {}): OwnershipRecord => owner({ pane, tab: `t-${pane}`, ...overrides });

test('two Jobs in one workspace keep two owner records', () => {
	const d = state();
	try {
		writeOwner(d.path, window('w1:p1', { name: 'first', ticket: '#1' }));
		writeOwner(d.path, window('w1:p2', { name: 'second', ticket: '#2' }));

		assert.equal(readOwner(d.path, 'w1:p1')?.name, 'first', 'the first record is not overwritten by the second');
		assert.equal(readOwner(d.path, 'w1:p2')?.name, 'second');
		assert.deepEqual(readOwners(d.path).map((record) => record.name).sort(), ['first', 'second']);
	} finally {
		d.cleanup();
	}
});

test('ending one window leaves its sibling\'s owner record intact', () => {
	const d = state();
	try {
		writeOwner(d.path, window('w1:p1', { name: 'first' }));
		writeOwner(d.path, window('w1:p2', { name: 'second' }));

		removeOwner(d.path, 'w1:p1');
		assert.equal(readOwner(d.path, 'w1:p1'), undefined, 'the closed window is forgotten');
		assert.equal(readOwner(d.path, 'w1:p2')?.name, 'second', 'its sibling in the same workspace is not');
	} finally {
		d.cleanup();
	}
});

test('a record written by an earlier build under its workspace is still readable by pane', () => {
	const d = state();
	try {
		// The old layout: one file named by workspace, describing one of its windows.
		mkdirSync(join(d.path, 'owners'), { recursive: true });
		writeFileSync(join(d.path, 'owners', 'w1.json'), JSON.stringify(window('w1:p2', { name: 'legacy' })), { mode: 0o600 });

		assert.equal(readOwner(d.path, 'w1:p2')?.name, 'legacy', 'an upgrade can still read the record it left behind');
		assert.deepEqual(readOwners(d.path).map((record) => record.name), ['legacy']);

		// Closing that window takes the legacy file with it, and only that one.
		removeOwner(d.path, 'w1:p2');
		assert.deepEqual(readOwners(d.path), []);
	} finally {
		d.cleanup();
	}
});

test('a replacement window retires the record of the pane it replaced', () => {
	const d = state();
	try {
		writeOwner(d.path, window('w1:p1', { name: 'worker' }));
		// The Job was replaced: same Job, new window.
		writeOwner(d.path, window('w1:p9', { name: 'worker' }));

		assert.equal(readOwner(d.path, 'w1:p1'), undefined, 'a Job has one window, so the old record goes');
		assert.equal(readOwner(d.path, 'w1:p9')?.name, 'worker');
		assert.deepEqual(readOwners(d.path).map((record) => record.pane), ['w1:p9']);
	} finally {
		d.cleanup();
	}
});

test('one workspace\'s retired records do not touch another session\'s Job of the same name', () => {
	const d = state();
	try {
		writeOwner(d.path, window('w1:p1', { name: 'worker', orchestrator: 'orch-a' }));
		writeOwner(d.path, window('w1:p2', { name: 'worker', orchestrator: 'orch-b' }));

		assert.deepEqual(readOwners(d.path).map((record) => record.orchestrator).sort(), ['orch-a', 'orch-b']);
	} finally {
		d.cleanup();
	}
});

test('closing a whole workspace row forgets its windows and no others', () => {
	const d = state();
	try {
		writeOwner(d.path, window('w1:p1', { name: 'gone' }));
		writeOwner(d.path, window('w1:p2', { name: 'also-gone' }));
		writeOwner(d.path, window('w2:p1', { name: 'kept', workspace: 'w2' }));

		removeOwnersInWorkspace(d.path, 'w1');
		assert.deepEqual(readOwners(d.path).map((record) => record.name), ['kept']);
	} finally {
		d.cleanup();
	}
});

test('a pane-named record wins over a legacy workspace-named one for the same window', () => {
	const d = state();
	try {
		mkdirSync(join(d.path, 'owners'), { recursive: true });
		writeFileSync(join(d.path, 'owners', 'w1.json'), JSON.stringify(window('w1:p1', { name: 'legacy' })), { mode: 0o600 });
		writeOwner(d.path, window('w1:p1', { name: 'current' }));

		assert.equal(readOwner(d.path, 'w1:p1')?.name, 'current');
		assert.deepEqual(readOwners(d.path).map((record) => record.name), ['current'], 'one window, one record');
	} finally {
		d.cleanup();
	}
});
