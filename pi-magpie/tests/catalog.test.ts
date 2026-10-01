import { test } from "node:test";
import assert from "node:assert/strict";
import {
	adaptiveThinking,
	baseUrlFor,
	magpieApi,
	ownedByOf,
	thinkingLevelMap,
	toPiModel,
	toPiModels,
	type MagpieModelEntry,
} from "../catalog.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PROVIDER_ID } from "../constants.ts";

const ROOT = "http://127.0.0.1:3425";

test("magpieApi: the API the provider speaks natively, Responses first", () => {
	assert.deepEqual(magpieApi(["/v1/responses"]), { api: "openai-responses", endpoint: "v1" });
	assert.deepEqual(magpieApi(["/v1/messages"]), { api: "anthropic-messages", endpoint: "root" });
	assert.deepEqual(magpieApi(["/v1/chat/completions"]), { api: "openai-completions", endpoint: "v1" });
	assert.deepEqual(magpieApi(["/v1/responses", "/v1/messages"]), { api: "openai-responses", endpoint: "v1" });
	// A routing group names none: its members may speak any, so magpie translates.
	assert.deepEqual(magpieApi(undefined), { api: "openai-completions", endpoint: "v1" });
	assert.deepEqual(magpieApi([]), { api: "openai-completions", endpoint: "v1" });
});

test("baseUrlFor: an Anthropic model is asked at the root, the SDK appends /v1", () => {
	assert.equal(baseUrlFor(ROOT, "root"), ROOT);
	assert.equal(baseUrlFor(ROOT, "v1"), `${ROOT}/v1`);
});

test("thinkingLevelMap: the model's levels, the rest hidden", () => {
	assert.deepEqual(thinkingLevelMap(["low", "high", "max"], false), {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	assert.deepEqual(thinkingLevelMap(["none", "low", "high", "max"], false), {
		off: "none",
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	// Anthropic's off sends thinking disabled, which Claude takes whatever its
	// levels: leave it out so pi keeps offering it.
	assert.deepEqual(thinkingLevelMap(["low", "high"], true), {
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.equal(thinkingLevelMap([], false), undefined);
});

test("adaptiveThinking: Claude 4.6 and on take adaptive thinking, not a budget", () => {
	assert.equal(adaptiveThinking("claude-opus-4-6"), true);
	assert.equal(adaptiveThinking("claude-sonnet-4.6"), true);
	assert.equal(adaptiveThinking("anthropic/claude-opus-5-5"), true);
	assert.equal(adaptiveThinking("claude-opus-4-5-20251101"), false);
	assert.equal(adaptiveThinking("claude-haiku-4-5"), false);
	assert.equal(adaptiveThinking("claude-3-5-sonnet-20241022"), false);
	assert.equal(adaptiveThinking("gpt-5.5-2026-04-23"), false);
});

test("toPiModel: the fields pi needs, and magpie's own reading of a model", () => {
	const entry: MagpieModelEntry = {
		id: "opencode-go/mimo-v2.6-flash",
		display_name: "MiMo-V2.6-Flash",
		context_length: 1_048_576,
		max_output_tokens: 131_072,
		modalities: { input: ["text", "image"] },
		reasoning: true,
		supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
		native_endpoints: ["/v1/chat/completions", "/v1/responses"],
		owned_by: "opencode-go",
	};
	const model = toPiModel(entry, ROOT);
	assert.equal(model.id, entry.id);
	assert.equal(model.name, "MiMo-V2.6-Flash");
	assert.equal(model.provider, PROVIDER_ID);
	assert.equal(model.api, "openai-responses");
	assert.equal(model.baseUrl, `${ROOT}/v1`);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 131_072);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(model.magpieOwnedBy, "opencode-go");
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("toPiModel: an Anthropic model keeps the root, adaptive ones are told so", () => {
	const model = toPiModel(
		{
			id: "anthropic/claude-opus-5-5",
			display_name: "Claude Opus 5.5",
			context_length: 200_000,
			max_output_tokens: 64_000,
			native_endpoints: ["/v1/messages"],
			supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }],
		},
		ROOT,
	);
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.baseUrl, ROOT);
	assert.deepEqual(model.compat, { forceAdaptiveThinking: true });
	assert.equal(model.thinkingLevelMap?.off, "none");
});

test("toPiModel: an entry without limits still becomes a usable model", () => {
	const model = toPiModel({ id: "deepseek/deepseek-chat" }, ROOT);
	assert.equal(model.name, "deepseek/deepseek-chat");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, `${ROOT}/v1`);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.reasoning, false);
	assert.equal(model.thinkingLevelMap, undefined);
	assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
	assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
	assert.equal(model.magpieOwnedBy, undefined);
});

test("toPiModels: entries without an id are dropped", () => {
	const models = toPiModels([{ id: "a/b" }, { id: "" }, {} as MagpieModelEntry], ROOT);
	assert.deepEqual(
		models.map((model) => model.id),
		["a/b"],
	);
});

test("ownedByOf: magpie's owner, else the id's provider part", () => {
	assert.equal(ownedByOf({ id: "codex/gpt-5.6-luna", owned_by: "codex" }), "codex");
	assert.equal(ownedByOf({ id: "codex/gpt-5.6-luna" }), "codex");
	assert.equal(ownedByOf({ id: "gpt-5.6-luna" }), undefined);
});
