/**
 * MTPLX model registry: Pi model id → installed MTPLX artifact ref.
 *
 * The refs are the artifact identifiers reported by `mtplx models --json`;
 * `--model-id` makes /health and /v1/models report Pi's id.
 *
 * The built-in map is the fallback; registrations added from `/mtplx` are
 * persisted next to it (~/.pi/agent/mtplx-models.json) and override it at load.
 *
 * Pi's model catalog is the USER's own ~/.pi/agent/models.json — a provider
 * config that pre-existed this package (created by `mtplx start pi` / the
 * /mtplx UI). The canonical provider name is MTPLX's own `mtplx`
 * (PI_PROVIDER_ID in MTPLX's mtplx/pi.py); this extension reads and writes
 * only that provider entry and leaves every other provider untouched.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelIdFromRef, displayNameFromId, slugFromId } from "./utils.ts";

const execFileAsync = promisify(execFile);

// Matches MTPLX's own PI_PROVIDER_ID ("mtplx") so the extension operates on
// the exact provider block that `mtplx start pi` creates.
export const MTPLX_PROVIDER = "mtplx";
const MODELS_FILE = join(homedir(), ".pi", "agent", "mtplx-models.json");
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

const BUILTIN_MODELS: Record<string, { ref: string }> = {
	"mtplx-qwen38-27b-optimized-quality": {
		ref: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality",
	},
};

export function loadRegisteredModels(): Record<string, { ref: string }> {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_FILE, "utf8")) as Record<string, { ref?: unknown }>;
		const out: Record<string, { ref: string }> = {};
		for (const [id, entry] of Object.entries(parsed)) {
			if (entry && typeof entry.ref === "string") out[id] = { ref: entry.ref };
		}
		return out;
	} catch {
		// missing or corrupt file → fall back to the built-ins only
	}
	return {};
}

export const MTPLX_MODELS: Record<string, { ref: string }> = { ...BUILTIN_MODELS, ...loadRegisteredModels() };

export function saveRegisteredModels(): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(MODELS_FILE, JSON.stringify(MTPLX_MODELS, null, 2) + "\n");
	} catch (error) {
		console.error(`MTPLX could not persist model registry: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// --- enabledModels management (settings.json) ---

function loadEnabledModels(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { enabledModels?: unknown };
		return Array.isArray(parsed.enabledModels) ? (parsed.enabledModels as string[]) : [];
	} catch {
		return [];
	}
}

export function enableModelInSettings(modelId: string): boolean {
	try {
		const catalog = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { enabledModels?: unknown[] };
		const enabled = Array.isArray(catalog.enabledModels) ? catalog.enabledModels : [];
		const entry = `mtplx/${modelId}`;
		if (enabled.includes(entry)) return true;
		enabled.push(entry);
		catalog.enabledModels = enabled;
		writeFileSync(SETTINGS_FILE, JSON.stringify(catalog, null, 2) + "\n");
		return true;
	} catch (error) {
		console.error(`pi-mtplx could not enable ${modelId} in settings.json: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export function disableModelInSettings(modelId: string): boolean {
	try {
		const catalog = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { enabledModels?: unknown[] };
		const enabled = Array.isArray(catalog.enabledModels) ? catalog.enabledModels : [];
		const entry = `mtplx/${modelId}`;
		const idx = enabled.indexOf(entry);
		if (idx === -1) return true;
		enabled.splice(idx, 1);
		catalog.enabledModels = enabled;
		writeFileSync(SETTINGS_FILE, JSON.stringify(catalog, null, 2) + "\n");
		return true;
	} catch (error) {
		console.error(`pi-mtplx could not disable ${modelId} in settings.json: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
type MtplxListedModel = { repo_id?: unknown; path?: unknown; name?: unknown };

export async function listMtplxModels(): Promise<MtplxListedModel[]> {
	try {
		const { stdout } = await execFileAsync("mtplx", ["list", "--json"], { timeout: 30_000 });
		const parsed = JSON.parse(stdout) as { models?: unknown };
		const models = parsed.models;
		return Array.isArray(models) ? (models as MtplxListedModel[]) : [];
	} catch {
		return [];
	}
}

export function listedIdentity(model: MtplxListedModel): string {
	return typeof model.repo_id === "string" && model.repo_id ? model.repo_id : typeof model.path === "string" ? model.path : "";
}

/**
 * Ask the user which MTPLX models are installed, then register the pick into
 * the mapping file and into the `mtplx` provider of the user's models.json
 * catalog. Every other provider is left untouched.
 */
export async function listModels(ctx: ExtensionContext): Promise<void> {
	const installed = await listMtplxModels();
	if (installed.length === 0) {
		ctx.ui.notify("No MTPLX models found. Install one with `mtplx install`.", "warning");
		return;
	}
	const choices = installed.map((model) => {
		const ref = listedIdentity(model);
		const refId = modelIdFromRef(ref);
		const existingId = Object.keys(MTPLX_MODELS).find((id) => MTPLX_MODELS[id].ref === ref || slugFromId(id) === slugFromId(refId));
		const id = existingId ?? refId;
		const mark = existingId ? "✓" : "✗";
		return `${mark} ${id} — ${ref}`;
	});
	choices.push("Cancel");
	const picked = await ctx.ui.select("MTPLX models — ✓ registered in Pi · ✗ available in MTPLX — run /reload after making changes", choices, undefined);
	if (!picked || picked === "Cancel") return;
	const ref = picked.split(" — ").slice(1).join(" — ");
	const modelId = Object.keys(MTPLX_MODELS).find((id) => MTPLX_MODELS[id].ref === ref) ?? modelIdFromRef(ref);
	if (MTPLX_MODELS[modelId]) {
		ctx.ui.notify(`${modelId} is already registered — run /reload, then switch with /model.`, "info");
		return;
	}

	// 1) Persist the Pi id → artifact ref mapping (also used to resolve autostart model ids).
	MTPLX_MODELS[modelId] = { ref };
	saveRegisteredModels();

	// 2) Register the model in the `mtplx` provider of Pi's catalog (models.json).
	try {
		const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
		const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown> };
		const providers = (catalog.providers ??= {});
		const provider = (providers[MTPLX_PROVIDER] ??= {
			api: "openai-completions",
			apiKey: "mtplx-local",
			authHeader: true,
			baseUrl: "http://127.0.0.1:8000/v1",
			compat: {
				maxTokensField: "max_tokens",
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			},
			headers: {
				"x-mtplx-client": "pi",
			},
		}) as { models?: unknown[] };
		const models = Array.isArray(provider.models) ? (provider.models as unknown[]) : [];
		if (models.some((entry) => (entry as { id?: unknown }).id === modelId)) {
			ctx.ui.notify(`Already in models.json: ${modelId}`, "warning");
			return;
		}
		models.push({
			id: modelId,
			name: displayNameFromId(modelId),
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 65536,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: null,
				xhigh: "xhigh",
				max: null,
			},
		});
		provider.models = models;
		writeFileSync(modelsJsonPath, JSON.stringify(catalog, null, 2) + "\n");
	} catch (error) {
		ctx.ui.notify(`MTPLX model mapping saved, but models.json update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	// 3) Also enable the model in settings.json so it shows on first boot.
	enableModelInSettings(modelId);
	ctx.ui.notify(`Registered ${modelId} → ${ref}. Switch to it with /model.`, "info");
}

/**
 * Remove a single registered model from the provider and from enabledModels.
 */
export function removeModel(modelId: string): boolean {
	// 1) Remove from the mtplx provider in models.json
	const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
	if (!existsSync(modelsJsonPath)) return false;
	try {
		const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown> };
		const provider = (catalog.providers?.[MTPLX_PROVIDER] as { models?: unknown[] }) ?? {};
		const models = Array.isArray(provider.models) ? provider.models : [];
		const filtered = (models as { id?: string }[]).filter((m) => m.id !== modelId);
		if (filtered.length === models.length) return false; // not found
		(provider as { models?: unknown[] }).models = filtered;
		writeFileSync(modelsJsonPath, JSON.stringify(catalog, null, 2) + "\n");
	} catch (error) {
		console.error(`pi-mtplx could not remove ${modelId} from models.json: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
	// 2) Also remove from enabledModels in settings.json
	disableModelInSettings(modelId);
	return true;
}

/**
 * Remove the entire `mtplx` provider from models.json and clean enabledModels.
 */
export function removePiMtplxProvider(): boolean {
	const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
	if (!existsSync(modelsJsonPath)) return false;
	try {
		const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown>; enabledModels?: string[] };
		if (!catalog.providers || !(MTPLX_PROVIDER in catalog.providers)) return false;
		// Remove all mtplx models from enabledModels
		if (catalog.enabledModels) {
			catalog.enabledModels = catalog.enabledModels.filter((m: string) => !m.startsWith("mtplx/"));
		}
		delete catalog.providers[MTPLX_PROVIDER];
		writeFileSync(modelsJsonPath, JSON.stringify(catalog, null, 2) + "\n");
		return true;
	} catch (error) {
		console.error(`pi-mtplx uninstall could not update models.json: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}