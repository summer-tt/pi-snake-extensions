/**
 * Configuration rules, and the one asymmetry that matters: a lock refuses.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, resolveConfig, worktreePathFor } from '../src/config.ts';

function fixture(files: { global?: unknown; project?: unknown }): { dir: string; globalPath: string; projectPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'phe-config-'));
	const globalPath = join(dir, 'global.json');
	const projectPath = join(dir, 'project.json');
	if (files.global !== undefined) writeFileSync(globalPath, JSON.stringify(files.global));
	if (files.project !== undefined) writeFileSync(projectPath, JSON.stringify(files.project));
	return { dir, globalPath, projectPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function read(config: { global?: unknown; project?: unknown }) {
	const f = fixture(config);
	try {
		return resolveConfig({ project: f.dir, agentDir: f.dir, globalPath: f.globalPath, projectPath: f.projectPath });
	} finally {
		f.cleanup();
	}
}

test('an absent configuration resolves to the documented defaults', () => {
	const config = read({});
	assert.equal(config.worktreeEnabled, true, 'an absent file is not a lock');
	assert.equal(config.worktreeLocked, false);
	assert.equal(config.worktreeRoot, 'auto');
	assert.equal(config.retentionCap, 2);
	assert.equal(config.placement, 'tab');
	assert.deepEqual(config.diagnostics, []);
});

test('a project lock wins over a global allowance', () => {
	const config = read({ global: { worktree: { enabled: true } }, project: { worktree: { enabled: false } } });
	assert.equal(config.worktreeLocked, true);
	assert.equal(config.worktreeEnabled, false);
});

test('a global lock cannot be unlocked by a project', () => {
	const config = read({ global: { worktree: { enabled: false } }, project: { worktree: { enabled: true } } });
	assert.equal(config.worktreeLocked, true, 'the lock is a union, not a lookup');
});

test('a malformed file degrades to defaults with a diagnostic rather than throwing', () => {
	const dir = mkdtempSync(join(tmpdir(), 'phe-config-'));
	const globalPath = join(dir, 'global.json');
	const projectPath = join(dir, 'project.json');
	writeFileSync(globalPath, '{ not json');
	try {
		const config = resolveConfig({ project: dir, agentDir: dir, globalPath, projectPath });
		assert.equal(config.retentionCap, DEFAULT_CONFIG.retentionCap);
		assert.equal(config.diagnostics.length, 1);
		assert.match(config.diagnostics[0] ?? '', /not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unsupported placement is reported and falls back to tab', () => {
	const config = read({ project: { placement: 'pane' } });
	assert.equal(config.placement, 'tab');
	assert.match(config.diagnostics.join(' '), /only "tab" is implemented/);
});

test('auto yields no path, so Herdr places the checkout itself', () => {
	assert.equal(worktreePathFor('auto', '/repo', 'fix-142'), undefined);
});

test('an explicit root expands to <root>/<job>, relative to the primary checkout', () => {
	assert.equal(worktreePathFor('.worktrees', '/repo', 'fix-142'), '/repo/.worktrees/fix-142');
	assert.equal(worktreePathFor('../repo.worktrees', '/repo', 'fix-142'), '/repo.worktrees/fix-142');
	assert.equal(worktreePathFor('/absolute/root', '/repo', 'fix-142'), '/absolute/root/fix-142');
});

test('a home-relative root is expanded', () => {
	const path = worktreePathFor('~/workspace/worktrees', '/repo', 'fix-142');
	assert.ok(path !== undefined && !path.startsWith('~'), 'the tilde is expanded');
	assert.match(path as string, /workspace\/worktrees\/fix-142$/);
});
