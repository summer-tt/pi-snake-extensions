/**
 * The Wake: how a delivery is identified, correlated, retried, and described.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	WAKE_CUSTOM_TYPE,
	WAKE_RETRY_DELAYS_MS,
	composeWakeText,
	describeWake,
	identitiesOf,
	isWakeMessage,
	makeWake,
	newCauseId,
	retryDelayFor,
	wakeDetails,
} from '../src/wake.ts';

const cause = (overrides: Partial<{ id: string; reason: string; panes: string[]; claimed: boolean; kind: 'claim' | 'settle' | 'dead'; attempt: number }> = {}) => ({
	id: overrides.id ?? 'wake-1',
	reason: overrides.reason ?? 'Job a (T1) at w1:p1 is idle with no completion claim.',
	panes: overrides.panes ?? ['w1:p1'],
	...(overrides.kind !== undefined ? { kind: overrides.kind } : {}),
	...(overrides.claimed === true ? { claimed: true } : {}),
	...(overrides.attempt !== undefined ? { attempt: overrides.attempt } : {}),
});

test('a cause identity is opaque and unique, so it can only be compared', () => {
	const first = newCauseId();
	assert.match(first, /^wake-/);
	assert.notEqual(first, newCauseId());
});

test('the retry ladder climbs and then holds at its last step', () => {
	assert.deepEqual(
		WAKE_RETRY_DELAYS_MS.slice(0, 3),
		[60_000, 5 * 60_000, 10 * 60_000],
		'a Wake nobody handles is retried after 1, then 5, then 10 minutes',
	);
	assert.equal(retryDelayFor(1), 60_000, 'one injection waits a minute');
	assert.equal(retryDelayFor(2), 5 * 60_000, 'two wait five');
	assert.equal(retryDelayFor(3), 10 * 60_000, 'three wait ten');
	assert.equal(retryDelayFor(4), 30 * 60_000);
	assert.equal(retryDelayFor(99), 30 * 60_000, 'and then at most once every thirty minutes');
});

test('the Wake text never claims a Job succeeded', () => {
	const report = makeWake([cause()], () => 0);
	assert.match(report.text, /never says a Job succeeded/);
	assert.match(report.text, /job read/);
	assert.match(report.text, /w1:p1/);
	assert.match(report.text, /1 job stopped working/, 'the headline is composed from the causes');
	assert.match(report.text, /Then `job retain` what you have captured/);
});

test('a coalesced Wake lists every cause and says when one declared completion', () => {
	const report = makeWake([cause({ id: 'a', panes: ['w1:p1'] }), cause({ id: 'b', panes: ['w2:p1'], claimed: true, reason: 'Job b settled and declared complete.' })], () => 0);
	assert.equal(report.causes.length, 2);
	assert.match(report.text, /declared complete/);
	assert.match(report.text, /1 Job declared complete, 1 job stopped working/, 'each kind is counted, not averaged');
	assert.equal(composeWakeText(report.causes), report.text);
});

test('a re-delivery says what it is instead of repeating the same text', () => {
	// The identity is what makes a retry the *same* news; without a line saying so, the
	// only difference from the first delivery is that there is no difference.
	const report = makeWake([cause({ attempt: 3, claimed: true, kind: 'claim' })], () => 0);
	assert.match(report.text, /Re-sent \(delivery 3\): nothing has answered this news yet\./);
	assert.match(report.text, /^## Job watch\n\n1 Job declared complete/m);
	assert.equal(makeWake([cause()], () => 0).text.includes('Re-sent'), false, 'a first delivery is not a re-delivery');
	assert.equal(describeWake(report).includes('re-sent, delivery 3'), true, 'and the tool result says it too');
});

test('the metadata carries one identity per coalesced cause', () => {
	const details = wakeDetails([cause({ id: 'a' }), cause({ id: 'b' })]);
	assert.deepEqual(details.identities, ['a', 'b']);
});

test('identities are read from the message details, and a non-Wake correlates with nothing', () => {
	const details = wakeDetails([cause({ id: 'a' })]);
	assert.deepEqual(identitiesOf({ customType: WAKE_CUSTOM_TYPE, details }), ['a']);
	assert.deepEqual(identitiesOf({ customType: WAKE_CUSTOM_TYPE, message: { details } }), ['a'], "Pi's nested message shape is read too");
	assert.deepEqual(identitiesOf({ customType: 'something-else' }), [], 'a non-Wake never correlates');
	assert.deepEqual(identitiesOf({ customType: WAKE_CUSTOM_TYPE }), [], 'a Wake whose metadata was lost correlates with nothing');
	assert.deepEqual(identitiesOf(undefined), []);
});

test('a message is a Wake only when it carries this extension type', () => {
	assert.equal(isWakeMessage({ customType: WAKE_CUSTOM_TYPE }), true);
	assert.equal(isWakeMessage({ customType: 'dev-pipeline-job-watch' }), false, 'another extension\'s Wake is not ours');
	assert.equal(isWakeMessage(undefined), false);
});

test('describing an empty Wake says so rather than inventing news', () => {
	assert.match(describeWake(makeWake([], () => 0)), /No Wake/);
	assert.match(describeWake(makeWake([cause({ claimed: true })], () => 0)), /declared complete/);
});
