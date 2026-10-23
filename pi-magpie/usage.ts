/**
 * The `/magpie` surface in one place: the argument completions, the overview's
 * command list and `help` all read this table, so a new subcommand can never
 * be documented in one of them and missing from another.
 */

import { shortGroupId } from "./routing.ts";

export interface MagpieSubcommand {
	/** The word typed after `/magpie`. */
	name: string;
	/** Its argument, as a placeholder, when it takes one. */
	args?: string;
	/** One line, lower case: completes the syntax, does not repeat it. */
	summary: string;
}

/** Every subcommand, in the order they are offered and listed. */
export const SUBCOMMANDS: readonly MagpieSubcommand[] = [
	{ name: "quota", args: "[model]", summary: "what that model's provider has left, per account" },
	{ name: "group", args: "[id]", summary: "a routing group's members, rules and last decision" },
	{ name: "groups", summary: "every routing group magpie offers" },
	{ name: "refresh", summary: "fetch magpie's catalog again now" },
	{ name: "endpoint", summary: "the gateway in use, and what models.json says" },
	{ name: "help", summary: "this list" },
];

/** `/magpie <name> <args>` for one subcommand. */
export function subcommandSyntax(subcommand: MagpieSubcommand): string {
	return `/magpie ${subcommand.name}${subcommand.args ? ` ${subcommand.args}` : ""}`;
}

export function findSubcommand(name: string | undefined): MagpieSubcommand | undefined {
	return name === undefined ? undefined : SUBCOMMANDS.find((subcommand) => subcommand.name === name);
}

/** The command list, aligned, as the overview and `help` show it. */
export function usageLines(): string[] {
	const width = Math.max(...SUBCOMMANDS.map((subcommand) => subcommandSyntax(subcommand).length));
	return SUBCOMMANDS.map(
		(subcommand) => `${subcommandSyntax(subcommand).padEnd(width)}   ${subcommand.summary}`,
	);
}

// =============================================================================
// Argument completions
// =============================================================================

export interface CompletionItem {
	/** Replaces the whole argument text, as pi's editor does for commands. */
	value: string;
	label: string;
	description?: string;
}

/** What completions need to know: the models this extension has installed, and which of them magpie routes. */
export interface CompletionSource {
	models(): readonly { id: string; name: string }[];
	/** The routing groups' ids, as `magpie groups` names them. */
	groups(): ReadonlySet<string>;
}

/**
 * A subsequence score, higher is better: consecutive hits and early hits win,
 * so `qg5` finds `quota group/…` the way pi's own completions do. Undefined
 * when the query is not a subsequence of the text.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
	if (query === "") return 0;
	const needle = query.toLowerCase();
	const haystack = text.toLowerCase();
	let score = 0;
	let at = 0;
	let previous = -2;
	for (let index = 0; index < haystack.length && at < needle.length; index++) {
		if (haystack[index] !== needle[at]) continue;
		score += index === previous + 1 ? 3 : 1;
		// A prefix match is worth more than the same letters found inside.
		if (at === 0 && index === 0) score += 2;
		previous = index;
		at++;
	}
	return at === needle.length ? score : undefined;
}

/** The items whose text matches the query, best match first, ties in place. */
export function rank<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
	const scored = items
		.map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined);
	scored.sort((left, right) => right.score - left.score || left.index - right.index);
	return scored.map((entry) => entry.item);
}

/**
 * What to offer for the text after `/magpie`: the subcommand while its name is
 * being typed, then the ids that subcommand takes. Answers `null` when there is
 * nothing to add, which is what pi reads as "no completions".
 */
export function argumentCompletions(prefix: string, source: CompletionSource): CompletionItem[] | null {
	const text = prefix.trimStart();
	const words = text.split(/\s+/).filter(Boolean);
	// A separator after the last word means that word is done, not completed.
	const closed = /\s$/.test(text);
	if (words.length === 0 || (words.length === 1 && !closed)) {
		const query = words[0] ?? "";
		// The summary is shown, but never matched on: matching it would make
		// every subcommand answer the first vowel anyone types.
		return itemsOrNull(
			rank(SUBCOMMANDS, query, (subcommand) => subcommand.name).map((subcommand) => ({
				value: `${subcommand.name}${subcommand.args ? " " : ""}`,
				label: subcommandSyntax(subcommand).slice("/magpie ".length),
				description: subcommand.summary,
			})),
		);
	}
	// One word that is closed, or a second word still open, is the argument.
	if (words.length > 2 || (words.length === 2 && closed)) return null;
	const name = words[0]!;
	const query = words[1] ?? "";
	if (name === "quota") {
		return itemsOrNull(
			rank(source.models(), query, (model) => `${model.id} ${model.name}`).map((model) => ({
				value: `quota ${model.id}`,
				label: model.id,
				description: model.name,
			})),
		);
	}
	if (name === "group") {
		// Which model is a group is magpie's answer, not a prefix's: its own list.
		const known = source.groups();
		const groups = source.models().filter((model) => known.has(shortGroupId(model.id)));
		return itemsOrNull(
			rank(groups, query, (model) => `${model.id} ${model.name}`).map((model) => {
				const id = shortGroupId(model.id);
				return { value: `group ${id}`, label: id, description: model.name };
			}),
		);
	}
	return null;
}

function itemsOrNull(items: CompletionItem[]): CompletionItem[] | null {
	return items.length > 0 ? items : null;
}
