/**
 * pi-magpie — the magpie gateway as a pi provider.
 *
 * The catalog is magpie's own (`GET /v1/models`), fetched on every network
 * refresh and kept across runs, so groups, accounts and providers appear and
 * disappear with magpie instead of being frozen into models.json. Requests are
 * handed to pi-ai's built-in implementation for the protocol each model speaks.
 *
 * `/login magpie` is optional: with no stored endpoint the provider answers
 * from magpie's own loopback default (`$MAGPIE_GW_URL`, `$MAGPIE_ADDR`, else
 * `http://127.0.0.1:3425`), so installing the extension is enough to reach a
 * magpie on this machine. A stored endpoint (`{type:"api_key", key,
 * env:{MAGPIE_GW_URL}}`) points it elsewhere.
 */

import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessageEventStream,
	type AuthResult,
	type Credential,
	isModelType,
	type Model,
	type Provider,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type TranscriptContext,
	stream,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
	baseUrlFor,
	type MagpieModelEntry,
	ownedByOf,
	type PiMagpieModel,
	toPiModels,
} from "./catalog.ts";
import { DEFAULT_TOKEN, GROUP_PREFIX, PROVIDER_ID, PROVIDER_NAME, ROOT_ENV } from "./constants.ts";
import {
	defaultRoot,
	fetchCatalog,
	normalizeRoot,
	rootFromCredential,
} from "./gateway.ts";

/** What the extension needs from the provider besides pi registering it. */
export interface MagpieProviderHandle {
	provider: Provider;
	/** The magpie provider that serves a model, as `/v1/magpie/quotas` names it. */
	ownedBy(modelId: string): string | undefined;
	/** The models currently installed, newest catalog first. */
	models(): readonly PiMagpieModel[];
}

/**
 * pi-ai's compat entrypoint takes a raw `Context` and normalizes it, while a
 * provider is handed an already-normalized transcript: the same messages under
 * a different type, which is how the built-in llama.cpp provider delegates too.
 * `stream` is per-API typed on the provider and untyped there, so the cast is
 * signed on the provider's own shape rather than the compat one.
 */
type ProviderStream = <TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	options?: ApiStreamOptions<TApi>,
) => AssistantMessageEventStream;

const delegateStream = stream as unknown as ProviderStream;

function tokenOf(credential: Credential | undefined): string {
	const key = credential && "key" in credential && typeof credential.key === "string" ? credential.key.trim() : "";
	return key || DEFAULT_TOKEN;
}

/** Whether persisted models were installed for this gateway root. */
export function servedByRoot(model: PiMagpieModel, root: string): boolean {
	return model.baseUrl === root || model.baseUrl === baseUrlFor(root, "v1");
}

/**
 * The root a request must go to.
 *
 * A model's own baseUrl is not trusted here: a `providers.magpie` block in
 * models.json sets one baseUrl for every model of the provider, which would
 * point an Anthropic model at `{root}/v1/v1/messages`.
 */
function requestRoot(options: { env?: Record<string, string> } | undefined): string {
	return normalizeRoot(options?.env?.[ROOT_ENV]) ?? defaultRoot();
}

function forRequest<T extends Model<Api>>(model: T, root: string): T {
	const baseUrl = model.api === "anthropic-messages" ? root : baseUrlFor(root, "v1");
	return model.baseUrl === baseUrl ? model : { ...model, baseUrl };
}

/** Build the provider pi registers. */
export function createMagpieProvider(): MagpieProviderHandle {
	let models: PiMagpieModel[] = [];
	const owners = new Map<string, string>();
	/** The catalog `/login` just fetched, so the models appear without another round trip. */
	let fromLogin: { root: string; models: PiMagpieModel[] } | undefined;

	const install = (next: PiMagpieModel[]): void => {
		models = next;
		owners.clear();
		for (const model of next) {
			if (model.magpieOwnedBy) owners.set(model.id, model.magpieOwnedBy);
		}
	};

	const provider: Provider = {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: baseUrlFor(defaultRoot(), "v1"),
		auth: {
			apiKey: {
				name: "Magpie gateway",
				async login({ prompt, notify, signal }) {
					const entered = await prompt({
						type: "text",
						message: "Magpie gateway endpoint",
						placeholder: defaultRoot(),
					});
					const root = normalizeRoot(entered) ?? defaultRoot();
					const key =
						(await prompt({ type: "secret", message: "API key", placeholder: DEFAULT_TOKEN })).trim() ||
						DEFAULT_TOKEN;
					notify({ type: "progress", message: `Asking ${root} for its catalog…` });
					const entries = await fetchCatalog(root, key, signal);
					const next = toPiModels(entries, root);
					if (next.length === 0) throw new Error(`${root} listed no models`);
					fromLogin = { root, models: next };
					return { type: "api_key", key, env: { [ROOT_ENV]: root } };
				},
				async check({ credential }) {
					// A stored endpoint or magpie's loopback default is enough to try;
					// whether it answers is a question for the catalog fetch, not auth.
					return {
						type: "api_key",
						source: rootFromCredential(credential) ? "stored credential" : "default gateway",
					};
				},
				async resolve({ credential }) {
					const stored = rootFromCredential(credential);
					const result: AuthResult = {
						auth: { apiKey: tokenOf(credential) },
						env: { [ROOT_ENV]: stored ?? defaultRoot() },
						source: stored ? "stored credential" : "default gateway",
					};
					return result;
				},
			},
		},
		getModels: () => models.filter((model) => isModelType(model, "chat")),
		getAllModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			// A stored endpoint names the gateway; without one, magpie's own
			// loopback default is the gateway, so installing is enough to browse it.
			const storedRoot = rootFromCredential(context.credential);
			const root = storedRoot ?? defaultRoot();
			if (context.stored) {
				const restored = (context.stored.models as readonly PiMagpieModel[]).filter(
					(model) =>
						model?.provider === PROVIDER_ID && isModelType(model, "chat") && servedByRoot(model, root),
				);
				if (!(await context.publish({ update: () => install([...restored]) }))) return;
			}
			if (fromLogin && fromLogin.root === root) {
				const next = fromLogin.models;
				fromLogin = undefined;
				await context.publish({
					persist: { models: next, checkedAt: Date.now() },
					update: () => install(next),
				});
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			let entries: MagpieModelEntry[];
			try {
				entries = await fetchCatalog(root, tokenOf(context.credential), context.signal);
			} catch (error) {
				// A stored gateway that is down is worth saying so; the loopback
				// default that is simply not running is not — the catalog is just empty.
				if (storedRoot) throw error;
				return;
			}
			if (context.signal.aborted) return;
			const next = toPiModels(entries, root);
			await context.publish({
				persist: { models: next, checkedAt: Date.now() },
				update: () => install(next),
			});
		},
		stream: (model, context, options) => delegateStream(forRequest(model, requestRoot(options)), context, options),
		streamSimple: (model, context: TranscriptContext, options?: SimpleStreamOptions) =>
			streamSimple(forRequest(model, requestRoot(options)), context, options),
	};

	return {
		provider,
		ownedBy: (modelId: string): string | undefined => {
			const known = owners.get(modelId);
			if (known) return known;
			if (modelId.startsWith(GROUP_PREFIX)) return undefined;
			const slash = modelId.indexOf("/");
			return slash > 0 ? modelId.slice(0, slash) : undefined;
		},
		models: () => models,
	};
}

/** The magpie provider of a catalog entry, for a lookup the live catalog missed. */
export function ownedByEntry(entry: MagpieModelEntry | undefined): string | undefined {
	return entry ? ownedByOf(entry) : undefined;
}
