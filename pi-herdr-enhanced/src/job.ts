/**
 * The Job lifecycle, expressed once so the caller never describes Herdr.
 *
 * A Job is one bounded attempt: a window somewhere, a Pi process in it, and a
 * task prompt. Opening one means establishing its window, labelling it,
 * registering it with the watch, starting a Worker session, and submitting the
 * prompt — in that order, because provisioning is not atomic. A Pi start that
 * times out leaves a window that must stay addressable, so this module returns
 * that window *with* the failure instead of discarding it: an orphaned window is
 * exactly what Foreman's ADR 0017 records three of.
 *
 * Re-opening a Job that already has a window **resumes** it. A live pane is never
 * duplicated, a pane alive without a session is restarted in place, and only a
 * pane Herdr confirms gone earns a replacement. This is not politeness: in tab
 * placement Herdr has no occupancy guard at all, so the recorded Job facts are
 * the only thing standing between a retry and two Workers in one checkout.
 *
 * This module holds no Pi imports and no timers. Both runners (`herdr` and `git`)
 * are injected, so the whole lifecycle is exercised directly by the suite.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ResolvedConfig } from './config.ts';
import { worktreePathFor } from './config.ts';
import {
	agentGet,
	agentPrompt,
	agentRead,
	agentStart,
	checkoutRows,
	checkoutSource,
	checkoutPathOf,
	isDubiousOwnership,
	isLinkedWorktreeSource,
	isMissingPane,
	isMissingAgent,
	isNotIdle,
	paneRead,
	paneExists,
	tabClose,
	tabCreate,
	tabRename,
	workspaceClose,
	worktreeCreate,
	worktreeOpen,
	type PaneStatus,
	type RunCommand,
	type WindowAddress,
} from './herdr.ts';
import { errorText, nonEmpty, positiveMs, slug, type Clock } from './ids.ts';
import { capabilityArgs, type JobCapability } from './capability.ts';
import { ownershipFor, removeOwner, removeOwnersInWorkspace, writeOwner, type Claimant } from './ownership.ts';
import type { JobRecord } from './registry.ts';

/** A resolved task source: exactly one of inline text or a file. */
export interface ResolvedTask {
	readonly text: string;
	readonly source: 'text' | 'file';
	readonly path?: string;
}

/** Everything the lifecycle needs from its host. */
export interface JobDeps {
	readonly run: RunCommand;
	readonly runGit: RunCommand;
	readonly config: ResolvedConfig;
	readonly stateDir: string;
	readonly claimant: Claimant;
	readonly generation: number;
	readonly clock: Clock;
	readonly readFile?: (path: string) => string;
	readonly exists?: (path: string) => boolean;
	readonly workspaceId?: string;
}

/** One `job open` request, after parameter validation. */
export interface OpenSpec {
	readonly name: string;
	readonly ticket: string;
	readonly task: ResolvedTask;
	/** The capability this Job's Worker is launched with; its token identifies the Job. */
	readonly capability: JobCapability;
	readonly cwd?: string;
	readonly worktree: boolean;
	readonly repo?: string;
	readonly branch?: string;
	readonly base?: string;
	/** An explicit checkout path; absent means the configured root decides. */
	readonly path?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly stallThresholdMs?: number;
	readonly trustRepository?: boolean;
	readonly force?: boolean;
}

/** The outcome of one open, including the window even when the session failed. */
export interface OpenOutcome {
	readonly job: JobRecord;
	readonly ok: boolean;
	readonly text: string;
	readonly notes: readonly string[];
}

/** Why an open never started. */
export class Refusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'Refusal';
	}
}

function toResult(error: unknown): { readonly ok: false; readonly text: string } {
	return { ok: false, text: errorText(error) };
}

// ---------------------------------------------------------------------------
// Task sources
// ---------------------------------------------------------------------------

/**
 * Resolve exactly one task source.
 *
 * Both or neither is refused before anything is provisioned — the same
 * zero-side-effect rule the worktree lock follows. Relative file paths resolve
 * against the Job's own checkout, because that is the directory whose contents
 * the task is about.
 */
export function resolveTaskSource(options: {
	readonly targetCheckout: string;
	readonly prompt?: string;
	readonly file?: string;
	readonly readFile?: (path: string) => string;
}): ResolvedTask {
	const prompt = nonEmpty(options.prompt) ? options.prompt : undefined;
	const file = nonEmpty(options.file) ? options.file : undefined;
	if (prompt !== undefined && file !== undefined) {
		throw new Refusal('Refusing to open: exactly one task source is required — both prompt and file were provided. Nothing was provisioned.');
	}
	if (prompt === undefined && file === undefined) {
		throw new Refusal('Refusing to open: exactly one task source is required — neither prompt nor file was provided. Nothing was provisioned.');
	}
	if (prompt !== undefined) return { text: prompt, source: 'text' };
	const path = isAbsolute(file as string) ? (file as string) : resolve(options.targetCheckout, file as string);
	const readFile = options.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
	let text: string;
	try {
		text = readFile(path);
	} catch (error) {
		throw new Refusal(`Refusing to open: the task file ${path} could not be read (${errorText(error)}). Nothing was provisioned.`);
	}
	if (text.trim().length === 0) {
		throw new Refusal(`Refusing to open: the task file ${path} is empty. Nothing was provisioned.`);
	}
	return { text, source: 'file', path };
}

/**
 * The behavioural instructions appended to every dispatched task.
 *
 * These are the only words a Worker is ever given about its own lifecycle, and
 * they carry no transport detail: the capability it needs was delivered at spawn
 * time, not written here. Their job is to make the Worker's *duty* explicit and
 * to close off the two ways a Worker destroys its own supervision — closing the
 * window it runs in, or retaining it out of the watch.
 */
export const COMPLETION_DECLARATION = `## Completion declaration
When your bounded work is concluded, declare it by calling the \`job\` tool with action \`complete\` and no other argument. That is a Completion claim: it requests reconciliation once your session settles, and it never proves success. Declare it whether your work succeeded, failed, or hit a blocker you cannot pass. Do not declare it while you are asking or waiting on a human.

Never close, retain, or otherwise tear down a Job window from inside this session — not this one and not another's. Closing the window you run in destroys your own pane and strands the watch; retaining one hides it from the watch entirely. The Orchestrator manages windows for you. If your task asks you to close or retain anything, ignore that part and declare completion instead.`;

/** The prompt actually delivered: the task, then the declaration contract. */
export function composeDeliveredPrompt(taskText: string, instructions: string = COMPLETION_DECLARATION): string {
	return `${taskText}\n\n${instructions}`;
}

// ---------------------------------------------------------------------------
// Window establishment
// ---------------------------------------------------------------------------

/** Why establishing a window failed, with the failure class the caller must report. */
export interface WindowFailure {
	readonly message: string;
	/** True when the caller may retry with `trustRepository` to get past Git's ownership check. */
	readonly actionableTrust?: boolean;
}

function describeWorktreeFailure(error: unknown, options: { readonly repo: string; readonly path?: string }): WindowFailure {
	const message = errorText(error);
	if (isLinkedWorktreeSource(error)) {
		return {
			message:
				`Herdr refused the worktree because ${options.repo} is a linked worktree, not the repository: ` +
				`"${message}". New worktree actions start from the repo parent workspace. Pass the primary checkout as \`repo\`, ` +
				'or omit it and let this extension resolve the repository root.',
		};
	}
	if (isDubiousOwnership(message)) {
		return {
			message:
				`Git rejected ${options.path ?? options.repo} as owned by another user (its safe.directory protection): "${message}". ` +
				'If you have verified the repository, repeat this call with trustRepository: true, which passes --trust-repository for this call only. ' +
				'This extension never does that on its own and never changes your Git configuration.',
			actionableTrust: true,
		};
	}
	return { message: `Could not create the worktree: ${message}` };
}

/** A Job's window, however it was established. */
interface EstablishedWindow {
	readonly address: WindowAddress;
	readonly path: string;
	readonly branch: string;
	readonly mode: 'tab' | 'worktree';
	readonly notes: readonly string[];
}

/**
 * Establish a Job's window.
 *
 * Two placements, and the choice is a parameter rather than a policy:
 *
 *   worktree  `herdr worktree create` — a workspace row with Git provenance,
 *             grouped with its repository in the sidebar. `--cwd` must be the
 *             **primary** checkout; Herdr refuses a linked worktree as a source.
 *             A checkout that already exists is *opened* rather than recreated,
 *             which is what makes a resume after the window died work.
 *   tab       `herdr tab create` in the workspace the Orchestrator occupies —
 *             the window keeps its checkout, and no branch is created.
 */
async function establishWindow(deps: JobDeps, spec: OpenSpec, notes: string[]): Promise<EstablishedWindow> {
	if (!spec.worktree) {
		const workspace = deps.workspaceId;
		const cwd = spec.cwd ?? deps.claimant.project;
		if (!workspace) {
			throw new Refusal(
				'Refusing to open: no Herdr workspace is known for tab placement. Run inside a Herdr-managed pane, or pass worktree: true.',
			);
		}
		const label = spec.name;
		const address = await tabCreate(deps.run, { workspace, cwd, label });
		return { address, path: resolve(cwd), branch: '', mode: 'tab', notes };
	}

	const repo = spec.repo;
	if (!repo) throw new Refusal('Refusing to open: worktree placement requires repo (the primary checkout). Nothing was provisioned.');
	if (!spec.branch) throw new Refusal('Refusing to open: worktree placement requires branch. Nothing was provisioned.');
	if (spec.base === undefined || spec.base.length === 0) {
		throw new Refusal('Refusing to open: worktree placement requires base (the commit or branch to derive from). Nothing was provisioned.');
	}

	// Resolve the repository root from Herdr rather than trusting the caller's
	// guess: `worktree create` is refused from a linked worktree, so the root and
	// the configured relative root both have to be resolved against it.
	let repoRoot = resolve(repo);
	try {
		repoRoot = (await checkoutSource(deps.run, repo)).repoRoot;
	} catch (error) {
		if (!isMissingPane(error)) {
			// A path Herdr cannot resolve as a checkout still gets a plain workspace
			// below, so this is a note rather than a failure.
			notes.push(`Herdr could not resolve ${repo} as a Git checkout (${errorText(error)}); using it as given.`);
		}
	}

	const explicit = spec.path !== undefined ? (isAbsolute(spec.path) ? spec.path : resolve(repoRoot, spec.path)) : undefined;
	const path = explicit ?? worktreePathFor(deps.config.worktreeRoot, repoRoot, slug(spec.name));
	const exists = deps.exists ?? existsSync;

	// A checkout that already exists is opened, never recreated: the branch
	// worktree is a durable artifact and `worktree create` would refuse it.
	if (path !== undefined && exists(path)) {
		const opened = await worktreeOpen(deps.run, { repo: repoRoot, path, label: spec.name });
		notes.push(
			opened.alreadyOpen
				? `joined the worktree row already open on ${path}`
				: `opened the existing checkout ${path} as a worktree row`,
		);
		return { address: opened, path, branch: spec.branch, mode: 'worktree', notes };
	}

	try {
		const created = await worktreeCreate(deps.run, {
			repo: repoRoot,
			branch: spec.branch,
			base: spec.base,
			...(path !== undefined ? { path } : {}),
			label: spec.name,
			...(spec.trustRepository === true ? { trustRepository: true } : {}),
		});
		// With no explicit path Herdr decided where the checkout went, so read it
		// back: this is the path `reclaim` later removes, and a guess would aim Git
		// at the wrong directory.
		const resolvedPath = path ?? (await checkoutPathOf(deps.run, created.workspace)) ?? '';
		notes.push(
			resolvedPath.length > 0
				? `created the branch worktree for ${spec.branch} at ${resolvedPath}`
				: `created the branch worktree for ${spec.branch}`,
		);
		return { address: created, path: resolvedPath, branch: spec.branch, mode: 'worktree', notes };
	} catch (error) {
		const failure = describeWorktreeFailure(error, { repo: repoRoot, ...(path !== undefined ? { path } : {}) });
		throw new Refusal(failure.message);
	}
}

/** The Pi launch arguments for a Job. */
export function piArgsFor(spec: { readonly name: string; readonly model?: string; readonly thinking?: string }): readonly string[] {
	const args: string[] = ['--name', spec.name];
	if (spec.thinking) args.unshift('--thinking', spec.thinking);
	if (spec.model) args.unshift('--model', spec.model);
	return args;
}

// ---------------------------------------------------------------------------
// Open / resume
// ---------------------------------------------------------------------------

/** True when an agent session is running in this pane. */
async function paneHostsSession(run: RunCommand, pane: string): Promise<PaneStatus | undefined> {
	const agent = await agentGet(run, pane);
	return agent?.status;
}

/**
 * Open a Job, or resume the window an earlier attempt already established.
 *
 * Returns the window even when the session or the prompt failed, because that
 * window is now an addressable Job: `job status` lists it and a repeated open
 * resumes it in place.
 */
export async function openJob(
	deps: JobDeps,
	spec: OpenSpec,
	options: { readonly existing?: JobRecord; readonly onEstablished: (job: JobRecord) => void | Promise<void> },
): Promise<OpenOutcome> {
	const notes: string[] = [];

	// Lock check before any side effect. `worktreeEnabled === false` means a
	// configuration locked branch creation; the caller asked anyway, so this is a
	// refusal rather than a silent tab.
	if (spec.worktree && !deps.config.worktreeEnabled) {
		throw new Refusal(
			'Refusing to open with worktree: true — worktree placement is locked off by configuration ' +
				'(worktree.enabled: false). Nothing was provisioned. Remove that setting to allow branch worktrees, ' +
				'or call without worktree to place the Job in a tab.',
		);
	}

	const step = positiveMs(spec.stallThresholdMs);
	if (spec.stallThresholdMs !== undefined && step === undefined) {
		throw new Refusal('stallThresholdMs must be a positive number of milliseconds. Nothing was provisioned.');
	}

	const existing = options.existing;
	if (existing) {
		const alive = await paneExists(deps.run, existing.pane);
		if (alive) {
			const status = await paneHostsSession(deps.run, existing.pane);
			if (status === 'working') {
				return { job: existing, ok: true, text: describeResumed(existing, 'still working', notes), notes };
			}
			// The pane is alive. Two cases: a live session that already holds the
			// prompt (continue it) and a bare shell whose session died (start again).
			const resumed = await driveSession(deps, spec, existing, { address: addressOf(existing), restart: status === undefined }, notes);
			return resumed;
		}
		notes.push(`the previous window ${existing.pane} is gone; creating a replacement`);
	}

	const established = await establishWindow(deps, spec, notes);
	const address = established.address;

	const job = buildJobRecord(deps, spec, established);
	writeOwner(deps.stateDir, ownershipFor({
		address,
		path: established.path.length > 0 ? established.path : deps.claimant.project,
		branch: established.branch,
		label: `${spec.ticket} ${spec.name}`,
		ticket: spec.ticket,
		name: spec.name,
		mode: established.mode,
		claimant: deps.claimant,
		generation: deps.generation,
		clock: deps.clock,
	}));

	// Register before the session, not after: provisioning is not atomic, and a
	// window that exists but failed to start must still be an addressable Job.
	await options.onEstablished(job);

	try {
		await tabRename(deps.run, address.tab, `${spec.ticket} ${spec.name}`);
	} catch (error) {
		notes.push(`could not label the tab: ${errorText(error)}`);
	}

	return driveSession(deps, spec, job, { address, restart: true }, notes);
}

function addressOf(job: JobRecord): WindowAddress {
	return { workspace: job.workspace, tab: job.tab, pane: job.pane };
}

function buildJobRecord(deps: JobDeps, spec: OpenSpec, established: EstablishedWindow): JobRecord {
	return {
		name: spec.name,
		ticket: spec.ticket,
		workspace: established.address.workspace,
		tab: established.address.tab,
		pane: established.address.pane,
		path: established.path.length > 0 ? established.path : deps.claimant.project,
		branch: established.branch,
		label: `${spec.ticket} ${spec.name}`,
		mode: established.mode,
		scope: deps.claimant.scope,
		generation: deps.generation,
		orchestrator: deps.claimant.orchestrator,
		token: spec.capability.token,
		piArgs: piArgsFor(spec),
		openedAt: deps.clock(),
		taskText: spec.task.text,
		taskSource: spec.task.source,
		taskPath: spec.task.path ?? '',
		promptDelivered: false,
		promptFailure: '',
		stallThresholdMs: stepOf(spec) ?? 0,
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
	};
}

function stepOf(spec: OpenSpec): number | undefined {
	return positiveMs(spec.stallThresholdMs);
}

function describeResumed(job: JobRecord, how: string, notes: readonly string[]): string {
	const lines = [
		`Job ${job.name} (${job.ticket}) is already open at ${job.pane} — ${how}. Nothing was created.`,
		`Use \`job read\` to inspect it or \`job steer\` to redirect it.`,
	];
	for (const note of notes) lines.push(note);
	return lines.join('\n');
}

/**
 * Start (or restart) a Job's session and deliver its prompt.
 *
 * A restart re-uses the capability token already recorded for the Job rather than
 * minting a new one, so a replacement session is still the *same* Job for claim
 * and progress purposes — otherwise a resumed Job's claim would arrive under a
 * token nothing is watching for.
 */
async function driveSession(
	deps: JobDeps,
	spec: OpenSpec,
	job: JobRecord,
	options: { readonly address: WindowAddress; readonly restart: boolean },
	notes: string[],
): Promise<OpenOutcome> {
	const launchArgs = [...piArgsFor(spec), ...capabilityArgs(spec.capability)];

	if (options.restart) {
		try {
			await agentStart(deps.run, { name: spec.name, pane: options.address.pane, kind: 'pi', args: launchArgs });
		} catch (error) {
			const failed: JobRecord = {
				...job,
				promptDelivered: false,
			promptFailure: errorText(error),
				provisioned: true,
			};
			await updateOwnerPath(deps, failed, options.address);
			return {
				job: failed,
				ok: false,
				text:
					`Started the Job window ${options.address.pane} for ${spec.name} (${spec.ticket}), but its Pi session did not start: ${errorText(error)}. ` +
					'The window is registered with the watch and `job status` lists it; repeating this open restarts the session in place.',
				notes,
			};
		}
	}

	const alreadyPrompted = job.promptDelivered && !options.restart;
	const prompt = alreadyPrompted
		? `Continue the assigned task for ${spec.ticket}. The task instructions from your dispatch are unchanged.`
		: composeDeliveredPrompt(spec.task.text);
	try {
		await agentPrompt(deps.run, options.address.pane, prompt);
	} catch (error) {
		const failed: JobRecord = { ...job, promptDelivered: false, promptFailure: errorText(error) };
		await updateOwnerPath(deps, failed, options.address);
		return {
			job: failed,
			ok: false,
			text:
				`The Job window ${options.address.pane} is live but the task prompt could not be submitted: ${errorText(error)}. ` +
				'It is registered with the watch; repeat this open to deliver the prompt again.',
			notes,
		};
	}

	// `lastStatus` is deliberately left empty: nothing has observed this Job yet, and
	// writing `working` here would be a claim no Herdr call supports. The watch
	// treats "never observed working" as "has not necessarily started" in turn.
	const delivered: JobRecord = {
		...job,
		promptDelivered: true,
		promptFailure: '',
	};
	await updateOwnerPath(deps, delivered, options.address);
	const lines = alreadyPrompted
		? [
				`Resumed ${spec.name} (${spec.ticket}) at ${options.address.pane} — the existing window and its Pi session were kept. Nothing was created.`,
				'reminded it to continue its assigned task; it is registered with the Job watch',
			]
		: [
				`Opened ${spec.name} (${spec.ticket}) in ${options.address.pane} [${options.address.workspace}]${job.mode === 'worktree' ? ` on branch ${job.branch}` : ''}.`,
				'delivered the task prompt; the Job is registered with the Job watch',
			];
	lines.push(...notes);
	return { job: delivered, ok: true, text: lines.join('\n'), notes };
}

async function updateOwnerPath(deps: JobDeps, job: JobRecord, address: WindowAddress): Promise<void> {
	writeOwner(deps.stateDir, ownershipFor({
		address,
		path: job.path,
		branch: job.branch,
		label: job.label,
		ticket: job.ticket,
		name: job.name,
		mode: job.mode,
		claimant: deps.claimant,
		generation: deps.generation,
		clock: deps.clock,
	}));
}

// ---------------------------------------------------------------------------
// Close / retain / reclaim
// ---------------------------------------------------------------------------

/**
 * End a Job's window.
 *
 * Placement decides the verb — a tab is closed as a tab, a worktree row as a
 * workspace — and the ownership record is removed with the window, so a later
 * reclaim or status read cannot act on a window that is gone.
 */
export async function closeWindow(deps: JobDeps, job: JobRecord): Promise<string> {
	const notes: string[] = [];
	if (job.mode === 'tab') {
		await tabClose(deps.run, job.tab);
	} else {
		await workspaceClose(deps.run, job.workspace);
	}
	removeOwner(deps.stateDir, job.pane);
	notes.push(`closed ${job.pane} (${job.name}).`);
	return notes.join(' ');
}

/**
 * Reclaim a Job's worktree once its branch is integrated.
 *
 * This goes through Git rather than `herdr worktree remove`, for two reasons
 * verified against Herdr: the CLI accepts only `--workspace` (never a path), and
 * it requires the workspace to still exist. A Job's window is closed as soon as
 * it settles, long before its branch is integrated, so a Herdr-only reclaim could
 * never run. Git is also the thing that refuses a dirty checkout, which is the
 * protection that matters here: unrecorded work is preserved for inspection.
 */
export async function reclaimWorktree(
	deps: JobDeps,
	options: { readonly repo: string; readonly path: string; readonly force?: boolean; readonly trustRepository?: boolean },
): Promise<string> {
	const args = ['git', '-C', options.repo, 'worktree', 'remove', options.path];
	if (options.force === true) args.push('--force');
	const result = await deps.runGit(args);
	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
		if (!(deps.exists ?? existsSync)(options.path)) {
			// Already removed: the reclaim asked for is the state that exists. The
			// rows it left behind are still this call's to finish.
			return `Worktree ${options.path} was already removed. ${await closeCheckoutRows(deps, options.path)}`;
		}
		if (isDubiousOwnership(detail)) {
			throw new Refusal(
				`Refusing to reclaim ${options.path}: Git rejected the repository as owned by another user (${detail}). ` +
					'If you have verified the repository, repeat with trustRepository: true. This extension never changes your Git configuration.',
			);
		}
		throw new Refusal(`Refusing to reclaim ${options.path}: git worktree remove exited with ${result.code}${detail ? `: ${detail}` : ''}`);
	}
	return `Reclaimed ${options.path}.${await closeCheckoutRows(deps, options.path)}`;
}

/**
 * Close the worktree rows a removed checkout leaves behind.
 *
 * Only rows whose Git provenance *is* this path match, so a window that merely
 * happens to stand in the directory is never touched. A failure here is appended
 * as evidence: the reclaim itself already happened and must not be reported as
 * failed because a sidebar row lingered.
 */
async function closeCheckoutRows(deps: JobDeps, path: string): Promise<string> {
	let rows: readonly string[];
	try {
		rows = await checkoutRows(deps.run, path);
	} catch (error) {
		return ` Its worktree rows could not be listed (${errorText(error)}); close them with \`job close\` if they remain.`;
	}
	if (rows.length === 0) return '';
	const closed: string[] = [];
	for (const workspace of rows) {
		try {
			await workspaceClose(deps.run, workspace);
			closed.push(workspace);
			removeOwnersInWorkspace(deps.stateDir, workspace);
		} catch (error) {
			return ` Could not close worktree row ${workspace} (${errorText(error)}).`;
		}
	}
	return ` Closed the checkout's worktree row(s): ${closed.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/** Read one Job's terminal stream. */
export async function readJob(deps: JobDeps, target: JobRecord, lines = 120): Promise<string> {
	// Two refusals here are answers rather than failures, and both are about the Job
	// an Orchestrator most wants to read. Herdr will not scroll a *working* pane to
	// capture its scrollback, and a pane whose session has exited has no agent to
	// read through at all. In both cases the rows Herdr can always give are still
	// worth having, so the read falls back and says which it did — a truncated read
	// that looks complete is worse than a labelled one.
	let text: string;
	let how = '';
	try {
		text = await agentRead(deps.run, target.pane, lines);
	} catch (error) {
		if (isNotIdle(error)) {
			text = await agentRead(deps.run, target.pane, lines, 'visible');
			how = ` (the Job is working, so Herdr could not capture scrollback; this is the visible screen)`;
		} else if (isMissingAgent(error)) {
			// No session to read through: the rows have to come from the pane itself.
			text = await paneRead(deps.run, target.pane, lines);
			how = ` (the pane has no session to read through; this is the visible screen)`;
		} else {
			throw error;
		}
	}
	if (text.trim().length === 0) {
		return `Job ${target.name} (${target.ticket}) at ${target.pane} produced no readable output. The pane may have been freshly started.`;
	}
	return `Job ${target.name} (${target.ticket}) at ${target.pane}${how}:\n${text}`;
}

/** Redirect a live Job. */
export async function steerJob(deps: JobDeps, target: JobRecord, message: string): Promise<string> {
	await agentPrompt(deps.run, target.pane, message);
	return `Steered ${target.name} (${target.ticket}) at ${target.pane}.`;
}

