import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkTwiceEditor } from "../think-twice-editor.ts";
import { RESERVED_BUILTIN_COMMANDS } from "../builtins.ts";

/**
 * Headless behavioral tests: drive ThinkTwiceEditor.handleInput with a stubbed
 * TUI/keybindings and observe what reaches pi's real submit (onSubmit).
 */

const ENTER = "\r";
const CTRL_ENTER = "\x1b[13;5u"; // kitty CSI-u: enter + ctrl
const ESC = "\x1b";

interface MakeOptions {
	shouldCountdown?: (text: string, builtinCommands: readonly string[]) => boolean;
	liveCommandNames?: () => readonly string[];
	delaySeconds?: number;
	doubleEnterSeconds?: number;
	warning?: (text: string) => string;
	/** Extra keybinding the stub resolves, in addition to tui.input.submit. */
	interruptKey?: string;
}

function makeEditor(options?: MakeOptions) {
	const tui = { requestRender() {} };
	const theme = {
		borderColor: (s: string) => s,
		selectList: {
			selectedPrefix: (s: string) => s,
			selectedText: (s: string) => s,
			description: (s: string) => s,
			scrollInfo: (s: string) => s,
			noMatch: (s: string) => s,
		},
	};
	const keybindings = {
		matches: (data: string, id: string) =>
			id === "tui.input.submit"
				? data === ENTER
				: id === "app.interrupt"
					? data === (options?.interruptKey ?? ESC)
					: false,
		getKeys: (id: string) => (id === "tui.input.submit" ? ["enter"] : []),
	};
	const editor = new ThinkTwiceEditor(tui as never, theme as never, keybindings as never, {
		delaySeconds: options?.delaySeconds ?? 0.4,
		doubleEnterSeconds: options?.doubleEnterSeconds,
		shouldCountdown: options?.shouldCountdown ?? (() => true),
		liveCommandNames: options?.liveCommandNames ?? (() => []),
		warning: options?.warning,
	});
	const submitted: string[] = [];
	const interrupted: string[] = [];
	editor.onSubmit = (text: string) => submitted.push(text);
	// pi wires app.interrupt to aborting the run; count the deliveries.
	editor.onAction("app.interrupt", () => interrupted.push("interrupt"));
	editor.setText("hello");
	return { editor, submitted, interrupted };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Enter keeps the text in the box and submits only after the countdown", async () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(ENTER);
	// Stock pi clears the editor here; pi-think-twice keeps it until the timer ends.
	assert.equal(editor.getText(), "hello");
	assert.deepEqual(submitted, []);

	await sleep(600); // delay is 400ms
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("Enter during the countdown is ignored before the double-enter interval: no send, no restart, no cancel", async () => {
	// delay 400ms, default double-enter interval 1000ms: the second Enter at
	// 150ms falls inside both, so it can never send early here.
	const { editor, submitted } = makeEditor({ delaySeconds: 0.4 });
	editor.handleInput(ENTER);
	await sleep(150);
	editor.handleInput(ENTER); // ignored
	await sleep(350); // 500ms total: past the original 400ms deadline, well before a restarted one
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	await sleep(300);
	assert.equal(submitted.length, 1);
});

test("a second Enter after the double-enter interval sends immediately", async () => {
	const { editor, submitted } = makeEditor({ delaySeconds: 5, doubleEnterSeconds: 0.15 });
	editor.handleInput(ENTER);
	await sleep(250); // past the 150ms interval, way before the 5s deadline
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
	await sleep(100);
	assert.equal(submitted.length, 1); // timer really stopped, nothing fires later
});

test("doubleEnterSeconds: 0 lets any Enter during the countdown send", () => {
	const { editor, submitted } = makeEditor({ delaySeconds: 5, doubleEnterSeconds: 0 });
	editor.handleInput(ENTER);
	editor.handleInput(ENTER); // first tick of the countdown already
	assert.deepEqual(submitted, ["hello"]);
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
});

test("any other key interrupts the countdown and leaves the text editable", async () => {
	const { editor, submitted } = makeEditor({ delaySeconds: 0.25 });
	editor.handleInput(ENTER);
	editor.handleInput("X"); // cancels and inserts
	await sleep(450); // past the original deadline
	assert.deepEqual(submitted, []);
	// Text was never sent and the edit landed — user keeps typing.
	assert.equal(editor.getText(), "helloX");
});

test("escape during the countdown cancels it and never reaches pi's interrupt handler", async () => {
	const { editor, submitted, interrupted } = makeEditor({ delaySeconds: 0.25 });
	editor.handleInput(ENTER);
	editor.handleInput(ESC);
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
	assert.deepEqual(interrupted, []); // the running agent keeps running
	await sleep(400); // past the original deadline
	assert.deepEqual(submitted, []);
	assert.equal(editor.getText(), "hello"); // text stays editable

	// The countdown is gone now, so the next escape is stock pi's interrupt.
	editor.handleInput(ESC);
	assert.deepEqual(interrupted, ["interrupt"]);
});

test("escape with no countdown running keeps its stock interrupt behavior", () => {
	const { editor, interrupted } = makeEditor();
	editor.handleInput(ESC);
	assert.deepEqual(interrupted, ["interrupt"]);
});

test("a rebound interrupt key is swallowed during the countdown too", () => {
	const CTRL_X = "\x18";
	const { editor, interrupted } = makeEditor({ delaySeconds: 5, interruptKey: CTRL_X });
	editor.handleInput(ENTER);
	editor.handleInput(CTRL_X);
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
	assert.deepEqual(interrupted, []);
});

test("exempt submissions go through immediately", () => {
	const { editor, submitted } = makeEditor({ shouldCountdown: () => false });
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("Ctrl+Enter sends immediately without starting a countdown", () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(CTRL_ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
});

test("Ctrl+Enter during a countdown finishes it immediately", () => {
	const { editor, submitted } = makeEditor();
	editor.handleInput(ENTER);
	assert.equal(editor.getText(), "hello");
	editor.handleInput(CTRL_ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
});

test("decision receives built-ins reflected from pi's captured provider", () => {
	let seen: readonly string[] | undefined;
	const { editor } = makeEditor({
		shouldCountdown: (_text, builtinCommands) => {
			seen = builtinCommands;
			return false;
		},
		liveCommandNames: () => ["review", "skill:foo"],
	});
	// What pi does: hand the editor its CombinedAutocompleteProvider.
	editor.setAutocompleteProvider({
		commands: [{ name: "settings" }, { name: "compact" }, { name: "review" }, { name: "skill:foo" }],
	} as never);
	editor.handleInput(ENTER);
	assert.ok(seen !== undefined);
	assert.deepEqual([...seen], ["settings", "compact"]);
});

test("without a provider the decision gets the reserved snapshot", () => {
	let seen: readonly string[] | undefined;
	const { editor } = makeEditor({
		shouldCountdown: (_text, builtinCommands) => {
			seen = builtinCommands;
			return false;
		},
	});
	editor.handleInput(ENTER);
	assert.ok(seen !== undefined);
	assert.deepEqual([...seen], [...RESERVED_BUILTIN_COMMANDS]);
});

test("a throwing decision fails open to an immediate stock submit", () => {
	const { editor, submitted } = makeEditor({
		shouldCountdown: () => {
			throw new Error("reflection or policy blew up");
		},
	});
	// Must not throw, must not wedge: stock pi submits right away.
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(editor.getText(), "");
	assert.equal((editor as unknown as { countdownTimer?: unknown }).countdownTimer, undefined);
});

test("a throwing liveCommandNames fails open too", () => {
	const { editor, submitted } = makeEditor({
		liveCommandNames: () => {
			throw new Error("getCommands blew up");
		},
	});
	editor.handleInput(ENTER);
	assert.deepEqual(submitted, ["hello"]);
});

test("the countdown text is painted with the warning color as a whole", () => {
	const { editor } = makeEditor({
		delaySeconds: 5,
		doubleEnterSeconds: 1,
		warning: (text) => `W{${text}}`,
	});
	editor.handleInput(ENTER);
	const border = (editor as unknown as { renderTopBorder(width: number, hidden: number): string }).renderTopBorder(80, 0);
	// Border dashes stay border-colored; spinner + message wear one warning span.
	assert.match(border, /^── W\{[^}]+· Ctrl\+Enter send now\}─+$/);
});

test("the border hint flips to plain Enter once the double-enter interval passes", async () => {
	const { editor } = makeEditor({ delaySeconds: 5, doubleEnterSeconds: 0.15 });
	editor.handleInput(ENTER);
	const border = () =>
		(editor as unknown as { renderTopBorder(width: number, hidden: number): string }).renderTopBorder(80, 0);
	assert.match(border(), /Ctrl\+Enter send now/);
	await sleep(250);
	assert.match(border(), /Enter send now/);
	assert.doesNotMatch(border(), /Ctrl\+Enter send now/);
});
