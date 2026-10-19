/**
 * A fake `herdr` CLI.
 *
 * The lifecycle's whole reason for existing is what it does around Herdr's
 * answers — refusing before a side effect, resuming instead of duplicating,
 * keeping a window whose session failed — so the suite drives those answers
 * directly rather than mocking each call site. Every command this extension
 * issues is modelled, and every side effect a test cares about is observable.
 */

import type { CommandResult, RunCommand } from '../src/herdr.ts';

export interface FakeAgent {
	pane: string;
	name: string;
	status: 'working' | 'idle' | 'done' | 'blocked' | 'unknown';
	session?: string;
}

export interface FakeWorkspace {
	workspace: string;
	label: string;
	tabs: Map<string, { pane: string; label: string }>;
	checkoutPath?: string;
}

export interface FakeHerdrOptions {
	/** Panes that exist but host no recognized agent (a bare shell). */
	readonly shells?: readonly string[];
	/** Make `worktree create` fail with this error code. */
	readonly worktreeCreateError?: { code: string; message: string };
	/** Fail Git's ownership check when `--trust-repository` is absent. */
	readonly dubiousOwnership?: boolean;
	/** Make `git worktree remove` refuse, as a dirty checkout makes it refuse. */
	readonly gitRefusesRemove?: boolean;
	/** Make `agent prompt` fail, as a pane that died between start and submission does. */
	readonly promptFails?: boolean;
	/**
	 * Resolve `agent wait` immediately instead of blocking.
	 *
	 * A real blocking wait is the watch's primary signal, so the default here is to
	 * block forever: a wait that resolved instantly would turn the watch into a
	 * poll loop and make every timing rule untestable.
	 */
	readonly waitsResolveImmediately?: boolean;
	/** Force `workspace close` to report success without removing the row. */
	readonly closeIsSlow?: boolean;
	/**
	 * Make `agent read` refuse scrollback the way Herdr refuses it for a working
	 * agent, pointing at `--source visible`. The rows are still readable that way,
	 * so a reader has to fall back rather than give up.
	 */
	readonly agentNotIdle?: boolean;
}

export class FakeHerdr {
	readonly workspaces = new Map<string, FakeWorkspace>();
	readonly agents = new Map<string, FakeAgent>();
	readonly prompts: { target: string; text: string }[] = [];
	/** Every `agent read`, with the source it asked for. */
	readonly reads: { readonly target: string; readonly source: string }[] = [];
	readonly calls: string[][] = [];
	readonly closed: string[] = [];
	readonly shells: Set<string>;
	worktrees: { path: string; branch: string; openWorkspace?: string }[] = [];
	private counter = 0;
	readonly options: FakeHerdrOptions;
	/** Outstanding blocking waits, so a test can settle one deliberately. */
	private readonly waits = new Map<string, (result: CommandResult) => void>();

	constructor(options: FakeHerdrOptions = {}) {
		this.options = options;
		this.shells = new Set(options.shells ?? []);
	}

	private id(prefix: string): string {
		this.counter += 1;
		return `${prefix}${this.counter}`;
	}

	/** Add a workspace with a root tab/pane, as Herdr's own create would. */
	addWorkspace(label: string, checkoutPath?: string): FakeWorkspace {
		const workspace = this.id('w');
		const tab = `${workspace}:t1`;
		const pane = `${workspace}:p1`;
		const entry: FakeWorkspace = {
			workspace,
			label,
			tabs: new Map([[tab, { pane, label }]]),
			...(checkoutPath ? { checkoutPath } : {}),
		};
		this.workspaces.set(workspace, entry);
		// A workspace's root pane sits at an interactive shell prompt, which is
		// exactly what `agent start` requires.
		this.shells.add(pane);
		return entry;
	}

	/** Make a pane host a recognized agent in the given state. */
	setAgent(pane: string, status: FakeAgent['status'], name = 'pi'): void {
		this.agents.set(pane, { pane, name, status });
	}

	/** Settle a job's outstanding blocking wait, as Herdr does when a pane changes state. */
	settleWait(pane: string): void {
		this.waits.get(pane)?.({ stdout: JSON.stringify({ id: 'x', result: { status: this.agents.get(pane)?.status ?? 'unknown' } }), stderr: '', code: 0 });
	}

	/** Move every remembered agent to a new state, for a settlement or a revival. */
	setAll(status: FakeAgent['status']): void {
		for (const agent of this.agents.values()) agent.status = status;
	}

	/** The `run` seam. */
	readonly run: RunCommand = async (args) => {
		this.calls.push([...args]);
		return this.dispatch([...args]);
	};

	/** The `git` seam. */
	readonly runGit: RunCommand = async (args) => {
		this.calls.push([...args]);
		if (args[0] !== 'git') return this.fail('invalid_args', `unexpected executable ${args[0]}`);
		const sub = args.slice(1);
		if (sub[0] === '-C') {
			// git -C <repo> worktree remove <path> [--force]
			if (sub[2] === 'worktree' && sub[3] === 'remove') {
				if (this.options.gitRefusesRemove && !sub.includes('--force')) {
					return { stdout: '', stderr: 'fatal: working tree is dirty', code: 1 };
				}
				return { stdout: '', stderr: '', code: 0 };
			}
		}
		return { stdout: '', stderr: '', code: 0 };
	};

	private ok(result: unknown): CommandResult {
		return { stdout: JSON.stringify({ id: 'cli:test', result }), stderr: '', code: 0 };
	}

	/** A failure the way herdr actually produces one: envelope on stderr, exit 1, empty stdout. */
	private fail(code: string, message: string): CommandResult {
		return { stdout: '', stderr: JSON.stringify({ error: { code, message }, id: 'cli:test' }), code: 1 };
	}

	private dispatch(args: string[]): CommandResult | Promise<CommandResult> {
		const [group, command] = args;
		if (group === 'agent') {
			if (command === 'list') {
				return this.ok({ agents: [...this.agents.values()].map((agent) => ({ pane_id: agent.pane, agent_status: agent.status, workspace_id: agent.pane.split(':')[0], tab_id: agent.pane.split(':')[0] + ':t1' })) });
			}
			if (command === 'get') {
				const pane = args[2] ?? '';
				const agent = this.agents.get(pane);
				if (!agent) {
					// Herdr distinguishes a pane that is gone from one that simply hosts no
					// agent it recognizes: the second is the normal answer for a pane whose
					// session exited, and the pane is still there to be read and restarted.
					if (!this.shells.has(pane)) return this.fail('pane_not_found', `pane ${pane} not found`);
					return this.fail('agent_not_found', `agent target ${pane} not found`);
				}
				return this.ok({ pane_id: agent.pane, agent_status: agent.status });
			}
			if (command === 'start') {
				const pane = args[args.indexOf('--pane') + 1] ?? '';
				if (!this.shells.has(pane) && !this.agents.has(pane)) return this.fail('pane_not_found', `pane ${pane} not found`);
				const sep = args.indexOf('--');
				this.agents.set(pane, { pane, name: args[2] ?? 'pi', status: 'working' });
				return this.ok({ type: 'ok', args: sep >= 0 ? args.slice(sep + 1) : [] });
			}
			if (command === 'prompt') {
				const target = args[2] ?? '';
				// Herdr resolves either a live agent name or the pane hosting it.
				const pane = this.agents.has(target) ? target : [...this.agents.values()].find((agent) => agent.name === target)?.pane;
				if (!pane) return this.fail('pane_not_found', `agent ${target} not found`);
				if (this.options.promptFails) return this.fail('agent_not_ready', 'the agent is not at an interactive prompt');
				this.prompts.push({ target: pane, text: args[3] ?? '' });
				return this.ok({ type: 'ok' });
			}
			if (command === 'read') {
				const source = args[args.indexOf('--source') + 1] ?? 'recent-unwrapped';
				this.reads.push({ target: args[2] ?? '', source });
				// Real Herdr prints the pane's rows on stdout, and only a *failure* is a
				// JSON envelope. Reading it as an envelope makes every successful read
				// look like a parse error whose message is the screen itself.
				if (this.options.agentNotIdle && source !== 'visible') {
					return this.fail('agent_not_idle', `cannot read while ${args[2] ?? ''} is working: its alternate-screen history can only be captured by scrolling while idle. Wait and retry, or use --source visible`);
				}
				// Herdr reads *through* the agent in the pane: a pane with no session has
				// nothing to read through, however many rows it has.
				if (!this.agents.has(args[2] ?? '')) {
					return this.fail('agent_not_found', `agent target ${args[2] ?? ''} not found`);
				}
				return { stdout: 'worker output\n', stderr: '', code: 0 };
			}
			if (command === 'wait') {
				const pane = args[2] ?? '';
				if (this.options.waitsResolveImmediately) return this.ok({ status: this.agents.get(pane)?.status ?? 'unknown' });
				return new Promise<CommandResult>((resolve) => {
					this.waits.set(pane, (result: CommandResult) => {
						this.waits.delete(pane);
						resolve(result);
					});
				});
			}
		}
		if (group === 'tab') {
			if (command === 'create') {
				const workspaceId = args[args.indexOf('--workspace') + 1] ?? '';
				const workspace = this.workspaces.get(workspaceId);
				if (!workspace) return this.fail('workspace_not_found', `workspace ${workspaceId} not found`);
				const tab = this.id(`${workspaceId}:t`);
				const pane = this.id(`${workspaceId}:p`);
				workspace.tabs.set(tab, { pane, label: args[args.indexOf('--label') + 1] ?? '' });
				this.shells.add(pane);
				return this.ok({ tab: { tab_id: tab }, root_pane: { pane_id: pane } });
			}
			if (command === 'rename') return this.ok({ type: 'ok' });
			if (command === 'close') {
				this.closed.push(args[2] ?? '');
				return this.ok({ type: 'ok' });
			}
		}
		if (group === 'workspace') {
			if (command === 'list') {
				return this.ok({
					workspaces: [...this.workspaces.values()].map((workspace) => ({
						workspace_id: workspace.workspace,
						label: workspace.label,
						...(workspace.checkoutPath ? { worktree: { checkout_path: workspace.checkoutPath } } : {}),
					})),
				});
			}
			if (command === 'close') {
				const id = args[2] ?? '';
				if (!this.workspaces.has(id)) return this.fail('workspace_not_found', `workspace ${id} not found`);
				this.closed.push(id);
				if (!this.options.closeIsSlow) this.workspaces.delete(id);
				return this.ok({ type: 'ok' });
			}
		}
		if (group === 'worktree') {
			if (command === 'list') {
				return this.ok({
					source: { repo_root: '/repo', repo_name: 'repo' },
					worktrees: this.worktrees.map((entry) => ({
						path: entry.path,
						branch: entry.branch,
						is_linked_worktree: true,
						...(entry.openWorkspace ? { open_workspace_id: entry.openWorkspace } : {}),
					})),
				});
			}
			if (command === 'create') {
				if (this.options.dubiousOwnership && !args.includes('--trust-repository')) {
					return this.fail('git_failed', 'fatal: detected dubious ownership in repository at /repo');
				}
				if (this.options.worktreeCreateError) return this.fail(this.options.worktreeCreateError.code, this.options.worktreeCreateError.message);
				const branch = args[args.indexOf('--branch') + 1] ?? 'main';
				const path = args.indexOf('--path') >= 0 ? (args[args.indexOf('--path') + 1] ?? '') : `/worktrees/repo/${branch}`;
				const workspace = this.addWorkspace(args[args.indexOf('--label') + 1] ?? branch, path);
				this.worktrees.push({ path, branch, openWorkspace: workspace.workspace });
				return this.ok({ workspace: { workspace_id: workspace.workspace }, tab: { tab_id: `${workspace.workspace}:t1` }, root_pane: { pane_id: `${workspace.workspace}:p1` } });
			}
			if (command === 'open') {
				const path = args[args.indexOf('--path') + 1] ?? '';
				const existing = this.worktrees.find((entry) => entry.path === path);
				const workspace = existing ? this.workspaces.get(existing.openWorkspace ?? '') : undefined;
				const target = workspace ?? this.addWorkspace(args[args.indexOf('--label') + 1] ?? path, path);
				if (!existing) this.worktrees.push({ path, branch: '', openWorkspace: target.workspace });
				return this.ok({
					workspace: { workspace_id: target.workspace },
					tab: { tab_id: `${target.workspace}:t1` },
					root_pane: { pane_id: `${target.workspace}:p1` },
					already_open: workspace !== undefined,
				});
			}
		}
		if (group === 'pane' && command === 'read') {
			// `pane read` prints rows as plain text, like `agent read`, and reaches a
			// pane whatever is (or is not) running in it.
			const pane = args[2] ?? '';
			const exists = this.agents.has(pane) || this.shells.has(pane);
			if (!exists) return this.fail('pane_not_found', `pane ${pane} not found`);
			this.reads.push({ target: pane, source: args[args.indexOf('--source') + 1] ?? 'visible' });
			return { stdout: 'pane rows\n', stderr: '', code: 0 };
		}
		if (group === 'pane' && command === 'get') {
			const pane = args[2] ?? '';
			const exists = this.agents.has(pane) || this.shells.has(pane);
			if (!exists) return this.fail('pane_not_found', `pane ${pane} not found`);
			return this.ok({ pane_id: pane });
		}
		return this.fail('unknown_command', `${args.join(' ')}`);
	}
}
