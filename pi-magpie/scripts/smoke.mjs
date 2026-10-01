#!/usr/bin/env node
/**
 * A live look at a running magpie: what this extension would install as models,
 * what the footer would say about the current one, and what the routing history
 * holds for a group. Read-only, and it prints the endpoint it used.
 *
 *   node scripts/smoke.mjs [root] [model-id]
 */

const root = (process.argv[2] ?? process.env.MAGPIE_GW_URL ?? "http://127.0.0.1:3425").replace(/\/+$/, "");
const wanted = process.argv[3];
const token = process.env.MAGPIE_TOKEN ?? "magpie";

const { toPiModels } = await import("../catalog.ts");
const { quotaView } = await import("../quota.ts");
const { defaultRoot, fetchCatalog, fetchQuotas, isLoopback, readRoutingTail, routingDays, runMagpie } =
	await import("../gateway.ts");
const { groupStatus, latestRoutesByGroup, parseGroupShow, parseGroupsList } = await import("../routing.ts");

console.log(`root:     ${root}`);
console.log(`default:  ${defaultRoot()}   loopback: ${isLoopback(root)}`);

const entries = await fetchCatalog(root, token, AbortSignal.timeout(8_000));
const models = toPiModels(entries, root);
console.log(`\ncatalog:  ${models.length} models`);
for (const model of models) {
	const thinking = model.reasoning
		? Object.entries(model.thinkingLevelMap ?? {})
				.filter(([, value]) => value)
				.map(([level]) => level)
				.join("/")
		: "no thinking";
	console.log(
		`  ${model.id}  ${model.name}  ${model.api}  ctx ${model.contextWindow}  out ${model.maxTokens}  ${thinking}${
			model.input.includes("image") ? "  images" : ""
		}  base ${model.baseUrl}`,
	);
}

const model = models.find((entry) => entry.id === wanted) ?? models.find((entry) => entry.id.startsWith("group/")) ?? models[0];
if (!model) process.exit(0);

console.log(`\nmodel:    ${model.id}`);
if (model.id.startsWith("group/")) {
	const id = model.id.slice("group/".length);
	const show = await runMagpie(["group", id]);
	const info = show.ok ? parseGroupShow(show.stdout) : undefined;
	console.log(
		`  info:    ${info ? `${info.routing} · stays ${info.stays} · ${info.members.join(" → ")}` : "not described"}`,
	);
	const [today, ...older] = await routingDays(2);
	const routes = await latestRoutesByGroup(await readRoutingTail(today ?? "", 1 << 20));
	const route = routes.get(id);
	console.log(`  footer:  ${groupStatus(route, info) ?? "nothing to say"}`);
	console.log(`  history: ${today ?? "no routing days"}${older.length ? ` (+${older.length} older)` : ""}`);
	if (route) console.log(`  last:    ${route.time} · ${route.group?.routing} · served ${route.served ?? "?"}`);
} else {
	const provider = model.magpieOwnedBy ?? model.id.split("/")[0];
	if (isLoopback(root)) {
		const quotas = await fetchQuotas(root, token, AbortSignal.timeout(8_000));
		const view = quotaView(quotas, provider);
		console.log(`  quota:   ${view.status ?? `nothing for ${provider}`}`);
		for (const line of view.report) console.log(`    ${line}`);
	}
}

const groups = await runMagpie(["groups"]);
if (groups.ok) {
	const rows = parseGroupsList(groups.stdout);
	console.log(`\ngroups:   ${rows.length}`);
	for (const row of rows) console.log(`  ${row.id}  ${row.routing ?? "?"}  ${row.members.join(" → ")}`);
} else {
	console.log(`\ngroups:   magpie CLI did not answer (${groups.error})`);
}
