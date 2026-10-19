/**
 * The spool: an owner-only directory, atomic records, TTL sweeps, and a token
 * that authorizes exactly one Job.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assertStrict from 'node:assert/strict';
import { test } from 'node:test';
import {
	SpoolError,
	consumeClaim,
	dropProgress,
	ensureSpool,
	readClaims,
	readProgress,
	spoolExists,
	verifySpool,
	writeClaim,
	writeProgress,
} from '../src/spool.ts';

function dir(): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), 'phe-spool-'));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const claim = (token: string, at = 1_000) => ({ name: 'fix-142', ticket: '#142', scope: 's1', token, claimedAt: at });

test('the spool directory is created owner-only and verified on every use', () => {
	const d = dir();
	try {
		const spool = join(d.path, 'spool');
		ensureSpool(spool);
		assert.equal(statSync(spool).mode & 0o077, 0, 'the directory is not accessible to group or other');
		verifySpool(spool);
		chmodSync(spool, 0o755);
		assert.throws(() => verifySpool(spool), (error: unknown) => error instanceof SpoolError && /owner-only/.test(error.message));
	} finally {
		d.cleanup();
	}
});

test('a claim is written to its final name and consumed exactly once', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeClaim(d.path, claim('job-a'));
		assert.equal(readdirSync(d.path).filter((name) => name.startsWith('claim-')).length, 1, 'no temp name survives the write');
		const first = consumeClaim(d.path, 'job-a');
		assert.equal(first?.token, 'job-a');
		assert.equal(consumeClaim(d.path, 'job-a'), undefined, 'a claim is consumed once');
	} finally {
		d.cleanup();
	}
});

test('a token authorizes only its own Job', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeClaim(d.path, claim('job-a'));
		assert.equal(consumeClaim(d.path, 'job-b'), undefined, 'another Job\'s token cannot read this claim');
		assert.equal(consumeClaim(d.path, 'job-a')?.token, 'job-a', 'and the claim is still there for its owner');
	} finally {
		d.cleanup();
	}
});

test('an expired claim is swept rather than honoured late', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeClaim(d.path, claim('job-old', 0));
		const claims = readClaims(d.path, 1_000, () => 10_000);
		assert.deepEqual(claims, []);
		assert.deepEqual(readdirSync(d.path), [], 'the stale file is gone, not merely ignored');
	} finally {
		d.cleanup();
	}
});

test('a malformed claim is discarded, never guessed at', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeFileSync(join(d.path, 'claim-job-broken.json'), JSON.stringify({ name: 'x' }), { mode: 0o600 });
		assert.deepEqual(readClaims(d.path, 1_000, () => 2_000), []);
		assert.deepEqual(readdirSync(d.path), []);
	} finally {
		d.cleanup();
	}
});

test('a record larger than the bound is never read', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeFileSync(join(d.path, 'claim-job-huge.json'), JSON.stringify({ ...claim('job-huge'), padding: 'x'.repeat(9_000) }), { mode: 0o600 });
		assert.deepEqual(readClaims(d.path, 1_000, () => 2_000), []);
	} finally {
		d.cleanup();
	}
});

test('the latest observation per token wins, and a foreign token is dropped on request', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeProgress(d.path, { name: 'a', ticket: '#1', token: 'job-a', observedAt: 10 });
		writeProgress(d.path, { name: 'a', ticket: '#1', token: 'job-a', observedAt: 20 });
		writeProgress(d.path, { name: 'b', ticket: '#2', token: 'job-b', observedAt: 15 });
		const progress = readProgress(d.path, 10_000, () => 100);
		assert.equal(progress.size, 2);
		assert.equal(progress.get('job-a')?.observedAt, 20);
		dropProgress(d.path, 'job-a');
		assert.equal(readProgress(d.path, 10_000, () => 100).has('job-a'), false);
		assert.equal(readProgress(d.path, 10_000, () => 100).has('job-b'), true);
	} finally {
		d.cleanup();
	}
});

test('claim and progress files never read each other', () => {
	const d = dir();
	try {
		ensureSpool(d.path);
		writeClaim(d.path, claim('shared'));
		writeProgress(d.path, { name: 'fix-142', ticket: '#142', token: 'shared', observedAt: 1_000 });
		assert.equal(readClaims(d.path, 10_000, () => 2_000).length, 1);
		assert.equal(readProgress(d.path, 10_000, () => 2_000).size, 1);
		assertStrict.equal(consumeClaim(d.path, 'shared')?.token, 'shared');
		assert.equal(readProgress(d.path, 10_000, () => 2_000).has('shared'), true, 'consuming a claim leaves the observation alone');
	} finally {
		d.cleanup();
	}
});

test('an absent spool is absent; a spool that cannot be inspected is not', () => {
	// "Not created yet" is the normal state of every Run scope before its first Job,
	// so the reader needs to tell it from "there is something wrong with it". The
	// writer's contract is unchanged: a claim is never written into a spool that
	// cannot be verified.
	const d = dir();
	try {
		const absent = join(d.path, 'not-yet');
		assert.equal(spoolExists(absent), false);
		assert.throws(() => verifySpool(absent), SpoolError, 'a writer still refuses an absent spool');

		const made = join(d.path, 'made');
		ensureSpool(made);
		assert.equal(spoolExists(made), true);

		const file = join(d.path, 'a-file');
		writeFileSync(file, '');
		assert.equal(spoolExists(file), true, 'a path that exists but is wrong must reach verifySpool');
		assert.throws(() => verifySpool(file), SpoolError);
	} finally {
		d.cleanup();
	}
});
