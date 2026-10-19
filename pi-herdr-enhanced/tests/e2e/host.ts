/**
 * The e2e host: a real extension runtime for a real `herdr`.
 *
 * The suite the rest of this directory drives is the shipped entry point. This
 * file supplies everything Pi normally supplies, and *only* that:
 *
 *   - `exec` spawns the actual `herdr` and `git` binaries, so every window,
 *     worktree, ownership record and spool file in the suite is real.
 *   - `appendEntry` accumulates real session entries, which is how the watch
 *     state and the Worker capability survive a restart; the seeds and restores
 *     the suite exercises go through those entries, not through private state.
 *   - `sendMessage` is the delivery channel, so a Wake asserted on is a Wake the
 *     extension actually produced, with the identity and details it produced.
 *   - `process.argv` carries the reserved spawn flag for a Worker host, exactly
 *     as a spawned Worker's argv does.
 *
 * A scenario therefore cannot pass by agreeing with a mock. State lives under a
 * temporary agent directory, the extension's `HERDR_WORKSPACE_ID` is a workspace
 * this host created and later closes, and nothing outside the temporary
 * directory is written.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CAPABILITY_FLAG, encodeCapability, type JobCapability } from '../../src/capability.ts';
import { familyScope } from '../../src/ownership.ts';
import type { JobRecord, WatchState } from '../../src/registry.ts';
import { WATCH_ENTRY_TYPE } from '../../src/registry.ts';
import { run, createTab, createWorkspace, closeWorkspace, tabsIn, paneAlive, runInPane, waitFor, workspaceAlive, type WindowAddress } from './herdr-e2e.ts';

/** A tool result as the extension returns it. */
export interface ToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

/** A registered tool, reduced to what the suite calls. */
interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<ToolResult>;
}

/** One session entry, in the shape the extension reads back. */
interface SessionEntry {
	readonly id: string;
	readonly type: 'custom';
	readonly customType: string;
	readonly data: unknown;
}

/** A Wake delivered through `sendMessage`. */
export interface DeliveredMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: unknown;
	readonly details: unknown;
	readonly options: unknown;
	readonly at: number;
}

export interface HostOptions {
	/** Scenario name; names the scope, the temporary directories and the workspace. */
	readonly name: string;
	/** The project directory. A fresh temporary directory when absent. */
	readonly project?: string;
	/** `worktree.enabled: false` in the *global* config file. */
	readonly globalWorktreeLocked?: boolean;
	/** `worktree.enabled: false` in the *project* config file. */
	readonly projectWorktreeLocked?: boolean;
	/** `retention.max_finished_windows`. */
	readonly retentionCap?: number;
	/** `watch.debounce_ms`, so a Wake is not waited for on the real 1.5s. */
	readonly debounceMs?: number;
	readonly tickMs?: number;
	/** Jobs to place in the watch before `session_start`, as a restored session would. */
	readonly seedJobs?: readonly JobRecord[];
	/** Makes this host a dispatched Worker: its capability rides the spawn flag in argv. */
	readonly capability?: JobCapability;
	/**
	 * An existing state directory to share, for a second session in one project.
	 *
	 * Two pi sessions in one project share a run scope **family**, which is what makes
	 * them two claimants rather than two unrelated sessions. Sharing the root is what
	 * lets one see the other's ledgers; the incarnation each lands on is derived from
	 * who is still running.
	 */
	readonly share?: { readonly stateDir: string; readonly root: string };
}

export class ExtensionHost {
	readonly options: HostOptions;
	readonly dir: string;
	readonly agentDir: string;
	readonly stateDir: string;
	/** The family root: the session id, or the explicit scope override. */
	readonly root: string;
	/** The incarnation this session lands on first, `<root>#0`. */
	readonly scope: string;
	readonly project: string;

	readonly tools = new Map<string, RegisteredTool>();
	readonly flags = new Map<string, unknown>();
	readonly handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	readonly entries: SessionEntry[] = [];
	readonly notifications: { readonly message: string; readonly level: string }[] = [];
	readonly messages: DeliveredMessage[] = [];
	/**
	 * Jobs to place in the watch at `session_start`.
	 *
	 * Pushed after `open()`, once the workspace a Job window lives in is known, and
	 * read at `launch()`. They arrive the way a resumed session's Jobs arrive — as a
	 * persisted watch entry — so the restore path under test is the production one.
	 */
	readonly seedJobs: JobRecord[] = [];

	workspace = '';
	private savedEnv: Record<string, string | undefined> = {};
	private savedArgv: string[] = [];
	private savedCwd = '';
	private entryCounter = 0;
	private started = false;

	constructor(options: HostOptions) {
		this.options = options;
		this.dir = mkdtempSync(join(tmpdir(), `phe-e2e-${options.name}-`));
		this.agentDir = join(this.dir, 'agent');
		this.stateDir = options.share?.stateDir ?? join(this.dir, 'state');
		this.project = options.project ?? join(this.dir, 'project');
		this.root = options.share?.root ?? `e2e-${options.name}`;
		this.scope = familyScope(this.root, 0);
		if (options.seedJobs !== undefined) this.seedJobs.push(...options.seedJobs);
		mkdirSync(this.agentDir, { recursive: true });
		mkdirSync(this.stateDir, { recursive: true });
		mkdirSync(this.project, { recursive: true });
	}

	/** The spool directory this host's run scope family writes claims and progress to. */
	get spoolPath(): string {
		return join(this.stateDir, 'spool', this.root);
	}

	// -------------------------------------------------------------------------
	// Configuration
	// -------------------------------------------------------------------------

	/** Write the global configuration file. */
	writeGlobalConfig(config: unknown): void {
		writeFileSync(join(this.agentDir, 'pi-herdr-enhanced.json'), JSON.stringify(config, null, 2));
	}

	/** Write a file under this host's temporary directory, creating its parents. */
	writeFile(path: string, body: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	}

	/** Write the project configuration file. */
	writeProjectConfig(config: unknown): void {
		const dir = join(this.project, '.agents', 'pi-herdr-enhanced');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	/**
	 * Create a workspace of our own and put the process into the state a spawned
	 * session begins in.
	 *
	 * Separate from `launch()` so a scenario can create a Job window inside this
	 * workspace and seed it before the watcher starts.
	 */
	async open(): Promise<void> {
		this.workspace = (await createWorkspace(`e2e-${this.options.name}`, this.project)).workspace;

		this.savedEnv = {};
		this.setEnv('PI_CODING_AGENT_DIR', this.agentDir);
		this.setEnv('PI_HERDR_ENHANCED_STATE', this.stateDir);
		this.setEnv('PI_HERDR_ENHANCED_SCOPE', this.root);
		this.setEnv('HERDR_WORKSPACE_ID', this.workspace);

		if (this.options.globalWorktreeLocked === true || this.options.retentionCap !== undefined || this.options.debounceMs !== undefined || this.options.tickMs !== undefined) {
			this.writeGlobalConfig({
				...(this.options.globalWorktreeLocked === true ? { worktree: { enabled: false } } : {}),
				...(this.options.retentionCap !== undefined ? { retention: { max_finished_windows: this.options.retentionCap } } : {}),
				...(this.options.debounceMs !== undefined || this.options.tickMs !== undefined
					? { watch: { ...(this.options.tickMs !== undefined ? { tick_ms: this.options.tickMs } : {}), ...(this.options.debounceMs !== undefined ? { debounce_ms: this.options.debounceMs } : {}) } }
					: {}),
			});
		}
		if (this.options.projectWorktreeLocked === true) {
			this.writeProjectConfig({ worktree: { enabled: false } });
		}

		if (this.options.capability) {
			this.savedArgv = [...process.argv];
			process.argv.push(`--${CAPABILITY_FLAG}`, encodeCapability(this.options.capability));
		}
		this.savedCwd = process.cwd();
		process.chdir(this.project);
	}

	/**
	 * Load the shipped extension and start a session.
	 *
	 * Order matters and mirrors Pi: the environment and argv are set first (a
	 * Worker learns its identity from the spawn flag), the extension factory runs
	 * second, and `session_start` third — because that is the first moment
	 * configuration, the run scope and the watch are established.
	 */
	async launch(): Promise<void> {
		if (this.seedJobs.length > 0) {
			this.appendEntry(WATCH_ENTRY_TYPE, { jobs: this.seedJobs, deliveries: [], armed: false } satisfies WatchState);
		}

		const module = (await import('../../index.ts')) as { default: (pi: ExtensionAPI) => void };
		module.default(this.pi());
		this.started = true;
		await this.emit('session_start', {});
	}

	/** Open the workspace and launch the extension in it. */
	async start(): Promise<void> {
		await this.open();
		await this.launch();
	}

	/** Stop the session, close the workspace, and put the process back as it was. */
	async stop(): Promise<void> {
		try {
			if (this.started) await this.emit('session_shutdown', {});
		} catch {
			// A shutdown that throws must not hide the scenario's own failure.
		}
		if (process.cwd() === this.project) process.chdir(this.savedCwd);
		for (const [key, value] of Object.entries(this.savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (this.savedArgv.length > 0) process.argv.splice(0, process.argv.length, ...this.savedArgv);
		if (this.workspace.length > 0) {
			try {
				// A teardown owns the whole group: a worktree Job the scenario left open
				// is this host's own window, not another session's.
				await closeWorkspace(this.workspace, { group: true });
				// A scenario that leaked a workspace has failed even when its assertions
				// passed: the operator's own Herdr is the shared resource here.
				await waitFor(`workspace ${this.workspace} to disappear`, async () => !(await workspaceAlive(this.workspace)), { timeoutMs: 30_000 });
			} catch (error) {
				throw new Error(`scenario '${this.options.name}' leaked the workspace ${this.workspace}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		rmSync(this.dir, { recursive: true, force: true });
	}

	// -------------------------------------------------------------------------
	// The Pi surface
	// -------------------------------------------------------------------------

	/** The ExtensionAPI this host offers. Cast because Pi's interface is far wider than any extension uses. */
	private pi(): ExtensionAPI {
		const host = this;
		return {
			registerFlag(name: string, options: unknown): void {
				host.flags.set(name, options);
			},
			registerTool(spec: unknown): void {
				const tool = spec as RegisteredTool;
				host.tools.set(tool.name, tool);
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
				const existing = host.handlers.get(event) ?? [];
				existing.push(handler);
				host.handlers.set(event, existing);
			},
			appendEntry(customType: string, data?: unknown): void {
				host.appendEntry(customType, data);
			},
			sendMessage(message: unknown, options?: unknown): void {
				const record = message as { customType?: unknown; content?: unknown; display?: unknown; details?: unknown };
				host.messages.push({
					customType: typeof record.customType === 'string' ? record.customType : '',
					content: typeof record.content === 'string' ? record.content : '',
					display: record.display,
					details: record.details,
					options,
					at: Date.now(),
				});
			},
			exec(command: string, args: string[], options?: { readonly cwd?: string; readonly timeout?: number; readonly signal?: AbortSignal }) {
				return run(command, args, {
					...(options?.cwd !== undefined ? { cwd: options.cwd } : { cwd: host.project }),
					// A blocking `herdr agent wait` has no timeout of its own; cap it far
					// beyond any scenario so a leak cannot outlive the run.
					timeout: options?.timeout ?? 600_000,
					...(options?.signal !== undefined ? { signal: options.signal } : {}),
				});
			},
		} as unknown as ExtensionAPI;
	}

	/** Append a session entry and make it readable through `sessionManager.getEntries`. */
	private appendEntry(customType: string, data?: unknown): void {
		this.entryCounter += 1;
		this.entries.push({ id: `e2e-entry-${this.entryCounter}`, type: 'custom', customType, data });
	}

	/** The context a handler or a tool receives. */
	private ctx(): unknown {
		const host = this;
		return {
			sessionManager: {
				getEntries: () => host.entries,
				getBranch: () => host.entries,
				getSessionId: () => host.root,
			},
			ui: {
				notify: (message: string, level: string) => {
					host.notifications.push({ message, level });
				},
			},
			cwd: this.project,
		};
	}

	/** Run every handler for one event, in registration order. */
	async emit(event: string, payload: unknown): Promise<unknown> {
		let last: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			last = await handler(payload, this.ctx());
		}
		return last;
	}

	// -------------------------------------------------------------------------
	// Calling the extension
	// -------------------------------------------------------------------------

	/** True when the extension registered this tool. */
	hasTool(name: string): boolean {
		return this.tools.has(name);
	}

	/** Call one registered tool exactly as Pi would. */
	async call(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		if (!tool) throw new Error(`no tool named '${toolName}' was registered (registered: ${[...this.tools.keys()].join(', ') || 'none'})`);
		return tool.execute(`e2e-call-${toolName}`, params, undefined, undefined, this.ctx());
	}

	/** Call a tool and require that it succeeded, returning its text. */
	async ok(toolName: string, params: Record<string, unknown>): Promise<string> {
		const result = await this.call(toolName, params);
		const body = textOf(result);
		if (result.isError === true) throw new Error(`${toolName} ${String(params.action)} failed: ${body}`);
		return body;
	}

	/** Call a tool and require that it was refused, returning the refusal text. */
	async refused(toolName: string, params: Record<string, unknown>): Promise<string> {
		const result = await this.call(toolName, params);
		if (result.isError !== true) throw new Error(`${toolName} ${String(params.action)} was expected to be refused but returned: ${textOf(result)}`);
		return textOf(result);
	}

	// -------------------------------------------------------------------------
	// Observation
	// -------------------------------------------------------------------------

	/** The watch state as last persisted, which is what a restart would restore. */
	watchState(): WatchState {
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const entry = this.entries[index] as SessionEntry;
			if (entry.customType !== WATCH_ENTRY_TYPE) continue;
			return entry.data as WatchState;
		}
		return { jobs: [], deliveries: [], armed: false };
	}

	/** The Jobs the watch still holds. */
	jobs(): readonly JobRecord[] {
		return this.watchState().jobs;
	}

	/** Open deliveries, which are the Wake news the watch still owes an answer for. */
	openDeliveries(): readonly { readonly id: string; readonly state: string; readonly panes: readonly string[] }[] {
		return this.watchState().deliveries.filter((delivery) => delivery.state !== 'acknowledged');
	}

	/** The last Wake delivered, or `undefined` when none has been. */
	lastWakeIfAny(): { readonly content: string; readonly details: { readonly identities?: readonly string[] } } | undefined {
		const message = this.messages.filter((candidate) => candidate.customType !== '').at(-1);
		if (!message) return undefined;
		return { content: message.content, details: (message.details ?? {}) as never };
	}

	/** The last Wake report delivered through `sendMessage`, decoded from its payload. */
	lastWake(): { readonly content: string; readonly details: { readonly identities?: readonly string[]; readonly reasons?: readonly { readonly id: string; readonly reason: string; readonly panes: readonly string[] }[] } } {
		const message = this.messages.filter((candidate) => candidate.customType !== '').at(-1);
		if (!message) throw new Error('no Wake has been delivered');
		return { content: message.content, details: (message.details ?? {}) as never };
	}

	/** The tabs Herdr currently reports in this host's workspace. */
	tabs(): Promise<readonly { tabId: string; label: string; paneIds: readonly string[] }[]> {
		return tabsIn(this.workspace);
	}

	/** True when Herdr still has this pane. */
	paneAlive(pane: string): Promise<boolean> {
		return paneAlive(pane);
	}

	/** A tab this workspace has never seen. */
	async windowCount(): Promise<number> {
		return (await this.tabs()).length;
	}

	// -------------------------------------------------------------------------
	// The run lifecycle, so a Wake can be consumed or left pending
	// -------------------------------------------------------------------------

	/** A run begins, as `agent_start` reports it. */
	async beginRun(): Promise<void> {
		await this.emit('agent_start', {});
		await this.emit('turn_start', {});
	}

	/**
	 * The delivered Wake enters the transcript.
	 *
	 * Pi hands an interleaved custom message to `message_start` as the message
	 * itself, carrying the `customType` the extension sent it under and the details
	 * it sent with it. That customType plus those identities are exactly how the
	 * watch recognizes that the news it raised has reached a run, so the host builds
	 * the shape from the Wake it actually delivered rather than from a hand-written
	 * one.
	 */
	async messageEnters(message?: unknown): Promise<void> {
		if (message !== undefined) {
			await this.emit('message_start', { message });
			return;
		}
		const last = this.messages.at(-1);
		if (!last) throw new Error('no Wake has been delivered, so none can enter the transcript');
		await this.emit('message_start', {
			message: { type: 'custom', customType: last.customType, content: last.content, display: last.display, details: last.details },
		});
	}

	/** The model finished its response while the run stays live. */
	async endTurn(): Promise<void> {
		await this.emit('turn_end', { message: { stopReason: 'endTurn' } });
	}

	/** The run settled. `aborted` is the difference between an acknowledgement and a retry. */
	async settleRun(aborted = false): Promise<void> {
		await this.emit('agent_end', {});
		await this.emit('agent_settled', { aborted });
	}

	private setEnv(key: string, value: string): void {
		if (!(key in this.savedEnv)) this.savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
}

/** The text a tool result carries. */
export function textOf(result: ToolResult): string {
	return result.content.map((block) => block.text ?? '').join('\n');
}

/**
 * A real tab in this host's workspace running an ordinary process.
 *
 * Used for a Job window that needs no Pi session: the window, the pane and the
 * process are all real Herdr objects, so closing, reading and liveness all take
 * the production path. Only the Worker's Pi session is omitted, and only where
 * the scenario is about the window rather than about the session.
 */
export async function makeTabRunning(host: ExtensionHost, label: string, command = 'sleep 600'): Promise<WindowAddress> {
	const address = await createTab(host.workspace, host.project, label);
	await runInPane(address.pane, command);
	return address;
}
