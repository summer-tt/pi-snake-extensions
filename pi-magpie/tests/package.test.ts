/**
 * The repository root is a pi package — the unit a git install at a pinned
 * commit brings in (`pi install git:github.com/summer-tt/pi-snake-extensions@<sha>`).
 * Its manifest must expose exactly pi-magpie, so that one extension loads and
 * nothing else from this monorepo, and it must vendor nothing: the SDK packages
 * are peer dependencies (`*`), and pi's loader maps them to the running
 * agent's own copies.
 *
 * This is the real chain, not a reading of it: a real `git clone` of this
 * repository sits at the path pi computes for the source, a real
 * `DefaultResourceLoader` resolves it from a real `settings.json` through the
 * real package manager, and the real loader imports the extension through the
 * SDK under test. `PI_MAGPIE_TEST_SDK` points that SDK at any
 * `@earendil-works/pi-coding-agent` package directory (the running agent's
 * release, say); without it, the package's own dev dependency is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** This repository, and the git source a pi install of it names. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GIT_HOST = "github.com";
const GIT_PATH = "summer-tt/pi-snake-extensions";
const GIT_SOURCE = `git:${GIT_HOST}/${GIT_PATH}`;

/** The SDK under test: the one pointed at, else the dev dependency. */
async function importSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	const override = process.env.PI_MAGPIE_TEST_SDK;
	if (override) return (await import(join(override, "dist", "index.js"))) as never;
	return import("@earendil-works/pi-coding-agent");
}

/**
 * A scratch agent directory and working directory, with this process's HOME
 * and agent dir pointed at them, so none of the user's own pi is discovered.
 */
async function isolatedPi(): Promise<{
	agentDir: string;
	cwd: string;
	previous: Record<string, string | undefined>;
}> {
	const base = await mkdtemp(join(tmpdir(), "pi-magpie-package-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "work");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	const previous = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.HOME = base;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { agentDir, cwd, previous };
}

/** A real `git clone` of this repository at `ref`, the way an install lands it. */
async function cloneRepositoryAt(target: string, ref: string): Promise<void> {
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	await execFileAsync("git", ["clone", "--quiet", "--no-hardlinks", REPO_ROOT, target], { env });
	await execFileAsync("git", ["checkout", "--quiet", "--detach", ref], { cwd: target, env });
}

test("a git install of this repository loads pi-magpie, and only it", async (t) => {
	const { stdout: sha } = await execFileAsync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
	const head = sha.trim();
	const sdk = await importSdk();
	const home = await isolatedPi();

	// Where pi keeps a user-scope git install of this source: a clone at the
	// pinned commit, with settings naming it.
	const cloneRoot = join(home.agentDir, "git", GIT_HOST, GIT_PATH);
	await rm(dirname(cloneRoot), { recursive: true, force: true });
	await mkdir(dirname(cloneRoot), { recursive: true });
	await cloneRepositoryAt(cloneRoot, head);
	await writeFile(
		join(home.agentDir, "settings.json"),
		JSON.stringify({ packages: [`${GIT_SOURCE}@${head}`] }, null, "\t"),
	);

	t.after(async () => {
		for (const [name, value] of Object.entries(home.previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(dirname(home.agentDir), { recursive: true, force: true });
	});

	// The manifest a git install reads: this extension, and nothing else.
	const manifest = JSON.parse(await readFile(join(cloneRoot, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	assert.deepEqual(manifest.pi?.extensions, ["./pi-magpie/index.ts"], "the root manifest exposes only pi-magpie");
	assert.ok(
		!manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
		"nothing is installed next to the extension",
	);
	assert.deepEqual(manifest.peerDependencies, {
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-ai": "*",
	});
	assert.ok(
		!existsSync(join(cloneRoot, "node_modules")),
		"the SDK stays with the host: the clone vendors no copy",
	);
	assert.throws(
		() => createRequire(join(cloneRoot, "pi-magpie", "index.ts")).resolve("@earendil-works/pi-coding-agent"),
		/Cannot find (package|module)/,
		"plain Node resolution finds no SDK in the install either",
	);

	// The real chain: settings → package manager → resource loader → loader.
	const settings = sdk.SettingsManager.create(home.cwd, home.agentDir);
	const loader = new sdk.DefaultResourceLoader({ cwd: home.cwd, agentDir: home.agentDir, settingsManager: settings });
	await loader.reload();
	const loaded = loader.getExtensions();

	assert.deepEqual(loaded.errors, [], "nothing fails to load");
	const fromThisRepo = loaded.extensions.filter((extension) => extension.resolvedPath.startsWith(`${cloneRoot}/`));
	assert.equal(fromThisRepo.length, 1, "exactly one extension of this repository loads");
	assert.equal(
		fromThisRepo[0]?.resolvedPath,
		join(cloneRoot, "pi-magpie", "index.ts"),
		"and it is pi-magpie's entrypoint, not another extension's",
	);
	assert.ok(fromThisRepo[0]?.commands.has("magpie"), "the /magpie command registered through the real loader");
	// A provider registration lands on the runtime's queue for the model
	// registry (a provider object registers natively; a name-and-config pair
	// on the other queue) — pi drains both when the runner binds.
	const registered = [
		...loaded.runtime.pendingProviderRegistrations.map((entry) => entry.name),
		...loaded.runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id),
	];
	assert.deepEqual(registered, ["magpie"], "the provider registered through the real runtime, once");
});
