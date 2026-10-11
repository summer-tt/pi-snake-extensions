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
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magpie from "../index.ts";

/** Verbatim from pi's runner.invalidate(): ctx getters throw exactly this. */
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const foreignResizeListeners = process.stdout.listeners("resize").slice();

after(() => {
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

/**
 * The ExtensionContext contract pi enforces from runner.createContext():
 * `hasUI` and `ui` getters assertActive() and throw once the runner is
 * invalidated. The model is a magpie one whose gateway is remote, so the
 * status renders from plain data — no network in the loop.
 */
function makeSession(options?: { providerAuth?: Promise<typeof REMOTE_AUTH> }) {
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
		model: { provider: "magpie", id: "test-model", name: "Test Model", api: "chat" },
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

test("a resize repaints the footer while the session is live", async () => {
	const ext = loadMagpieExtension();
	const session = makeSession();
	await ext.dispatch("session_start", sessionStart, session.ctx);
	assert.deepEqual(session.statusWrites, ["magpie Test Model"], "session_start renders the status");

	session.statusWrites.length = 0;
	process.stdout.emit("resize");
	assert.deepEqual(session.statusWrites, ["magpie Test Model"], "resize repaints from the cached reading");

	await ext.dispatch("session_shutdown", sessionShutdown, session.ctx);
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
