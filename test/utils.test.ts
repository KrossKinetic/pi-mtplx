/**
 * Unit tests for the pure, dependency-free helpers in src/utils.ts.
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelIdFromRef, displayNameFromId, slugFromId, isMtplxModel, FAN_MODES } from "../src/utils.ts";

test("modelIdFromRef derives the Pi id from an artifact ref", () => {
	// The function uses the last path segment of the ref, so this mirrors the actual output.
	assert.equal(modelIdFromRef("Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality"), "mtplx-qwen3.8-27b-mtplx-optimized-quality");
});

test("modelIdFromRef handles refs without a slash", () => {
	const id = modelIdFromRef("some-local-model");
	assert.ok(id.startsWith("mtplx-"));
	assert.equal(id, id.toLowerCase());
});

test("displayNameFromId title-cases the id", () => {
	assert.equal(displayNameFromId("mtplx-qwen38-27b-optimized-quality"), "Qwen38 27b Optimized Quality");
});

test("slugFromId strips the mtplx- prefix and normalizes separators", () => {
	assert.equal(slugFromId("mtplx-qwen38-27b-optimized-quality"), "qwen38-27b-optimized-quality");
	assert.equal(slugFromId("mtplx-some--weird--id"), "some-weird-id");
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