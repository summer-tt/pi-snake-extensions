import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopback, normalizeRoot, modelsUrl, quotasUrl, traceUrl } from "../gateway.ts";

test("normalizeRoot: a scheme is assumed, /v1 and trailing slashes dropped", () => {
	assert.equal(normalizeRoot("http://127.0.0.1:3425"), "http://127.0.0.1:3425");
	assert.equal(normalizeRoot("http://127.0.0.1:3425/"), "http://127.0.0.1:3425");
	assert.equal(normalizeRoot("http://127.0.0.1:3425/v1"), "http://127.0.0.1:3425");
	assert.equal(normalizeRoot("http://127.0.0.1:3425/v1/"), "http://127.0.0.1:3425");
	assert.equal(normalizeRoot("127.0.0.1:3425"), "http://127.0.0.1:3425");
	assert.equal(normalizeRoot("  magpie.local:3425/v1  "), "http://magpie.local:3425");
	assert.equal(normalizeRoot("https://magpie.example.com/magpie/v1"), "https://magpie.example.com/magpie");
	assert.equal(normalizeRoot("http://[::1]:3425/v1"), "http://[::1]:3425");
});

test("normalizeRoot: nothing usable is undefined", () => {
	assert.equal(normalizeRoot(undefined), undefined);
	assert.equal(normalizeRoot(""), undefined);
	assert.equal(normalizeRoot("   "), undefined);
	assert.equal(normalizeRoot("not a url"), undefined);
	assert.equal(normalizeRoot("ftp://host:3425"), undefined);
});

test("isLoopback: only this machine's gateway has quotas and routing history", () => {
	assert.equal(isLoopback("http://127.0.0.1:3425"), true);
	assert.equal(isLoopback("http://127.1.2.3:3425"), true);
	assert.equal(isLoopback("http://localhost:3425"), true);
	assert.equal(isLoopback("http://[::1]:3425"), true);
	assert.equal(isLoopback("http://0.0.0.0:3425"), true);
	assert.equal(isLoopback("http://192.168.1.5:3425"), false);
	assert.equal(isLoopback("https://magpie.example.com"), false);
});

test("endpoint URLs hang off the root", () => {
	assert.equal(modelsUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1/models");
	assert.equal(quotasUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1/magpie/quotas");
});

test("the quota URL asks for magpie's own reading, or the vendors'", () => {
	const root = "http://127.0.0.1:3425";
	assert.equal(quotasUrl(root), `${root}/v1/magpie/quotas`, "a plain read asks the vendors");
	assert.equal(quotasUrl(root, true), `${root}/v1/magpie/quotas?kept=1`, "kept asks none");
	assert.equal(quotasUrl(root, false), `${root}/v1/magpie/quotas`);
});

test("the routing trace hangs off the root too", () => {
	assert.equal(traceUrl("http://127.0.0.1:3425"), "http://127.0.0.1:3425/v1/magpie/trace");
});
