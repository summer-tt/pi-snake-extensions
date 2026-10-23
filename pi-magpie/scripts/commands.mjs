#!/usr/bin/env node
/**
 * Every `/magpie` subcommand against a running magpie, without a TUI: the
 * extension is loaded with a fake `pi` and a fake context, and each report is
 * printed exactly as the command would show it.
 *
 *   node scripts/commands.mjs [root] [model-id]
 */

const root = (process.argv[2] ?? process.env.MAGPIE_GW_URL ?? "http://127.0.0.1:3425").replace(/\/+$/, "");
const wanted = process.argv[3] ?? "";

const extension = (await import("../index.ts")).default;

let handler;
let completions = null;
const started = [];
const registered = [];
extension({
	registerProvider: (provider) => registered.push(provider.id),
	on: (event, callback) => {
		if (event === "session_start") started.push(callback);
		return () => {};
	},
	registerCommand: (_name, command) => {
		handler = command.handler;
		completions = command.getArgumentCompletions;
	},
});
if (!handler) throw new Error("the extension registered no /magpie command");

const { toPiModels } = await import("../catalog.ts");
const { fetchCatalog } = await import("../gateway.ts");
const models = toPiModels(await fetchCatalog(root, "magpie", AbortSignal.timeout(8_000)), root);
// The first routing group magpie serves, which is what the footer and the
// reports have most to say about.
const { runMagpie } = await import("../gateway.ts");
const { parseGroupsList, shortGroupId } = await import("../routing.ts");
const listed = await runMagpie(["groups"]);
const groupIds = new Set(listed.ok ? parseGroupsList(listed.stdout).map((row) => shortGroupId(row.id)) : []);
const model =
	models.find((entry) => entry.id === wanted) ??
	models.find((entry) => groupIds.has(shortGroupId(entry.id))) ??
	models[0];

const ctx = {
	hasUI: true,
	model,
	ui: {
		notify: (text) => console.log(text),
		setStatus: (_key, text) => console.log(`[status] ${text ?? "(cleared)"}`),
	},
	modelRegistry: {
		getAll: () => models,
		getProviderAuth: async () => ({
			auth: { apiKey: "magpie" },
			env: { MAGPIE_GW_URL: root },
			source: "stored credential",
		}),
		getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		refresh: async () => ({ aborted: false, errors: new Map() }),
	},
};

// The session start is what learns magpie's routing groups, as in pi.
for (const callback of started) await callback({ type: "session_start", reason: "resume" }, ctx);

console.log(`registered provider: ${registered.join(", ")}\ncurrent model:       ${model?.id ?? "none"}\n`);
for (const args of ["", "quota", `quota ${model.id}`, `group`, "groups", "endpoint", "refresh", "help", "bogus"]) {
	console.log(`── /magpie ${args}`.trimEnd());
	await handler(args, ctx);
	console.log();
}

const { argumentCompletions } = await import("../usage.ts");
const source = { models: () => models, groups: () => groupIds };
console.log("── Tab completion");
for (const prefix of ["", "g", "gr", "quota ", "quota mimo", "group ", "groups ", "refresh ", "nope"]) {
	const items = argumentCompletions(prefix, source);
	const shown = items?.slice(0, 6).map((item) => item.label).join(" | ") ?? "(nothing)";
	const more = items && items.length > 6 ? ` | +${items.length - 6}` : "";
	console.log(`  /magpie ${prefix}`.padEnd(22) + `→ ${shown}${more}`);
}
