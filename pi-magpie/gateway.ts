/**
 * pi-magpie — the parts of magpie this extension talks to: the gateway over
 * HTTP, the magpie CLI, and the files magpie keeps on this machine.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import type { Credential } from "@earendil-works/pi-ai/compat";
import type { MagpieModelEntry } from "./catalog.ts";
import { DEFAULT_ROOT, PROVIDER_ID, ROOT_ENV } from "./constants.ts";
import type { QuotaEntry } from "./quota.ts";
import type { TraceRoute } from "./routing.ts";

const execFileAsync = promisify(execFile);

/** Where the gateway listens: the configured root, magpie's own env, or loopback. */
export function defaultRoot(): string {
	return (
		normalizeRoot(process.env[ROOT_ENV]) ??
		normalizeRoot(process.env.MAGPIE_ADDR) ??
		DEFAULT_ROOT
	);
}

/**
 * A gateway root as pi should carry it: a scheme is assumed, trailing slashes
 * and a trailing /v1 are dropped, so `/v1/models` and friends can be joined on.
 * Undefined for input that is not a URL.
 */
export function normalizeRoot(input: string | undefined): string | undefined {
	const raw = (input ?? "").trim();
	if (!raw) return undefined;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (!url.hostname) return undefined;
	let path = url.pathname.replace(/\/+$/, "");
	path = path.replace(/\/v1$/i, "");
	return `${url.origin}${path}`;
}

/** The root a stored credential names. */
export function rootFromCredential(credential: Credential | undefined): string | undefined {
	const env = (credential as { env?: Record<string, unknown> } | undefined)?.env;
	const value = env?.[ROOT_ENV];
	return typeof value === "string" ? normalizeRoot(value) : undefined;
}

/**
 * Whether a gateway root is this machine's. magpie answers quota questions to
 * loopback only, and the routing history lives on the gateway's own machine.
 */
export function isLoopback(root: string): boolean {
	let host: string;
	try {
		host = new URL(root).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	} catch {
		return false;
	}
	return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
}

export const modelsUrl = (root: string): string => `${root}/v1/models`;
export const modelUrl = (root: string, id: string): string => `${root}/v1/models/${id}`;

/**
 * The allowances as magpie reports them. `kept` asks for what magpie last
 * read, asking no vendor: the footer's own reading, since a plain read makes
 * magpie read the vendors again whenever its minute of cache is up.
 */
export const quotasUrl = (root: string, kept = false): string =>
	`${root}/v1/magpie/quotas${kept ? "?kept=1" : ""}`;

/** magpie's live routing trace: this machine only, and never a held key. */
export const traceUrl = (root: string): string => `${root}/v1/magpie/trace`;

/** GET a magpie endpoint as JSON, with a bounded wait that the caller can cancel. */
export async function fetchJson(
	url: string,
	token: string,
	signal: AbortSignal,
	timeoutMs = 8_000,
): Promise<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const detail = body.trim().slice(0, 200);
			throw new Error(`${url} answered ${response.status}${detail ? `: ${detail}` : ""}`);
		}
		return (await response.json()) as unknown;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

/** magpie's model catalog. */
export async function fetchCatalog(
	root: string,
	token: string,
	signal: AbortSignal,
): Promise<MagpieModelEntry[]> {
	const body = await fetchJson(modelsUrl(root), token, signal);
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) throw new Error(`${modelsUrl(root)} did not answer a model list`);
	return data as MagpieModelEntry[];
}

/** One catalog entry, for a lookup the live catalog cannot answer. */
export async function fetchModel(
	root: string,
	token: string,
	id: string,
	signal: AbortSignal,
): Promise<MagpieModelEntry | undefined> {
	try {
		const body = await fetchJson(modelUrl(root, id), token, signal);
		return typeof (body as MagpieModelEntry)?.id === "string" ? (body as MagpieModelEntry) : undefined;
	} catch {
		return undefined;
	}
}

/** Everything magpie knows its subscriptions, plans and keys have left. */
export async function fetchQuotas(
	root: string,
	token: string,
	signal: AbortSignal,
	options: { kept?: boolean } = {},
): Promise<QuotaEntry[]> {
	const url = quotasUrl(root, options.kept);
	const body = await fetchJson(url, token, signal);
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data)) throw new Error(`${url} did not answer a quota list`);
	return data as QuotaEntry[];
}

/**
 * The gateway's live routing trace. Undefined when it cannot tell it — a
 * gateway on another machine is refused (the trace is this machine's), and so
 * is a magpie too old to have one; the caller then reads the routing history
 * on disk instead.
 */
export async function fetchTrace(
	root: string,
	token: string,
	signal: AbortSignal,
): Promise<TraceRoute[] | undefined> {
	const url = traceUrl(root);
	let body: unknown;
	try {
		body = await fetchJson(url, token, signal);
	} catch {
		return undefined;
	}
	const data = (body as { routes?: unknown })?.routes;
	if (!Array.isArray(data)) return undefined;
	return data as TraceRoute[];
}

// =============================================================================
// The magpie CLI and the files it keeps
// =============================================================================

/** The magpie binary: MAGPIE_BIN when set, else the one on PATH. */
export function magpieBinary(): string {
	return process.env.MAGPIE_BIN?.trim() || "magpie";
}

export type MagpieRun = { ok: true; stdout: string } | { ok: false; error: string };

/** Run the magpie CLI once. FAIL_SOFT: a missing binary is reported, never thrown. */
export async function runMagpie(args: readonly string[], options: { signal?: AbortSignal } = {}): Promise<MagpieRun> {
	try {
		const { stdout } = await execFileAsync(magpieBinary(), [...args], {
			timeout: 8_000,
			maxBuffer: 1 << 20,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return { ok: true, stdout };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

/** magpie's config directory: `magpie/providers.json` and the routing history live under it. */
export function magpieConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	return xdg ? join(xdg, "magpie") : join(homedir(), ".config", "magpie");
}

/** Where magpie keeps one routing-history file per day. */
export function routingDir(): string {
	return join(magpieConfigDir(), "routing");
}

/** The routing-history files, newest day first (`.jsonl`, older days gzipped). */
export async function routingDays(limit = 3): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(routingDir());
	} catch {
		return [];
	}
	return names
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(name))
		.sort()
		.reverse()
		.slice(0, limit)
		.map((name) => join(routingDir(), name));
}

/** Read a routing day, gunzipping it when magpie sealed it. */
export async function readRoutingDay(path: string): Promise<string> {
	if (!path.endsWith(".gz")) {
		try {
			return await readFile(path, "utf8");
		} catch {
			return "";
		}
	}
	try {
		return gunzipSync(await readFile(path)).toString("utf8");
	} catch {
		return "";
	}
}

/**
 * The tail of a routing day: enough for the latest decisions without reading a
 * whole day. A sealed (gzipped) day is read whole — there is no tail of a
 * gzip stream.
 */
export async function readRoutingTail(path: string, bytes = 256 * 1024): Promise<string> {
	if (path.endsWith(".gz")) return readRoutingDay(path);
	try {
		const handle = await open(path, "r");
		try {
			const { size } = await handle.stat();
			const start = Math.max(0, size - bytes);
			const length = size - start;
			if (length <= 0) return "";
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, start);
			const text = buffer.toString("utf8");
			if (start === 0) return text;
			const firstBreak = text.indexOf("\n");
			return firstBreak < 0 ? "" : text.slice(firstBreak + 1);
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

/**
 * Whether pi's models.json names this extension's provider, and whether that
 * block takes the connection or the catalog over from it. Read for the
 * startup warning and `/magpie endpoint` — the two hints must not fire for a
 * block that only tunes models.
 */
export interface MagpieProviderBlockInModelsJson {
	/** Whether models.json carries a `providers.magpie` block at all. */
	present: boolean;
	/**
	 * Whether that block carries static connection or catalog config — a
	 * provider-wide `baseUrl`, `headers`, `apiKey` or `authHeader`, or a
	 * non-empty `models` list — rather than per-model `modelOverrides` (with a
	 * display `name`) alone, which change the models they name without
	 * touching how any model is reached.
	 */
	staticConfig: boolean;
}

/** A JSON object, as every record this file reads is. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a models.json provider block holds config pi composes over every
 * model of the provider it names. pi's own composition is the authority
 * (`applyModelsJson` / `composeModelProvider`): `baseUrl` replaces every
 * model's base URL (the `??` there applies an empty string too), provider-wide
 * `headers`, `apiKey` and `authHeader` reach every request, and a non-empty
 * `models` list is a frozen catalog pi prefers over a live one. `name`, `api`
 * (it only feeds static model definitions), `compat` and `modelOverrides`
 * change no model's connection and are not a conflict.
 */
function staticProviderConfig(block: Record<string, unknown>): boolean {
	if (Array.isArray(block.models) && block.models.length > 0) return true;
	if (typeof block.baseUrl === "string") return true;
	if (isRecord(block.headers) && Object.keys(block.headers).length > 0) return true;
	if (block.apiKey !== undefined) return true;
	return block.authHeader === true;
}

/**
 * What pi's models.json says about this provider: whether it names `magpie`,
 * and whether that block overrides the connection or the model list this
 * extension serves. A block of per-model `modelOverrides` (with a `name`)
 * tunes models and is not a conflict.
 */
export async function magpieProviderBlockInModelsJson(
	agentDir: string,
): Promise<MagpieProviderBlockInModelsJson> {
	try {
		const raw = await readFile(join(agentDir, "models.json"), "utf8");
		const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
		const block = parsed?.providers?.[PROVIDER_ID];
		if (!isRecord(block)) return { present: false, staticConfig: false };
		return { present: true, staticConfig: staticProviderConfig(block) };
	} catch {
		return { present: false, staticConfig: false };
	}
}

/** pi's agent directory is the caller's to resolve; this is only for display. */
export function modelsJsonPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

/** magpie's public base URL for people, as the CLI and README print it. */
export function gatewayUrlFor(root: string): string {
	return `${root}/v1`;
}
