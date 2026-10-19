/**
 * Configuration, and the one rule configuration must never break.
 *
 * Two files are read and merged key by key:
 *
 *   global   `~/.pi/agent/pi-herdr-enhanced.json`
 *   project  `<project>/.agents/pi-herdr-enhanced/config.json`   (wins per key)
 *
 * The one asymmetry is `worktree.enabled`. `job open`'s `worktree` parameter
 * defaults to **false** and that default is not configurable — a configuration
 * cannot make Jobs start creating branches on their own. All configuration can
 * do is *lock the other direction*: `enabled: false` at either level refuses any
 * `worktree: true` call outright. Both files are therefore read for that key
 * even when the project file wins on everything else, because a lock must not be
 * unlockable by a lower scope.
 *
 * A lock refuses; it never degrades. Silently turning a `worktree: true` request
 * into a tab would leave the caller believing it holds an isolated branch while
 * its Worker writes into a shared checkout — a much more expensive mistake than
 * a refusal.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Where non-worktree Jobs live. `pane` splitting is deliberately not implemented. */
export type Placement = 'tab';

/** Where a worktree checkout is created. */
export type WorktreeRoot = 'auto' | string;

/** The merged configuration, after defaults. */
export interface ResolvedConfig {
	readonly placement: Placement;
	/** `false` when either scope locked it; the parameter default is always `false`. */
	readonly worktreeEnabled: boolean;
	readonly worktreeLocked: boolean;
	/** `auto` omits `--path` and lets Herdr use its `worktrees.directory`. */
	readonly worktreeRoot: WorktreeRoot;
	readonly retentionCap: number;
	readonly tickMs: number;
	readonly debounceMs: number;
	readonly stallThresholdMs: number;
	/** Non-fatal problems worth telling the operator about once. */
	readonly diagnostics: readonly string[];
}

/** The documented defaults, also what an absent or unreadable file resolves to. */
export const DEFAULT_CONFIG: ResolvedConfig = {
	placement: 'tab',
	worktreeEnabled: true,
	worktreeLocked: false,
	worktreeRoot: 'auto',
	retentionCap: 2,
	tickMs: 60_000,
	debounceMs: 1_500,
	stallThresholdMs: 20 * 60_000,
	diagnostics: [],
};

/** The global configuration file, beside pi's own agent configuration. */
export function defaultGlobalConfigPath(agentDir: string): string {
	return join(agentDir, 'pi-herdr-enhanced.json');
}

/** The project configuration file, beside the project's other agent configuration. */
export function defaultProjectConfigPath(project: string): string {
	return join(project, '.agents', 'pi-herdr-enhanced', 'config.json');
}

/** The per-key shape either file may declare. */
interface PartialConfig {
	placement?: unknown;
	worktree?: { enabled?: unknown; root?: unknown };
	retention?: { max_finished_windows?: unknown };
	watch?: { tick_ms?: unknown; debounce_ms?: unknown; stall_threshold_ms?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readPartial(path: string, readFile: (path: string) => string, diagnostics: string[]): PartialConfig {
	let text: string;
	try {
		text = readFile(path);
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined;
		if (code === 'ENOENT') return {};
		diagnostics.push(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}. Defaults were used for that file.`);
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		diagnostics.push(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Defaults were used for that file.`);
		return {};
	}
	if (!isRecord(parsed)) {
		diagnostics.push(`${path} must contain a JSON object. Defaults were used for that file.`);
		return {};
	}
	return parsed;
}

/** A positive integer from either file, or the default when absent or unusable. */
function positiveIntOr(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return fallback;
	return value;
}

function positiveMsOr(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

export interface ResolveConfigOptions {
	/** The project directory whose project file is read. */
	readonly project: string;
	/** The agent directory holding the global file. */
	readonly agentDir: string;
	/** File reader seam; absent means `node:fs`. */
	readonly readFile?: (path: string) => string;
	/** Overrides either file, for tests and for `PI_HERDR_ENHANCED_CONFIG`. */
	readonly globalPath?: string;
	readonly projectPath?: string;
}

/**
 * Read both files and resolve the effective configuration.
 *
 * Never throws: an unreadable or malformed file degrades to defaults with a
 * diagnostic, because a Job must still be openable when someone fat-fingers a
 * trailing comma in a config file — the failure would otherwise be indistinguishable
 * from Herdr being unavailable.
 */
export function resolveConfig(options: ResolveConfigOptions): ResolvedConfig {
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
	const diagnostics: string[] = [];
	const globalPath = options.globalPath ?? defaultGlobalConfigPath(options.agentDir);
	const projectPath = options.projectPath ?? defaultProjectConfigPath(options.project);
	const global = readPartial(globalPath, readFile, diagnostics);
	const project = readPartial(projectPath, readFile, diagnostics);

	// The lock is a union, not a lookup: `false` anywhere locks, and nothing
	// below can unlock something above.
	const globalEnabled = isRecord(global.worktree) ? global.worktree.enabled : undefined;
	const projectEnabled = isRecord(project.worktree) ? project.worktree.enabled : undefined;
	const locked = globalEnabled === false || projectEnabled === false;

	const root = isRecord(project.worktree) && project.worktree.root !== undefined
		? project.worktree.root
		: isRecord(global.worktree) ? global.worktree.root : undefined;
	const worktreeRoot = typeof root === 'string' && root.trim().length > 0 ? root.trim() : DEFAULT_CONFIG.worktreeRoot;

	const placementRaw = project.placement ?? global.placement;
	if (placementRaw !== undefined && placementRaw !== 'tab') {
		diagnostics.push(`placement "${String(placementRaw)}" is not supported; only "tab" is implemented. Using "tab".`);
	}

	const retention = project.retention ?? global.retention;
	const watch = project.watch ?? global.watch;

	return {
		placement: 'tab',
		worktreeEnabled: !locked,
		worktreeLocked: locked,
		worktreeRoot,
		retentionCap: positiveIntOr(retention?.max_finished_windows, DEFAULT_CONFIG.retentionCap),
		tickMs: positiveMsOr(watch?.tick_ms, DEFAULT_CONFIG.tickMs),
		debounceMs: positiveMsOr(watch?.debounce_ms, DEFAULT_CONFIG.debounceMs),
		stallThresholdMs: positiveMsOr(watch?.stall_threshold_ms, DEFAULT_CONFIG.stallThresholdMs),
		diagnostics,
	};
}

/**
 * The absolute checkout path for a Job, or `undefined` to let Herdr decide.
 *
 * `auto` returns `undefined` so `worktree create` runs without `--path` and
 * Herdr places the checkout under its own `worktrees.directory`
 * (default `~/.herdr/worktrees`, as `<repo>/<branch-slug>`). Every other value
 * is a root the operator chose, expanded to an absolute `<root>/<job>`:
 * a relative root resolves against the **primary checkout**, because that is
 * what `--cwd` is and because the same relative root must mean the same place
 * from any worktree.
 *
 * Classic roots, as documented in the README:
 *
 *   `auto`                    `~/.herdr/worktrees/<repo>/<branch-slug>`
 *   `.worktrees`              `<repo>/.worktrees/<job>`   — needs `.worktrees/` in .gitignore
 *   `../<repo>.worktrees`     a sibling of the repository — outside, no .gitignore
 *   `~/workspace/worktrees`   `<root>/<repo>/<job>`       — one root for every repo
 */
export function worktreePathFor(root: WorktreeRoot, repoRoot: string, jobName: string): string | undefined {
	if (root === 'auto') return undefined;
	const expanded = root.startsWith('~/') ? join(homedir(), root.slice(2)) : root === '~' ? homedir() : root;
	const base = isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
	return join(base, jobName);
}

/**
 * The state directory: ownership records, generation ledgers, and the spool.
 *
 * Global rather than per-project because the Worker and the Orchestrator are
 * different processes that may share nothing but this path — the Worker learns
 * it from the capability it was spawned with, never from its own checkout.
 */
export function defaultStateDir(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_HERDR_ENHANCED_STATE;
	if (typeof override === 'string' && override.trim().length > 0) return resolve(override.trim());
	return join(agentDir, 'state', 'pi-herdr-enhanced');
}

/**
 * The spool directory a run scope family's claims and progress files travel
 * through.
 *
 * Keyed by the family **root**, not by an incarnation's scope: every incarnation
 * of one session writes into the same directory, so a session that absorbs a dead
 * sibling reads that sibling's Completion claims rather than only its own. The
 * claim token is what routes one record to one Job, so a shared directory cannot
 * let one Worker impersonate another.
 */
export function spoolDirFor(stateDir: string, root: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_HERDR_ENHANCED_SPOOL_PATH;
	if (typeof override === 'string' && override.trim().length > 0) return resolve(override.trim());
	return join(stateDir, 'spool', root);
}
