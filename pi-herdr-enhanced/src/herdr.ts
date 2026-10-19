/**
 * The `herdr` CLI as one testable seam.
 *
 * Every Herdr call this extension makes goes through here, and every one of them
 * goes through the CLI rather than the automation socket. Two measured reasons,
 * inherited from Foreman's investigation and re-checked on herdr 0.9.4:
 *
 *   - The socket is bimodal — ~0.4 ms or ~105 ms with nothing in between,
 *     because Herdr closes the connection per request and sometimes pays a
 *     delayed-ack penalty. The CLI is a stable 4–5 ms and is the same transport
 *     Herdr's own Pi integration uses, so what an operator sees matches what
 *     this extension does.
 *   - A failed CLI call writes its machine-readable envelope to **stderr** and
 *     leaves stdout empty, exiting 1 (verified). A transport that reads only
 *     stdout degrades every typed error to a generic failure, and the two
 *     code-based decisions the Job lifecycle rests on — `pane_not_found` means
 *     dead, `workspace_not_found` means the close already happened — stop
 *     working at once. {@link herdrJson} therefore reads the envelope from
 *     either stream.
 *
 * `run` is injected so this module stays free of Pi and child-process details
 * and can be exercised directly by the suite.
 */

import { realpathSync } from 'node:fs';

/** The shape a spawn resolves to, reduced to what this module needs. */
export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** How a long-running Herdr call is cancelled — a waiting call outlives its Job. */
export interface RunOptions {
	readonly signal?: AbortSignal;
}

/** One `herdr` invocation, with the arguments after the executable name. */
export type RunCommand = (args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

/**
 * A typed Herdr failure.
 *
 * The `code` is Herdr's own (`pane_not_found`, `workspace_not_found`,
 * `linked_worktree_source`, …); it is what the lifecycle branches on, so it is
 * never re-derived from the message text.
 */
export class HerdrError extends Error {
	readonly code: string;
	readonly args: readonly string[];

	constructor(code: string, message: string, args: readonly string[] = []) {
		super(message);
		this.name = 'HerdrError';
		this.code = code;
		this.args = args;
	}
}

/** True when a thrown value is a Herdr failure with this exact code. */
export function isHerdrCode(error: unknown, code: string): boolean {
	return error instanceof HerdrError && error.code === code;
}

/** True when a Herdr error means the pane no longer exists. */
export function isMissingPane(error: unknown): boolean {
	return isHerdrCode(error, 'pane_not_found');
}

/**
 * True when a Herdr error means the pane hosts no agent it recognizes.
 *
 * This is not the same as a missing pane, and it is the *normal* answer for a pane
 * whose session has exited: the pane is still there to be read and restarted, so a
 * caller asking about its agent gets an answer of "nothing", not a failure. The
 * distinction matters — a Job whose session died is restarted in place, and that
 * path is reached by way of this question.
 */
export function isMissingAgent(error: unknown): boolean {
	return isHerdrCode(error, 'agent_not_found');
}

/** True when a Herdr error means the workspace was already gone. */
export function isMissingWorkspace(error: unknown): boolean {
	return isHerdrCode(error, 'workspace_not_found');
}

/** True when Herdr refused because the source is a linked worktree, not the repo. */
export function isLinkedWorktreeSource(error: unknown): boolean {
	return isHerdrCode(error, 'linked_worktree_source');
}

/**
 * Herdr refused to scroll a pane that is still working.
 *
 * Capturing an agent's alternate-screen history means scrolling it, and scrolling
 * a working pane disturbs what it is drawing. Herdr refuses any scrollback request
 * for a working agent — whatever the line count — and points at `--source visible`
 * as the part it can always give.
 */
export function isNotIdle(error: unknown): boolean {
	return isHerdrCode(error, 'agent_not_idle');
}

/** True when a primary workspace close needs `--group`. */
export function isGroupCloseRequired(error: unknown): boolean {
	return isHerdrCode(error, 'workspace_group_close_required');
}

/** True when Git refused the checkout because another user owns it. */
export function isDubiousOwnership(text: string): boolean {
	return /dubious ownership|detected dubious ownership in repository/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * The error envelope Herdr writes, read from whichever stream carries it.
 *
 * A success payload is the JSON on stdout. A failure is `{"error":{"code",
 * "message"}}` on stderr with exit status 1 — but the envelope is accepted from
 * either stream so a merged transport keeps working, and an unparseable body
 * still yields a typed error rather than a silent success.
 */
function parseEnvelope(stdout: string, stderr: string): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
	const attempts: string[] = [];
	if (stderr.trim().length > 0) attempts.push(stderr);
	if (stdout.trim().length > 0) attempts.push(stdout);
	for (const body of attempts) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		const error = parsed.error;
		if (isRecord(error)) {
			const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'herdr_error';
			const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : code;
			return { ok: false, code, message };
		}
		return { ok: true, value: parsed };
	}
	const detail = (stderr.trim() || stdout.trim()).slice(0, 400);
	return { ok: false, code: 'herdr_unparseable', message: detail.length > 0 ? detail : 'herdr produced no JSON output' };
}

/**
 * One Herdr call that answers with text rather than an envelope.
 *
 * `agent read` prints the pane's rows directly on stdout, and only its *failure*
 * is a JSON envelope — on stderr. A caller that insists on an envelope therefore
 * reads a successful screen capture as a parse failure whose message is the
 * screen itself. Both shapes are accepted here, because the rows are the point:
 * an envelope that carries `text`/`output`/`content` is unwrapped the same way as
 * one Herdr version or another may wrap it.
 */
export async function herdrText(run: RunCommand, args: readonly string[], options?: RunOptions): Promise<string> {
	const result = await run(args, options);
	const body = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	if (isRecord(parsed) && isRecord(parsed.error)) {
		const error = parsed.error;
		const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'herdr_error';
		const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : code;
		throw new HerdrError(code, message, args);
	}
	if (result.code !== 0) {
		throw new HerdrError('herdr_nonzero_exit', `herdr ${args.join(' ')} exited with ${result.code}: ${body.trim().slice(0, 200)}`, args);
	}
	if (isRecord(parsed)) {
		const value = 'result' in parsed ? parsed.result : parsed;
		if (isRecord(value)) {
			for (const key of ['text', 'output', 'content'] as const) {
				if (typeof value[key] === 'string') return value[key];
			}
		}
	}
	return result.stdout;
}

/**
 * One Herdr call, resolving to the payload inside its `{"id","result"}` wrapper.
 *
 * Exit status and envelope are both honoured: a zero exit with an `error` body
 * is still a failure (and vice versa), because the two have been observed to
 * disagree across herdr versions.
 */
export async function herdrJson(run: RunCommand, args: readonly string[], options?: RunOptions): Promise<unknown> {
	const result = await run(args, options);
	const envelope = parseEnvelope(result.stdout, result.stderr);
	if (!envelope.ok) throw new HerdrError(envelope.code, envelope.message, args);
	if (result.code !== 0) {
		throw new HerdrError('herdr_nonzero_exit', `herdr ${args.join(' ')} exited with ${result.code}`, args);
	}
	const value = envelope.value;
	if (isRecord(value)) {
		if ('result' in value) return value.result;
		if ('error' in value) {
			const error = value.error;
			if (isRecord(error)) {
				const code = typeof error.code === 'string' ? error.code : 'herdr_error';
				const message = typeof error.message === 'string' ? error.message : code;
				throw new HerdrError(code, message, args);
			}
		}
	}
	return value;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) throw new HerdrError('invalid_output', `herdr returned no ${what}`, []);
	return value;
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
	const value = source[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new HerdrError('invalid_output', `herdr returned no ${what}`, []);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Agents and panes
// ---------------------------------------------------------------------------

/** The five lifecycle states Herdr reports for a pane hosting a recognized agent. */
export type PaneStatus = 'working' | 'idle' | 'done' | 'blocked' | 'unknown';

const KNOWN_STATUSES: readonly PaneStatus[] = ['working', 'idle', 'done', 'blocked', 'unknown'];

function isPaneStatus(value: unknown): value is PaneStatus {
	return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value);
}

/** One live agent, reduced to what Job classification needs. */
export interface AgentSnapshot {
	readonly pane: string;
	readonly workspace: string;
	readonly tab: string;
	readonly status: PaneStatus;
	/** The agent's own session identity, when Herdr can report it. */
	readonly session?: string;
}

/**
 * Every recognized agent on this host, keyed by pane id.
 *
 * One call, not one per Job: the poll classifies the whole open set from a
 * single snapshot, so N Jobs cost one Herdr call per round rather than N.
 */
export async function agentList(run: RunCommand): Promise<ReadonlyMap<string, AgentSnapshot>> {
	const result = requireRecord(await herdrJson(run, ['agent', 'list']), 'agent list result');
	const agents = Array.isArray(result.agents) ? result.agents : [];
	const byPane = new Map<string, AgentSnapshot>();
	for (const entry of agents) {
		if (!isRecord(entry)) continue;
		const pane = entry.pane_id;
		if (typeof pane !== 'string' || pane.length === 0) continue;
		const session = isRecord(entry.agent_session) && typeof entry.agent_session.value === 'string' ? entry.agent_session.value : undefined;
		byPane.set(pane, {
			pane,
			workspace: typeof entry.workspace_id === 'string' ? entry.workspace_id : '',
			tab: typeof entry.tab_id === 'string' ? entry.tab_id : '',
			status: isPaneStatus(entry.agent_status) ? entry.agent_status : 'unknown',
			...(session ? { session } : {}),
		});
	}
	return byPane;
}

/** One live agent, or `undefined` when that pane hosts nothing Herdr recognizes. */
export async function agentGet(run: RunCommand, pane: string): Promise<AgentSnapshot | undefined> {
	try {
		const result = requireRecord(await herdrJson(run, ['agent', 'get', pane]), 'agent get result');
		const entry = isRecord(result.agent) ? result.agent : result;
		const status = isPaneStatus(entry.agent_status) ? entry.agent_status : 'unknown';
		const session = isRecord(entry.agent_session) && typeof entry.agent_session.value === 'string' ? entry.agent_session.value : undefined;
		return {
			pane: typeof entry.pane_id === 'string' ? entry.pane_id : pane,
			workspace: typeof entry.workspace_id === 'string' ? entry.workspace_id : '',
			tab: typeof entry.tab_id === 'string' ? entry.tab_id : '',
			status,
			...(session ? { session } : {}),
		};
	} catch (error) {
		if (isMissingPane(error) || isMissingAgent(error)) return undefined;
		throw error;
	}
}

/** True when the pane still exists, whatever occupies it. */
export async function paneExists(run: RunCommand, pane: string): Promise<boolean> {
	try {
		await herdrJson(run, ['pane', 'get', pane]);
		return true;
	} catch (error) {
		if (isMissingPane(error)) return false;
		throw error;
	}
}

/** How `agent read` is asked for rows, matching Herdr's own vocabulary. */
export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped' | 'detection';

/** Read a live agent's terminal stream. */
export async function agentRead(run: RunCommand, target: string, lines = 120, source: ReadSource = 'recent-unwrapped'): Promise<string> {
	return herdrText(run, ['agent', 'read', target, '--lines', String(lines), '--source', source]);
}

/**
 * Read a pane's rows without going through the agent in it.
 *
 * `agent read` reads *through* a session, so a pane whose session has exited has
 * nothing to read through — while its last screen is still sitting there, and
 * `pane read` is Herdr's own way to reach it. That is the difference between a
 * window whose Worker has died and a window that cannot be inspected at all.
 */
export async function paneRead(run: RunCommand, pane: string, lines = 120, source: ReadSource = 'visible'): Promise<string> {
	return herdrText(run, ['pane', 'read', pane, '--lines', String(lines), '--source', source]);
}

/**
 * Submit a prompt to an agent.
 *
 * Deliberately no wait: delivering a task and observing its settlement are
 * different concerns here. The Job is registered with the watch *before* its
 * prompt is sent, so a Worker that fails instantly is still an addressable Job.
 */
export async function agentPrompt(run: RunCommand, target: string, text: string): Promise<void> {
	await herdrJson(run, ['agent', 'prompt', target, text]);
}

/**
 * Block until an agent reaches one of the requested states.
 *
 * This is the watch's primary signal — a Job that stops working is reported the
 * moment Herdr sees it, rather than on the next poll tick. The caller aborts it
 * when the Job stops being one it waits on.
 */
export async function agentWait(
	run: RunCommand,
	target: string,
	until: readonly PaneStatus[],
	timeoutMs: number | undefined,
	signal?: AbortSignal,
): Promise<PaneStatus | undefined> {
	const args = ['agent', 'wait', target];
	for (const status of until) args.push('--until', status);
	if (timeoutMs !== undefined) args.push('--timeout', String(timeoutMs));
	const result = await herdrJson(run, args, signal ? { signal } : {});
	if (!isRecord(result)) return undefined;
	const status = result.status ?? result.agent_status;
	return isPaneStatus(status) ? status : undefined;
}

/** Start a recognized agent in an existing pane at a shell prompt. */
export async function agentStart(
	run: RunCommand,
	options: { readonly name: string; readonly pane: string; readonly kind: string; readonly args: readonly string[] },
): Promise<void> {
	await herdrJson(run, ['agent', 'start', options.name, '--kind', options.kind, '--pane', options.pane, '--', ...options.args]);
}

// ---------------------------------------------------------------------------
// Workspaces, tabs, worktrees
// ---------------------------------------------------------------------------

/** The addressing every window-establishing command returns. */
export interface WindowAddress {
	readonly workspace: string;
	readonly tab: string;
	readonly pane: string;
}

function addressesFrom(result: Record<string, unknown>, what: string): WindowAddress {
	const workspace = requireRecord(result.workspace, `${what} workspace`);
	const tab = requireRecord(result.tab, `${what} tab`);
	const pane = requireRecord(result.root_pane, `${what} root pane`);
	return {
		workspace: requireString(workspace, 'workspace_id', `${what} workspace id`),
		tab: requireString(tab, 'tab_id', `${what} tab id`),
		pane: requireString(pane, 'pane_id', `${what} pane id`),
	};
}

/** Every workspace on this host, raw — callers read the fields they need. */
export async function workspaceList(run: RunCommand): Promise<readonly Record<string, unknown>[]> {
	const result = requireRecord(await herdrJson(run, ['workspace', 'list']), 'workspace list result');
	const workspaces = result.workspaces;
	return Array.isArray(workspaces) ? workspaces.filter(isRecord) : [];
}

/** A workspace's label, or `undefined` when it has none. */
export async function workspaceLabel(run: RunCommand, workspace: string): Promise<string | undefined> {
	for (const entry of await workspaceList(run)) {
		if (entry.workspace_id !== workspace) continue;
		return typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : undefined;
	}
	return undefined;
}

/**
 * Close a workspace.
 *
 * Idempotent in the one way that matters: `workspace_not_found` means the close
 * the caller asked for has already happened. Note that Herdr reports success
 * before the row actually disappears from `workspace list` — a caller that
 * verifies immediately must tolerate that, which is why no lifecycle step here
 * treats a just-closed workspace as still open.
 */
/**
 * Close a workspace, idempotently.
 *
 * A workspace that has linked worktree workspaces refuses a plain close, and the
 * flag Herdr names for it takes the *whole group* — which for a Job would include
 * the Orchestrator's own workspace. So that outcome is turned into an explicit
 * refusal rather than retried: ending more than the window that was asked about is
 * not this extension's decision to make, and a Job's window is the only thing it
 * ever closes.
 */
export async function workspaceClose(run: RunCommand, workspace: string): Promise<void> {
	try {
		await herdrJson(run, ['workspace', 'close', workspace]);
	} catch (error) {
		if (isMissingWorkspace(error)) return;
		if (isGroupCloseRequired(error)) {
			throw new HerdrError(
				'workspace_group_close_required',
				`Herdr will not close ${workspace} on its own: it has linked worktree workspaces, and the flag that would close it would close the whole group — including the workspace this session runs in. Close the worktree windows first.`,
				['workspace', 'close', workspace],
			);
		}
		throw error;
	}
}

/**
 * Create a tab in an existing workspace and return its root pane.
 *
 * This is the non-worktree placement: a Job lives in a tab of the workspace the
 * Orchestrator already occupies, so a run of Jobs reads as tabs rather than as a
 * flat list of new workspaces. `tab create` returns `.result.tab` and
 * `.result.root_pane` — the root pane is at a shell prompt, which is what
 * `agent start` requires.
 */
export async function tabCreate(
	run: RunCommand,
	options: { readonly workspace: string; readonly cwd: string; readonly label: string },
): Promise<WindowAddress> {
	const result = requireRecord(
		await herdrJson(run, ['tab', 'create', '--workspace', options.workspace, '--cwd', options.cwd, '--label', options.label, '--no-focus']),
		'tab create result',
	);
	const tab = requireRecord(result.tab, 'tab create tab');
	const pane = requireRecord(result.root_pane, 'tab create root pane');
	return {
		workspace: typeof result.workspace === 'string' ? result.workspace : options.workspace,
		tab: requireString(tab, 'tab_id', 'tab create tab id'),
		pane: requireString(pane, 'pane_id', 'tab create root pane id'),
	};
}

/** Rename a tab, so the sidebar row names the Ticket behind the Job. */
export async function tabRename(run: RunCommand, tab: string, label: string): Promise<void> {
	await herdrJson(run, ['tab', 'rename', tab, label]);
}

/** Close a tab. `tab_not_found` means the close already happened. */
export async function tabClose(run: RunCommand, tab: string): Promise<void> {
	try {
		await herdrJson(run, ['tab', 'close', tab]);
	} catch (error) {
		if (isHerdrCode(error, 'tab_not_found')) return;
		throw error;
	}
}

/** True when two paths name the same file, regardless of symlinked prefixes. */
export function samePath(left: string, right: string): boolean {
	if (left === right) return true;
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

/** One Git checkout Herdr knows about. */
export interface WorktreeEntry {
	readonly path: string;
	readonly branch?: string;
	readonly linked: boolean;
	readonly openWorkspace?: string;
}

/** The repository behind a checkout, plus every worktree Herdr can see. */
export interface CheckoutSource {
	/** The primary checkout. `worktree create` and `open` are refused from anywhere else. */
	readonly repoRoot: string;
	readonly repoName: string;
	readonly worktrees: readonly WorktreeEntry[];
}

/**
 * Resolve the repository behind a path.
 *
 * `worktree create` and `worktree open` start from the **primary** checkout: a
 * linked worktree path is refused with `linked_worktree_source` (verified on
 * herdr 0.9.4). So every worktree decision begins here, and a caller that knows
 * only a checkout path learns the repo root from Herdr rather than guessing one
 * from a directory name.
 */
export async function checkoutSource(run: RunCommand, path: string): Promise<CheckoutSource> {
	const result = requireRecord(await herdrJson(run, ['worktree', 'list', '--cwd', path]), 'worktree list result');
	const source = requireRecord(result.source, 'worktree list source');
	const repoRoot = requireString(source, 'repo_root', 'worktree list repo root');
	const repoName = typeof source.repo_name === 'string' && source.repo_name.length > 0 ? source.repo_name : 'repo';
	const entries = Array.isArray(result.worktrees) ? result.worktrees : [];
	const worktrees: WorktreeEntry[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.path !== 'string') continue;
		worktrees.push({
			path: entry.path,
			...(typeof entry.branch === 'string' ? { branch: entry.branch } : {}),
			linked: entry.is_linked_worktree === true,
			...(typeof entry.open_workspace_id === 'string' ? { openWorkspace: entry.open_workspace_id } : {}),
		});
	}
	return { repoRoot, repoName, worktrees };
}

export interface WorktreeCreateOptions {
	readonly repo: string;
	readonly branch: string;
	readonly base: string;
	/** Absolute checkout path. Absent means "let Herdr decide": `<worktrees.directory>/<repo>/<branch-slug>`. */
	readonly path?: string;
	readonly label: string;
	readonly trustRepository?: boolean;
}

/**
 * Create a Job's branch worktree and open it as a workspace row.
 *
 * When `path` is absent Herdr places the checkout under its own
 * `worktrees.directory` (default `~/.herdr/worktrees`) as
 * `<repo>/<branch-slug>` — verified on herdr 0.9.4. That is the default here
 * too, because inventing a second convention beside Herdr's own would mean two
 * places to look for a checkout.
 *
 * `--trust-repository` is only ever passed when the caller asked for it: it
 * bypasses Git's `safe.directory` protection for a repository owned by another
 * user, which is a decision about trust that belongs to a human, not to a
 * default.
 */
export async function worktreeCreate(run: RunCommand, options: WorktreeCreateOptions): Promise<WindowAddress> {
	const args = ['worktree', 'create', '--cwd', options.repo, '--branch', options.branch, '--base', options.base];
	if (options.path !== undefined) args.push('--path', options.path);
	args.push('--label', options.label);
	if (options.trustRepository === true) args.push('--trust-repository');
	args.push('--no-focus');
	const result = requireRecord(await herdrJson(run, args), 'worktree create result');
	return addressesFrom(result, 'worktree create');
}

/**
 * The Git checkout path Herdr recorded for a workspace, when it has one.
 *
 * A worktree Job's checkout path is decided by Herdr when no `--path` is given,
 * so the caller has to read it back rather than assume it: the path is what
 * `reclaim` later removes, and guessing it would aim Git at the wrong directory.
 */
export async function checkoutPathOf(run: RunCommand, workspace: string): Promise<string | undefined> {
	for (const entry of await workspaceList(run)) {
		if (entry.workspace_id !== workspace) continue;
		const checkout = isRecord(entry.worktree) ? entry.worktree.checkout_path : undefined;
		return typeof checkout === 'string' && checkout.length > 0 ? checkout : undefined;
	}
	return undefined;
}

/**
 * Open an existing checkout as a worktree row: a workspace with Git provenance,
 * grouped with its repository.
 *
 * `alreadyOpen` reports that Herdr returned the row that was already there
 * rather than creating one — one checkout has exactly one worktree row, so a
 * second `worktree open` joins the first. This is the recovery path for a Job
 * whose checkout outlived its window: the branch worktree is already on disk,
 * so `worktree create` would refuse it, but the row is a legitimate place to
 * resume.
 */
export async function worktreeOpen(
	run: RunCommand,
	options: { readonly repo: string; readonly path: string; readonly label?: string },
): Promise<WindowAddress & { readonly alreadyOpen: boolean }> {
	const args = ['worktree', 'open', '--cwd', options.repo, '--path', options.path];
	if (options.label !== undefined) args.push('--label', options.label);
	args.push('--no-focus');
	const result = requireRecord(await herdrJson(run, args), 'worktree open result');
	return { ...addressesFrom(result, 'worktree open'), alreadyOpen: result.already_open === true };
}

/**
 * Workspace ids of open rows whose Git checkout provenance is `path`.
 *
 * Only provenance-backed rows match. Herdr records `checkout_path` for the rows
 * it opened through the worktree commands, so a pane merely *standing* in some
 * directory — an operator's own window that happened to `cd` there — is never a
 * match, and closing these rows can never close a workspace this extension does
 * not own.
 */
export async function checkoutRows(run: RunCommand, path: string): Promise<readonly string[]> {
	const rows: string[] = [];
	for (const workspace of await workspaceList(run)) {
		const workspaceId = workspace.workspace_id;
		if (typeof workspaceId !== 'string') continue;
		const checkout = isRecord(workspace.worktree) ? workspace.worktree.checkout_path : undefined;
		if (typeof checkout === 'string' && samePath(checkout, path)) rows.push(workspaceId);
	}
	return rows;
}

/** True when Herdr is reachable from this process. */
export function herdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === '1' && typeof env.HERDR_PANE_ID === 'string' && env.HERDR_PANE_ID.length > 0;
}
