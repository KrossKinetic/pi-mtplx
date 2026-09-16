import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listedIdentity, resolveInstalledModels, servedModelId } from "../src/model-discovery.ts";

test("Forge outputs use installed paths while repository refs stay stable", () => {
	assert.equal(listedIdentity({ repo_id: "Swift-Qwen3.8-27B-MTPLX-Q8", path: "/models/Swift-Qwen3.8-27B-MTPLX-Q8" }), "/models/Swift-Qwen3.8-27B-MTPLX-Q8");
	assert.equal(listedIdentity({ repo_id: "owner/model", path: "/models/owner--model" }), "owner/model");
	assert.equal(listedIdentity({ path: "/models/local" }), "/models/local");
	assert.equal(listedIdentity({ repo_id: "", path: "" }), "");
});

test("an unresolved artifact does not block models before or after it", async () => {
	const installed = [
		{ repo_id: "owner/first" },
		{ repo_id: "owner/incomplete" },
		{ repo_id: "forged", path: "/models/forged" },
	];
	const result = await resolveInstalledModels(installed, async (ref) => {
		if (ref === "owner/incomplete") throw new Error("Missing runtime contract");
		return ref === "/models/forged" ? "canonical-forged" : "canonical-first";
	});
	assert.deepEqual(result.resolved.map(({ ref, id }) => ({ ref, id })), [
		{ ref: "owner/first", id: "canonical-first" },
		{ ref: "/models/forged", id: "canonical-forged" },
	]);
	assert.deepEqual(result.failures, ["owner/incomplete: Missing runtime contract"]);
});

test("all failed artifacts return diagnostics and no registrable models", async () => {
	const result = await resolveInstalledModels([{ repo_id: "owner/broken" }], async () => { throw new Error("unavailable"); });
	assert.deepEqual(result, { resolved: [], failures: ["owner/broken: unavailable"] });
});

test("quickstart errors expose JSON stdout or stderr and failed lookups can be retried", async () => {
	const bin = mkdtempSync(join(tmpdir(), "pi-mtplx-discovery-"));
	const originalPath = process.env.PATH;
	const cli = join(bin, "mtplx");
	try {
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		writeFileSync(cli, '#!/bin/sh\nprintf \'%s\\n\' \'{"detail":"Model path is not available locally: forged","error":"unavailable"}\'\nexit 1\n', { mode: 0o755 });
		await assert.rejects(servedModelId("test-forged"), /Model path is not available locally: forged/);
		writeFileSync(cli, '#!/bin/sh\nprintf \'%s\\n\' \'runtime failed\' >&2\nexit 1\n');
		await assert.rejects(servedModelId("test-forged"), /runtime failed/);
		writeFileSync(cli, '#!/bin/sh\nprintf \'%s\\n\' \'{"model_id":"canonical-forged"}\'\n');
		assert.equal(await servedModelId("test-forged"), "canonical-forged");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(bin, { recursive: true, force: true });
	}
});
