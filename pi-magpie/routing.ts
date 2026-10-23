/**
 * pi-magpie — routing groups: what the magpie CLI says a group is, and how the
 * last request through it actually went.
 *
 * The definitions come from `magpie group <id>` (magpie's own public reading of
 * a group) and the last decision from the gateway's live routing trace
 * (`GET /v1/magpie/trace`, this machine only) or, when that cannot answer,
 * from magpie's routing history: one JSON object per completed request, written
 * by the gateway under `~/.config/magpie/routing/<day>.jsonl`
 * (internal/gateway/trace.go).
 */

/** A routing group as `magpie group <id>` describes it. */
export interface GroupInfo {
	id?: string;
	name?: string;
	/** magpie found this group rather than the user making it. */
	auto?: boolean;
	removed?: boolean;
	/** smart / order / rotate / usage / manual. */
	routing?: string;
	/** auto / session / turn / off. */
	stays?: string;
	levels?: string;
	effort?: string;
	classifier?: string;
	usedBy?: string;
	/** Member ids, in the group's order, as "provider/model[:effort]". */
	members: string[];
	/** The member a manual group sends everything to. */
	picked?: string;
	rules: string[];
}

/** One line of `magpie groups`. */
export interface GroupListRow {
	id: string;
	name?: string;
	routing?: string;
	stays?: string;
	members: string[];
	usedBy?: string;
	auto?: boolean;
}

/** One account or key as routing weighed it (gateway trace.go, Weighed). */
export interface RouteWeighed {
	/** What rests after a failure. */
	id?: string;
	provider?: string;
	name?: string;
	who?: string;
	kind?: string;
	plan?: string;
	model?: string;
	/** Share of its allowance used, 0–100. */
	used?: number;
	/** When those windows renew, the biggest first. */
	renews?: string[];
	/** In turn: it was this one's turn. */
	turn?: boolean;
}

/** One candidate trying a request (gateway trace.go, Try). */
export interface RouteTry {
	id?: string;
	model?: string;
	effort?: string;
	status?: number;
	fail?: string;
	error?: string;
	millis?: number;
}

/** The group a request asked for (gateway trace.go, GroupRef). */
export interface RouteGroup {
	id?: string;
	/** The id magpie's catalog gives it: `group/<id>`, or a found group's `auto/<model>`. */
	ref?: string;
	name?: string;
	routing?: string;
	affinity?: string;
	auto?: boolean;
	/** Members ready to take it, in order. */
	members?: string[];
}

/** The conversation's affinity, and whether it stayed put (gateway trace.go). */
export interface RouteAffinity {
	mode?: string;
	turn?: number;
	last?: string;
	/** session, turn, cache — or why it did not stay. */
	why?: string;
	kept?: boolean;
}

/** One completed request's way through routing (gateway trace.go, Route). */
export interface Route {
	time?: string;
	agent?: string;
	/** The model as the agent asked, so a group's id. */
	model?: string;
	/** The provider the model resolved to. */
	provider?: string;
	group?: RouteGroup;
	affinity?: RouteAffinity;
	order?: RouteWeighed[];
	tries?: RouteTry[];
	served?: string;
	status?: number;
	error?: string;
	millis?: number;
	tokens?: number;
}

/**
 * One try as the live routing trace tells it (gateway trace.go, Try): the same
 * attempt as the history's, timed in `ms` rather than `millis`.
 */
export interface TraceTry {
	id?: string;
	model?: string;
	effort?: string;
	status?: number;
	fail?: string;
	error?: string;
	ms?: number;
}

/**
 * One request as `GET /v1/magpie/trace` tells it: the decision the gateway
 * holds in memory, which is what the footer reads — no file to tail, no CLI to
 * run, and the last route changes the moment a request completes.
 */
export interface TraceRoute {
	time?: string;
	agent?: string;
	model?: string;
	provider?: string;
	group?: RouteGroup;
	affinity?: RouteAffinity;
	served?: string;
	status?: number;
	error?: string;
	tokens?: number;
	tries?: TraceTry[];
}

// =============================================================================
// magpie CLI output
// =============================================================================

/** eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;]*m/g;

/** magpie's CLI output without its colors. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Two or more spaces: magpie's column separator. */
const COLUMN = /\s{2,}/;

/**
 * A group's id as magpie lists it: `group/<id>` for one the user made, and
 * `auto/<model>` for one magpie found — the model's own id after the slash, so
 * a client reading it as a model id knows the model
 * (internal/provider/autoref.go).
 */
const GROUP_REF = "(?:group/[a-z0-9][a-z0-9-]*|auto/[^\\s]+)";
const GROUP_REF_LINE = new RegExp(`^${GROUP_REF}$`);

/**
 * A field of `magpie group <id>`: two spaces, a key padded to nine columns, a
 * space, then the value. Long keys (`classifier`) are not padded, so the keys
 * are matched rather than counted.
 */
const GROUP_FIELD = /^\s{2}(used by|routing|stays|models|rules|levels|effort|classifier)\s+(.*)$/;

/** A member or rule that did not fit on its key's first line. */
const GROUP_CONTINUATION = /^\s{12,}(\S.*)$/;

const ROUTINGS = new Set(["smart", "order", "rotate", "usage", "manual"]);

/** `magpie group <id>` as a group's definition. */
export function parseGroupShow(text: string): GroupInfo | undefined {
	const info: GroupInfo = { members: [], rules: [] };
	let field: string | undefined;
	for (const raw of stripAnsi(text).split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;
		const header = new RegExp(`^\\s+(.*?)\\s{2,}(${GROUP_REF})(.*)$`).exec(line);
		if (header && !info.id) {
			info.id = header[2];
			info.name = header[1].replace(/\s+found$/, "").trim();
			info.auto = /found by magpie/.test(header[3]);
			info.removed = /\bremoved\b/.test(header[3]);
			continue;
		}
		const match = GROUP_FIELD.exec(line);
		if (match) {
			field = match[1];
			applyGroupField(info, field, match[2] ?? "", line.includes("●"));
			continue;
		}
		// A member or rule that did not fit on its key's first line.
		if (field) {
			const continuation = GROUP_CONTINUATION.exec(line);
			if (continuation) applyGroupField(info, field, continuation[1] ?? "", line.includes("●"));
		}
	}
	if (!info.id) return undefined;
	return info;
}

function applyGroupField(info: GroupInfo, key: string, value: string, pickedHere: boolean): void {
	const trimmed = value.trim();
	// magpie pads a value's own text after two spaces with its reading of it.
	const first = trimmed.split(COLUMN)[0]?.trim() || trimmed;
	switch (key) {
		case "routing":
			info.routing = first.split(/\s+/)[0] || undefined;
			break;
		case "stays":
			info.stays = first.split(/\s+/)[0] || undefined;
			break;
		case "models":
			addMember(info, trimmed, pickedHere);
			break;
		case "rules":
			// magpie numbers its rules; the report numbers them again.
			info.rules.push(first.replace(/^\d+\s+/, ""));
			break;
		case "levels":
			info.levels = first || undefined;
			break;
		case "effort":
			info.effort = first.split(/\s+/)[0] || undefined;
			break;
		case "classifier":
			info.classifier = first.split(/\s+/)[0] || undefined;
			break;
		case "used by":
			info.usedBy = first || undefined;
			break;
	}
}

/** `1 opencode-go/mimo-v2.6-flash ●  OpenCode Go · MiMo` → the member id. */
function addMember(info: GroupInfo, text: string, picked: boolean): void {
	const match = /^\s*(\d+)\s+(\S+)/.exec(text);
	if (!match) return;
	const id = match[2];
	if (!info.members.includes(id)) info.members.push(id);
	if (picked) info.picked = id;
}

/** `magpie groups` as a list of rows. */
export function parseGroupsList(text: string): GroupListRow[] {
	const rows: GroupListRow[] = [];
	for (const raw of stripAnsi(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const columns = line.split(COLUMN);
		const idIndex = columns.findIndex((column) => GROUP_REF_LINE.test(column.trim()));
		if (idIndex < 0) continue;
		const row: GroupListRow = {
			id: columns[idIndex].trim(),
			name: undefined,
			routing: undefined,
			stays: undefined,
			members: [],
			usedBy: undefined,
			auto: false,
		};
		const name = columns.slice(0, idIndex).join(" ").replace(/\s+found$/, "").trim();
		if (name) row.name = name;
		row.auto = /found/.test(columns.slice(0, idIndex).join(" "));
		const how = columns[idIndex + 1]?.trim();
		if (how) {
			const [routing, stays] = how.split(/\s+·\s+/);
			if (routing && ROUTINGS.has(routing.split(/\s+/)[0] ?? "")) row.routing = routing.split(/\s+/)[0];
			if (stays?.startsWith("stays")) row.stays = stays.replace(/^stays\s+/, "").trim();
		}
		const members = columns[idIndex + 2]?.trim();
		if (members) row.members = splitMembers(members);
		const usedBy = columns.find((column) => column.startsWith("←"));
		if (usedBy) row.usedBy = usedBy.replace(/^←\s*/, "").trim();
		rows.push(row);
	}
	return rows;
}

/** `● a/x · b/y` or `a/x → b/y` → the model ids. */
export function splitMembers(text: string): string[] {
	return text
		.split(/\s+(?:·|→)\s+/)
		.map((member) =>
			member
				.replace(/^●\s*/, "")
				.replace(/\s*\(not served\)\s*$/, "")
				.trim(),
		)
		.filter((member) => member.length > 0);
}

// =============================================================================
// The routing history
// =============================================================================

/** One line of a routing-history file as a route, when it parses. */
export function parseRoute(line: string): Route | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed[0] !== "{") return undefined;
	try {
		const parsed = JSON.parse(trimmed) as Route;
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The latest route a group took, newest line first, either spelling of its id. */
export function latestGroupRoute(text: string, groupId: string): Route | undefined {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const route = parseRoute(lines[index] ?? "");
		if (route && routeMatchesGroup(route, groupId)) return route;
	}
	return undefined;
}

/** `group/relay` and `relay` name the same group. */
export function shortGroupId(id: string): string {
	return id.replace(/^group\//, "");
}

/**
 * The ids a route names its group by: the catalog's own (`auto/<model>` or
 * `group/<id>`), the id magpie keeps inside (`auto-<slug>` or `<id>`), and
 * `group/<id>`. Whichever an agent sent, one of them is the model's id.
 */
function groupNames(route: Route): string[] {
	const names: string[] = [];
	if (route.group?.ref) names.push(shortGroupId(route.group.ref));
	if (route.group?.id) names.push(shortGroupId(route.group.id));
	if (route.model) names.push(shortGroupId(route.model));
	return names;
}

/** Whether a route went through the group this id names, however it is spelt. */
export function routeMatchesGroup(route: Route, groupId: string): boolean {
	const wanted = shortGroupId(groupId);
	return wanted !== "" && groupNames(route).includes(wanted);
}

/** The latest route of each group, by group id: the whole day in one pass. */
export function latestRoutesByGroup(text: string): Map<string, Route> {
	const routes = new Map<string, Route>();
	for (const line of text.split(/\r?\n/)) {
		const route = parseRoute(line);
		if (!route) continue;
		const id = route.group?.id ?? (route.model?.startsWith("group/") ? route.model : undefined);
		if (id) routes.set(id, route);
	}
	return routes;
}

/** The latest route of any kind through one model id. */
export function latestRoute(text: string, modelId: string): Route | undefined {
	const lines = text.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const route = parseRoute(lines[index] ?? "");
		if (route && (route.model === modelId || route.group?.id === modelId)) return route;
	}
	return undefined;
}

// =============================================================================
// The live trace
// =============================================================================

/** A trace route as the routing history's route, so one reading serves both. */
export function traceToRoute(route: TraceRoute): Route {
	return {
		time: route.time,
		agent: route.agent,
		model: route.model,
		provider: route.provider,
		group: route.group,
		affinity: route.affinity,
		served: route.served,
		status: route.status,
		error: route.error,
		tokens: route.tokens,
		tries: (route.tries ?? []).map((attempt) => ({
			id: attempt.id,
			model: attempt.model,
			effort: attempt.effort,
			status: attempt.status,
			fail: attempt.fail,
			error: attempt.error,
			millis: attempt.ms,
		})),
	};
}

/** The latest route through a group in a trace, oldest first as the trace tells it. */
export function latestGroupRouteIn(routes: readonly TraceRoute[], groupId: string): Route | undefined {
	const wanted = shortGroupId(groupId);
	if (!wanted) return undefined;
	let latest: TraceRoute | undefined;
	for (const route of routes) {
		if (routeMatchesGroup(route, wanted)) latest = route;
	}
	return latest ? traceToRoute(latest) : undefined;
}

/** A route's time as a clock, for the header line. */
export function routeClock(route: Route, now = Date.now()): string {
	const at = route.time ? Date.parse(route.time) : Number.NaN;
	if (!Number.isFinite(at)) return "?";
	const age = now - at;
	if (age < 60_000) return "just now";
	const minutes = Math.round(age / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(age / 3_600_000);
	if (hours < 48) return `${hours}h ago`;
	return new Date(at).toISOString().slice(0, 10);
}

/** A candidate as one reading: who it is, what it has left. */
export function weighedText(weighed: RouteWeighed, now = Date.now()): string {
	const who = weighed.who?.trim() || weighed.name?.trim() || weighed.provider || weighed.id || "?";
	const parts = [who];
	if (typeof weighed.used === "number" && Number.isFinite(weighed.used)) {
		parts.push(`${Math.round(weighed.used)}% used`);
	}
	const renew = weighed.renews?.find((at) => {
		const time = Date.parse(at);
		return Number.isFinite(time);
	});
	if (renew) {
		const when = formatWhen(Date.parse(renew), now);
		if (when) parts.push(`renews ${when}`);
	}
	if (weighed.turn) parts.push("its turn");
	return parts.join(", ");
}

function formatWhen(at: number, now: number): string | undefined {
	const left = at - now;
	if (!Number.isFinite(left)) return undefined;
	if (left <= 60_000) return "now";
	const minutes = Math.round(left / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(left / 3_600_000);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(left / 86_400_000);
	if (days < 7) return `${days}d`;
	return new Date(at).toISOString().slice(0, 10);
}

/** How the last request through a group actually went, as `/magpie` prints it. */
export function describeRoute(route: Route, now = Date.now()): string[] {
	const lines: string[] = [];
	const head = [`${routeClock(route, now)}`];
	if (route.agent) head.push(`asked by ${route.agent}`);
	lines.push(`last route: ${head.join(" · ")}`);
	const group = route.group;
	if (group) {
		const how = [group.routing || "smart"];
		if (group.affinity) how.push(`stays ${group.affinity}`);
		if (group.name) how.push(group.name);
		lines.push(`  group: ${how.join(" · ")}`);
		if (group.members?.length) lines.push(`  members: ${group.members.join(" → ")}`);
	}
	if (route.affinity?.why) {
		lines.push(`  affinity: ${route.affinity.why}${route.affinity.kept ? " (stayed put)" : ""}`);
	}
	const order = route.order ?? [];
	if (order.length > 0) {
		lines.push("  weighed:");
		order.forEach((weighed, index) => {
			lines.push(`    ${index + 1}. ${weighed.model ? `${weighed.model} on ` : ""}${weighedText(weighed, now)}`);
		});
	}
	const tries = route.tries ?? [];
	for (const attempt of tries) {
		const who = attempt.id ?? "?";
		const where = attempt.model && attempt.model !== who ? `${who} → ${attempt.model}` : who;
		const took = typeof attempt.millis === "number" ? ` ${Math.round(attempt.millis)}ms` : "";
		if (attempt.fail || (attempt.status !== undefined && attempt.status >= 400)) {
			const why = attempt.error?.trim() || attempt.fail || `HTTP ${attempt.status}`;
			lines.push(`  tried ${where}: failed${took} — ${why}`);
		} else {
			lines.push(`  tried ${where}: ok${took}`);
		}
	}
	if (route.served) lines.push(`  served: ${route.served}`);
	if (typeof route.tokens === "number") lines.push(`  tokens: ${route.tokens}`);
	return lines;
}

/** The footer reading of a group: its routing, and who answered last. */
export function groupStatus(route: Route | undefined, info: GroupInfo | undefined): string | undefined {
	const routing = route?.group?.routing || info?.routing;
	const served = route?.served || route?.tries?.[route.tries.length - 1]?.model;
	// The members decide whether the model is news: the definition magpie gives
	// now, else the list the last request was routed with.
	const members = info?.members?.length ? info.members : route?.group?.members ?? [];
	const provider = route?.provider || route?.tries?.[route.tries.length - 1]?.id || soleProvider(members);
	const parts: string[] = [];
	if (routing) parts.push(routing);
	if (served) parts.push(`→ ${answerText(provider, served, members)}`);
	else if (members.length > 0) parts.push(`${members.length} models`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Who answered, as the footer says it: the provider alone — spelled out, it
 * is the whole story — while every member is the same model (the model
 * carries no news, only the provider varies), provider and model when the
 * members differ, a long provider cut to `ant..ity` only there. A provider
 * the facts do not name leaves the model alone.
 */
function answerText(provider: string | undefined, served: string, members: string[]): string {
	if (!provider) return served;
	return oneModel(members) ? provider : `${abbrevProvider(provider)}/${served}`;
}

/** How wide a provider id may get in the footer before it is cut. */
const PROVIDER_CUT = 8;

/**
 * A provider id for the footer: at most `PROVIDER_CUT` characters, longer ones
 * cut in the middle with `..` — `antigravity` → `ant..ity`.
 */
export function abbrevProvider(id: string): string {
	if (id.length <= PROVIDER_CUT) return id;
	const keep = (PROVIDER_CUT - 2) / 2;
	// Cut short of a separator, so `opencode-go` does not end in `..-go`.
	const head = id.slice(0, keep).replace(/[-_.]+$/, "") || id.slice(0, keep);
	const tail = id.slice(-keep).replace(/^[-_.]+/, "") || id.slice(-keep);
	return `${head}..${tail}`;
}

/** Whether every member asks for one model — they differ only in provider. */
function oneModel(members: string[]): boolean {
	const model = members[0] === undefined ? undefined : memberModel(members[0]);
	return model !== undefined && members.every((member) => memberModel(member) === model);
}

/** A member id's model half: `opencode-go/mimo-v2.6-flash:high` → `mimo-v2.6-flash`. */
function memberModel(member: string): string {
	const slash = member.indexOf("/");
	const model = slash < 0 ? member : member.slice(slash + 1);
	return model.replace(/:[^:]*$/, "");
}

/** The one provider every member names, when a single provider serves them all. */
function soleProvider(members: string[]): string | undefined {
	let sole: string | undefined;
	for (const member of members) {
		const slash = member.indexOf("/");
		if (slash <= 0) continue;
		const provider = member.slice(0, slash);
		if (sole === undefined) sole = provider;
		else if (sole !== provider) return undefined;
	}
	return sole;
}
