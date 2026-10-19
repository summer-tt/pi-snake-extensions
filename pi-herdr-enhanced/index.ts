/**
 * pi-herdr-enhanced — Job dispatch and a Job watch on top of the `herdr` CLI.
 *
 *   job         open / complete / close / retain / reclaim / status / read / steer
 *   job_watch   status / wake / dismiss / hold / release
 *
 * The extension is the Orchestrator's hands and its alarm clock, and it owns
 * everything between "this task needs a Job" and "that Job is finished", so the
 * caller never describes Herdr for its own work.
 *
 * Three things here are worth knowing before reading the tools:
 *
 *   **Opening registers before it starts.** A window that exists but whose Pi
 *   session failed to start is still an addressable Job — `job status` lists it
 *   and a repeated open resumes it. The alternative, rolling the window back,
 *   leaves an orphan that nothing can address.
 *
 *   **The capability rides the spawn, not the prompt.** A Worker learns which Job
 *   it is from a launch flag this extension registers; the model is never taught
 *   the transport, and a session without a capability is an Orchestrator by
 *   definition. That single fact is what makes the Worker-only refusals safe.
 *
 *   **The watch wakes; it never concludes.** A Wake names Herdr's states and the
 *   Orchestrator reads the pane. Everything the watch does is built so a Wake is
 *   delivered exactly when it is still interesting, and acknowledged only when a
 *   run actually consumed it.
 */

import { hostname } from 'node:os';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { makeSessionCapability, CAPABILITY_FLAG, newCapability, type JobCapability } from './src/capability.ts';
import { defaultStateDir, resolveConfig, spoolDirFor, DEFAULT_CONFIG, type ResolvedConfig } from './src/config.ts';
import { herdrAvailable, paneExists, workspaceList, type RunCommand } from './src/herdr.ts';
import { errorText, now as clock, opaqueId, positiveMs } from './src/ids.ts';
import {
	closeWindow,
	openJob,
	readJob,
	reclaimWorktree,
	resolveTaskSource,
	steerJob,
	type JobDeps,
	type OpenSpec,
} from './src/job.ts';
import { claimFamily, claimGeneration, claimLiveness, classifyWindowOwnership, familyScope, familyScopes, getProcessStartTime, isOwnEarlierIncarnation, removeOwner, restoreScopeChain, scopeClaimant, SCOPE_ENTRY_TYPE, type Claimant, type FamilyClaimant, type TakeoverSpec } from './src/ownership.ts';
import { findJob, removePanes, restoreWatch, retainPanes, retainedJobs, type WatchState } from './src/registry.ts';
import { ensureSpool, verifySpool, writeClaim, writeProgress } from './src/spool.ts';
import { Watch, type WatchHost } from './src/watch.ts';
import { describeWake, makeWake, WAKE_CUSTOM_TYPE } from './src/wake.ts';
import { WATCH_ENTRY_TYPE } from './src/registry.ts';

/** A tool result in the shape Pi expects. */
interface ToolResult {
	content: { type: 'text'; text: string }[];
	details: unknown;
	isError?: boolean;
}

const text = (message: string, isError = false): ToolResult => ({
	content: [{ type: 'text', text: message }],
	details: undefined,
	...(isError ? { isError: true } : {}),
});

/** A non-empty string parameter, or `undefined`. */
function param(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** The takeover evidence a call supplied, if any. */
function takeoverFrom(params: Record<string, unknown>): TakeoverSpec | undefined {
	if (params.takeover !== true) return undefined;
	return {
		takeover: true,
		...(param(params, 'expectedOwner') ? { expectedOwner: param(params, 'expectedOwner') } : {}),
		...(typeof params.expectedGeneration === 'number' ? { expectedGeneration: params.expectedGeneration } : {}),
	};
}

const JOB_PARAMETERS = {
	type: 'object',
	required: ['action'],
	properties: {
		action: { type: 'string', enum: ['open', 'complete', 'close', 'retain', 'reclaim', 'status', 'read', 'steer'] },
		name: { type: 'string', description: 'Job name, for example fix-142-conflicts. Also the Job\'s identity for resume: re-opening the same name returns to the same window.' },
		ticket: { type: 'string', description: 'Ticket or scope reference, for example #142.' },
		prompt: { type: 'string', description: 'The bounded task text. Exactly one of prompt or file is required.' },
		file: { type: 'string', description: 'A task file. Relative paths resolve against the Job checkout. Exactly one of prompt or file is required.' },
		model: { type: 'string', description: 'Pi model id for the Worker.' },
		thinking: { type: 'string', description: 'Pi thinking level for the Worker.' },
		cwd: { type: 'string', description: 'Where a non-worktree Job works. Defaults to the current project directory.' },
		worktree: { type: 'boolean', description: 'Create a branch worktree for this Job (default false). Requires repo, branch and base. A configuration may lock this off; a locked call is refused, never downgraded.' },
		repo: { type: 'string', description: 'For worktree: the PRIMARY checkout of the repository. A linked worktree is refused — omit it and the repository root is resolved from Herdr.' },
		branch: { type: 'string', description: 'For worktree: the branch the Job works on.' },
		base: { type: 'string', description: 'For worktree: the commit or branch the Job branch derives from.' },
		path: { type: 'string', description: 'For worktree: an explicit checkout path. Omit it to use the configured worktree root, whose default is Herdr\'s own worktrees directory.' },
		trustRepository: { type: 'boolean', description: 'Pass --trust-repository for this call only, to get past Git refusing a repository owned by another user. Only set it after you have verified the repository; this extension never does it on its own and never changes your Git configuration.' },
		force: { type: 'boolean', description: 'For reclaim: pass --force to git worktree remove, for a dirty checkout. Prefer inspecting the checkout over forcing it.' },
		target: { type: 'string', description: 'Job name, pane id, workspace id or tab id for read and steer.' },
		message: { type: 'string', description: 'Message for steer.' },
		workspace: { type: 'string', description: 'Workspace id or Job name for close.' },
		panes: { type: 'array', items: { type: 'string' }, description: 'Pane, workspace or Job names for retain.' },
		keep: { type: 'number', description: 'Retention cap for retain. Omit it and the configured retention.max_finished_windows applies, closing the oldest Retained window beyond it.' },
		reason: { type: 'string', description: 'Why an unfinished Job should end. Required to close a Job that neither declared completion nor is Retained.' },
		stallThresholdMs: { type: 'number', description: 'Per-Job suspected-stall threshold. Omit for the configured default.' },
		lines: { type: 'number', description: 'Lines to read for read.' },
		scope: { type: 'string', description: 'Run scope to inspect; "all" for wider inspection.' },
		wider: { type: 'boolean', description: 'Inspect every Job window on this host, across Run scopes.' },
		takeover: { type: 'boolean', description: 'Take over a scope or window owned by another live Orchestrator. Requires expectedOwner and expectedGeneration.' },
		expectedOwner: { type: 'string', description: 'The recorded owner a takeover must match exactly.' },
		expectedGeneration: { type: 'number', description: 'The recorded generation a takeover must match exactly.' },
	},
} as const;

const WATCH_PARAMETERS = {
	type: 'object',
	required: ['action'],
	properties: {
		action: { type: 'string', enum: ['status', 'wake', 'dismiss', 'hold', 'release'] },
		panes: {
			type: 'array',
			items: { type: 'string' },
			description: 'Pane, workspace or Job names to dismiss, hold or release.',
		},
		note: { type: 'string', description: 'For hold: why the Job is waiting on a human.' },
		timeoutMs: { type: 'number', description: 'For hold: how long to suppress ordinary Wake decisions. Defaults to thirty minutes.' },
		scope: { type: 'string', description: 'Run scope to inspect; "all" for wider inspection.' },
		wider: { type: 'boolean', description: 'Inspect every Job window on this host, across Run scopes.' },
	},
} as const;

/** The default hold duration: long enough for a human answer, short enough to be a bounded wait. */
const DEFAULT_HOLD_MS = 30 * 60_000;

export default function (pi: ExtensionAPI): void {
	if (!herdrAvailable()) return;

	// The reserved spawn flag a Worker's Pi launch carries. Registering it is what
	// makes Pi's argument parser accept it; the value is read back from the
	// Worker's own argv on first use.
	pi.registerFlag(CAPABILITY_FLAG, {
		description: 'pi-herdr-enhanced Job capability delivered at spawn time (opaque)',
		type: 'string',
	});

	// The extension context is only available inside handlers; the wake path and
	// the tools both need the most recent one.
	let context: any;
	let watch: Watch;
	let config: ResolvedConfig = DEFAULT_CONFIG;
	let stateDir = '';
	/** The family root: the session id, or the explicit `PI_HERDR_ENHANCED_SCOPE` override. */
	let root = '';
	let spoolPath = '';
	let family: FamilyClaimant;
	let claimant: Claimant;
	let generation = 1;
	/** Every scope this session holds, so a window opened by a dead incarnation is still disposable. */
	const held = new Map<string, number>();
	/** The scopes this session held last, primary first, read from its own branch at startup. */
	let chain: readonly string[] = [];
	// Not authorized until a claim has been made: holding the scope is something this
	// session establishes, not something it starts out with.
	let authorized = false;
	let authorizationReason: string | undefined;
	let worker = false;
	/**
	 * Whether this session has taken its place in the run scope family yet.
	 *
	 * The claim is made at the first *mutation*, not at session start. A session
	 * that only reads or reports has nothing to fence, and claiming on its behalf
	 * would write to the family's ledgers — and make a concurrent incarnation of the
	 * same session derive an unnecessary scope — for a session that never dispatches
	 * anything.
	 */
	let claimed = false;

	const runHerdr: RunCommand = async (args, options) => {
		const result = await pi.exec('herdr', [...args], options);
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};

	/** Git calls. Arguments already begin with `git`. */
	const runGit: RunCommand = async (args) => {
		const result = await pi.exec(args[0] ?? 'git', [...args.slice(1)]);
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};

	const sessionCapability = makeSessionCapability((customType, data) => pi.appendEntry(customType, data));

	const notify = (message: string, level: 'info' | 'warning' | 'error'): void => {
		try {
			context?.ui?.notify?.(message, level);
		} catch {
			// Notification is best-effort; no lifecycle step may depend on it.
		}
	};

	function jobDeps(): JobDeps {
		return {
			run: runHerdr,
			runGit,
			config,
			stateDir,
			claimant,
			generation,
			clock,
			...(typeof process.env.HERDR_WORKSPACE_ID === 'string' ? { workspaceId: process.env.HERDR_WORKSPACE_ID } : {}),
		};
	}

	function persist(state: WatchState): void {
		pi.appendEntry(WATCH_ENTRY_TYPE, state);
	}

	const host: WatchHost = {
		persist,
		inject: (report) => {
			pi.sendMessage(
				{
					customType: WAKE_CUSTOM_TYPE,
					content: report.text,
					display: true,
					details: {
						identities: report.causes.map((cause) => cause.id),
						reasons: report.causes.map((cause) => ({ id: cause.id, reason: cause.reason, panes: cause.panes })),
					},
				},
				{ triggerTurn: true, deliverAs: 'followUp' },
			);
		},
		notify,
		close: async (job) => {
			await closeWindow(jobDeps(), job);
			watch.forget([job.pane]);
		},
	};

	watch = new Watch(host, { run: runHerdr, config, spoolPath: '' });

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	pi.on('session_start', (_event: unknown, ctx: any) => {
		context = ctx;
		// pi's own agent directory, so configuration and state live beside every
		// other pi extension's rather than in whatever checkout the session happens
		// to be in.
		const agentDir = getAgentDir();
		const project = process.cwd();
		config = resolveConfig({ project, agentDir });
		for (const diagnostic of config.diagnostics) notify(diagnostic, 'warning');

		stateDir = defaultStateDir(agentDir);
		// The family root: the session id, or an explicit override for sessions that
		// deliberately share one run scope. `PI_SESSION_ID` is not usable here — Pi only
		// injects it into shell tools, never into the extension process — so the session
		// id is read from the session manager.
		const sessionId = typeof ctx?.sessionManager?.getSessionId === 'function' ? ctx.sessionManager.getSessionId() : undefined;
		root =
			(process.env.PI_HERDR_ENHANCED_SCOPE !== undefined && process.env.PI_HERDR_ENHANCED_SCOPE.trim().length > 0
				? process.env.PI_HERDR_ENHANCED_SCOPE.trim()
				: undefined) ?? sessionId ?? `orchestrator-${process.pid}`;
		spoolPath = spoolDirFor(stateDir, root);
		// One `ps` call, at startup: without it a recycled PID could be mistaken for
		// the previous owner of this scope, and a handoff would look like a takeover.
		const startTime = getProcessStartTime(process.pid);

		family = {
			root,
			// The orchestrator is the family root, not the PID: every incarnation of one
			// session is the same family, and the nonce/pid/startTime are what tell two
			// concurrent incarnations apart.
			orchestrator: root,
			project,
			pid: process.pid,
			host: hostname(),
			// Recorded so a later session can tell a live owner from a recycled PID,
			// which is the difference between a handoff and a takeover.
			...(startTime !== undefined ? { startTime } : {}),
			nonce: opaqueId('inc-'),
		};
		// Provisional until the first mutation picks the incarnation; `#0` is the primary.
		claimant = scopeClaimant(family, familyScope(root, 0));
		held.clear();
		chain = [];

		const claim = sessionCapability(ctx);
		if (claim) {
			worker = true;
			// A dispatched Worker owns no run scope. It dispatches nothing, and it ends its
			// own Job only by declaring completion, so it has nothing to fence. Claiming
			// a scope here would be worse than pointless: a Worker reads the scope from
			// its own environment, not from the capability, so it would claim whatever
			// family its terminal happened to be in — including the Orchestrator's own —
			// and put itself in front of the session that launched it.
			generation = 1;
			authorized = false;
			claimed = false;
			authorizationReason = `this session is the dispatched Worker ${claim.name} (${claim.ticket})`;
		} else {
			// A resumed session reads back the scope it held from its own branch, not from
			// the file's union of branches: two concurrent incarnations of one session
			// diverge, and each must find its own place again.
			const branch = typeof ctx?.sessionManager?.getBranch === 'function' ? ctx.sessionManager.getBranch() : [];
			chain = restoreScopeChain(Array.isArray(branch) ? branch : [], root);
		}

		// Restore the run scope from the session's own entries. A resumed session
		// learns which Jobs it was watching; a fresh one starts empty, and an empty
		// watch is reported rather than assumed to be the same as "nothing open".
		const entries = typeof ctx?.sessionManager?.getEntries === 'function' ? ctx.sessionManager.getEntries() : [];
		watch = new Watch(host, { run: runHerdr, config, spoolPath });
		watch.restore(restoreWatch(entries));

		if (watch.openJobs.length > 0) {
			notify(`Job watch restored with ${watch.openJobs.length} open Job(s).`, 'info');
		}
		watch.start();
	});

	pi.on('session_shutdown', () => watch.stop());

	// -------------------------------------------------------------------------
	// Wake delivery and acknowledgement
	// -------------------------------------------------------------------------

	pi.on('agent_start', () => {
		watch.startRun();
		watch.startTurn();
	});
	pi.on('turn_start', () => watch.startTurn());
	pi.on('turn_end', (event: any) => {
		watch.noteTurnOutcome(event?.outcome);
		watch.endTurn({ modelFinished: turnFinished(event) });
	});
	pi.on('agent_end', () => watch.endTurn());
	pi.on('message_start', (event: any) => watch.observeWakeMessage(event?.message));
	pi.on('agent_settled', (event: any) => {
		watch.onAgentSettled(event?.aborted === true);
		watch.endRun();
	});

	// -------------------------------------------------------------------------
	// The progress producer
	// -------------------------------------------------------------------------

	/**
	 * A Worker records *that* it was active, and nothing else.
	 *
	 * Four signals count: nonempty assistant output, a tool execution start,
	 * credible streaming tool output, and a tool result. Each writes one
	 * timestamp-only file through the session's own capability, so activity never
	 * leaves the session as content and one Worker can never update another Job.
	 * An Orchestrator session has no capability and therefore never writes.
	 */
	let lastProgressWrite = 0;
	const noteActivity = (ctx: any): void => {
		const capability = sessionCapability(ctx);
		if (!capability) return;
		const at = clock();
		if (at - lastProgressWrite < 5_000) return;
		lastProgressWrite = at;
		try {
			verifySpool(capability.spoolPath);
			writeProgress(capability.spoolPath, { name: capability.name, ticket: capability.ticket, token: capability.token, observedAt: at });
		} catch {
			// A progress write is best-effort evidence; a failure is not a Job failure.
		}
	};

	pi.on('message_update', (event: any, ctx: any) => {
		const update = event?.assistantMessageEvent;
		if (!update) return;
		const nonempty =
			(update.type === 'text_delta' && typeof update.delta === 'string' && update.delta.trim().length > 0) ||
			(update.type === 'text_end' && typeof update.content === 'string' && update.content.trim().length > 0);
		if (nonempty) noteActivity(ctx);
	});
	pi.on('tool_execution_start', (_event: any, ctx: any) => noteActivity(ctx));
	pi.on('tool_execution_update', (event: any, ctx: any) => {
		if (credible(event?.partialResult)) noteActivity(ctx);
	});
	pi.on('tool_execution_end', (_event: any, ctx: any) => noteActivity(ctx));

	// -------------------------------------------------------------------------
	// The Job tool
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: 'job',
		label: 'Job',
		description:
			'Open one bounded Job and inspect or end it later: a Herdr window, a Pi Worker, and a task prompt in one call. Inside a dispatched Worker session, `complete` declares the Job\'s bounded work concluded.',
		promptSnippet: 'Open, inspect and end one Job without touching Herdr directly',
		promptGuidelines: [
			'Use job instead of herdr_layout, herdr_pane or herdr_agent for anything you dispatch. job open establishes the window, starts the Worker and submits the prompt together, and job_watch replaces a blocking wait on each Worker. Reserve the herdr_* tools for one-off pane or terminal work outside a Job lifecycle.',
			'job open defaults to a tab in your own Herdr workspace (worktree: false). Pass worktree: true with repo, branch and base only when the Job genuinely needs an isolated branch; a configuration may lock that off, in which case the call is refused rather than downgraded.',
			'job open and job complete are Worker-only in one direction: a dispatched Worker concludes with `job complete` and never closes or retains a window, because ending the window it runs in strands the watch. An Orchestrator ends Jobs with job close or job retain.',
			'job open resumes instead of duplicating: repeating the same Job name returns to the window that already exists — a live session is left alone or continued, a pane whose session died is restarted in place, and only a pane confirmed gone earns a replacement. Do not open a second window to work around a Job that looks stuck; read or steer it.',
			'A failed open still registers its window. job status lists it and repeating the open resumes it in place. Only job close discards it.',
			'job status is the single view of the open set. Read a pane with job read before concluding anything: a Wake or a status line reports Herdr\'s classification, which cannot tell a Job that finished in a second from one that never launched.',
			'Use job retain on a Job whose work you have captured, instead of closing it: the window stays readable while it leaves the watch entirely, bounded by the configured retention cap. Use job close for a Job that should end outright — an unfinished Job needs a reason.',
			'Use job reclaim once a worktree Job\'s branch is integrated, passing repo and path. It removes the checkout through Git, which refuses a dirty one, and closes the worktree rows it leaves behind.',
			'Use job read or job steer to inspect or redirect one Job.',
		],
		parameters: JOB_PARAMETERS,
		async execute(_id: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: any): Promise<ToolResult> {
			if (ctx) context = ctx;
			try {
				switch (params.action) {
					case 'open':
						return text(await handleOpen(params, ctx));
					case 'complete':
						return text(await handleComplete(ctx));
					case 'close':
						return text(await handleClose(params, ctx));
					case 'retain':
						return text(await handleRetain(params, ctx));
					case 'reclaim':
						return text(await handleReclaim(params, ctx));
					case 'status':
						return text(await handleStatus(params));
					case 'read': {
						const target = param(params, 'target');
						if (!target) return text('read requires target', true);
						const job = findJob(watch.watchState, target);
						if (!job) return text(noSuchJob(target), true);
						const lines = typeof params.lines === 'number' ? params.lines : 120;
						return text(await readJob(jobDeps(), job, lines));
					}
					case 'steer': {
						const target = param(params, 'target');
						const message = param(params, 'message');
						if (!target || !message) return text('steer requires target and message', true);
						const job = findJob(watch.watchState, target);
						if (!job) return text(noSuchJob(target), true);
						await requireAuthorized(params, target, job.scope);
						await authorizeWindow(job, `steer '${job.name}'`, takeoverFrom(params));
						return text(await steerJob(jobDeps(), job, message));
					}
					default:
						return text(`Unknown action: ${String(params.action)}`, true);
				}
			} catch (error) {
				return text(errorText(error), true);
			}
		},
	});

	/**
	 * Open, or resume, one Job.
	 *
	 * Parameter validation happens before any side effect: a `worktree: true`
	 * request under a lock, both or neither task sources, a bad stall threshold, and
	 * a missing placement input all fail with nothing created.
	 */
	async function handleOpen(params: Record<string, unknown>, ctx: any): Promise<string> {
		const name = param(params, 'name');
		const ticket = param(params, 'ticket');
		if (!name) throw new Error('open requires name');
		if (!ticket) throw new Error('open requires ticket');

		const worktree = params.worktree === true;
		if (worktree && !config.worktreeEnabled) {
			throw new Error(
				'Refusing to open with worktree: true — worktree placement is locked off by configuration (worktree.enabled: false). ' +
					'Nothing was provisioned. Remove that setting to allow branch worktrees, or call without worktree to place the Job in a tab.',
			);
		}
		const stallThresholdMs = positiveMs(params.stallThresholdMs);
		if (params.stallThresholdMs !== undefined && stallThresholdMs === undefined) {
			throw new Error('stallThresholdMs must be a positive number of milliseconds. Nothing was provisioned.');
		}

		await requireAuthorized(params, `open '${name}'`);

		const cwd = param(params, 'cwd') ?? claimant.project;
		// A worktree Job's task file resolves against the checkout it will work in,
		// which does not exist yet; the repository is the closest honest base.
		const task = resolveTaskSource({ targetCheckout: param(params, 'repo') ?? cwd, ...(param(params, 'prompt') ? { prompt: param(params, 'prompt') } : {}), ...(param(params, 'file') ? { file: param(params, 'file') } : {}) });

		const existing = watch.openJobs.find((candidate) => candidate.name === name);
		const capability: JobCapability =
			existing !== undefined && existing.token.length > 0
				? { name, ticket, token: existing.token, scope: claimant.scope, spoolPath }
				: newCapability({ name, ticket, scope: claimant.scope, spoolPath });

		const spec: OpenSpec = {
			name,
			ticket,
			task,
			capability,
			cwd,
			worktree,
			...(param(params, 'repo') ? { repo: param(params, 'repo') } : {}),
			...(param(params, 'branch') ? { branch: param(params, 'branch') } : {}),
			...(param(params, 'base') ? { base: param(params, 'base') } : {}),
			...(param(params, 'path') ? { path: param(params, 'path') } : {}),
			...(param(params, 'model') ? { model: param(params, 'model') } : {}),
			...(param(params, 'thinking') ? { thinking: param(params, 'thinking') } : {}),
			...(stallThresholdMs !== undefined ? { stallThresholdMs } : {}),
			...(params.trustRepository === true ? { trustRepository: true } : {}),
		};

		// Ensure the spool exists before a Worker could write to it, so the channel is
		// ready at spawn time rather than at first use. A fresh state directory needs
		// creating here: `verifySpool` refuses an absent spool, and a Job cannot be
		// claimed into one that is not there.
		ensureSpool(spoolPath);

		// Enforce the retention cap over finished siblings before adding another:
		// skipping a retain must not leave finished windows unbounded.
		await evictOverCap();

		const outcome = await openJob(jobDeps(), spec, {
			...(existing ? { existing } : {}),
			onEstablished: (job) => watch.register(job),
		});
		// A Job whose window was gone is replaced rather than resumed, and the
		// replacement lands on a new pane. The record of the dead window goes with it,
		// so the watch never holds a phantom Job that nothing can address.
		if (existing !== undefined && existing.pane !== outcome.job.pane) watch.forget([existing.pane]);
		// Re-opening a Job is an explicit statement that it is live work again, so a
		// retention — whose whole purpose was to end its life in the watch — does not
		// survive it. A continued Job running unwatched is exactly what this prevents.
		const revived = existing !== undefined && existing.retention !== 'none';
		// The Job record is authoritative in the watch; keep it in step with what the
		// session actually did.
		watch.patch(outcome.job.pane, revived ? { ...outcome.job, retention: 'none', retainedAt: 0 } : outcome.job);
		notify(`Job ${outcome.job.name} (${outcome.job.ticket}) at ${outcome.job.pane}: ${outcome.ok ? 'open' : 'window only'}`, outcome.ok ? 'info' : 'warning');
		if (!revived) return outcome.text;
		return `${outcome.text}\nThis Job had been Retained; re-opening returned it to the Job watch.`;
	}

	/** A Worker's own declaration that its bounded work is concluded. */
	async function handleComplete(ctx: any): Promise<string> {
		const capability = sessionCapability(ctx);
		if (!capability) {
			return (
				'job complete is a Worker signal: this session carries no Job capability, so there is nothing to declare. ' +
				'It works only inside a dispatched Worker session. An Orchestrator reconciles by reading each pane with `job read`, not by declaring on a Job\'s behalf.'
			);
		}
		try {
			verifySpool(capability.spoolPath);
			writeClaim(capability.spoolPath, {
				name: capability.name,
				ticket: capability.ticket,
				scope: capability.scope,
				token: capability.token,
				claimedAt: clock(),
			});
		} catch (error) {
			return `Could not record the completion claim: ${errorText(error)}. The Job watch still wakes the Orchestrator once this session settles, so the declaration only makes that Wake definite.`;
		}
		return (
			`Recorded the completion claim for ${capability.name} (${capability.ticket}). ` +
			'This requests reconciliation once this session settles; it does not prove success. Continue with your summary — the Job watch wakes the Orchestrator when it is settled, and ending the window is the Orchestrator\'s job.'
		);
	}

	/**
	 * End a Job's window.
	 *
	 * The closure guard: a Job that neither declared completion nor is Retained
	 * needs an explicit reason. The refusal names what is actually known — the
	 * lifecycle observation — so the caller can decide rather than guess.
	 */
	async function handleClose(params: Record<string, unknown>, ctx: any): Promise<string> {
		const capability = sessionCapability(ctx);
		if (capability) {
			throw new Error(
				`Refusing to close: this session is the dispatched Worker ${capability.name} (${capability.ticket}), and the Job lifecycle belongs to the Orchestrator. ` +
				'Closing a Job window from inside a Worker ends the Worker\'s own pane and strands the watch. Conclude by calling `job` with action `complete`.'
			);
		}
		const target = param(params, 'workspace') ?? param(params, 'target') ?? param(params, 'name');
		if (!target) throw new Error('close requires workspace (a workspace id or a Job name)');
		const job = findJob(watch.watchState, target);
		if (!job) throw new Error(noSuchJob(target));
		await requireAuthorized(params, `close '${job.name}'`, job.scope);
		await authorizeWindow(job, `close '${job.name}'`, takeoverFrom(params));

		const reason = param(params, 'reason');
		const finished = job.retention !== 'none' || job.claimedComplete;
		if (!finished && reason === undefined) {
			throw new Error(
				`Refusing to close ${job.name} (${job.ticket}) at ${job.pane}: it neither declared completion nor is Retained, so ending it is an explicit decision. ` +
					`Its observed state is ${job.lastStatus === '' ? 'unobserved' : job.lastStatus}${job.promptFailure ? ` (prompt delivery failed: ${job.promptFailure})` : ''}. ` +
					'Inspect it with `job read` first, then repeat with a `reason` naming why ending it is justified.',
			);
		}
		const closed = await closeWindow(jobDeps(), job);
		watch.forget([job.pane]);
		return `${closed}${reason ? ` Reason recorded: ${reason}` : ''}`;
	}

	/** Keep a finished Job's window open for inspection, out of the watch. */
	async function handleRetain(params: Record<string, unknown>, ctx: any): Promise<string> {
		const capability = sessionCapability(ctx);
		if (capability) {
			throw new Error(
				`Refusing to retain: this session is the dispatched Worker ${capability.name} (${capability.ticket}), and the Job lifecycle belongs to the Orchestrator. ` +
				'Retaining from inside a Worker hides the Job from the watch it is registered in. Conclude by calling `job` with action `complete`.'
			);
		}
		const targets = Array.isArray(params.panes) ? params.panes.filter((pane): pane is string => typeof pane === 'string') : [];
		if (targets.length === 0) throw new Error('retain requires a non-empty panes list');
		const keep = typeof params.keep === 'number' ? params.keep : config.retentionCap;
		const retained: string[] = [];
		const missed: string[] = [];
		for (const target of targets) {
			const job = findJob(watch.watchState, target);
			if (!job) {
				missed.push(target);
				continue;
			}
			await requireAuthorized(params, `retain '${job.name}'`, job.scope);
			await authorizeWindow(job, `retain '${job.name}'`, takeoverFrom(params));
			watch.restore(retainPanes(watch.watchState, [job.pane], 'manual', clock));
			// Retaining *is* the reconciliation a Wake asked for, so the news that named
			// this Job is answered here rather than left to nag the next `job status` and
			// to come back on the retry ladder.
			watch.resolveNews([job.pane]);
			retained.push(job.name);
		}
		const evicted = await evictOverCap(keep);
		const lines: string[] = [];
		if (retained.length > 0) lines.push(`Retained ${retained.join(', ')} for inspection; they no longer affect the Job watch.`);
		if (missed.length > 0) lines.push(`Matched no open Job: ${missed.join(', ')}.`);
		if (evicted.length > 0) lines.push(`The retention cap (${keep}) closed the oldest Retained window(s): ${evicted.join(', ')}.`);
		if (retained.length === 0 && missed.length === 0) lines.push('Nothing retained.');
		return lines.join(' ');
	}

	/** Remove an integrated branch worktree and the rows it left behind. */
	async function handleReclaim(params: Record<string, unknown>, ctx: any): Promise<string> {
		const job = param(params, 'name') ? findJob(watch.watchState, param(params, 'name') as string) : undefined;
		const repo = param(params, 'repo') ?? job?.path;
		const path = param(params, 'path') ?? job?.path;
		if (!repo || !path) throw new Error('reclaim requires repo and path (or the name of an open worktree Job)');
		await requireAuthorized(params, `reclaim '${path}'`, job?.scope);
		if (job) await authorizeWindow(job, `reclaim '${job.name}'`, takeoverFrom(params));
		const result = await reclaimWorktree(jobDeps(), {
			repo,
			path,
			...(params.force === true ? { force: true } : {}),
			...(params.trustRepository === true ? { trustRepository: true } : {}),
		});
		if (job) {
			removeOwner(stateDir, job.pane);
			watch.forget([job.pane]);
		}
		return result;
	}

	/** The whole open set, with Herdr's current observation of each Job. */
	async function handleStatus(params: Record<string, unknown>): Promise<string> {
		const wider = params.wider === true || params.scope === 'all';
		if (!wider) {
			const observations = await observeForStatus();
			const lines = [watch.describe(observations)];
			const note = scopeNote();
			if (note) lines.push('', note);
			return lines.join('\n');
		}
		return widerStatus();
	}

	async function observeForStatus(): Promise<ReadonlyMap<string, { readonly status: any; readonly present?: boolean }>> {
		const map = new Map<string, { readonly status: any; readonly present?: boolean }>();
		try {
			const { agentList } = await import('./src/herdr.ts');
			for (const [pane, agent] of await agentList(runHerdr)) map.set(pane, { status: agent.status });
		} catch {
			// A Herdr outage leaves each Job's last recorded status in place.
		}
		// A pane Herdr no longer has is not the same as one that is merely idle, and
		// `agent list` cannot tell those apart: it omits both. For a read, one extra
		// call is worth it, because a stale status is the difference between "this Job
		// finished" and "its window was closed underneath you".
		const { paneExists } = await import('./src/herdr.ts');
		for (const job of watch.openJobs) {
			if (map.has(job.pane)) continue;
			try {
				if (!(await paneExists(runHerdr, job.pane))) map.set(job.pane, { status: 'unknown', present: false });
			} catch {
				// A pane that cannot be asked about stays reported as it was last seen.
			}
		}
		return map;
	}

	/**
	 * Inspect every Job window on this host, whether or not this session opened it.
	 *
	 * A window is reported with the ownership classification that *authorizes* what
	 * may be done with it: only `current-session` permits a mutation, and `unowned`
	 * is evidence a human reads, never a licence to dispose of someone else's work.
	 */
	async function widerStatus(): Promise<string> {
		const lines: string[] = [];
		let workspaces: readonly Record<string, unknown>[];
		try {
			workspaces = await workspaceList(runHerdr);
		} catch (error) {
			return `Herdr is unavailable, so no Job windows can be inspected: ${errorText(error)}`;
		}
		const { readOwners } = await import('./src/ownership.ts');
		const reported = new Set<string>();
		const recordedWorkspaces = new Set<string>();
		// Every recorded window, one per pane. A pane, not a workspace: `tab` Jobs share
		// the Orchestrator's workspace, so reading one record per workspace hid every Job
		// but the last one opened in it — which is exactly the retained Job an operator
		// comes here to inspect.
		for (const record of readOwners(stateDir)) {
			reported.add(record.pane);
			recordedWorkspaces.add(record.workspace);
			const classification = classifyWindowOwnership({
				pane: record.pane,
				currentOrchestrator: claimant.orchestrator,
				currentScope: claimant.scope,
				currentGeneration: generation,
				stateDir,
				currentScopes: [...held.keys()],
			});
			const known = watch.openJobs.some((job) => job.pane === record.pane);
			lines.push(
				`- ${record.workspace} ${record.pane} '${record.label}' ${record.name} (${record.ticket}) scope ${record.scope} gen ${record.generation} — ${classification.category}${known ? ' (open in this watch)' : ''}`,
			);
			lines.push(`  ${classification.reason}`);
		}
		// A Job this watch still holds is never hidden, record or no record: the watch is
		// evidence in its own right, and `wider` is what a refusal tells the operator to
		// read.
		for (const job of watch.openJobs) {
			if (reported.has(job.pane)) continue;
			reported.add(job.pane);
			recordedWorkspaces.add(job.workspace);
			lines.push(
				`- ${job.workspace} ${job.pane} '${job.label}' ${job.name} (${job.ticket}) scope ${job.scope} gen ${job.generation} — no owner record${job.retention !== 'none' ? ' (retained)' : ''}`,
			);
			lines.push('  this session\'s watch still holds the Job; no readable owner record survives for its window');
		}
		// A workspace that looks like a Job window but has nothing recorded is named
		// rather than skipped: silence would read as "no such window".
		for (const workspace of workspaces) {
			const workspaceId = typeof workspace.workspace_id === 'string' ? workspace.workspace_id : undefined;
			if (!workspaceId || recordedWorkspaces.has(workspaceId)) continue;
			const label = typeof workspace.label === 'string' ? workspace.label : '';
			if (!/\b(Job|worker)\b/i.test(label)) continue;
			lines.push(`- ${workspaceId} '${label}' no owner record — ownership-unknown`);
			lines.push('  no durable owner record exists for this window; the workspace only looks like a Job window');
		}
		return lines.length > 0 ? `Job windows on this host:\n${lines.join('\n')}` : 'No Job windows found on this host.';
	}

	/**
	 * The answer for a target that matches no open Job.
	 *
	 * This is where an operator lands after the Job it wants has already been closed
	 * or dismissed — often by an earlier call of its own — so it names the ways that
	 * happens rather than leaving the caller to guess.
	 */
	function noSuchJob(target: string): string {
		return `No open Job matches '${target}'. It may already have been closed or dismissed, or a different name may be in use; \`job status\` lists the open set.`;
	}

	/**
	 * What the run scope's ledger says about who owns it — reported, never claimed.
	 *
	 * `job status` is a read, so it takes no generation. It is still the information
	 * an operator needs before dispatching, so it is stated here: whether the scope
	 * is unclaimed, ours, another running session's, or left behind by a session that
	 * is gone.
	 */
	function scopeNote(): string | undefined {
		if (worker || claimed) return undefined;
		const familyEntries = familyScopes(stateDir, root);
		if (familyEntries.length === 0) return undefined;
		const live = familyEntries.filter(
			(entry) => entry.latest !== undefined && claimLiveness(entry.latest) === 'observed-live' && !isOwnEarlierIncarnation(entry.latest, family),
		);
		if (live.length === 0) {
			return `Run scope family '${root}' has no live incarnation (${familyEntries.map((entry) => entry.scope).join(', ')}); the first dispatch inherits the oldest one.`;
		}
		const next = familyEntries.reduce((highest, entry) => Math.max(highest, entry.index), -1) + 1;
		return `Run scope family '${root}' has ${live.length} live incarnation(s) (${live.map((entry) => entry.scope).join(', ')}); dispatching takes a new scope '${familyScope(root, next)}'.`;
	}

	/**
	 * Close Retained windows beyond the cap.
	 *
	 * A failure is reported rather than raised: the cap is maintenance, and a window
	 * it could not evict must not fail the operation that triggered the pass.
	 */
	async function evictOverCap(keep = config.retentionCap): Promise<readonly string[]> {
		const state = watch.watchState;
		const retained = retainedJobs(state);
		if (retained.length <= keep) return [];
		const evicted: string[] = [];
		for (const job of retained.slice(0, retained.length - keep)) {
			try {
				await closeWindow(jobDeps(), job);
				watch.forget([job.pane]);
				evicted.push(job.name);
			} catch (error) {
				notify(`Could not close Retained Job ${job.name} at ${job.pane}: ${errorText(error)}. End it with \`job close\`.`, 'warning');
			}
		}
		return evicted;
	}

	/**
	 * Refuse a mutation this session is not authorized to make.
	 *
	 * A call may supply takeover evidence; doing so re-attempts the claim, so the
	 * authority is established from the ledger rather than asserted by the caller.
	 */
	/**
	 * Record this session's place in its scope family, so a resume reads it back.
	 *
	 * Written on the *branch*: two concurrent incarnations of one session file each
	 * append their own entry, and each reads only its own back. The entry is not a
	 * fence — the ledgers are — so a lost write costs a derived incarnation number,
	 * never authority.
	 */
	function persistScope(): void {
		pi.appendEntry(SCOPE_ENTRY_TYPE, {
			root,
			scope: claimant.scope,
			generation,
			held: [...held].map(([scope, value]) => ({ scope, generation: value })),
			at: clock(),
		});
	}

	/**
	 * Refuse a mutation this session is not authorized to make.
	 *
	 * A call may supply takeover evidence; doing so re-attempts the claim, so the
	 * authority is established from the ledger rather than asserted by the caller.
	 *
	 * `windowScope` is the scope of the window a window mutation acts on. Takeover
	 * evidence names the scope the call is *about*, so for those calls it is applied
	 * by `authorizeWindow` instead: spending it here would take over whichever scope
	 * this session happens to lead with and leave the window itself untouchable.
	 */
	async function requireAuthorized(params: Record<string, unknown>, what: string, windowScope?: string): Promise<void> {
		const spec = windowScope === undefined ? takeoverFrom(params) : undefined;
		// A Worker owns no run scope, so there is nothing to claim: its identity comes
		// from the capability it was spawned with, and it may only declare completion.
		if (!worker && (!claimed || spec)) {
			const claim = claimFamily(stateDir, family, spec, clock, {}, chain);
			generation = claim.generation;
			authorized = claim.authorized;
			authorizationReason = claim.reason;
			claimed = claim.authorized;
			if (claim.authorized) {
				for (const member of claim.held) held.set(member.scope, member.generation);
				claimant = scopeClaimant(family, claim.scope);
				// The held map is insertion-ordered with the primary scope first, so it is
				// the chain a resume will read back — including scopes absorbed earlier.
				chain = [...held.keys()];
				persistScope();
				if (claim.inherited) notify(`Took over run scope '${claim.root}' at generation ${claim.generation}. Every incarnation of this session whose process is gone was absorbed.`, 'info');
			}
		}
		if (authorized) return;
		throw new Error(
			`Refusing to ${what}: this session does not own run scope '${root}'. ${authorizationReason ?? 'Ownership evidence is unavailable.'} ` +
				'Set PI_HERDR_ENHANCED_SCOPE to give this session a family of its own.',
		);
	}

	/**
	 * Refuse disposing of a window that belongs to a live incarnation other than this one.
	 *
	 * Every window records the scope it was opened under. A scope this session holds —
	 * its own or an absorbed sibling — is ours to end. A scope that is not held is
	 * re-claimed here: a sibling that has since died is absorbed and its window
	 * becomes disposable, while one that is still running stays untouchable and is
	 * named, never disposed of.
	 */
	async function authorizeWindow(job: { readonly scope: string; readonly pane: string }, what: string, spec?: TakeoverSpec): Promise<void> {
		if (worker) return;
		if (held.has(job.scope)) return;
		// A plain claim first: it succeeds when the ledger already names this session
		// (an earlier `requireAuthorized` in the same call may have taken this very
		// scope) or when the owner is provably gone.
		let claim = claimGeneration(stateDir, scopeClaimant(family, job.scope), undefined, clock);
		// The takeover an operator supplies names the scope the *window* was opened
		// under, which is not necessarily the scope this session leads with: the chain
		// is a session's own history, and a window can predate the incarnation that now
		// holds it. Applying the evidence here is what makes `takeover: true` reach the
		// window instead of being spent on an unrelated sibling.
		if (!claim.authorized && spec?.takeover === true) {
			claim = claimGeneration(stateDir, scopeClaimant(family, job.scope), spec, clock);
		}
		if (claim.authorized) {
			held.set(job.scope, claim.generation);
			chain = [...held.keys()];
			persistScope();
			return;
		}
		throw new Error(
			`Refusing to ${what}: the window ${job.pane} was opened under scope '${job.scope}', which another live incarnation of this session holds. ` +
				`${claim.reason ?? 'Ownership evidence is unavailable.'} Inspect it with \`job status wider: true\`, or take it over explicitly with takeover: true, expectedOwner, and expectedGeneration.`,
		);
	}

	// -------------------------------------------------------------------------
	// The watch tool
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: 'job_watch',
		label: 'Job watch',
		description:
			'Inspect or narrow the Job watch that wakes this session as soon as an open Job stops working. Opening and closing Jobs already registers and deregisters them.',
		promptSnippet: 'Inspect the Job watch that wakes this session when an open Job stops working',
		promptGuidelines: [
			'Use job_watch to learn what the Job watch has to report. Do not poll a Job or hold a blocking wait on it: open Jobs are watched by blocking Herdr waits, and a Job that stops working wakes this session by itself.',
			'job_watch status is the open-set view: what is watched, what is Retained, and which Wake news has no answer yet. Retaining or closing the Job a news item names is what answers it; status keeps reporting it until then.',
			'job_watch wake forces one observation round and reports the resulting Wake. It never proves a Job succeeded — read the pane.',
			'job_watch dismiss is only for a window that Herdr no longer has — after a crash, or a tab closed by hand. It refuses a window that is still there, naming job retain and job close instead, because a name that reads like "dismiss the news" would otherwise close a window that is being reconciled.',
			'Use job_watch hold only when a Worker has genuinely reached a human question: it suppresses ordinary Wake decisions for that Job while keeping dead-pane and deadline checks. Release it when the human wait is over.',
		],
		parameters: WATCH_PARAMETERS,
		async execute(_id: string, params: Record<string, unknown>, _signal?: unknown, _onUpdate?: unknown, ctx?: any): Promise<ToolResult> {
			if (ctx) context = ctx;
			try {
				switch (params.action) {
					case 'status':
						// `wider` and `scope: 'all'` are decided in one place, so the scope view
						// and the host view can never disagree about what exists.
						return text(await handleStatus(params));
					case 'wake': {
						const report = (await watch.poll()) ?? makeWake([], clock);
						return text(describeWake(report));
					}
					case 'dismiss': {
						const targets = Array.isArray(params.panes) ? params.panes.filter((pane): pane is string => typeof pane === 'string') : [];
						if (targets.length === 0) return text('dismiss requires a non-empty panes list', true);
						const dismissed: string[] = [];
						const failed: string[] = [];
						for (const target of targets) {
							const job = findJob(watch.watchState, target);
							if (!job) {
								failed.push(noSuchJob(target));
								continue;
							}
							try {
								// `dismiss` is for a window that is already gone. Its name reads like
								// "dismiss the news", and an operator who meant that would otherwise
								// silently close a window it was still reconciling — which is the very
								// mistake this action's name invites. A live window is refused, and both
								// verbs that do the intended thing are named in the refusal.
								if (await paneExists(runHerdr, job.pane)) {
									failed.push(`${target}: the window ${job.pane} is still there. Use \`job retain\` to keep it readable and stop its Wake, or \`job close\` to end it.`);
									continue;
								}
								await closeWindow(jobDeps(), job);
								watch.forget([job.pane]);
								if (watch.openJobs.some((candidate) => candidate.pane === job.pane)) failed.push(`${target}: still registered after closing.`);
								else dismissed.push(target);
							} catch (error) {
								failed.push(`${target}: ${errorText(error)}`);
							}
						}
						if (failed.length > 0) {
							const done = dismissed.length > 0 ? `Dismissed ${dismissed.join(', ')}. ` : '';
							return text(`${done}Could not dismiss ${failed.join(' ')} The Job watch still reports these.`, true);
						}
						return text(`Dismissed ${dismissed.length} window(s).`);
					}
					case 'hold': {
						const targets = Array.isArray(params.panes) ? params.panes.filter((pane): pane is string => typeof pane === 'string') : [];
						if (targets.length === 0) return text('hold requires a non-empty panes list', true);
						const ms = positiveMs(params.timeoutMs) ?? DEFAULT_HOLD_MS;
						return text(watch.hold(targets, param(params, 'note'), ms));
					}
					case 'release': {
						const targets = Array.isArray(params.panes) ? params.panes.filter((pane): pane is string => typeof pane === 'string') : [];
						if (targets.length === 0) return text('release requires a non-empty panes list', true);
						return text(watch.release(targets));
					}
					default:
						return text(`Unknown action: ${String(params.action)}`, true);
				}
			} catch (error) {
				return text(errorText(error), true);
			}
		},
	});

	// A pane that vanished is worth a Wake immediately, without waiting for the
	// tick, but the poll already pays that cost: `paneExists` is consulted per open
	// Job inside the round, and a dead pane is classified `dead` there.
}

/**
 * True when a `turn_end` event marks the model finishing its response — the
 * boundary where Pi drains its follow-up queue while the run stays live.
 *
 * Read from Pi's own payload. Evidence that is simply absent fails open to the
 * old "inject anywhere" behaviour, which is safe by construction: an early
 * injection is delivered at the same later boundary, only against older news.
 */
export function turnFinished(event: unknown): boolean {
	const payload = event as { message?: { stopReason?: unknown; content?: unknown }; toolResults?: unknown } | undefined;
	const message = payload?.message;
	if (message !== null && typeof message === 'object') {
		if (message.stopReason === 'toolUse') return false;
		if (Array.isArray(message.content) && message.content.some((block) => (block as { type?: unknown } | null)?.type === 'toolCall')) return false;
		return true;
	}
	if (Array.isArray(payload?.toolResults) && payload.toolResults.length > 0) return false;
	return true;
}

/** Whether a streaming tool update carries anything worth calling activity. */
export function credible(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === 'object') return Object.keys(value).length > 0;
	return true;
}
