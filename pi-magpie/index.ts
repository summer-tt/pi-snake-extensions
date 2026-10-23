/**
 * pi-magpie — magpie's gateway as a pi provider, with its quotas and routing
 * groups in the footer and under `/magpie`.
 *
 *   /login magpie        optional: point at another gateway and key. Without
 *                        it the extension reaches magpie's own loopback
 *                        default (http://127.0.0.1:3425, key "magpie")
 *   /magpie              where the gateway is, what it serves, and the current
 *                        model's quota or routing group
 *   /magpie quota [id]   what the model's provider has left
 *   /magpie group [id]   a routing group's members, rules and last decision
 *   /magpie groups       every routing group magpie offers
 *   /magpie refresh      fetch magpie's catalog again now
 *   /magpie endpoint     the gateway in use, and whether models.json also names it
 *
 * Every one of those completes on Tab: the subcommands while the first word is
 * typed, then the ids the subcommand takes.
 *
 * The footer follows the gateway by itself: it re-reads after every run
 * (`agent_end`), on a model switch and at session start, and repaints at the
 * terminal's new width. Those reads ask magpie for what it already read
 * (`GET /v1/magpie/quotas?kept=1`), so watching the footer never makes magpie
 * read a vendor; only a reading magpie has let go stale (STALE_READING_MS) is
 * read again with the vendors asked. A routing group's line comes from the
 * gateway's live routing trace (`GET /v1/magpie/trace`) and falls back to the
 * routing history on disk; which models are groups is magpie's own list
 * (`magpie groups`, in the background), never a prefix's.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_TOKEN, PROVIDER_ID, ROOT_ENV, STATUS_KEY, STATUS_TTL_MS, STALE_READING_MS } from "./constants.ts";
import {
	defaultRoot,
	fetchModel,
	fetchQuotas,
	fetchTrace,
	gatewayUrlFor,
	isLoopback,
	magpieProviderInModelsJson,
	modelsJsonPath,
	normalizeRoot,
	readRoutingTail,
	routingDays,
	runMagpie,
} from "./gateway.ts";
import { quotaView, readingAt, statusForWidth, type QuotaEntry } from "./quota.ts";
import {
	describeRoute,
	type GroupInfo,
	groupStatus,
	type GroupListRow,
	latestGroupRoute,
	latestGroupRouteIn,
	latestRoutesByGroup,
	parseGroupShow,
	parseGroupsList,
	type Route,
	shortGroupId,
} from "./routing.ts";
import { createMagpieProvider, type MagpieProviderHandle, ownedByEntry } from "./provider.ts";
import { argumentCompletions, findSubcommand, usageLines } from "./usage.ts";

const PROVIDER_LABEL = "magpie";
/** The status label when the footer has no room for the whole word: `magpie` → `mag`. */
const STATUS_LABEL_CUT = "mag";
/**
 * Columns this status leaves to the footer's other statuses. Extension statuses
 * share one line in alphabetical key order and `magpie` sorts first, so a
 * greedy quota line would push every sibling into the truncation zone.
 */
const STATUS_BUDGET_MARGIN = 40;

/** What the footer shows for one model, recomputed against the width on a resize. */
type StatusRender = () => string | undefined;

/** Whether a context can still be used: pi's getters throw once it is stale. */
function usable(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

/** One reading of the gateway: the line, and when the numbers behind it were read. */
interface StatusReading {
	render: StatusRender;
	/** When magpie read the numbers, ms; undefined when the reading doesn't say. */
	readAt?: number;
	/** Whether this read asked the vendors, rather than magpie's own cache. */
	full: boolean;
}

/** What this extension knows about the gateway right now. */
interface GatewayAuth {
	root: string;
	token: string;
	/** Whether the gateway is on this machine: quotas and routing history are. */
	local: boolean;
	/** Whether an endpoint was stored by `/login magpie`, rather than the default. */
	stored: boolean;
}

export default function (pi: ExtensionAPI): void {
	const magpie = createMagpieProvider();
	pi.registerProvider(magpie.provider);

	let cache: { key: string; at: number; reading: StatusReading } | undefined;
	/** The routing groups magpie serves, by id — whichever spelling it gives them. */
	let groups = new Set<string>();
	let generation = 0;
	/** The context the current status was set from, so a resize can repaint it. Released at session_shutdown. */
	let statusCtx: ExtensionContext | undefined;
	/** The text the footer holds, so an unchanged reading does not repaint it. */
	let written: string | undefined;
	/** Readings that failed in a row: one is a blip, two in a row is news. */
	let failures = 0;
	/** When the vendors were last asked, so one stale reading is read again, not every one. */
	let lastFullAt = 0;

	/**
	 * Re-ask what magpie's routing groups are; a magpie without the CLI keeps
	 * none. Answers whether that changed anything, which is when the footer is
	 * worth painting again.
	 */
	const loadGroups = async (ctx: ExtensionContext): Promise<boolean> => {
		let next = new Set<string>();
		try {
			next = await knownGroupIds(await gatewayAuth(ctx));
		} catch {
			next = new Set();
		}
		const changed = next.size !== groups.size || [...next].some((id) => !groups.has(id));
		groups = next;
		return changed;
	};

	const writeStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		// setStatus repaints the footer whatever it says: an unchanged reading is
		// left alone.
		if (text === written) return;
		written = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	/**
	 * Re-read what the footer shows. The default read asks magpie for what it
	 * already read (`?kept=1`), which asks no vendor at all — cheap enough to do
	 * whenever the gateway's answer can have changed. `full` asks the vendors
	 * too, for a reading magpie has let go stale or for a command that says now.
	 */
	const refreshStatus = async (
		ctx: ExtensionContext,
		options: { force?: boolean; full?: boolean } = {},
	): Promise<void> => {
		// A refresh resumed after the session was replaced finds a ctx whose
		// getters throw: it has nothing left to say.
		if (!usable(ctx)) return;
		statusCtx = ctx;
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			writeStatus(ctx, undefined);
			cache = undefined;
			return;
		}
		const { force = false, full = false } = options;
		const hit = cache;
		// A model switch and a run's end can arrive together: a reading taken a
		// moment ago stands, rather than asking the gateway again for it.
		if (!force && !full && hit && hit.key === model.id && Date.now() - hit.at < STATUS_TTL_MS) {
			writeStatus(ctx, hit.reading.render());
			return;
		}
		const mine = ++generation;
		let reading: StatusReading;
		try {
			const auth = await gatewayAuth(ctx);
			reading = await statusReading(magpie, model, auth, full, groups);
			failures = 0;
		} catch {
			// Keep what the footer already shows: a gateway restarted or one
			// request timing out is not news. Two failures in a row are.
			if (cache?.key === model.id && ++failures < 2) return;
			failures = 0;
			reading = { render: () => `${PROVIDER_LABEL} unreachable`, full: true };
		}
		if (mine !== generation) return;
		cache = { key: model.id, at: Date.now(), reading };
		writeStatus(ctx, reading.render());
		if (full) {
			lastFullAt = Date.now();
		} else if (staleReading(reading, Date.now(), lastFullAt)) {
			// magpie's cache has not been read for a while (nothing else asked
			// it: a gateway with no window open): ask it to read once now.
			lastFullAt = Date.now();
			void refreshStatus(ctx, { full: true }).catch(() => {});
		}
	};

	// setStatus takes a fixed string, so the width-aware tiers are chosen when it
	// is set: repaint the cached reading at the terminal's new width.
	const repaintOnResize = (): void => {
		const ctx = statusCtx;
		const render = cache?.reading.render;
		if (!ctx || !render || !usable(ctx)) return;
		writeStatus(ctx, render());
	};

	pi.on("session_start", async (event, ctx) => {
		// Re-arm per session: a replacement or reload runs a fresh factory while
		// the previous runtime's listener must be gone (off-then-on keeps this
		// idempotent if session_start ever fires twice without a shutdown).
		process.stdout.off("resize", repaintOnResize);
		process.stdout.on("resize", repaintOnResize);
		written = undefined;
		failures = 0;
		lastFullAt = 0;
		if (event.reason === "startup") await warnIfModelsJsonHandlesMagpie(ctx);
		await refreshStatus(ctx, { force: true });
		// `magpie groups` takes a moment (it asks the running magpie): the footer
		// paints from the routing trace first, and paints again when the list lands.
		void loadGroups(ctx)
			.then((changed) => (changed ? refreshStatus(ctx, { force: true }) : undefined))
			.catch(() => {});
	});

	pi.on("session_shutdown", () => {
		// pi fires this before it invalidates the ctx, and the getters of a stale
		// ctx throw. A raw stream listener is not supervised by pi's event
		// dispatch, so a resize after this point would crash the whole process:
		// release the listener and the captured ctx, bump the generation so a
		// refreshStatus still awaiting the gateway returns instead of touching it.
		++generation;
		statusCtx = undefined;
		cache = undefined;
		groups = new Set();
		written = undefined;
		failures = 0;
		lastFullAt = 0;
		process.stdout.off("resize", repaintOnResize);
	});

	pi.on("model_select", (_event, ctx) => {
		void refreshStatus(ctx, { force: true }).catch(() => {});
	});

	pi.on("agent_end", (_event, ctx) => {
		// The run just went through the gateway, so magpie's latest route and its
		// own quota reading have moved: show them now, without asking a vendor.
		void refreshStatus(ctx).catch(() => {});
	});

	pi.registerCommand("magpie", {
		description: "Magpie gateway — the models, quotas and routing groups it serves",
		getArgumentCompletions: (prefix) =>
			argumentCompletions(prefix, { models: () => magpie.models(), groups: () => groups }),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const target = rest[0];
			const now = Date.now();
			const lines = await report(ctx, magpie, sub, target, now, groups);
			const unknown = sub !== undefined && !findSubcommand(sub);
			ctx.ui.notify(lines.join("\n"), unknown ? "warning" : "info");
			if (sub === "refresh") {
				// The catalog and the groups move together: a group added in
				// magpie belongs in the footer as soon as the refresh says so.
				void loadGroups(ctx)
					.then(() => refreshStatus(ctx, { force: true, full: true }))
					.catch(() => {});
			}
		},
	});
}

// =============================================================================
// The footer
// =============================================================================

async function statusReading(
	magpie: MagpieProviderHandle,
	model: Model<Api>,
	auth: GatewayAuth,
	full: boolean,
	groups: ReadonlySet<string>,
): Promise<StatusReading> {
	const plain: StatusReading = { render: () => `${PROVIDER_LABEL} ${model.name}`, full: true };
	// Quotas and routing are told to this machine alone: a gateway elsewhere
	// answers with its catalog and takes the requests, but not with its accounts
	// or its routing, and this machine's history is another gateway's.
	if (!auth.local) return plain;
	// Which model is a routing group is magpie's answer, not a prefix's: its own
	// list of groups, and for one that list cannot name, the routing the gateway
	// did — a request magpie split across members is a group whatever its id looks like.
	const known = groups.has(shortGroupId(model.id));
	if (!known && groups.size === 0) {
		const proof = await groupProof(auth, model.id);
		if (proof) return groupReading(auth, model, proof);
	}
	if (known) return groupReading(auth, model);
	const provider = await quotaProviderFor(magpie, auth, model.id);
	if (!provider) return plain;
	// A run's end reads what magpie already read; only a reading gone stale
	// asks magpie to read the vendors, so a footer refresh costs them nothing.
	const entries = await fetchQuotas(auth.root, auth.token, AbortSignal.timeout(8_000), { kept: !full });
	const view = quotaView(entries, provider);
	const readAt = readingAt(entries, provider);
	const forms = view.status;
	if (forms) {
		return { render: () => statusForWidth(forms, statusBudget(), PROVIDER_LABEL, STATUS_LABEL_CUT), readAt, full };
	}
	// Nothing left for that provider — which is also what a routing group reports
	// when it has no card of its own: ask the gateway whose members it routed.
	const proof = await groupProof(auth, model.id);
	if (proof) return groupReading(auth, model, proof);
	// magpie says nothing of this provider at all (a group's id is nobody's
	// provider): the model's name is all there is to show.
	if (view.entries.length === 0) return plain;
	return { render: () => `${PROVIDER_LABEL} ${provider} — no quota reported`, readAt, full };
}

/**
 * Proof that a model is a routing group, from the gateway's own memory: a
 * request through it that names the members it chose between. The live trace
 * only — a routing history line names the model it asked for too, and that a
 * request asked for a model is not proof it is a group. Undefined when the
 * trace cannot answer, or when its latest route names no group.
 */
async function groupProof(auth: GatewayAuth, modelId: string): Promise<Route | undefined> {
	const trace = await fetchTrace(auth.root, auth.token, AbortSignal.timeout(8_000));
	if (!trace) return undefined;
	const route = latestGroupRouteIn(trace, modelId);
	return route?.group ? route : undefined;
}

/** The footer line of a routing group: its strategy and who answered last. */
async function groupReading(auth: GatewayAuth, model: Model<Api>, known?: Route): Promise<StatusReading> {
	const route = known ?? (await groupRoute(auth, model.id));
	const status = groupStatus(route, undefined);
	return {
		render: () => (status ? `${PROVIDER_LABEL} ${status}` : `${PROVIDER_LABEL} ${model.name}`),
		readAt: Date.now(),
		full: true,
	};
}

/**
 * Whether a reading is old enough to be worth asking the vendors again. A full
 * read never is; one that doesn't say when it was read is judged by the last
 * full read, so the check cannot loop.
 */
function staleReading(reading: StatusReading, now: number, lastFullAt: number): boolean {
	if (reading.full) return false;
	return reading.readAt === undefined
		? now - lastFullAt >= STALE_READING_MS
		: now - reading.readAt >= STALE_READING_MS;
}

/** Columns this status may take: the terminal, less what sibling statuses may show. */
function statusBudget(): number {
	const columns = process.stdout.columns;
	return typeof columns === "number" && columns > 0
		? columns - STATUS_BUDGET_MARGIN
		: Number.POSITIVE_INFINITY;
}

// =============================================================================
// `/magpie`
// =============================================================================

async function report(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	sub: string | undefined,
	target: string | undefined,
	now: number,
	groups: ReadonlySet<string>,
): Promise<string[]> {
	switch (sub) {
		case "quota":
			return quotaReport(ctx, magpie, target, now, groups);
		case "group":
			return groupReport(ctx, target, groups);
		case "groups":
			return groupsReport(ctx, magpie, groups);
		case "refresh":
			return refreshReport(ctx);
		case "endpoint":
			return endpointReport(ctx);
		case "help":
			return helpReport();
		case undefined:
			return overviewReport(ctx, magpie, now, groups);
		default:
			return [`unknown: /magpie ${sub}`, "what it can report on:", ...usageLines()];
	}
}

/**
 * `/magpie` on its own: where the gateway is, what it serves, and the current
 * model's own reading — the whole picture, with the command list under it,
 * rather than one line of help or one model's quota.
 */
async function overviewReport(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	now: number,
	groups: ReadonlySet<string>,
): Promise<string[]> {
	const auth = await gatewayAuth(ctx);
	const models = magpieModels(ctx);
	const found = models.filter((model) => groups.has(shortGroupId(model.id))).length;
	const lines = [
		`${PROVIDER_LABEL} · ${gatewayUrlFor(auth.root)} · ${
			auth.local ? "this machine" : "remote"
		} · ${auth.stored ? "logged in" : "default gateway"}`,
		`catalog: ${count(models.length, "model")}${found > 0 ? ` · ${count(found, "routing group")}` : ""}`,
	];
	const model = ctx.model;
	if (model?.provider === PROVIDER_ID) {
		lines.push(`current: ${model.name} (${model.id}) · ${model.api}`);
		lines.push(...(await currentLines(ctx, magpie, auth, now, groups)).map((line) => `  ${line}`));
	} else {
		lines.push(
			`current: ${model ? `${model.provider}/${model.id}` : "no model"} — not a magpie one${models.length > 0 ? " (/model lists them)" : ""}`,
		);
	}
	lines.push("", ...usageLines());
	return lines;
}

/** The current model's own reading: its routing group, or its quota. */
async function currentLines(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	auth: GatewayAuth,
	now: number,
	groups: ReadonlySet<string>,
): Promise<string[]> {
	const model = ctx.model;
	if (!model || model.provider !== PROVIDER_ID) return [];
	if (groups.has(shortGroupId(model.id))) return groupReport(ctx, model.id, groups);
	return (await quotaLines(magpie, auth, model.id, now, auth.token)).map((line) => `quota: ${line}`);
}

function helpReport(): string[] {
	return [`${PROVIDER_LABEL} — the gateway's models, quotas and routing groups`, ...usageLines()];
}

function count(amount: number, noun: string): string {
	return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

async function quotaReport(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	target: string | undefined,
	now: number,
	groups: ReadonlySet<string>,
): Promise<string[]> {
	const auth = await gatewayAuth(ctx);
	const model = target
		? magpieModels(ctx).find((entry) => entry.id === target || entry.name === target)
		: ctx.model?.provider === PROVIDER_ID
			? ctx.model
			: undefined;
	if (!model) {
		return [`no magpie model to report on${target ? `: ${target}` : " — name one: /magpie quota <model>"}`];
	}
	if (groups.has(shortGroupId(model.id))) {
		return [
			`${model.id} is a routing group — a group has no quota of its own`,
			...(await groupReport(ctx, model.id, groups)),
		];
	}
	return quotaLines(magpie, auth, model.id, now, auth.token);
}

async function quotaLines(
	magpie: MagpieProviderHandle,
	auth: GatewayAuth,
	modelId: string,
	now: number,
	token: string,
): Promise<string[]> {
	if (!auth.local) {
		return ["unavailable: quotas are only told to this machine (magpie serves them over loopback)"];
	}
	const provider = await quotaProviderFor(magpie, auth, modelId);
	if (!provider) return [`${modelId} names no magpie provider to report on`];
	let entries: QuotaEntry[];
	try {
		entries = await fetchQuotas(auth.root, token, AbortSignal.timeout(8_000));
	} catch (error) {
		return [`could not ask magpie: ${error instanceof Error ? error.message : String(error)}`];
	}
	const view = quotaView(entries, provider, now);
	if (view.entries.length === 0) return [`magpie reports no quota for ${provider}`];
	return [`${provider} —`, ...view.report];
}

async function groupReport(ctx: ExtensionContext, id: string | undefined, groups: ReadonlySet<string>): Promise<string[]> {
	// magpie's CLI takes a group by any of its ids: `step-5-preview`,
	// `group/step-5-preview`, `auto/deepseek-v4.1-flash` or `auto-deepseek-v4-1-flash`.
	const groupId = id?.trim() || currentGroupId(ctx, groups);
	if (!groupId) return ["the current model is not a routing group — name one: /magpie group <id>"];
	const lines: string[] = [];
	const info = await groupDefinition(groupId);
	if (info) {
		const named = info.id ?? groupId;
		lines.push(`${named}${info.name ? ` · ${info.name}` : ""}${info.auto ? " · found by magpie" : ""}`);
		const fields = [info.routing ? `routing ${info.routing}` : "", info.stays ? `stays ${info.stays}` : ""].filter(
			Boolean,
		);
		if (fields.length > 0) lines.push(`  ${fields.join(" · ")}`);
		if (info.members.length > 0) {
			lines.push(
				...info.members.map(
					(member, index) =>
						`  ${index + 1}. ${member}${member === info.picked ? " ●" : ""}`,
				),
			);
		}
		if (info.effort) lines.push(`  effort: ${info.effort}`);
		if (info.levels) lines.push(`  levels: ${info.levels}`);
		if (info.classifier) lines.push(`  classifier: ${info.classifier}`);
		lines.push(...info.rules.map((rule, index) => `  rule ${index + 1}: ${rule}`));
	} else {
		lines.push(`${groupId} — magpie did not describe it (is the magpie CLI on PATH?)`);
	}
	const route = await lastRouteFor(groupId);
	if (route) lines.push(...describeRoute(route));
	else lines.push("  no request through it in the routing history yet");
	return lines;
}

async function groupsReport(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	groups: ReadonlySet<string>,
): Promise<string[]> {
	const rows = new Map<string, GroupListRow>();
	const cli = await runMagpie(["groups"]);
	if (cli.ok) {
		for (const row of parseGroupsList(cli.stdout)) rows.set(row.id, row);
	}
	const current = currentGroupId(ctx, groups);
	const routes = await groupRoutes();
	const catalog = magpie.models();
	const served = catalog.filter((model) => groups.has(shortGroupId(model.id)));
	const ids = new Set<string>([...served.map((model) => model.id), ...rows.keys()]);
	if (ids.size === 0) {
		return ["no routing groups: magpie serves none and the magpie CLI listed none"];
	}
	const lines: string[] = [`${ids.size} routing group${ids.size === 1 ? "" : "s"}:`];
	for (const id of [...ids].sort()) {
		const short = id.replace(/^group\//, "");
		const row = rows.get(id) ?? rows.get(short);
		const route = routes.get(short);
		const model = served.find((entry) => entry.id === id);
		const name = row?.name ?? model?.name ?? "";
		const routing = route?.group?.routing || row?.routing || "?";
		const members = route?.group?.members ?? row?.members ?? [];
		const against = route?.order?.length ? ` · ${route.order.length} weighed` : "";
		const here = current !== undefined && shortGroupId(id) === current ? "  ← current" : "";
		const lines2 = [
			`  ${id}${name ? ` ${name}` : ""} · ${routing}${members.length > 0 ? ` · ${members.join(" → ")}` : ""}${against}${here}`,
		];
		// A catalog that has not been fetched yet cannot say a group is gone.
		if (!model && catalog.length > 0) lines2.push("    (not served now)");
		lines.push(...lines2);
	}
	if (!cli.ok) lines.push(`  (the magpie CLI did not answer: ${cli.error})`);
	return lines;
}

async function refreshReport(ctx: ExtensionContext): Promise<string[]> {
	const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
	const error = result.errors.get(PROVIDER_ID);
	if (error) return [`could not refresh magpie's catalog: ${error.message}`];
	const models = magpieModels(ctx);
	return [`magpie's catalog: ${count(models.length, "model")}`];
}

async function endpointReport(ctx: ExtensionContext): Promise<string[]> {
	const auth = await gatewayAuth(ctx);
	const lines = [
		`endpoint: ${gatewayUrlFor(auth.root)}${auth.local ? "" : " (remote)"} (${auth.stored ? "stored" : "default"})`,
		`default:  ${gatewayUrlFor(defaultRoot())}`,
		`stored:   pi's auth.json (provider "${PROVIDER_ID}", env ${ROOT_ENV})`,
		"/login magpie changes the endpoint and the key; /logout magpie forgets them",
	];
	const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
	lines.push(`auth: ${status.configured ? (status.label ?? status.source ?? "configured") : "not configured"}`);
	if (await magpieProviderInModelsJson(getAgentDir())) {
		lines.push(
			`note: ${modelsJsonPath(getAgentDir())} also names providers.${PROVIDER_ID} — magpie's static block overrides every model's base URL. Set Pi's model to default in magpie, or drop that block.`,
		);
	}
	return lines;
}

// =============================================================================
// Gateway facts
// =============================================================================

/**
 * The gateway this session talks to: the one `/login magpie` stored, or
 * magpie's own loopback default — installing the extension is enough to reach
 * a magpie on this machine.
 */
async function gatewayAuth(ctx: ExtensionContext): Promise<GatewayAuth> {
	const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID).catch(() => undefined);
	const stored = normalizeRoot(auth?.env?.[ROOT_ENV]);
	const root = stored ?? defaultRoot();
	return {
		root,
		token: auth?.auth.apiKey?.trim() || DEFAULT_TOKEN,
		local: isLoopback(root),
		stored: Boolean(stored),
	};
}

/** The magpie provider that serves a model, asking magpie when the catalog cannot say. */
async function quotaProviderFor(
	magpie: MagpieProviderHandle,
	auth: GatewayAuth,
	modelId: string,
): Promise<string | undefined> {
	const known = magpie.ownedBy(modelId);
	if (known) return known;
	const entry = await fetchModel(auth.root, auth.token, modelId, AbortSignal.timeout(8_000));
	return ownedByEntry(entry);
}

/** The current model's group id, when the model is one of magpie's routing groups. */
function currentGroupId(ctx: ExtensionContext, groups: ReadonlySet<string>): string | undefined {
	const model = ctx.model;
	return model?.provider === PROVIDER_ID && groups.has(shortGroupId(model.id))
		? shortGroupId(model.id)
		: undefined;
}

/** Every model this extension has installed. */
function magpieModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
}

/**
 * The routing groups magpie serves, by id. `magpie groups` is the one place
 * magpie says which models are groups — `group/<id>`, or a found group's
 * `auto/<model>` — so nothing here guesses from a prefix. A magpie without its
 * CLI on PATH answers nothing, and the footer then learns a group from the
 * routing trace, once that group has taken a request.
 */
async function knownGroupIds(auth: GatewayAuth): Promise<Set<string>> {
	const ids = new Set<string>();
	// Another machine's groups are another machine's: its CLI is not this one's.
	if (!auth.local) return ids;
	const run = await runMagpie(["groups"]);
	if (!run.ok) return ids;
	for (const row of parseGroupsList(run.stdout)) ids.add(shortGroupId(row.id));
	return ids;
}

/** A group as the magpie CLI describes it; undefined when it cannot. */
async function groupDefinition(id: string): Promise<GroupInfo | undefined> {
	const run = await runMagpie(["group", id]);
	return run.ok ? parseGroupShow(run.stdout) : undefined;
}

/** A group's last request: the gateway's live trace, else its routing history. */
async function groupRoute(auth: GatewayAuth, id: string): Promise<Route | undefined> {
	const trace = await fetchTrace(auth.root, auth.token, AbortSignal.timeout(8_000));
	if (trace) {
		const route = latestGroupRouteIn(trace, id);
		if (route) return route;
	}
	return lastRouteFor(id);
}

/** The last request through a group, from magpie's routing history. */
async function lastRouteFor(id: string): Promise<Route | undefined> {
	for (const path of await routingDays(2)) {
		const route = latestGroupRoute(await readRoutingTail(path), id);
		if (route) return route;
	}
	return undefined;
}

/** Every group's latest request, from the newest routing day. */
async function groupRoutes(): Promise<Map<string, Route>> {
	const [today] = await routingDays(1);
	if (!today) return new Map();
	return latestRoutesByGroup(await readRoutingTail(today));
}

// =============================================================================
// The models.json warning
// =============================================================================

/**
 * magpie writes `providers.magpie` into pi's models.json whenever one of its
 * models is picked for Pi there. That block changes what this extension's
 * models get: one baseUrl for every model of the provider. Say so once, at
 * startup.
 */
async function warnIfModelsJsonHandlesMagpie(ctx: ExtensionContext): Promise<void> {
	const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
	if (!status.configured) return;
	if (!(await magpieProviderInModelsJson(getAgentDir()))) return;
	const warning = [
		`magpie: ${modelsJsonPath(getAgentDir())} still names providers.${PROVIDER_ID}.`,
		"magpie's static block there overrides every model's base URL (an Anthropic model would be asked at /v1/v1/messages).",
		"Next to it, pi prefers magpie's frozen model list over this extension's live catalog.",
		"Set Pi's model to default in magpie (or delete that block) to let the live catalog through.",
	].join("\n");
	// The same shape pi uses for its own diagnostics: a warning without a TUI.
	if (ctx.hasUI) ctx.ui.notify(warning, "warning");
	else console.warn(warning);
}
