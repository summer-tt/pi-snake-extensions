/**
 * The pi-think-twice editor: intercepts Enter, keeps the text in the box, and runs
 * the send countdown in the editor's top border.
 *
 * Key handling, per the design:
 * - Enter while idle (non-exempt text): start the countdown, text stays put.
 * - Any key while counting down: cancel (text stays — keep editing).
 * - Escape while counting down: cancel and swallow — it never reaches pi's
 *   `app.interrupt` handler, so a running agent keeps running (a second
 *   Escape, now with no countdown active, aborts as usual).
 * - Enter while counting down: ignored until `doubleEnterSeconds` (default
 *   1 s) have elapsed since the first Enter — a deliberate double Enter then
 *   sends immediately; a faster repeat is treated as a bounce and ignored.
 * - Ctrl+Enter: send now — skips the countdown when idle, finishes it early
 *   while active.
 *
 * Failure policy: every pi-think-twice code path that could break (decision,
 * reflection, ticking, rendering) degrades to stock pi behavior — fail open to
 * an immediate submit, or keep the text and stop the timer. No failure path
 * leaves pi stuck or crashes the TUI.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	type AutocompleteProvider,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { resolveBuiltinCommands } from "./builtins.ts";
import { DEFAULT_DOUBLE_ENTER_SECONDS } from "./config.ts";

/** pi's interrupt/cancel action id; ESC by default, rebindable by the user. */
const INTERRUPT_ACTION = "app.interrupt";

/** Same braille frames as pi's own working spinner (pi-tui Loader defaults). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
/** Plain Enter for replaying a submit; "\r" matches "enter" in every key mode. */
const SUBMIT_KEY = "\r";
const TAB_KEY = "\t";

export interface ThinkTwiceEditorOptions {
	/** Countdown length in seconds (> 0; the extension is not installed at 0). */
	delaySeconds: number;
	/**
	 * Seconds that must pass after the first Enter before a second Enter
	 * sends immediately; 0 lets any Enter during the countdown send.
	 */
	doubleEnterSeconds?: number;
	/**
	 * Decides whether this submission opens the countdown. Receives the
	 * built-in command names reflected from pi's autocomplete provider.
	 */
	shouldCountdown: (text: string, builtinCommands: readonly string[]) => boolean;
	/**
	 * Every current `pi.getCommands()` name — subtracted from the provider's
	 * list to isolate the built-ins.
	 */
	liveCommandNames: () => readonly string[];
	/** Warning color (yellow/orange) for the whole countdown text; falls back to the editor border color. */
	warning?: (text: string) => string;
}

export class ThinkTwiceEditor extends CustomEditor {
	private readonly kb: KeybindingsManager;
	private readonly delayMs: number;
	private readonly doubleEnterMs: number;
	private readonly shouldCountdownFn: ThinkTwiceEditorOptions["shouldCountdown"];
	private readonly liveCommandNames: () => readonly string[];
	private readonly warning: (text: string) => string;

	/** pi's autocomplete provider, captured for built-in reflection. */
	private receivedProvider: AutocompleteProvider | undefined;

	private countdownTimer: ReturnType<typeof setInterval> | undefined;
	private deadline = 0;
	private frameIndex = 0;
	/** The original Enter sequence, replayed when the countdown completes. */
	private pendingKey: string | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: ThinkTwiceEditorOptions) {
		// embedWorkingStatus matches the stock editor's border spinner.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.kb = keybindings;
		this.delayMs = Math.max(0, options.delaySeconds) * 1000;
		this.doubleEnterMs = Math.max(0, options.doubleEnterSeconds ?? DEFAULT_DOUBLE_ENTER_SECONDS) * 1000;
		this.shouldCountdownFn = options.shouldCountdown;
		this.liveCommandNames = options.liveCommandNames;
		this.warning = options.warning ?? ((text) => theme.borderColor(text));
	}

	/**
	 * pi hands its autocomplete provider to every custom editor — both when
	 * the editor component is swapped and whenever the provider is rebuilt.
	 * Capturing it here is what makes the built-in list reflectable.
	 */
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.receivedProvider = provider;
		super.setAutocompleteProvider(provider);
	}

	private get countdownActive(): boolean {
		return this.countdownTimer !== undefined;
	}

	/** Milliseconds elapsed since the countdown started (0 while idle). */
	private elapsedMs(): number {
		return this.countdownActive ? this.delayMs - (this.deadline - Date.now()) : 0;
	}

	/** Whether a second Enter now sends: the double-enter interval has passed. */
	private doubleEnterReady(): boolean {
		return this.elapsedMs() >= this.doubleEnterMs;
	}

	override handleInput(data: string): void {
		try {
			this.handleInputImpl(data);
		} catch {
			// Fail open: any pi-think-twice bug behaves exactly like stock pi.
			this.hardStopCountdown();
			super.handleInput(data);
		}
	}

	private handleInputImpl(data: string): void {
		// pi disables submission in some states; respect that completely.
		if (this.disableSubmit) {
			super.handleInput(data);
			return;
		}

		// Mirror pi's own precedence: newline wins over submit, so Shift+Enter
		// and Ctrl+J keep inserting new lines instead of starting a countdown.
		const isSubmit =
			this.kb.matches(data, "tui.input.submit") &&
			!this.kb.matches(data, "tui.input.newLine");
		const isSendNow = matchesKey(data, "ctrl+enter");

		if (this.countdownActive) {
			if (isSendNow) {
				this.finishNow();
				return;
			}
			// Cancel-and-swallow for the interrupt key (ESC by default): the
			// keybinding is resolved by pi, so rebinding works, and nothing is
			// re-implemented — only its delivery is blocked for this one press.
			// With autocomplete open we fall through: stock pi cancels the
			// suggestion instead of interrupting, and it must keep doing that.
			if (this.kb.matches(data, INTERRUPT_ACTION) && !this.isShowingAutocomplete()) {
				this.cancelCountdown();
				return;
			}
			if (isSubmit) {
				// Second Enter: ignored until the double-enter interval has elapsed
				// since the first one; after that it sends immediately.
				if (this.elapsedMs() >= this.doubleEnterMs) {
					this.finishNow();
				}
				return;
			}
			// Any other key interrupts; the text stays in the box.
			this.cancelCountdown();
			super.handleInput(data);
			return;
		}

		if (isSendNow) {
			this.submitNow();
			return;
		}

		if (isSubmit) {
			if (this.isShowingAutocomplete()) {
				// pi would complete AND submit on one Enter (choose = run). Split
				// it: Tab applies the suggestion without submitting, then the
				// normal countdown decision runs on the completed text.
				super.handleInput(TAB_KEY);
			}
			// Stock backslash workaround: a trailing "\" + Enter inserts a
			// newline instead of submitting (pi does this when Shift+Enter is
			// unavailable). Cursor position is private, so approximate with the
			// buffer ending in a backslash — the common end-of-line case.
			if (this.getText().endsWith("\\")) {
				super.handleInput(data);
				return;
			}
			const text = this.getText().trim();
			if (!text || !this.decideShouldCountdown(text)) {
				// Empty or exempt (built-in / registered command): submit as usual.
				super.handleInput(data);
				return;
			}
			this.startCountdown(data);
			return;
		}

		super.handleInput(data);
	}

	/**
	 * The countdown decision, with both failure layers folded in:
	 * reflection failures fall back to the reserved built-in list inside
	 * `resolveBuiltinCommands`; anything else (getCommands, policy bugs)
	 * fails open to `false` = stock immediate submit.
	 */
	private decideShouldCountdown(text: string): boolean {
		try {
			const builtinCommands = resolveBuiltinCommands(
				this.receivedProvider,
				this.liveCommandNames(),
			);
			return this.shouldCountdownFn(text, builtinCommands);
		} catch {
			return false;
		}
	}

	/** Ctrl+Enter: apply any open suggestion, then submit without a countdown. */
	private submitNow(): void {
		if (this.isShowingAutocomplete()) {
			super.handleInput(TAB_KEY);
		}
		super.handleInput(SUBMIT_KEY);
	}

	private startCountdown(pendingKey: string): void {
		this.pendingKey = pendingKey;
		this.deadline = Date.now() + this.delayMs;
		this.frameIndex = 0;
		this.countdownTimer = setInterval(() => this.tick(), TICK_MS);
		this.tick();
	}

	private tick(): void {
		try {
			if (this.countdownTimer === undefined) return;
			if (Date.now() >= this.deadline) {
				this.finishNow();
				return;
			}
			this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		} catch {
			// Breakdown mid-countdown: stop the timer, leave the text untouched.
			// The user just presses Enter again (which then fails open if the
			// fault persists) — no deadlock, no crash.
			this.hardStopCountdown();
		}
	}

	private cancelCountdown(): void {
		if (this.countdownTimer === undefined) return;
		this.hardStopCountdown();
		this.tui.requestRender();
	}

	private finishNow(): void {
		if (this.countdownTimer === undefined) return;
		const key = this.pendingKey ?? SUBMIT_KEY;
		this.hardStopCountdown();
		this.tui.requestRender();
		// super skips this override, so the replay reaches pi's real submit.
		super.handleInput(key);
	}

	/** Stop the timer without rendering — safe to call from any failure path. */
	private hardStopCountdown(): void {
		if (this.countdownTimer !== undefined) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = undefined;
		}
		this.pendingKey = undefined;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.countdownActive || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}
		try {
			const remaining = Math.max(0, this.deadline - Date.now());
			const seconds = Math.max(1, Math.ceil(remaining / 1000));
			const spinner = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];

			// Widest → narrowest; pick the first variant that fits inside the
			// border ("── " prefix plus at least two trailing dashes). The hint
			// flips once the double-enter interval makes plain Enter a send.
			const sendHint = this.doubleEnterReady() ? "Enter send now" : "Ctrl+Enter send now";
			const variants = [
				`${spinner} sending in ${seconds}s · ESC to cancel · ${sendHint}`,
				`${spinner} sending in ${seconds}s · ESC to cancel`,
				`${spinner} ${seconds}s`,
			];
			const content = variants.find((variant) => visibleWidth(variant) + 3 + 2 <= width);
			if (content === undefined) {
				// Too narrow to show anything meaningful: plain border.
				return this.borderColor("─".repeat(width));
			}

			const pad = Math.max(0, width - 3 - visibleWidth(content));
			// The whole countdown text (spinner + message) wears the warning color.
			return this.borderColor("── ") + this.warning(content) + this.borderColor("─".repeat(pad));
		} catch {
			// Never let a rendering fault take down the TUI's render loop.
			return super.renderTopBorder(width, hiddenLineCount);
		}
	}
}
