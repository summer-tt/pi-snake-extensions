/**
 * Real Herdr and Git access for the e2e suite.
 *
 * Nothing here is faked: every call spawns the `herdr` or `git` binary the
 * extension itself spawns, and the helpers only cover what an assertion needs to
 * observe. The suite runs inside a Herdr-managed pane, and it works in a Herdr
 * workspace of its own so a run never disturbs the operator's layout.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary directory, for fixtures like a repository. */
export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/**
 * The `herdr` runner in the shape the extension's own seam takes.
 *
 * Lets a scenario call a single production helper directly — resolving a
 * repository, listing rows — without going through a whole tool call.
 */
export function runHerdrCommand(): (args: readonly string[], options?: { readonly signal?: AbortSignal }) => Promise<RunResult> {
	return (args, options) => run('herdr', args, { timeout: 60_000, ...(options?.signal !== undefined ? { signal: options.signal } : {}) });
}

/** A finished command. A non-zero exit is a result, not an exception. */
export interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/**
 * Whether this process is inside a Herdr-managed pane.
 *
 * The e2e suite drives the real Herdr server, and the extension itself registers
 * nothing outside a Herdr pane, so both the suite and its subject share this
 * precondition. Asserted rather than assumed: a run that silently skipped every
 * scenario would look like a pass.
 */
export function insideHerdr(): boolean {
	return process.env.HERDR_ENV === '1' && (process.env.HERDR_PANE_ID ?? '').length > 0;
}

/** Run a command, capturing both streams, and never reject on a non-zero exit. */
export function run(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly timeout?: number; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = execFile(
			command,
			[...args],
			{
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
				...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {}),
				...(options.env !== undefined ? { env: options.env } : {}),
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
				const code = failure && typeof failure.code === 'number' ? failure.code : failure ? 1 : 0;
				resolve({ stdout, stderr, code });
			},
		);
	});
}

/** The Herdr error envelope, decoded. */
export class HerdrCliError extends Error {
	readonly code: string;
	constructor(code: string, message: string, context: string) {
		super(`${context}: ${code}: ${message}`);
		this.name = 'HerdrCliError';
		this.code = code;
	}
}

/** Run `herdr` and return the parsed `.result`. Throws on Herdr's error envelope. */
export async function herdrJson<T = Record<string, unknown>>(args: readonly string[]): Promise<T> {
	const result = await run('herdr', args, { timeout: 60_000 });
	const text = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
	let envelope: unknown;
	try {
		envelope = JSON.parse(text);
	} catch {
		throw new Error(`herdr ${args.join(' ')} did not return JSON (exit ${result.code}): ${text.slice(0, 400)}`);
	}
	const record = envelope as { result?: T; error?: { code?: unknown; message?: unknown } };
	if (record.error) {
		throw new HerdrCliError(String(record.error.code ?? 'unknown'), String(record.error.message ?? ''), `herdr ${args.join(' ')}`);
	}
	if (record.result === undefined) throw new Error(`herdr ${args.join(' ')} returned no result: ${text.slice(0, 400)}`);
	return record.result;
}

/** Herdr's shape for a window-establishing command. */
export interface WindowAddress {
	readonly workspace: string;
	readonly tab: string;
	readonly pane: string;
}

interface AddressPayload {
	readonly workspace?: { workspace_id?: unknown };
	readonly tab?: { tab_id?: unknown; label?: unknown };
	readonly root_pane?: { pane_id?: unknown };
}

/**
 * Read a window address out of Herdr's answer.
 *
 * `tab create` reports only the tab and its root pane — the workspace is the one
 * the caller named — so the expected workspace is the fallback. Anything else
 * missing is a shape this suite does not understand and must not paper over.
 */
function addressOf(payload: AddressPayload, what: string, fallbackWorkspace = ''): WindowAddress {
	const workspace = typeof payload.workspace?.workspace_id === 'string' ? payload.workspace.workspace_id : fallbackWorkspace;
	const tab = payload.tab?.tab_id;
	const pane = payload.root_pane?.pane_id;
	if (workspace.length === 0 || typeof tab !== 'string' || typeof pane !== 'string') {
		throw new Error(`${what} did not return a workspace, tab and root pane: ${JSON.stringify(payload)}`);
	}
	return { workspace, tab, pane };
}

/** Create a workspace of our own, so the suite never touches the operator's layout. */
export async function createWorkspace(label: string, cwd: string): Promise<WindowAddress> {
	return addressOf(await herdrJson<AddressPayload>(['workspace', 'create', '--label', label, '--cwd', cwd, '--no-focus']), 'workspace create');
}

/** Create a tab and its root pane, which is the non-worktree placement a Job uses. */
export async function createTab(workspace: string, cwd: string, label: string): Promise<WindowAddress> {
	return addressOf(await herdrJson<AddressPayload>(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus']), 'tab create', workspace);
}

/** Close a tab. Tolerates one that is already gone, like the extension does. */
export async function closeTab(tab: string): Promise<void> {
	try {
		await herdrJson(['tab', 'close', tab]);
	} catch (error) {
		if (error instanceof HerdrCliError && error.code === 'tab_not_found') return;
		throw error;
	}
}

/**
 * Close a workspace. Tolerates one that is already gone, like the extension does.
 *
 * Herdr refuses a plain close of a workspace that has linked worktree workspaces —
 * `workspace_group_close_required` — and names `--group` as the flag that closes
 * them together. That is only ever right for a teardown that owns the whole group,
 * so it is opt-in here, and a scenario that leaks a worktree Job fails loudly
 * instead of quietly taking the Orchestrator's workspace with it.
 */
export async function closeWorkspace(workspace: string, options: { readonly group?: boolean } = {}): Promise<void> {
	try {
		await herdrJson(['workspace', 'close', workspace, ...(options.group === true ? ['--group'] : [])]);
	} catch (error) {
		if (error instanceof HerdrCliError && error.code === 'workspace_not_found') return;
		if (error instanceof HerdrCliError && error.code === 'workspace_group_close_required') {
			throw new Error(
				`closing ${workspace} needs --group: it has linked worktree workspaces. A Job window was left open. (${error.message})`,
			);
		}
		throw error;
	}
}

/** The tabs Herdr currently reports inside one workspace. */
export async function tabsIn(workspace: string): Promise<readonly { tabId: string; label: string; paneIds: readonly string[] }[]> {
	const result = await herdrJson<{ tabs?: readonly Record<string, unknown>[] }>(['tab', 'list']);
	const rows: { tabId: string; label: string; paneIds: readonly string[] }[] = [];
	for (const row of result.tabs ?? []) {
		if (row.workspace_id !== workspace) continue;
		const tabId = typeof row.tab_id === 'string' ? row.tab_id : '';
		if (tabId.length === 0) continue;
		rows.push({
			tabId,
			label: typeof row.label === 'string' ? row.label : '',
			paneIds: await panesOf(tabId),
		});
	}
	return rows;
}

/** The panes living in one tab. */
export async function panesOf(tab: string): Promise<readonly string[]> {
	const result = await herdrJson<{ panes?: readonly Record<string, unknown>[] }>(['pane', 'list']);
	return (result.panes ?? [])
		.filter((pane) => pane.tab_id === tab)
		.map((pane) => (typeof pane.pane_id === 'string' ? pane.pane_id : ''))
		.filter((pane) => pane.length > 0);
}

/** True when Herdr still has this pane. */
export async function paneAlive(pane: string): Promise<boolean> {
	try {
		await herdrJson(['pane', 'get', pane]);
		return true;
	} catch (error) {
		if (error instanceof HerdrCliError && error.code === 'pane_not_found') return false;
		throw error;
	}
}

/** True when Herdr still has this tab. */
export async function tabAlive(tab: string): Promise<boolean> {
	const result = await herdrJson<{ tabs?: readonly Record<string, unknown>[] }>(['tab', 'list']);
	return (result.tabs ?? []).some((row) => row.tab_id === tab);
}

/** True when Herdr still has this workspace. */
export async function workspaceAlive(workspace: string): Promise<boolean> {
	const result = await herdrJson<{ workspaces?: readonly Record<string, unknown>[] }>(['workspace', 'list']);
	return (result.workspaces ?? []).some((row) => row.workspace_id === workspace);
}

/** Every workspace Herdr reports, for detecting leaks. */
export async function workspaceIds(): Promise<readonly string[]> {
	const result = await herdrJson<{ workspaces?: readonly Record<string, unknown>[] }>(['workspace', 'list']);
	return (result.workspaces ?? []).map((row) => (typeof row.workspace_id === 'string' ? row.workspace_id : '')).filter((id) => id.length > 0);
}

/**
 * Start an ordinary process in a pane, for a Job window that needs no Pi session.
 *
 * `pane run` answers with an empty stream rather than an envelope, so this is a
 * plain spawn: the exit code is the whole answer.
 */
export async function runInPane(pane: string, command: string): Promise<void> {
	const result = await run('herdr', ['pane', 'run', pane, command], { timeout: 30_000 });
	if (result.code !== 0) throw new Error(`herdr pane run ${pane} ${command} failed (${result.code}): ${result.stderr.trim()}`);
}

/**
 * The last rows of a pane's rendered terminal.
 *
 * `pane read` prints its rows directly — only a failure is a JSON envelope — so
 * this reads stdout as text and falls back to unwrapping an envelope for a Herdr
 * version that wraps them.
 */
export async function paneText(pane: string, lines = 40): Promise<string> {
	const result = await run('herdr', ['pane', 'read', pane, '--lines', String(lines), '--source', 'visible'], { timeout: 30_000 });
	const body = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
	if (/^[\s]*\{/.test(body)) {
		try {
			const parsed = JSON.parse(body) as { readonly result?: { readonly text?: unknown } };
			if (typeof parsed.result?.text === 'string') return parsed.result.text;
		} catch {
			// Not an envelope after all: the rows are the answer.
		}
	}
	return body;
}

// ---------------------------------------------------------------------------
// Git, for the worktree scenarios
// ---------------------------------------------------------------------------

/** Run git in a directory. */
export async function git(cwd: string, args: readonly string[]): Promise<RunResult> {
	return run('git', args, { cwd, timeout: 30_000 });
}

/** Run git and fail loudly when it does, because a broken fixture hides the real bug. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout.trim();
}

/**
 * Await a condition by polling, for the parts of Herdr that settle
 * asynchronously — `workspace close` and `tab close` both report success before
 * the row disappears from the list.
 */
export async function waitFor<T>(
	what: string,
	probe: () => Promise<T | undefined | false>,
	options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const intervalMs = options.intervalMs ?? 200;
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		last = await probe();
		if (last !== undefined && last !== false) return last as T;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
