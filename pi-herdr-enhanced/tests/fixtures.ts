/**
 * Shared fixtures. A Job record has many required fields by design — every field
 * a patch may clear is a required value with a neutral default — so the suite
 * builds one in a single place rather than repeating twenty literals.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ResolvedConfig } from '../src/config.ts';
import { newCapability, type JobCapability } from '../src/capability.ts';
import { FakeHerdr } from './fake-herdr.ts';
import type { JobDeps } from '../src/job.ts';
import type { Claimant } from '../src/ownership.ts';
import type { JobRecord } from '../src/registry.ts';

export function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		name: 'fix-142',
		ticket: '#142',
		workspace: 'w1',
		tab: 'w1:t1',
		pane: 'w1:p1',
		path: '/repo',
		branch: '',
		label: '#142 fix-142',
		mode: 'tab',
		scope: 's1',
		generation: 1,
		orchestrator: 'orch-a',
		token: 'job-a',
		piArgs: ['--name', 'fix-142'],
		openedAt: 1_000,
		taskText: 'do the thing',
		taskSource: 'text',
		taskPath: '',
		promptDelivered: true,
		promptFailure: '',
		stallThresholdMs: 0,
		claimedComplete: false,
		claimedAt: 0,
		lastFailure: '',
		lastStatus: '',
		lastObservedAt: 0,
		workedAt: 0,
		announcedAt: 0,
		retention: 'none',
		retainedAt: 0,
		heldUntil: 0,
		heldNote: '',
		provisioned: false,
		...overrides,
	};
}

export function makeClaimant(overrides: Partial<Claimant> = {}): Claimant {
	return { scope: 's1', orchestrator: 'orch-a', project: '/repo', pid: 41, host: 'h', nonce: 'n1', ...overrides };
}

export interface JobFixture {
	readonly herdr: FakeHerdr;
	readonly deps: JobDeps;
	readonly stateDir: string;
	readonly spoolPath: string;
	readonly workspace: string;
	readonly capability: JobCapability;
	readonly config: ResolvedConfig;
	cleanup(): void;
}

export function jobFixture(options: { readonly config?: Partial<ResolvedConfig>; readonly herdr?: FakeHerdr } = {}): JobFixture {
	const root = mkdtempSync(join(tmpdir(), 'phe-job-'));
	const stateDir = join(root, 'state');
	const spoolPath = join(root, 'spool');
	const herdr = options.herdr ?? new FakeHerdr();
	const workspace = herdr.addWorkspace('~').workspace;
	const capability = newCapability({ name: 'fix-142', ticket: '#142', scope: 's1', spoolPath });
	const config: ResolvedConfig = { ...DEFAULT_CONFIG, ...options.config };
	const deps: JobDeps = {
		run: herdr.run,
		runGit: herdr.runGit,
		config,
		stateDir,
		claimant: makeClaimant(),
		generation: 1,
		clock: () => 1_000,
		workspaceId: workspace,
	};
	return {
		herdr,
		deps,
		stateDir,
		spoolPath,
		workspace,
		capability,
		config,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
