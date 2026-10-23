import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	argumentCompletions,
	findSubcommand,
	fuzzyScore,
	rank,
	SUBCOMMANDS,
	subcommandSyntax,
	usageLines,
} from "../usage.ts";

const source = {
	models: () => [
		{ id: "opencode-go/mimo-v2.6-flash", name: "MiMo-V2.6-Flash" },
		{ id: "codex/gpt-5.5", name: "GPT-5.5" },
		{ id: "auto/mimo-v2.6-flash", name: "MiMo-V2.6-Flash" },
		{ id: "group/step-5-preview", name: "step-5-preview" },
	],
	// `magpie groups` names them: a found group's auto/<model>, a made one's group/<id>.
	groups: () =>
		new Set([
			"auto/mimo-v2.6-flash",
			"step-5-preview",
		]),
};

const labels = (prefix: string): string[] =>
	(argumentCompletions(prefix, source) ?? []).map((item) => item.label);

describe("the /magpie command table", () => {
	it("names every subcommand with its syntax", () => {
		assert.deepEqual(
			SUBCOMMANDS.map(subcommandSyntax),
			[
				"/magpie quota [model]",
				"/magpie group [id]",
				"/magpie groups",
				"/magpie refresh",
				"/magpie endpoint",
				"/magpie help",
			],
		);
	});

	it("lists them aligned, each with its summary", () => {
		const lines = usageLines();
		assert.equal(lines.length, SUBCOMMANDS.length);
		for (const [index, subcommand] of SUBCOMMANDS.entries()) {
			assert.match(lines[index]!, new RegExp(`^${subcommandSyntax(subcommand).replace(/[[\]]/g, "\\$&")}\\s{2,}\\S`));
		}
	});

	it("finds a subcommand by name, and nothing for a wrong one", () => {
		assert.equal(findSubcommand("quota")?.name, "quota");
		assert.equal(findSubcommand("quotas"), undefined);
		assert.equal(findSubcommand(undefined), undefined);
	});
});

describe("fuzzyScore", () => {
	it("accepts only subsequences", () => {
		assert.notEqual(fuzzyScore("qg", "quota group"), undefined);
		assert.equal(fuzzyScore("qz", "quota group"), undefined);
		assert.equal(fuzzyScore("", "anything"), 0);
	});

	it("prefers consecutive and early hits", () => {
		assert.ok(fuzzyScore("quota", "quota")! > fuzzyScore("quota", "quo ta")!);
		assert.ok(fuzzyScore("a", "apple")! > fuzzyScore("a", "banana")!);
	});

	it("is case-insensitive", () => {
		assert.equal(fuzzyScore("MIMO", "mimo"), fuzzyScore("mimo", "mimo"));
	});
});

describe("rank", () => {
	it("keeps the given order when the scores tie", () => {
		assert.deepEqual(rank(["aa", "ab", "ba"], "a", (text) => text), ["aa", "ab", "ba"]);
	});

	it("drops what does not match at all", () => {
		assert.deepEqual(rank(["one", "two"], "zz", (text) => text), []);
	});
});

describe("argumentCompletions", () => {
	it("offers every subcommand for an empty argument", () => {
		assert.deepEqual(labels(""), SUBCOMMANDS.map((subcommand) => subcommandSyntax(subcommand).slice("/magpie ".length)));
		assert.equal(argumentCompletions("", source)![0]!.value, "quota ");
		assert.equal(argumentCompletions("", source)![2]!.value, "groups");
		assert.equal(argumentCompletions("", source)![1]!.description, SUBCOMMANDS[1]!.summary);
	});

	it("narrows the subcommand as it is typed", () => {
		assert.deepEqual(labels("q"), ["quota [model]"]);
		assert.deepEqual(labels("gr"), ["group [id]", "groups"]);
		assert.deepEqual(labels("en"), ["endpoint"]);
		// A prefix match comes first, even when other names hold the letter.
		assert.equal(labels("e")[0], "endpoint");
		assert.equal(argumentCompletions("nope", source), null);
	});

	it("ranks a contiguous match above a scattered one", () => {
		// "gpt" is consecutive in codex/gpt-5.5, and only a subsequence of the group.
		assert.deepEqual(labels("quota gpt"), ["codex/gpt-5.5", "group/step-5-preview"]);
	});

	it("offers the models a quota can name", () => {
		const items = argumentCompletions("quota ", source)!;
		assert.equal(items.length, 4);
		assert.deepEqual(items[0], {
			value: "quota opencode-go/mimo-v2.6-flash",
			label: "opencode-go/mimo-v2.6-flash",
			description: "MiMo-V2.6-Flash",
		});
		assert.deepEqual(labels("quota mimo"), [
			"opencode-go/mimo-v2.6-flash",
			"auto/mimo-v2.6-flash",
		]);
	});

	it("offers the groups magpie lists, by the id the CLI takes, without a prefix", () => {
		const items = argumentCompletions("group ", source)!;
		assert.deepEqual(items.map((item) => item.value), [
			"group auto/mimo-v2.6-flash",
			"group step-5-preview",
		]);
		assert.deepEqual(items.map((item) => item.label), [
			"auto/mimo-v2.6-flash",
			"step-5-preview",
		]);
	});

	it("stops once the argument is done or cannot be completed", () => {
		assert.equal(argumentCompletions("groups ", source), null);
		assert.equal(argumentCompletions("refresh ", source), null);
		assert.equal(argumentCompletions("help ", source), null);
		assert.equal(argumentCompletions("quota mimo ", source), null);
		assert.equal(argumentCompletions("quota a b", source), null);
	});

	it("tolerates leading space, as the editor sends it", () => {
		assert.deepEqual(labels("  gr"), ["group [id]", "groups"]);
		assert.deepEqual(labels("  quota step"), ["group/step-5-preview"]);
	});
});
