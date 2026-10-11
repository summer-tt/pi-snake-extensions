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
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_TOKEN, GROUP_PREFIX, PROVIDER_ID, ROOT_ENV, STATUS_KEY, STATUS_TTL_MS } from "./constants.ts";
import {
	defaultRoot,
	fetchModel,
	fetchQuotas,
	gatewayUrlFor,
	isLoopback,
	magpieProviderInModelsJson,
	modelsJsonPath,
	normalizeRoot,
	readRoutingTail,
	routingDays,
	runMagpie,
} from "./gateway.ts";
import { quotaView, statusForWidth, type QuotaEntry, type StatusForms } from "./quota.ts";
import {
	describeRoute,
	type GroupInfo,
	groupStatus,
	type GroupListRow,
	latestGroupRoute,
	latestRoutesByGroup,
	parseGroupShow,
	parseGroupsList,
	type Route,
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

	let cache: { key: string; at: number; render: StatusRender } | undefined;
	let generation = 0;
	/** The context the current status was set from, so a resize can repaint it. Released at session_shutdown. */
	let statusCtx: ExtensionContext | undefined;

	const refreshStatus = async (ctx: ExtensionContext, force = false): Promise<void> => {
		if (!ctx.hasUI) return;
		statusCtx = ctx;
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			cache = undefined;
			return;
		}
		const hit = cache;
		if (!force && hit && hit.key === model.id && Date.now() - hit.at < STATUS_TTL_MS) {
			ctx.ui.setStatus(STATUS_KEY, hit.render());
			return;
		}
		const mine = ++generation;
		let render: StatusRender;
		try {
			render = await statusRender(ctx, magpie, model);
		} catch {
			render = () => `${PROVIDER_LABEL} unreachable`;
		}
		if (mine !== generation) return;
		cache = { key: model.id, at: Date.now(), render };
		ctx.ui.setStatus(STATUS_KEY, render());
	};

	// setStatus takes a fixed string, so the width-aware tiers are chosen when it
	// is set: repaint the cached reading at the terminal's new width.
	const repaintOnResize = (): void => {
		const ctx = statusCtx;
		const render = cache?.render;
		if (!ctx?.hasUI || !render) return;
		ctx.ui.setStatus(STATUS_KEY, render());
	};

	pi.on("session_start", async (event, ctx) => {
		// Re-arm per session: a replacement or reload runs a fresh factory while
		// the previous runtime's listener must be gone (off-then-on keeps this
		// idempotent if session_start ever fires twice without a shutdown).
		process.stdout.off("resize", repaintOnResize);
		process.stdout.on("resize", repaintOnResize);
		if (event.reason === "startup") await warnIfModelsJsonHandlesMagpie(ctx);
		await refreshStatus(ctx, true);
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
		process.stdout.off("resize", repaintOnResize);
	});

	pi.on("model_select", (_event, ctx) => {
		void refreshStatus(ctx, true);
	});

	pi.registerCommand("magpie", {
		description: "Magpie gateway — the models, quotas and routing groups it serves",
		getArgumentCompletions: (prefix) => argumentCompletions(prefix, { models: () => magpie.models() }),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const target = rest[0];
			const now = Date.now();
			const lines = await report(ctx, magpie, sub, target, now);
			const unknown = sub !== undefined && !findSubcommand(sub);
			ctx.ui.notify(lines.join("\n"), unknown ? "warning" : "info");
			if (sub === "refresh") await refreshStatus(ctx, true);
		},
	});
}

// =============================================================================
// The footer
// =============================================================================

async function statusRender(
	ctx: ExtensionContext,
	magpie: MagpieProviderHandle,
	model: Model<Api>,
): Promise<StatusRender> {
	const auth = await gatewayAuth(ctx);
	if (model.id.startsWith(GROUP_PREFIX)) {
		const id = model.id.slice(GROUP_PREFIX.length);
		const route = await lastRouteFor(id);
		const info = await groupDefinition(id);
		const status = groupStatus(route, info);
		return () => (status ? `${PROVIDER_LABEL} ${status}` : `${PROVIDER_LABEL} ${model.name}`);
	}
	if (!auth.local) return () => `${PROVIDER_LABEL} ${model.name}`;
	const provider = await quotaProviderFor(magpie, auth, model.id);
	if (!provider) return () => `${PROVIDER_LABEL} ${model.name}`;
	const entries = await fetchQuotas(auth.root, auth.token, AbortSignal.timeout(8_000));
	const view = quotaView(entries, provider);
	const forms = view.status;
	if (!forms) return () => `${PROVIDER_LABEL} ${provider} — no quota reported`;
	return () => statusForWidth(forms, statusBudget(), PROVIDER_LABEL, STATUS_LABEL_CUT);
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
): Promise<string[]> {
	switch (sub) {
		case "quota":
			return quotaReport(ctx, magpie, target, now);
		case "group":
			return groupReport(ctx, target);
		case "groups":
			return groupsReport(ctx, magpie);
		case "refresh":
			return refreshReport(ctx);
		case "endpoint":
			return endpointReport(ctx);
		case "help":
			return helpReport();
		case undefined:
			return overviewReport(ctx, magpie, now);
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
): Promise<string[]> {
	const auth = await gatewayAuth(ctx);
	const models = magpieModels(ctx);
	const groups = models.filter((model) => model.id.startsWith(GROUP_PREFIX)).length;
	const lines = [
		`${PROVIDER_LABEL} · ${gatewayUrlFor(auth.root)} · ${
			auth.local ? "this machine" : "remote"
		} · ${auth.stored ? "logged in" : "default gateway"}`,
		`catalog: ${count(models.length, "model")}${groups > 0 ? ` · ${count(groups, "routing group")}` : ""}`,
	];
	const model = ctx.model;
	if (model?.provider === PROVIDER_ID) {
		lines.push(`current: ${model.name} (${model.id}) · ${model.api}`);
		lines.push(...(await currentLines(ctx, magpie, auth, now)).map((line) => `  ${line}`));
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
): Promise<string[]> {
	const model = ctx.model;
	if (!model || model.provider !== PROVIDER_ID) return [];
	if (model.id.startsWith(GROUP_PREFIX)) {
		return groupReport(ctx, model.id.slice(GROUP_PREFIX.length));
	}
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
	if (model.id.startsWith(GROUP_PREFIX)) {
		return [
			`${model.id} is a routing group — a group has no quota of its own`,
			...(await groupReport(ctx, model.id.slice(GROUP_PREFIX.length))),
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

async function groupReport(ctx: ExtensionContext, id: string | undefined): Promise<string[]> {
	const groupId = id?.replace(/^group\//, "") ?? currentGroupId(ctx);
	if (!groupId) return ["the current model is not a routing group — name one: /magpie group <id>"];
	const lines: string[] = [];
	const info = await groupDefinition(groupId);
	if (info) {
		lines.push(`group/${groupId}${info.name ? ` · ${info.name}` : ""}${info.auto ? " · found by magpie" : ""}`);
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
		lines.push(`group/${groupId} — magpie did not describe it (is the magpie CLI on PATH?)`);
	}
	const route = await lastRouteFor(groupId);
	if (route) lines.push(...describeRoute(route));
	else lines.push("  no request through it in the routing history yet");
	return lines;
}

async function groupsReport(ctx: ExtensionContext, magpie: MagpieProviderHandle): Promise<string[]> {
	const rows = new Map<string, GroupListRow>();
	const cli = await runMagpie(["groups"]);
	if (cli.ok) {
		for (const row of parseGroupsList(cli.stdout)) rows.set(row.id, row);
	}
	const here = currentGroupId(ctx);
	const current = here ? `group/${here}` : undefined;
	const routes = await groupRoutes();
	const catalog = magpie.models();
	const served = catalog.filter((model) => model.id.startsWith(GROUP_PREFIX));
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
		const here = id === current ? "  ← current" : "";
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

function currentGroupId(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model?.provider === PROVIDER_ID && model.id.startsWith(GROUP_PREFIX)
		? model.id.slice(GROUP_PREFIX.length)
		: undefined;
}

/** Every model this extension has installed. */
function magpieModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
}

/** A group as the magpie CLI describes it; undefined when it cannot. */
async function groupDefinition(id: string): Promise<GroupInfo | undefined> {
	const run = await runMagpie(["group", id]);
	return run.ok ? parseGroupShow(run.stdout) : undefined;
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
