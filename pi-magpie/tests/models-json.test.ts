/**
 * The models.json hints must tell a conflict from a tune-up: pi composes a
 * `providers.magpie` block over this extension's live catalog, but only its
 * static fields override connection settings or individual models (`baseUrl`,
 * provider-wide `headers`/`apiKey`/`authHeader`, a non-empty `models` list).
 * Per-model `modelOverrides` — what a magpie user keeps next to the extension
 * for windows, prices and cache TTLs, with a display `name` — change the
 * models they name and no connection: neither the startup warning nor the
 * `/magpie endpoint` note may fire for them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { magpieProviderBlockInModelsJson } from "../gateway.ts";
import magpie from "../index.ts";

/** A scratch directory holding a models.json (or none). */
async function agentDirWithModelsJson(content?: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-magpie-models-json-"));
	if (content !== undefined) await writeFile(join(dir, "models.json"), content);
	return dir;
}

/** The analysis of one providers.magpie block, as the reader should report it. */
async function analysis(content?: string) {
	const dir = await agentDirWithModelsJson(content);
	try {
		return await magpieProviderBlockInModelsJson(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("no models.json, or one that never names magpie, is no conflict", async () => {
	assert.deepEqual(await analysis(), { present: false, staticConfig: false });
	assert.deepEqual(await analysis("not json at all"), { present: false, staticConfig: false });
	assert.deepEqual(await analysis(JSON.stringify({})), { present: false, staticConfig: false });
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { openai: { baseUrl: "https://api.openai.com/v1" } } })),
		{ present: false, staticConfig: false },
		"another provider's static block is not magpie's",
	);
});

test("a providers.magpie of modelOverrides alone is not a static block", async () => {
	const read = await analysis(
		JSON.stringify({
			providers: {
				magpie: {
					modelOverrides: {
						"codex/gpt-6.1-sol": { contextWindow: 400_000, cost: { input: 1.25, output: 10 } },
						"group/gk": { contextWindow: 500_000, maxTokens: 128_000 },
					},
				},
			},
		}),
	);
	assert.deepEqual(read, { present: true, staticConfig: false });
});

test("modelOverrides next to a harmless name are still not a static block", async () => {
	const read = await analysis(
		JSON.stringify({
			providers: {
				magpie: {
					name: "Magpie",
					modelOverrides: { "group/max": { contextWindow: 500_000 } },
				},
			},
		}),
	);
	assert.deepEqual(read, { present: true, staticConfig: false });
});

test("the tuning-only fields pi composes without touching a connection", async () => {
	// `compat` and provider-level `api` adjust protocol flags and static-model
	// defaults; they set no endpoint, credential or model list of their own.
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { compat: { thinkingFormat: "openai" } } } })),
		{ present: true, staticConfig: false },
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { api: "openai-completions" } } })),
		{ present: true, staticConfig: false },
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { models: [] } } })),
		{ present: true, staticConfig: false },
		"an empty models list freezes nothing",
	);
});

test("a baseUrl is a conflict — pi applies it to every model, an empty string too", async () => {
	assert.deepEqual(
		await analysis(
			JSON.stringify({
				providers: {
					magpie: {
						baseUrl: "http://127.0.0.1:3425/v1",
						modelOverrides: { "codex/gpt-6.1-sol": { contextWindow: 400_000 } },
					},
				},
			}),
		),
		{ present: true, staticConfig: true },
		"overrides next to a baseUrl do not make the block harmless",
	);
	// pi composes with `config.baseUrl ?? model.baseUrl`, which an empty
	// string passes: every model would be asked at "".
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { baseUrl: "" } } })),
		{ present: true, staticConfig: true },
	);
});

test("static model definitions are a conflict", async () => {
	const read = await analysis(
		JSON.stringify({
			providers: {
				magpie: {
					name: "Magpie",
					models: [{ id: "codex/gpt-6.1-sol", api: "openai-responses", baseUrl: "http://127.0.0.1:3425/v1" }],
				},
			},
		}),
	);
	assert.deepEqual(read, { present: true, staticConfig: true });
});

test("provider-wide auth and headers are a conflict; per-model headers are not", async () => {
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { apiKey: "stored-key" } } })),
		{ present: true, staticConfig: true },
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { headers: { "X-Magpie": "on" } } } })),
		{ present: true, staticConfig: true },
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { authHeader: true } } })),
		{ present: true, staticConfig: true },
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { headers: {} } } })),
		{ present: true, staticConfig: false },
		"no header is named, so no request is changed",
	);
	assert.deepEqual(
		await analysis(JSON.stringify({ providers: { magpie: { authHeader: false } } })),
		{ present: true, staticConfig: false },
		"false is pi's default",
	);
	assert.deepEqual(
		await analysis(
			JSON.stringify({
				providers: {
					magpie: { modelOverrides: { "codex/gpt-6.1-sol": { headers: { "X-Per-Model": "on" } } } },
				},
			}),
		),
		{ present: true, staticConfig: false },
		"a model's own header tune-up changes that model's requests alone",
	);
});

// =============================================================================
// The hints: what the footer's session and `/magpie endpoint` actually say
// =============================================================================

/** `getAgentDir()` reads this, so the hints can be pointed at a scratch dir. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Loads the real factory against a recording API, as lifecycle.test.ts does. */
function loadMagpieExtension() {
	const notifications: Array<{ text: string; type: string }> = [];
	const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => Promise<void>>>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const api = {
		registerProvider() {},
		registerCommand(_name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			command = definition.handler;
		},
		on(event: string, handler: (payload: unknown, ctx: unknown) => Promise<void>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const at = list.indexOf(handler);
				if (at >= 0) list.splice(at, 1);
			};
		},
	} as unknown as ExtensionAPI;
	magpie(api);
	const ctx = {
		hasUI: true,
		ui: {
			notify: (text: string, type = "info") => notifications.push({ text, type }),
			setStatus: () => {},
		},
		model: { provider: "magpie", id: "test-model", name: "Test Model", api: "chat" },
		modelRegistry: {
			// A remote gateway, so the footer renders without a fetch.
			getProviderAuth: async () => ({
				env: { MAGPIE_GW_URL: "http://remote.example:7777" },
				auth: { apiKey: "key" },
			}),
			getProviderAuthStatus: () => ({ configured: true }),
		},
	};
	return {
		notifications,
		ctx,
		async dispatch(event: string, payload: unknown) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		runCommand: async (args: string) => {
			assert.ok(command, "the extension registered no /magpie command");
			await command(args, ctx);
		},
	};
}

/** The extension under a scratch agent dir, with its session driven like pi's. */
async function withMagpieSession(
	modelsJson: string | undefined,
	run: (ext: ReturnType<typeof loadMagpieExtension>) => Promise<void>,
): Promise<void> {
	const dir = await agentDirWithModelsJson(modelsJson);
	const realDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = dir;
	try {
		const ext = loadMagpieExtension();
		try {
			await ext.dispatch("session_start", { type: "session_start", reason: "startup" });
			await run(ext);
		} finally {
			await ext.dispatch("session_shutdown", { type: "session_shutdown", reason: "new" });
		}
	} finally {
		if (realDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = realDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("startup stays silent for modelOverrides — even next to a name", async () => {
	await withMagpieSession(
		JSON.stringify({
			providers: { magpie: { name: "Magpie", modelOverrides: { "group/max": { contextWindow: 500_000 } } } },
		}),
		async (ext) => {
			assert.deepEqual(
				ext.notifications.filter((note) => note.type === "warning"),
				[],
				"no conflict to report",
			);
			await ext.runCommand("endpoint");
			assert.ok(
				!ext.notifications.some((note) => note.text.includes("providers.magpie")),
				"/magpie endpoint has no note either",
			);
		},
	);
});

test("startup warns once for a static block, and /magpie endpoint notes it", async () => {
	await withMagpieSession(
		JSON.stringify({
			providers: {
				magpie: {
					baseUrl: "http://127.0.0.1:3425/v1",
					models: [{ id: "codex/gpt-6.1-sol", api: "openai-responses" }],
				},
			},
		}),
		async (ext) => {
			const warnings = ext.notifications.filter((note) => note.type === "warning");
			assert.equal(warnings.length, 1, "the startup warning, once");
			assert.match(warnings[0]?.text ?? "", /providers\.magpie with static config/);
			assert.match(warnings[0]?.text ?? "", /models adds or replaces entries by ID/);
			assert.match(warnings[0]?.text ?? "", /Other models from the gateway remain available/);
			await ext.runCommand("endpoint");
			const note = ext.notifications.filter((note) => note.text.includes("note:")).at(-1);
			assert.match(note?.text ?? "", /static config/);
		},
	);
});

test("a models.json elsewhere on the machine is not read", async () => {
	// An empty agent dir models.json: whatever the user's own ~/.pi holds, the
	// hints answer for the dir this session runs with.
	await withMagpieSession(undefined, async (ext) => {
		assert.deepEqual(ext.notifications, []);
	});
});
