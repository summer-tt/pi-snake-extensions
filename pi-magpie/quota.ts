/**
 * pi-magpie — what the current model's provider has left, as magpie reports it
 * (`GET /v1/magpie/quotas`). Rendering only: the request lives in gateway.ts.
 */

/** One allowance window of a subscription, plan or key. */
export interface QuotaWindow {
	name?: string;
	/** Share of the window used, 0–100. */
	used?: number;
	/** Share of the window left, 0–100. */
	remaining?: number;
	resetsAt?: string;
	/** The vendor's own wording, when it gave one (e.g. "0 / 6900"). */
	display?: string;
}

/** Everything left on one subscription, plan or key. */
export interface QuotaEntry {
	provider?: string;
	name?: string;
	kind?: string;
	plan?: string;
	user?: string;
	windows?: QuotaWindow[];
	until?: string;
	resets?: { count?: number; until?: string };
	error?: string;
}

/** The quota lines for one model. */
export interface QuotaView {
	/** The entries that belong to the model's provider, tightest window first. */
	entries: QuotaEntry[];
	/** The window the footer shows: the least left, then the soonest to reset. */
	tightest?: { entry: QuotaEntry; window: QuotaWindow };
	/** The footer's reading at both widths, or undefined when nothing is known. */
	status?: StatusForms;
	/** Lines for `/magpie`. */
	report: string[];
}

/** The share left in one window, when the vendor said it. */
export function remainingPercent(window: QuotaWindow): number | undefined {
	if (typeof window.remaining === "number" && Number.isFinite(window.remaining)) {
		return Math.max(0, Math.min(100, window.remaining));
	}
	if (typeof window.used === "number" && Number.isFinite(window.used)) {
		return Math.max(0, Math.min(100, 100 - window.used));
	}
	return undefined;
}

/** A window as it reads: the vendor's own wording, else the share left. */
export function windowText(window: QuotaWindow): string {
	const display = window.display?.trim();
	if (display) return display;
	const remaining = remainingPercent(window);
	return remaining === undefined ? "?" : `${Math.round(remaining)}%`;
}

/** When a window starts again, as magpie's ResetClock reads it. */
export function formatReset(resetsAt: string | undefined, now: number): string | undefined {
	if (!resetsAt) return undefined;
	const at = Date.parse(resetsAt);
	if (!Number.isFinite(at)) return undefined;
	const left = at - now;
	if (left <= 60_000) return "now";
	const minutes = Math.round(left / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(left / 3_600_000);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(left / 86_400_000);
	if (days < 7) return `${days}d`;
	return new Date(at).toISOString().slice(0, 10);
}

/** The entries that belong to one magpie provider. */
export function selectQuotas(entries: readonly QuotaEntry[], provider: string): QuotaEntry[] {
	return entries.filter((entry) => entry?.provider === provider);
}

/** The window with the least left, then the soonest to reset. */
export function tightestWindow(
	entries: readonly QuotaEntry[],
): { entry: QuotaEntry; window: QuotaWindow } | undefined {
	let best: { entry: QuotaEntry; window: QuotaWindow } | undefined;
	for (const entry of entries) {
		for (const window of entry.windows ?? []) {
			if (!best || tighter(window, best.window)) best = { entry, window };
		}
	}
	return best;
}

function tighter(candidate: QuotaWindow, current: QuotaWindow): boolean {
	const candidateLeft = remainingPercent(candidate) ?? 101;
	const currentLeft = remainingPercent(current) ?? 101;
	if (candidateLeft !== currentLeft) return candidateLeft < currentLeft;
	const candidateReset = resetTime(candidate);
	const currentReset = resetTime(current);
	if (candidateReset === undefined) return currentReset !== undefined;
	if (currentReset === undefined) return false;
	return candidateReset < currentReset;
}

function resetTime(window: QuotaWindow): number | undefined {
	const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	return Number.isFinite(at) ? at : undefined;
}

/** A magpie provider's quota as the footer and `/magpie` read it. */
export function quotaView(entries: readonly QuotaEntry[], provider: string, now = Date.now()): QuotaView {
	const selected = selectQuotas(entries, provider);
	const tightest = tightestWindow(selected);
	const report: string[] = [];
	for (const entry of selected) {
		report.push(entryTitle(entry));
		if (entry.error) {
			report.push(`  error: ${entry.error.trim()}`);
			continue;
		}
		const windows = entry.windows ?? [];
		if (windows.length === 0) {
			report.push("  no allowance reported");
			continue;
		}
		for (const window of windows) {
			const reset = formatReset(window.resetsAt, now);
			const name = window.name?.trim() || "allowance";
			report.push(`  ${name} ${windowText(window)}${reset ? ` · resets ${reset}` : ""}`);
		}
	}
	return { entries: selected, tightest, status: statusForms(tightest, now), report };
}

/** The footer reading of a quota at both widths it may be shown at. */
export interface StatusForms {
	/** Roomy footer: `16% left · reset 3d`. */
	full: string;
	/** Footer with no room: `16% · 3d`. */
	short: string;
}

/**
 * The one-line footer reading of a quota: the share left spelled out with room,
 * cut to the bare number without. Both forms are label-less — the caller
 * prefixes the provider and picks the tier by the width it has.
 */
export function statusForms(
	tightest: { entry: QuotaEntry; window: QuotaWindow } | undefined,
	now = Date.now(),
): StatusForms | undefined {
	if (!tightest) return undefined;
	const { window } = tightest;
	const remaining = remainingPercent(window);
	const share = remaining === undefined ? windowText(window) : `${Math.round(remaining)}%`;
	const reset = formatReset(window.resetsAt, now);
	return {
		full: `${share} left${reset ? ` · reset ${reset}` : ""}`,
		short: `${share}${reset ? ` · ${reset}` : ""}`,
	};
}

/**
 * The footer line at the width there is: the full reading when `budget` has
 * room for it (label included), the cut one when it does not.
 */
export function statusForWidth(forms: StatusForms, budget: number, label: string, cutLabel: string): string {
	const full = `${label} ${forms.full}`;
	return full.length <= budget ? full : `${cutLabel} ${forms.short}`;
}

/** `OpenCode Go · plus · user@example.com (subscription)`. */
function entryTitle(entry: QuotaEntry): string {
	const parts = [entry.name?.trim() || entry.provider || "provider"];
	if (entry.plan?.trim()) parts.push(entry.plan.trim());
	if (entry.user?.trim()) parts.push(entry.user.trim());
	const title = parts.join(" · ");
	return entry.kind?.trim() ? `${title} (${entry.kind.trim()})` : title;
}
