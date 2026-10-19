/**
 * Job records for scenarios that start from a window rather than from a dispatch.
 *
 * A seeded Job is not a shortcut around the extension: it is the record a resumed
 * session reads back, in the exact shape `restoreWatch` parses. Window-lifecycle
 * scenarios (retention, hold, dismiss, an eviction that really closes a tab) can
 * therefore run against real Herdr windows without paying for a Pisession that is
 * not what they are testing.
 */

import { join } from 'node:path';
import type { JobRecord } from '../../src/registry.ts';
import type { WindowAddress } from './herdr-e2e.ts';

export interface SeedInput {
	readonly name: string;
	readonly ticket: string;
	readonly address: WindowAddress;
	readonly scope: string;
	readonly orchestrator?: string;
	readonly generation?: number;
	readonly mode?: 'tab' | 'worktree';
	readonly path?: string;
	readonly branch?: string;
	readonly token?: string;
	readonly retention?: 'none' | 'auto' | 'manual';
	readonly claimedComplete?: boolean;
	readonly promptDelivered?: boolean;
	readonly lastStatus?: JobRecord['lastStatus'];
	readonly provisioned?: boolean;
	readonly openedAt?: number;
}

/** A complete, parseable Job record for a real window. */
export function seedJob(input: SeedInput): JobRecord {
	const openedAt = input.openedAt ?? Date.now();
	return {
		name: input.name,
		ticket: input.ticket,
		workspace: input.address.workspace,
		tab: input.address.tab,
		pane: input.address.pane,
		path: input.path ?? '',
		branch: input.branch ?? '',
		label: `${input.ticket} ${input.name}`,
		mode: input.mode ?? 'tab',
		scope: input.scope,
		generation: input.generation ?? 1,
		orchestrator: input.orchestrator ?? 'e2e-orchestrator',
		token: input.token ?? `token-${input.name}`,
		piArgs: ['--name', input.name],
		openedAt,
		taskText: `seeded task for ${input.name}`,
		taskSource: 'text',
		taskPath: '',
		promptDelivered: input.promptDelivered ?? true,
		promptFailure: '',
		stallThresholdMs: 0,
		claimedComplete: input.claimedComplete ?? false,
		claimedAt: input.claimedComplete === true ? openedAt : 0,
		lastFailure: '',
		lastStatus: input.lastStatus ?? '',
		lastObservedAt: 0,
		workedAt: 0,
		announcedAt: 0,
		retention: input.retention ?? 'none',
		retainedAt: input.retention !== undefined && input.retention !== 'none' ? openedAt : 0,
		heldUntil: 0,
		heldNote: '',
		provisioned: input.provisioned ?? true,
	};
}

/** The path a claim file for this token would occupy, for asserting on the spool. */
export function claimPath(spoolPath: string, token: string): string {
	return join(spoolPath, `claim-${token}.json`);
}
