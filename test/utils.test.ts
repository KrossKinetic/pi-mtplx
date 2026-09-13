/**
 * Unit tests for the pure, dependency-free helpers in src/utils.ts.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNameFromId, isMtplxModel, maskMtplxApiKey, mtplxApiKeyFromCatalog, mtplxEndpointFromBaseUrl, resolveMtplxApiKey, FAN_MODES, DEFAULT_AUTO_SHUTDOWN, DEFAULT_AUTO_START, DEFAULT_MTPLX_API_KEY, DEFAULT_SSD_SESSION_CACHE } from "../src/utils.ts";
import { servedModelIdFromDryRun } from "../src/model-discovery.ts";

test("servedModelIdFromDryRun uses MTPLX's canonical model id", () => {
	assert.equal(servedModelIdFromDryRun({ model_id: "mtplx-qwen36-35b-a3b-optimized-balance" }), "mtplx-qwen36-35b-a3b-optimized-balance");
	assert.throws(() => servedModelIdFromDryRun({}), /served model id/);
});

test("displayNameFromId title-cases the id", () => {
	assert.equal(displayNameFromId("mtplx-qwen38-27b-optimized-quality"), "Qwen38 27b Optimized Quality");
});

test("isMtplxModel matches the mtplx provider only", () => {
	assert.equal(isMtplxModel({ provider: "mtplx", id: "x" }), true);
	assert.equal(isMtplxModel({ provider: "mtplx-pi", id: "x" }), false);
	assert.equal(isMtplxModel({ provider: "anthropic", id: "x" }), false);
	assert.equal(isMtplxModel(undefined), false);
});

test("FAN_MODES matches the MTPLX CLI fan modes", () => {
	assert.deepEqual([...FAN_MODES], ["default", "smart", "max"]);
});

test("SSD session cache defaults to on", () => {
	assert.equal(DEFAULT_SSD_SESSION_CACHE, true);
});

test("auto-shutdown defaults to on", () => {
	assert.equal(DEFAULT_AUTO_SHUTDOWN, true);
});

test("auto-start defaults to on", () => {
	assert.equal(DEFAULT_AUTO_START, true);
});

test("mtplxEndpointFromBaseUrl normalizes local and remote endpoints", () => {
	assert.deepEqual(mtplxEndpointFromBaseUrl("http://127.0.0.1:8001/v1/"), {
		baseUrl: "http://127.0.0.1:8001/v1",
		origin: "http://127.0.0.1:8001",
		host: "127.0.0.1",
		port: 8001,
		isLoopback: true,
	});
	assert.deepEqual(mtplxEndpointFromBaseUrl("https://mtplx.example/v1"), {
		baseUrl: "https://mtplx.example/v1",
		origin: "https://mtplx.example",
		host: "mtplx.example",
		port: 443,
		isLoopback: false,
	});
});

test("mtplxApiKeyFromCatalog reads the provider-level key", () => {
	assert.equal(mtplxApiKeyFromCatalog({ providers: { mtplx: { apiKey: "  local-test-key  " } } }), "local-test-key");
});

test("mtplxApiKeyFromCatalog ignores missing or malformed keys", () => {
	for (const catalog of [undefined, {}, { providers: {} }, { providers: { mtplx: {} } }, { providers: { mtplx: { apiKey: "  " } } }, { providers: { mtplx: { apiKey: 1 } } }]) {
		assert.equal(mtplxApiKeyFromCatalog(catalog), undefined);
	}
});

test("maskMtplxApiKey does not expose the configured key", () => {
	assert.equal(maskMtplxApiKey(undefined), `default (${DEFAULT_MTPLX_API_KEY})`);
	assert.equal(maskMtplxApiKey("abc"), "configured");
	assert.equal(maskMtplxApiKey("local-test-key"), "••••-key");
});

test("resolveMtplxApiKey uses the configured key or the default", () => {
	assert.equal(resolveMtplxApiKey("custom-key"), "custom-key");
	assert.equal(resolveMtplxApiKey(undefined), DEFAULT_MTPLX_API_KEY);
});
