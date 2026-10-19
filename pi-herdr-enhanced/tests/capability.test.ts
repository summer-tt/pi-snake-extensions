/**
 * The capability: a Worker's identity crosses a process boundary, and a session
 * without one is an Orchestrator by definition.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	CAPABILITY_ENTRY_TYPE,
	CAPABILITY_FLAG,
	capabilityArgs,
	capabilityFromArgv,
	capabilityFromEntries,
	decodeCapability,
	encodeCapability,
	isWorkerArgv,
	makeSessionCapability,
	newCapability,
	type JobCapability,
} from '../src/capability.ts';

const capability: JobCapability = {
	name: 'fix-142',
	ticket: '#142',
	token: 'job-abc',
	scope: 's1',
	spoolPath: '/state/spool/s1',
};

/** A session manager with the shape Pi hands the extension. */
const session = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } });

test('a capability survives the spawn-argument round trip', () => {
	const args = capabilityArgs(capability);
	assert.deepEqual(args[0], `--${CAPABILITY_FLAG}`);
	assert.deepEqual(decodeCapability(encodeCapability(capability)), capability);
	assert.deepEqual(capabilityFromArgv(['pi', '--name', 'x', ...args.slice(0, 2), '--thinking', 'high']), capability);
});

test('the flag is accepted in both spellings Pi has used', () => {
	assert.deepEqual(capabilityFromArgv([`--${CAPABILITY_FLAG}=${encodeCapability(capability)}`]), capability);
	assert.deepEqual(capabilityFromArgv([`--${CAPABILITY_FLAG}`, encodeCapability(capability)]), capability);
});

test('a malformed capability resolves to nothing rather than to a partial identity', () => {
	assert.equal(capabilityFromArgv([`--${CAPABILITY_FLAG}`]), undefined);
	assert.equal(capabilityFromArgv([`--${CAPABILITY_FLAG}`, 'not-base64-json!']), undefined);
	const half = Buffer.from(JSON.stringify({ name: 'x', ticket: '#1' }), 'utf8').toString('base64url');
	assert.equal(decodeCapability(half), undefined, 'a capability missing its spool path is not usable');
});

test('a session without a capability is an Orchestrator', () => {
	assert.equal(capabilityFromEntries([]), undefined);
	assert.equal(capabilityFromEntries([{ customType: CAPABILITY_ENTRY_TYPE, data: {} }]), undefined);
	assert.equal(isWorkerArgv(['pi', '--name', 'orchestrator']), false);
	assert.equal(isWorkerArgv(['pi', ...capabilityArgs(capability)]), true);
});

test('the persisted entry wins over the spawn arguments, and is written once', () => {
	const written: { type: string; data: unknown }[] = [];
	const resolve = makeSessionCapability((type, data) => written.push({ type, data }), ['pi', ...capabilityArgs(capability)]);

	// A resumed session carries its identity in its entries even though argv no
	// longer has the flag.
	const persisted = capabilityFromEntries([{ customType: CAPABILITY_ENTRY_TYPE, data: { ...capability, token: 'job-persisted' } }]);
	assert.deepEqual(persisted?.token, 'job-persisted');

	const fromArgv = resolve(session([]));
	assert.deepEqual(fromArgv, capability);
	assert.deepEqual(resolve(session([])), capability, 'resolution is cached');
	assert.equal(written.length, 1, 'the capability is persisted on first successful use only');
	assert.equal(written[0]?.type, CAPABILITY_ENTRY_TYPE);
});

test('an Orchestrator session caches its absence and never writes', () => {
	const written: unknown[] = [];
	const resolve = makeSessionCapability((type, data) => written.push({ type, data }), ['pi', '--name', 'orchestrator']);
	assert.equal(resolve(session([])), undefined);
	assert.equal(resolve(session([])), undefined);
	assert.deepEqual(written, [], 'a plain Orchestrator session never grows capability entries');
});

test('a new capability mints a fresh token and carries the caller identity', () => {
	const first = newCapability({ name: 'a', ticket: '#1', scope: 's1', spoolPath: '/p' });
	const second = newCapability({ name: 'a', ticket: '#1', scope: 's1', spoolPath: '/p' });
	assert.notEqual(first.token, second.token, 'two Jobs are never the same Job by token');
	assert.match(first.token, /^job-/);
});
