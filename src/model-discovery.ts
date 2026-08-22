/**
 * MTPLX model registry: Pi model id → installed MTPLX artifact ref.
 *
 * The refs are the artifact identifiers reported by `mtplx models --json`;
 * `--model-id` makes /health and /v1/models report Pi's id.
 *
 * The extension ships no model weights and hard-codes no model. The registry
 * holds only models registered through `/mtplx`, persisted to
 * ~/.pi/agent/mtplx-models.json; each Pi model id is derived live from the
 * artifact's ref (see modelIdFromRef) so models.json, enabledModels and this
 * registry always agree on the id.
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
import { modelIdFromRef, displayNameFromId } from "./utils.ts";

const execFileAsync = promisify(execFile);

// Matches MTPLX's own PI_PROVIDER_ID ("mtplx") so the extension operates on
// the exact provider block that `mtplx start pi` creates.
export const MTPLX_PROVIDER = "mtplx";
const MODELS_FILE = join(homedir(), ".pi", "agent", "mtplx-models.json");
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");

export function loadRegisteredModels(): Record<string, { ref: string }> {
	try {
		const parsed = JSON.parse(readFileSync(MODELS_FILE, "utf8")) as Record<string, { ref?: unknown }>;
		const out: Record<string, { ref: string }> = {};
		for (const [id, entry] of Object.entries(parsed)) {
			if (entry && typeof entry.ref === "string") out[id] = { ref: entry.ref };
		}
		return out;
	} catch {
		// missing or corrupt file → empty registry
	}
	return {};
}

export const MTPLX_MODELS: Record<string, { ref: string }> = loadRegisteredModels();

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
		if (idx === -1) return false; // nothing to remove
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
 * Model ids currently present in the `mtplx` provider of Pi's catalog
 * (models.json). This is the source of truth for whether a model is actually
 * registered with Pi (and thus usable via /model) — independent of the registry,
 * which only records which MTPLX artifacts are available, not which are registered.
 */
function catalogModelIds(): string[] {
	const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
	try {
		const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown> };
		const provider = catalog.providers?.[MTPLX_PROVIDER] as { models?: { id?: unknown }[] } | undefined;
		if (!provider || !Array.isArray(provider.models)) return [];
		return provider.models.filter((m): m is { id: string } => typeof m.id === "string").map((m) => m.id);
	} catch {
		return [];
	}
}

type ModelProfile = {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
};

/**
 * Neutral fallback used only when an installed artifact's metadata cannot be read
 * (mtplx list validates that config.json exists, so this is a last resort). It
 * deliberately assumes nothing about the model: text-only, modest context, no
 * reasoning capability.
 */
const FALLBACK_PROFILE: ModelProfile = { contextWindow: 131072, maxTokens: 131072, reasoning: false, input: ["text"] };

/**
 * Derive a Pi provider model profile from the installed artifact's OWN metadata
 * (config.json + mtplx_runtime.json). Context window, vision support, reasoning
 * and token limits are read from the model itself — never assumed for a brand —
 * so an arbitrary MTPLX model registers with correct values.
 */
function readModelProfile(model: MtplxListedModel | undefined): ModelProfile {
	const dir = typeof model?.path === "string" ? model.path : "";
	if (!dir) return FALLBACK_PROFILE;
	try {
		const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
			text_config?: Record<string, unknown>;
			max_position_embeddings?: unknown;
			sliding_window?: unknown;
			vision_config?: unknown;
			model_type?: unknown;
			architectures?: unknown;
		};
		const raw = config.text_config ?? config;
		const ctx = Number(raw.max_position_embeddings ?? config.max_position_embeddings ?? config.sliding_window);
		const contextWindow = Number.isFinite(ctx) && ctx > 0 ? ctx : FALLBACK_PROFILE.contextWindow;
		const arch = String(config.model_type ?? (config.architectures as unknown[] | undefined)?.[0] ?? "");
		return {
			contextWindow,
			// max output tokens can't exceed the model's own context (both from the live read)
			maxTokens: contextWindow,
			// detect reasoning support from the architecture string rather than assuming a brand
			reasoning: /reasoning|thinking|^qwen3/i.test(arch.toLowerCase()),
			input: config.vision_config ? ["text", "image"] : ["text"],
		};
	} catch {
		return FALLBACK_PROFILE;
	}
}

/**
 * Toggle registration of MTPLX models — register unregistered models,
 * unregister registered ones. Shows ✓/✗ marks to indicate status.
 *
 * Returns true if a change was made (user should /reload).
 */
export async function manageModels(ctx: ExtensionContext): Promise<boolean> {
	const installed = await listMtplxModels();
	if (installed.length === 0) {
		ctx.ui.notify("No MTPLX models found. Install one with `mtplx install`.", "warning");
		return false;
	}
	const catalog = new Set(catalogModelIds());
	const choices = installed.map((model) => {
		const ref = listedIdentity(model);
		// Each artifact maps to exactly one Pi model id, derived live from its ref.
		// No hard-coded ids — the same id is written to models.json, enabledModels and
		// the registry so the three never drift apart.
		const id = modelIdFromRef(ref);
		// ✓ means registered in Pi's catalog (models.json); ✗ means just installed in MTPLX.
		const mark = catalog.has(id) ? "✓" : "✗";
		return `${mark} ${id} — ${ref}`;
	});
	choices.push("Cancel");
	const picked = await ctx.ui.select("MTPLX models — ✓ registered in Pi · ✗ available in MTPLX — run /reload after making changes", choices, undefined);
	if (!picked || picked === "Cancel") return false;
	const ref = picked.split(" — ").slice(1).join(" — ");
	const modelId = modelIdFromRef(ref);
	// The installed-model record for the chosen artifact (used to read its live metadata).
	const chosen = installed.find((m) => listedIdentity(m) === ref);

	if (catalog.has(modelId)) {
		// Unregister: remove from models.json, enabledModels, and the id→ref registry.
		const wasActive = ctx.model?.provider === MTPLX_PROVIDER && ctx.model?.id === modelId;
		if (removeModel(modelId)) {
			ctx.ui.notify(
				wasActive
					? `Unregistered ${modelId} — still active for this session; it will drop from /model once you switch away.`
					: `Unregistered ${modelId}. Run /reload.`,
				"info",
			);
			return true;
		}
		ctx.ui.notify(`${modelId} could not be unregistered.`, "warning");
		return false;
	}

	// Register the model
	// 1) Persist the Pi id → artifact ref mapping.
	MTPLX_MODELS[modelId] = { ref };
	saveRegisteredModels();

	// 2) Register in the mtplx provider of Pi's catalog (models.json).
	//    Context window, vision, reasoning and token limits are read LIVE from the
	//    installed artifact's config/runtime contract — never assumed for a brand.
	const profile = readModelProfile(chosen);
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
			ctx.ui.notify(`${modelId} is already registered — run /reload, then switch with /model.`, "info");
			return false;
		}
		models.push({
			id: modelId,
			name: displayNameFromId(modelId),
			api: "openai-completions",
			reasoning: profile.reasoning,
			input: profile.input,
			contextWindow: profile.contextWindow,
			maxTokens: profile.maxTokens,
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
		return false;
	}
	// 3) Also enable the model in settings.json.
	enableModelInSettings(modelId);
	ctx.ui.notify(`Registered ${modelId} → ${ref}. Switch to it with /model.`, "info");
	return true;
}
/**
 * Remove a single registered model from the provider and from enabledModels.
 */
export function removeModel(modelId: string): boolean {
	let changed = false;
	// 1) Remove from the mtplx provider in models.json
	const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
	if (existsSync(modelsJsonPath)) {
		try {
			const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown> };
			const provider = (catalog.providers?.[MTPLX_PROVIDER] as { models?: { id?: string }[] }) ?? {};
			const models = Array.isArray(provider.models) ? provider.models : [];
			const filtered = models.filter((m) => m.id !== modelId);
			if (filtered.length !== models.length) {
				provider.models = filtered;
				writeFileSync(modelsJsonPath, JSON.stringify(catalog, null, 2) + "\n");
				changed = true;
			}
		} catch (error) {
			console.error(`pi-mtplx could not remove ${modelId} from models.json: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 2) Remove from enabledModels in settings.json (no-op if already absent).
	if (disableModelInSettings(modelId)) changed = true;
	// 3) Remove from the extension registry (id → artifact ref). Built-in entries are
	// re-merged on reload, but removing the own property here clears any persisted
	// mtplx-models.json copy so the registry can't drift from Pi's catalog.
	if (Object.prototype.hasOwnProperty.call(MTPLX_MODELS, modelId)) {
		delete MTPLX_MODELS[modelId];
		saveRegisteredModels();
		changed = true;
	}
	return changed;
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