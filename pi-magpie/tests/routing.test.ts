import { test } from "node:test";
import assert from "node:assert/strict";
import {
	abbrevProvider,
	describeRoute,
	groupStatus,
	latestGroupRoute,
	latestRoutesByGroup,
	parseGroupsList,
	parseGroupShow,
	parseRoute,
	routeClock,
	splitMembers,
	stripAnsi,
	weighedText,
} from "../routing.ts";

// Captured from `magpie group group/auto-mimo-v2-6-flash`.
const SHOW = `  MiMo-V2.6-Flash  group/auto-mimo-v2-6-flash  found by magpie — changing it makes it yours
  routing   smart
  stays     auto
  models    1 opencode-go/mimo-v2.6-flash  OpenCode Go · MiMo-V2.6-Flash
            2 xiaomi/mimo-v2.6-flash  Xiaomi MiMo · MiMo-V2.6-Flash
`;

// The same shape for a hand-made manual group with a rule, classifier and levels.
const MANUAL = `  Relay  group/relay  removed · magpie group restore relay
  routing   manual  every request to c/luna; magpie group pick relay <model> picks another
  stays     session
  models    1 a/sol
            2 c/luna ●
  rules     1 under 100000 tokens
  levels    low, medium, high  offered to agents; a model without the one asked is sent its nearest
  effort    auto  the classifier picks each turn's reasoning
  classifier fast/judge  rates how hard each turn is
  used by   pi, claude
`;

// Captured from `magpie groups`.
const LIST = `  DeepSeek V4.1 Flash found  group/auto-deepseek-v4-1-flash  smart  opencode-go/deepseek-v4.1-flash · workbuddy/deepseek-v4.1-flash
  MiMo-V2.6-Flash found      group/auto-mimo-v2-6-flash      smart  opencode-go/mimo-v2.6-flash · xiaomi/mimo-v2.6-flash
  Relay                      group/relay                      manual · stays session  ● c/luna  ← pi
`;

test("stripAnsi: magpie's colors are not part of its text", () => {
	assert.equal(stripAnsi("\u001b[1mMiMo\u001b[0m and \u001b[2mfound\u001b[0m"), "MiMo and found");
});

test("parseGroupShow: a found group as magpie describes it", () => {
	const info = parseGroupShow(SHOW);
	assert.equal(info?.id, "group/auto-mimo-v2-6-flash");
	assert.equal(info?.name, "MiMo-V2.6-Flash");
	assert.equal(info?.auto, true);
	assert.equal(info?.removed, false);
	assert.equal(info?.routing, "smart");
	assert.equal(info?.stays, "auto");
	assert.deepEqual(info?.members, ["opencode-go/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"]);
	assert.equal(info?.picked, undefined);
});

test("parseGroupShow: a manual group's pick, rules, levels and classifier", () => {
	const info = parseGroupShow(MANUAL);
	assert.equal(info?.id, "group/relay");
	assert.equal(info?.name, "Relay");
	assert.equal(info?.removed, true);
	assert.equal(info?.routing, "manual");
	assert.equal(info?.stays, "session");
	assert.deepEqual(info?.members, ["a/sol", "c/luna"]);
	assert.equal(info?.picked, "c/luna");
	assert.deepEqual(info?.rules, ["under 100000 tokens"]);
	assert.equal(info?.levels, "low, medium, high");
	assert.equal(info?.effort, "auto");
	assert.equal(info?.classifier, "fast/judge");
	assert.equal(info?.usedBy, "pi, claude");
});

test("parseGroupShow: text without a group is not a group", () => {
	assert.equal(parseGroupShow(""), undefined);
	assert.equal(parseGroupShow("no routing groups yet"), undefined);
});

test("parseGroupsList: the id, its routing and the members' order", () => {
	const rows = parseGroupsList(LIST);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0], {
		id: "group/auto-deepseek-v4-1-flash",
		name: "DeepSeek V4.1 Flash",
		routing: "smart",
		stays: undefined,
		members: ["opencode-go/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash"],
		usedBy: undefined,
		auto: true,
	});
	assert.equal(rows[1]?.name, "MiMo-V2.6-Flash");
	assert.equal(rows[2]?.routing, "manual");
	assert.equal(rows[2]?.stays, "session");
	assert.deepEqual(rows[2]?.members, ["c/luna"]);
	assert.equal(rows[2]?.usedBy, "pi");
});

test("splitMembers: the separators magpie joins members with", () => {
	assert.deepEqual(splitMembers("a/x · b/y"), ["a/x", "b/y"]);
	assert.deepEqual(splitMembers("a/x → b/y"), ["a/x", "b/y"]);
	assert.deepEqual(splitMembers("● c/luna"), ["c/luna"]);
	assert.deepEqual(splitMembers("a/x (not served)"), ["a/x"]);
});

const GROUP_ROUTE = JSON.stringify({
	time: "2026-09-30T09:41:50.045683+08:00",
	agent: "pi",
	model: "group/auto-mimo-v2-6-flash",
	provider: "opencode-go",
	group: {
		id: "auto-mimo-v2-6-flash",
		name: "MiMo-V2.6-Flash",
		routing: "smart",
		affinity: "session",
		auto: true,
		members: ["opencode-go/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
	},
	affinity: { mode: "session", turn: 4, last: "opencode-go", why: "no-cache" },
	order: [
		{ id: "opencode-go", provider: "opencode-go", name: "OpenCode Go", who: "key-1", model: "mimo-v2.6-flash", used: 34, renews: ["2026-10-04T01:14:46+08:00"] },
		{ id: "xiaomi", provider: "xiaomi", name: "Xiaomi MiMo", used: 0, renews: ["2026-10-07T09:41:50+08:00"], turn: true },
	],
	tries: [
		{ id: "opencode-go", model: "mimo-v2.6-flash", status: 500, fail: "resting", millis: 1200 },
		{ id: "xiaomi", model: "mimo-v2.6-flash", millis: 800 },
	],
	served: "mimo-v2.6-flash",
	tokens: 1234,
});

const PHYSICAL_ROUTE = JSON.stringify({
	time: "2026-09-30T09:46:31.182768+08:00",
	agent: "intovibe",
	model: "codex/gpt-5.6-luna",
	provider: "codex",
	order: [{ id: "codex", provider: "codex", who: "a@b.c", used: 12 }],
	tries: [{ id: "codex", model: "gpt-5.6-luna", millis: 900 }],
});

test("parseRoute: a line of magpie's routing history", () => {
	const route = parseRoute(GROUP_ROUTE);
	assert.equal(route?.group?.id, "auto-mimo-v2-6-flash");
	assert.equal(route?.group?.routing, "smart");
	assert.equal(route?.tries?.length, 2);
	assert.equal(parseRoute(""), undefined);
	assert.equal(parseRoute("not json"), undefined);
	assert.equal(parseRoute("{oops"), undefined);
});

test("latestGroupRoute: the newest line for the group, either spelling", () => {
	const text = [PHYSICAL_ROUTE, GROUP_ROUTE].join("\n");
	assert.equal(latestGroupRoute(text, "auto-mimo-v2-6-flash")?.served, "mimo-v2.6-flash");
	assert.equal(latestGroupRoute(text, "group/auto-mimo-v2-6-flash")?.served, "mimo-v2.6-flash");
	assert.equal(latestGroupRoute(text, "relay"), undefined);
});

test("latestRoutesByGroup: every group's last request in one pass", () => {
	const routes = latestRoutesByGroup([PHYSICAL_ROUTE, GROUP_ROUTE, PHYSICAL_ROUTE].join("\n"));
	assert.deepEqual([...routes.keys()], ["auto-mimo-v2-6-flash"]);
	assert.equal(routes.get("auto-mimo-v2-6-flash")?.group?.routing, "smart");
});

test("describeRoute: who was weighed, what was tried, what answered", () => {
	const route = parseRoute(GROUP_ROUTE);
	assert.ok(route);
	const now = Date.parse("2026-09-30T09:42:00+08:00");
	const lines = describeRoute(route, now);
	assert.equal(lines[0], "last route: just now · asked by pi");
	assert.equal(lines[1], "  group: smart · stays session · MiMo-V2.6-Flash");
	assert.equal(lines[2], "  members: opencode-go/mimo-v2.6-flash → xiaomi/mimo-v2.6-flash");
	assert.equal(lines[3], "  affinity: no-cache");
	assert.equal(lines[4], "  weighed:");
	assert.equal(lines[5], "    1. mimo-v2.6-flash on key-1, 34% used, renews 4d");
	assert.equal(lines[6], "    2. Xiaomi MiMo, 0% used, renews 2026-10-07, its turn");
	assert.equal(lines[7], "  tried opencode-go → mimo-v2.6-flash: failed 1200ms — resting");
	assert.equal(lines[8], "  tried xiaomi → mimo-v2.6-flash: ok 800ms");
	assert.equal(lines[9], "  served: mimo-v2.6-flash");
	assert.equal(lines[10], "  tokens: 1234");
});

test("describedRoute: a physical request has no group", () => {
	const route = parseRoute(PHYSICAL_ROUTE);
	assert.ok(route);
	const lines = describeRoute(route, Date.parse("2026-09-30T10:00:00+08:00"));
	assert.equal(lines[0], "last route: 13m ago · asked by intovibe");
	assert.equal(lines.some((line) => line.includes("group:")), false);
	assert.equal(lines[1], "  weighed:");
});

test("groupStatus: routing and who answered, else the count", () => {
	const route = parseRoute(GROUP_ROUTE);
	// Every member is mimo-v2.6-flash, so the provider alone carries the news —
	// spelled out, there is room for it.
	assert.equal(groupStatus(route, undefined), "smart → opencode-go");
	assert.equal(groupStatus(undefined, parseGroupShow(SHOW)), "smart 2 models");
	assert.equal(groupStatus(undefined, undefined), undefined);
});

// A group whose members ask for different models, answered by a long-named one.
const MIXED_ROUTE = JSON.stringify({
	time: "2026-09-30T10:00:00+08:00",
	model: "group/multi",
	provider: "antigravity",
	group: {
		id: "multi",
		routing: "order",
		members: ["antigravity/gemini-3.8-flash", "openai-proxy/gpt-6-luna"],
	},
	tries: [{ id: "antigravity", model: "gemini-3.8-flash", millis: 900 }],
	served: "gemini-3.8-flash",
});

test("groupStatus: provider alone for one model, provider and model for several", () => {
	assert.equal(groupStatus(parseRoute(MIXED_ROUTE), undefined), "order → ant..ity/gemini-3.8-flash");
});

test("groupStatus: the provider magpie does not name comes from the members", () => {
	const route = parseRoute(
		JSON.stringify({
			model: "group/solo",
			group: { id: "solo", routing: "smart", members: ["opencode-go/mimo-v2.6-flash"] },
			served: "mimo-v2.6-flash",
		}),
	);
	assert.equal(groupStatus(route, undefined), "smart → opencode-go");
	// No provider anywhere and members that differ: only the model is known.
	const blind = parseRoute(
		JSON.stringify({ model: "group/two", served: "gpt-6-luna", group: { id: "two", members: ["a/x", "b/y"] } }),
	);
	assert.equal(groupStatus(blind, undefined), "→ gpt-6-luna");
});

test("abbrevProvider: eight columns, cut in the middle", () => {
	assert.equal(abbrevProvider("xiaomi"), "xiaomi");
	assert.equal(abbrevProvider("antigravity"), "ant..ity");
	assert.equal(abbrevProvider("anthropic"), "ant..pic");
	assert.equal(abbrevProvider("opencode-go"), "ope..go");
	assert.equal(abbrevProvider("abcdefghijkl"), "abc..jkl");
});

test("routeClock and weighedText read a route for people", () => {
	const route = parseRoute(GROUP_ROUTE);
	assert.ok(route);
	assert.equal(routeClock(route, Date.parse("2026-09-30T09:41:00+08:00")), "just now");
	assert.equal(routeClock(route, Date.parse("2026-09-30T11:41:50+08:00")), "2h ago");
	assert.equal(routeClock({}, Date.now()), "?");
	assert.equal(weighedText({ who: "a@b.c" }), "a@b.c");
	assert.equal(weighedText({ provider: "codex", used: 0 }), "codex, 0% used");
	assert.equal(weighedText({ name: "Codex" }), "Codex");
	assert.equal(weighedText({}), "?");
});
