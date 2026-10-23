/**
 * The footer status must not outlive its session.
 *
 * pi guarantees `session_shutdown` runs before it invalidates the old context
 * (teardownCurrent / reload / dispose all do shutdown → invalidate), and from
 * then on every ctx getter — `hasUI`, `ui`, … — throws "This extension ctx is
 * stale …". The status repaints from a raw `process.stdout` "resize" listener
 * that no event dispatch supervises: if it survives the session, the next
 * terminal resize is an uncaught exception that takes the process down.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie from "../index.ts";

/** Verbatim from pi's runner.invalidate(): ctx getters throw exactly this. */
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const foreignResizeListeners = process.stdout.listeners("resize").slice();

// No magpie CLI here: the group a model is cannot come from `magpie groups`, so
// the footer asks the gateway's routing instead — the path a machine without
// the CLI takes, and a deterministic one for a test.
const realMagpieBin = process.env.MAGPIE_BIN;
before(() => {
	process.env.MAGPIE_BIN = "/nonexistent/magpie-for-tests";
});

after(() => {
	if (realMagpieBin === undefined) delete process.env.MAGPIE_BIN;
	else process.env.MAGPIE_BIN = realMagpieBin;
	for (const listener of process.stdout.listeners("resize")) {
		if (!foreignResizeListeners.includes(listener)) {
			process.stdout.removeListener("resize", listener);
		}
	}
});

type Handler = (payload: unknown, ctx: unknown) => unknown;

/** Loads the real extension factory against a recording ExtensionAPI. */
function loadMagpieExtension(): {
	dispatch: (event: string, payload: unknown, ctx: unknown) => Promise<void>;
} {
	const handlers = new Map<string, Handler[]>();
	const api = {
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
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
	return {
		async dispatch(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

const REMOTE_AUTH = {
	env: { MAGPIE_GW_URL: "http://remote.example:7777" },
	auth: { apiKey: "key" },
};

const LOOPBACK_AUTH = {
	env: { MAGPIE_GW_URL: "http://127.0.0.1:3425" },
	auth: { apiKey: "magpie" },
};

/** A model whose provider the catalog can name without a lookup (`ownedBy`). */
const CODEX_MODEL = {
	provider: "magpie",
	id: "codex/gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "chat",
};

/**
 * The ExtensionContext contract pi enforces from runner.createContext():
 * `hasUI` and `ui` getters assertActive() and throw once the runner is
 * invalidated. The default model's gateway is remote, so the status renders
 * from plain data — no network in the loop.
 */
function makeSession(options?: {
	providerAuth?: Promise<typeof REMOTE_AUTH | typeof LOOPBACK_AUTH>;
	model?: typeof CODEX_MODEL;
}) {
	let stale = false;
	const statusWrites: Array<string | undefined> = [];
	const ctx = {
		get hasUI() {
			if (stale) throw new Error(STALE_MESSAGE);
			return true;
		},
		mode: "tui",
		get ui() {
			if (stale) throw new Error(STALE_MESSAGE);
			return {
				setStatus: (_key: string, value?: string) => {
					statusWrites.push(value);
				},
				notify: () => {},
			};
		},
		model: options?.model ?? { provider: "magpie", id: "test-model", name: "Test Model", api: "chat" },
		modelRegistry: {
			getProviderAuth: () => options?.providerAuth ?? Promise.resolve(REMOTE_AUTH),
			getProviderAuthStatus: () => ({ configured: true }),
		},
	};
	return {
		ctx,
		statusWrites,
		/** What pi's session.dispose() does after session_shutdown handlers ran. */
		invalidate: () => {
			stale = true;
		},
	};
}

const sessionStart = { type: "session_start", reason: "resume" };
const sessionShutdown = { type: "session_shutdown", reason: "new" };
const agentEnd = { type: "agent_end", messages: [] };

/** Enough event-loop turns for a background refresh (and its fetches) to land. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** A quota answer as the gateway sends it, one Codex card. */
function quotaAnswer(options: { kept: boolean; readAt?: number; remaining?: number }): unknown {
	const remaining = options.remaining ?? 93;
	return {
		object: "list",
		data: [
			{
				provider: "codex",
				name: "Codex",
				kind: "subscription",
				windows: [
					{
						name: "7 days",
						used: 100 - remaining,
						remaining,
						resetsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
					},
				],
				...(options.kept && options.readAt !== undefined ? { readAt: new Date(options.readAt).toISOString() } : {}),
			},
		],
	};
}

/** Swap `fetch` for a recorder: every URL it was asked, and the answers. */
function stubFetch(answer: (url: string) => { status?: number; body?: unknown }): {
	calls: string[];
	asked: () => string[];
	restore: () => void;
} {
	const calls: string[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		const { status = 200, body } = answer(url);
		const reply = {
			ok: status < 400,
			status,
			json: async () => body,
			text: async () => (body === undefined ? "" : JSON.stringify(body)),
		};
		return reply as unknown as Response;
	}) as typeof fetch;
	return {
		calls,
		/** The URL paths asked, without the gateway root. */
		asked: () => calls.map((url) => url.replace(/^https?:\/\/[^/]+/, "")),
		restore: () => {
			globalThis.fetch = real;
		},
	};
}

const KEPT = "/v1/magpie/quotas?kept=1";
const FULL = "/v1/magpie/quotas";
const TRACE = "/v1/magpie/trace";

test("a resize repaints only what the width changed", async () => {
	const ext = loadMagpieExtension();
	const session = makeSession();
	await ext.dispatch("session_start", sessionStart, session.ctx);
	assert.deepEqual(session.statusWrites, ["magpie Test Model"], "session_start renders the status");

	session.statusWrites.length = 0;
	process.stdout.emit("resize");
	assert.deepEqual(session.statusWrites, [], "the same reading is not written twice");

	await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
});

test("the footer reads what magpie already read, asking no vendor", async () => {
	const fetch = stubFetch(() => ({ body: quotaAnswer({ kept: true, readAt: Date.now() }) }));
	try {
		const ext = loadMagpieExtension();
		const session = makeSession({ providerAuth: Promise.resolve(LOOPBACK_AUTH), model: CODEX_MODEL });
		await ext.dispatch("session_start", sessionStart, session.ctx);
		assert.deepEqual(fetch.asked(), [TRACE, KEPT], "a kept read, never a full one");
		assert.match(session.statusWrites.at(-1) ?? "", /^magpie 93% left/);

		// A run's end reads again, past the TTL, and repaints only when the
		// numbers moved.
		const real = Date.now;
		Date.now = () => real() + 60_000;
		try {
			await ext.dispatch("agent_end", agentEnd, session.ctx);
			await settle();
			assert.deepEqual(fetch.asked(), [TRACE, KEPT, TRACE, KEPT], "the run's end asks the gateway again");
			assert.equal(session.statusWrites.length, 1, "an unchanged reading is not repainted");
		} finally {
			Date.now = real;
		}
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	} finally {
		fetch.restore();
	}
});

test("a reading magpie let go stale is read once, with the vendors asked", async () => {
	let read = false;
	// A full read refreshes magpie's own cache: the kept answers after it are new.
	const fetch = stubFetch((url) => {
		if (url.endsWith("/v1/magpie/quotas")) {
			read = true;
			return { body: quotaAnswer({ kept: true, remaining: 40 }) };
		}
		return url.includes("kept=1")
			? {
					body: quotaAnswer({
						kept: true,
						remaining: read ? 40 : 93,
						readAt: read ? Date.now() : Date.now() - 20 * 60_000,
					}),
				}
			: { body: { object: "trace", routes: [] } };
	});
	try {
		const ext = loadMagpieExtension();
		const session = makeSession({ providerAuth: Promise.resolve(LOOPBACK_AUTH), model: CODEX_MODEL });
		await ext.dispatch("session_start", sessionStart, session.ctx);
		await settle();
		assert.deepEqual(
			fetch.asked(),
			[TRACE, KEPT, TRACE, FULL],
			"a stale reading is followed by one full read; the trace says whether the model is a group",
		);
		assert.match(session.statusWrites.at(-1) ?? "", /^magpie 40% left/);

		// The full read is throttled: the next refresh, still within the stale
		// window, does not ask the vendors again.
		await ext.dispatch("agent_end", agentEnd, session.ctx);
		await settle();
		assert.equal(fetch.asked().filter((path) => path === FULL).length, 1);
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	} finally {
		fetch.restore();
	}
});

test("a failed refresh keeps the reading the footer has, until a second failure", async () => {
	let failing = false;
	const fetch = stubFetch(() =>
		failing ? { status: 503 } : { body: quotaAnswer({ kept: true, readAt: Date.now() }) },
	);
	try {
		const ext = loadMagpieExtension();
		const session = makeSession({ providerAuth: Promise.resolve(LOOPBACK_AUTH), model: CODEX_MODEL });
		await ext.dispatch("session_start", sessionStart, session.ctx);
		const good = session.statusWrites.at(-1);
		assert.match(good ?? "", /^magpie 93% left/);

		failing = true;
		const real = Date.now;
		let writes = session.statusWrites.length;
		Date.now = () => real() + 60_000;
		try {
			await ext.dispatch("agent_end", agentEnd, session.ctx);
			await settle();
			assert.equal(session.statusWrites.length, writes, "one failure writes nothing");
			await ext.dispatch("agent_end", agentEnd, session.ctx);
			await settle();
		} finally {
			Date.now = real;
		}
		assert.equal(session.statusWrites.at(-1), "magpie unreachable", "the second failure is news");
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	} finally {
		fetch.restore();
	}
});

test("a resize after session replacement never touches the stale context", async () => {
	const ext = loadMagpieExtension();
	const session = makeSession();
	await ext.dispatch("session_start", sessionStart, session.ctx);

	// pi's order in teardownCurrent: shutdown handlers run, then dispose()
	// invalidates the ctx, then the terminal may resize at any moment.
	await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	session.invalidate();

	session.statusWrites.length = 0;
	assert.doesNotThrow(
		() => process.stdout.emit("resize"),
		"the resize listener must be gone before the context goes stale",
	);
	assert.deepEqual(session.statusWrites, []);
});

test("a refresh in flight at shutdown does not resume into the stale context", async () => {
	const ext = loadMagpieExtension();
	let releaseAuth!: (value: typeof REMOTE_AUTH) => void;
	const pendingAuth = new Promise<typeof REMOTE_AUTH>((resolve) => {
		releaseAuth = resolve;
	});
	const session = makeSession({ providerAuth: pendingAuth });

	const starting = ext.dispatch("session_start", sessionStart, session.ctx);
	await new Promise((resolve) => setImmediate(resolve));

	await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	session.invalidate();
	releaseAuth(REMOTE_AUTH);

	await assert.doesNotReject(starting, "the in-flight refresh must observe the shutdown");
	assert.deepEqual(session.statusWrites, []);
});

test("load/start/shutdown cycles leave no resize listeners behind", async () => {
	const before = process.stdout.listeners("resize").length;
	for (let cycle = 0; cycle < 3; cycle++) {
		const ext = loadMagpieExtension();
		const session = makeSession();
		await ext.dispatch("session_start", sessionStart, session.ctx);
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
		session.invalidate();
	}
	assert.equal(
		process.stdout.listeners("resize").length,
		before,
		"every listener the factory installs must be released at session_shutdown",
	);
});

/** A trace answer with one completed request through a group. */
function traceAnswer(options: { group: boolean }): unknown {
	return {
		object: "trace",
		routes: [
			{
				time: new Date().toISOString(),
				agent: "pi",
				model: "group/auto-some-model",
				provider: "opencode-go",
				group: options.group
					? {
							id: "auto-some-model",
							ref: "auto/some-model",
							routing: "order",
							members: ["opencode-go/some-model", "codex/other-model"],
						}
					: null,
				served: "some-model",
				tries: [{ id: "opencode-go", model: "some-model", status: 200, ms: 900 }],
			},
		],
	};
}

test("a group magpie lists nowhere is still a group when its request says so", async () => {
	// The catalog gives a found group's model its lead provider, so a quota
	// reading would answer — but the request record says what it really is.
	const fetch = stubFetch((url) =>
		url.endsWith(TRACE)
			? { body: traceAnswer({ group: true }) }
			: { body: quotaAnswer({ kept: true, readAt: Date.now(), remaining: 12 }) },
	);
	try {
		const ext = loadMagpieExtension();
		const session = makeSession({
			providerAuth: Promise.resolve(LOOPBACK_AUTH),
			model: { provider: "magpie", id: "auto/some-model", name: "Some Model", api: "chat" },
		});
		await ext.dispatch("session_start", sessionStart, session.ctx);
		assert.deepEqual(fetch.asked(), [TRACE], "the routing alone answers, no quota asked");
		assert.equal(session.statusWrites.at(-1), "magpie order → ope..go/some-model");
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	} finally {
		fetch.restore();
	}
});

test("a model that was routed without a group is still a model", async () => {
	const fetch = stubFetch((url) =>
		url.endsWith(TRACE)
			? { body: traceAnswer({ group: false }) }
			: { body: quotaAnswer({ kept: true, readAt: Date.now() }) },
	);
	try {
		const ext = loadMagpieExtension();
		const session = makeSession({ providerAuth: Promise.resolve(LOOPBACK_AUTH), model: CODEX_MODEL });
		await ext.dispatch("session_start", sessionStart, session.ctx);
		assert.deepEqual(fetch.asked(), [TRACE, KEPT], "the routing says no, so the quota is read");
		assert.match(session.statusWrites.at(-1) ?? "", /^magpie 93% left/);
		await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
	} finally {
		fetch.restore();
	}
});
