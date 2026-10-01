/**
 * pi-magpie — magpie's catalog entry (`GET /v1/models`) as a pi model.
 *
 * Every mapping here mirrors what magpie does when it writes pi's models.json
 * itself (internal/agent/agents.go, the "pi" shape): reasoning levels become a
 * thinkingLevelMap, each model is asked on the API its provider speaks
 * natively, and a Claude that only thinks adaptively is told so.
 */

import type { AnthropicMessagesCompat, Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai/compat";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	PROVIDER_ID,
} from "./constants.ts";

/** One entry of magpie's `GET /v1/models`. */
export interface MagpieModelEntry {
	id: string;
	display_name?: string;
	context_length?: number;
	context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	modalities?: { input?: string[] };
	reasoning?: boolean;
	supported_reasoning_levels?: { effort?: string }[];
	/** The paths a request for this model is relayed on as it is. */
	native_endpoints?: string[];
	/** The magpie provider that serves it; a routing group's is its first member's. */
	owned_by?: string;
}

/** pi's thinking levels, lowest first (pi-ai's EXTENDED_THINKING_LEVELS). */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The APIs pi knows how to speak to magpie, and the path each lives on. */
export const MAGPIE_PATHS = {
	responses: "/v1/responses",
	anthropic: "/v1/messages",
} as const;

export type MagpieApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/**
 * The API pi should ask a model on, and where that API's base URL points.
 *
 * magpie relays a request on the API its provider speaks natively, so asking
 * on one of those keeps the gateway out of the translation. A routing group
 * names none (its members may speak any), and anything else goes over Chat.
 */
export function magpieApi(nativeEndpoints: readonly string[] | undefined): {
	api: MagpieApi;
	/** "root" is `{root}` (an SDK that appends /v1 itself); "v1" is `{root}/v1`. */
	endpoint: "root" | "v1";
} {
	const native = nativeEndpoints ?? [];
	if (native.includes(MAGPIE_PATHS.responses)) return { api: "openai-responses", endpoint: "v1" };
	if (native.includes(MAGPIE_PATHS.anthropic)) return { api: "anthropic-messages", endpoint: "root" };
	return { api: "openai-completions", endpoint: "v1" };
}

/** The base URL a model of this shape is asked on. */
export function baseUrlFor(root: string, endpoint: "root" | "v1"): string {
	return endpoint === "root" ? root : `${root}/v1`;
}

/**
 * The thinkingLevelMap for a model's levels: pi's every level mapped to the
 * model's own, the rest hidden with null.
 *
 * pi's off is the model's none. A model without one has off hidden — except
 * on Anthropic's Messages API, where pi's off sends thinking disabled, which
 * Claude takes whatever its levels; there off is left out, for pi to offer as
 * before.
 */
export function thinkingLevelMap(
	efforts: readonly string[],
	anthropic: boolean,
): ThinkingLevelMap | undefined {
	if (efforts.length === 0) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of PI_THINKING_LEVELS) {
		const effort = level === "off" ? "none" : level;
		map[level] = efforts.includes(effort) ? effort : null;
	}
	if (anthropic && map.off === null) delete map.off;
	return map;
}

/** claude-opus-5-5, claude-sonnet-4.6 and the like, wherever the id is namespaced. */
const CLAUDE_VERSION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:[^0-9]|$)/;

/**
 * Whether a Claude model thinks only adaptively: from 4.6 on it refuses
 * `thinking.type=enabled` with a budget ("requires adaptive thinking"), so pi
 * must be told to ask for adaptive thinking instead of a budget.
 */
export function adaptiveThinking(modelId: string): boolean {
	const match = CLAUDE_VERSION.exec(modelId.toLowerCase());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 4 || (major === 4 && minor >= 6);
}

/** A pi model as this extension builds it: magpie's owner rides along for quotas. */
export type PiMagpieModel = Model<Api> & {
	/** The magpie provider that serves the model, as `/v1/magpie/quotas` names it. */
	magpieOwnedBy?: string;
};

/** One catalog entry as a pi chat model. */
export function toPiModel(entry: MagpieModelEntry, root: string): PiMagpieModel {
	const { api, endpoint } = magpieApi(entry.native_endpoints);
	const efforts = (entry.supported_reasoning_levels ?? [])
		.map((level) => level?.effort)
		.filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
	const input = (entry.modalities?.input ?? []).filter(
		(modality): modality is "text" | "image" => modality === "text" || modality === "image",
	);
	const contextWindow = entry.context_length ?? entry.context_window ?? entry.max_input_tokens;
	const model: PiMagpieModel = {
		id: entry.id,
		name: entry.display_name?.trim() || entry.id,
		api,
		provider: PROVIDER_ID,
		baseUrl: baseUrlFor(root, endpoint),
		input: input.length > 0 ? input : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// magpie records "does reason" separately from "has adjustable levels":
		// `reasoning: true` with empty levels is a thinking switch with no effort
		// tiers (yetone/magpie#402), so the flag rides along either way.
		reasoning: entry.reasoning === true || efforts.length > 0,
		contextWindow: positive(contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positive(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
	};
	if (entry.owned_by) model.magpieOwnedBy = entry.owned_by;
	const levels = thinkingLevelMap(efforts, api === "anthropic-messages");
	if (levels) model.thinkingLevelMap = levels;
	if (api === "anthropic-messages" && adaptiveThinking(entry.id)) {
		model.compat = { forceAdaptiveThinking: true } satisfies AnthropicMessagesCompat;
	}
	return model;
}

/** The whole catalog as pi models, entries without an id dropped. */
export function toPiModels(entries: readonly MagpieModelEntry[], root: string): PiMagpieModel[] {
	return entries
		.filter((entry) => typeof entry?.id === "string" && entry.id.length > 0)
		.map((entry) => toPiModel(entry, root));
}

/**
 * The magpie provider a model is served by: the catalog's `owned_by`, the
 * provider part of its id, or a single-model lookup when neither is known.
 */
export function ownedByOf(entry: MagpieModelEntry): string | undefined {
	if (entry.owned_by) return entry.owned_by;
	const slash = entry.id.indexOf("/");
	return slash > 0 ? entry.id.slice(0, slash) : undefined;
}

function positive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
