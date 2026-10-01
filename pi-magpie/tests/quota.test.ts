import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatReset,
	quotaView,
	remainingPercent,
	selectQuotas,
	statusLine,
	tightestWindow,
	windowText,
	type QuotaEntry,
} from "../quota.ts";

const NOW = Date.parse("2026-10-01T12:00:00+08:00");

const codex: QuotaEntry = {
	provider: "codex",
	name: "Codex",
	kind: "subscription",
	plan: "plus",
	user: "tffan@tutamail.com",
	windows: [
		{ name: "5 hours", used: 3, remaining: 97, resetsAt: "2026-10-01T15:49:23+08:00" },
		{ name: "7 days", used: 84, remaining: 16, resetsAt: "2026-10-04T01:14:46+08:00" },
	],
};

const workbuddy: QuotaEntry = {
	provider: "workbuddy",
	name: "WorkBuddy",
	kind: "subscription",
	plan: "Free",
	user: "孙小猫",
	windows: [{ name: "Credits", used: 0, remaining: 100, display: "0 / 6900" }],
};

test("remainingPercent: from remaining, else from used, clamped", () => {
	assert.equal(remainingPercent({ remaining: 16.4 }), 16.4);
	assert.equal(remainingPercent({ used: 84 }), 16);
	assert.equal(remainingPercent({ remaining: -5 }), 0);
	assert.equal(remainingPercent({ remaining: 140 }), 100);
	assert.equal(remainingPercent({}), undefined);
});

test("windowText: the vendor's own wording wins", () => {
	assert.equal(windowText({ display: "0 / 6900", remaining: 100 }), "0 / 6900");
	assert.equal(windowText({ remaining: 84.4 }), "84%");
	assert.equal(windowText({ used: 16 }), "84%");
	assert.equal(windowText({}), "?");
});

test("selectQuotas: only the model's provider", () => {
	assert.deepEqual(
		selectQuotas([codex, workbuddy], "codex").map((entry) => entry.provider),
		["codex"],
	);
	assert.deepEqual(selectQuotas([codex, workbuddy], "gemini"), []);
});

test("tightestWindow: the least left, then the soonest to reset", () => {
	const tight = tightestWindow([codex, workbuddy]);
	assert.equal(tight?.entry.provider, "codex");
	assert.equal(tight?.window.name, "7 days");
	// Equal windows: the one resetting first wins.
	const equal = tightestWindow([
		{ provider: "p", windows: [{ name: "late", remaining: 50, resetsAt: "2026-10-09T00:00:00Z" }] },
		{ provider: "p", windows: [{ name: "soon", remaining: 50, resetsAt: "2026-10-02T00:00:00Z" }] },
	]);
	assert.equal(equal?.window.name, "soon");
	assert.equal(tightestWindow([{ provider: "p" }]), undefined);
});

test("formatReset: as magpie's own clock reads it", () => {
	assert.equal(formatReset(undefined, NOW), undefined);
	assert.equal(formatReset("not a date", NOW), undefined);
	assert.equal(formatReset("2026-10-01T11:59:30+08:00", NOW), "now");
	assert.equal(formatReset("2026-10-01T14:30:00+08:00", NOW), "3h");
	assert.equal(formatReset("2026-10-04T01:14:46+08:00", NOW), "3d");
	assert.equal(formatReset("2026-12-24T00:00:00+08:00", NOW), "2026-12-23");
});

test("statusLine: the tightest window, one line", () => {
	assert.equal(statusLine(tightestWindow([codex]), NOW), "Codex · 16% · 3d");
	assert.equal(statusLine(tightestWindow([workbuddy]), NOW), "WorkBuddy · 0 / 6900");
	assert.equal(statusLine(undefined, NOW), undefined);
});

test("quotaView: report lines, and an error is reported as one", () => {
	const view = quotaView([codex, workbuddy], "codex", NOW);
	assert.equal(view.entries.length, 1);
	assert.equal(view.status, "Codex · 16% · 3d");
	assert.deepEqual(view.report, [
		"Codex · plus · tffan@tutamail.com (subscription)",
		"  5 hours 97% · resets 4h",
		"  7 days 16% · resets 3d",
	]);

	const errored = quotaView([{ provider: "codex", name: "Codex", error: "  token expired  " }], "codex", NOW);
	assert.deepEqual(errored.report, ["Codex", "  error: token expired"]);
	assert.equal(errored.status, undefined);

	const silent = quotaView([{ provider: "codex", name: "Codex" }], "codex", NOW);
	assert.deepEqual(silent.report, ["Codex", "  no allowance reported"]);
	assert.deepEqual(quotaView([], "codex", NOW).report, []);
});
