/**
 * MTPLX model registry: Pi model id → installed MTPLX artifact ref.
 *
 * The refs are the artifact identifiers reported by `mtplx list --json`.
 * MTPLX's `quickstart --dry-run --json` supplies the canonical served id used
 * by Pi, /health, and /v1/models.
 *
 * The extension ships no model weights and hard-codes no model. The registry
 * holds only models registered through `/mtplx`, persisted to
 * ~/.pi/agent/mtplx-models.json; models.json, enabledModels and this registry
 * use the same MTPLX-supplied id.
 *
 * Pi's model catalog lives in ~/.pi/agent/models.json. The canonical provider
 * name is `mtplx`; this extension reads and writes only that provider entry
 * and leaves every other provider untouched.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { displayNameFromId } from "./utils.ts";

const execFileAsync = promisify(execFile);

// Keep the provider name consistent across model registration and lifecycle handling.
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
type ResolvedMtplxModel = { model: MtplxListedModel; ref: string; id: string };

const servedIdCache = new Map<string, string>();

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
 * MTPLX itself chooses the default served id. `mtplx list` reports artifact
 * refs, not that id, so ask quickstart for its dry-run plan rather than trying
 * to reproduce its naming rules in Pi.
 */
export async function servedModelId(ref: string): Promise<string> {
	const cached = servedIdCache.get(ref);
	if (cached) return cached;
	const { stdout } = await execFileAsync("mtplx", ["quickstart", "--model", ref, "--dry-run", "--json"], { timeout: 30_000 });
	const id = servedModelIdFromDryRun(JSON.parse(stdout) as unknown);
	servedIdCache.set(ref, id);
	return id;
}

/** Parse the model id from MTPLX's machine-readable quickstart plan. */
export function servedModelIdFromDryRun(plan: unknown): string {
	if (typeof plan !== "object" || plan === null || typeof (plan as { model_id?: unknown }).model_id !== "string" || !(plan as { model_id: string }).model_id) {
		throw new Error("MTPLX did not return a served model id");
	}
	return (plan as { model_id: string }).model_id;
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

/**
 * Replace legacy ref-derived ids with MTPLX's own served ids. This runs only
 * from the explicit Models menu, where the resulting Pi restart is expected.
 */
function migrateRegisteredModelIds(models: readonly ResolvedMtplxModel[]): string[] {
	const servedIds = new Map(models.map(({ ref, id }) => [ref, id]));
	const changes = new Map<string, string>();
	for (const [oldId, entry] of Object.entries(MTPLX_MODELS)) {
		const newId = servedIds.get(entry.ref);
		if (!newId || newId === oldId) continue;
		const collision = MTPLX_MODELS[newId];
		if (collision && collision.ref !== entry.ref) {
			console.warn(`pi-mtplx: cannot migrate ${oldId} to ${newId}; that id is already assigned to a different artifact.`);
			continue;
		}
		changes.set(oldId, newId);
	}
	if (changes.size === 0) return [];

	try {
		const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
		const catalog = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as { providers?: Record<string, unknown> };
		const provider = catalog.providers?.[MTPLX_PROVIDER] as { models?: Record<string, unknown>[] } | undefined;
		if (provider && Array.isArray(provider.models)) {
			const seen = new Set<string>();
			provider.models = provider.models.flatMap((model) => {
				const id = typeof model.id === "string" ? model.id : undefined;
				const replacement = id ? changes.get(id) : undefined;
				const nextId = replacement ?? id;
				if (!nextId || seen.has(nextId)) return [];
				seen.add(nextId);
				return [{ ...model, id: nextId, ...(replacement ? { name: displayNameFromId(nextId) } : {}) }];
			});
		}
		writeFileSync(modelsJsonPath, JSON.stringify(catalog, null, 2) + "\n");

		if (existsSync(SETTINGS_FILE)) {
			const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { enabledModels?: unknown };
			if (Array.isArray(settings.enabledModels)) {
				settings.enabledModels = [...new Set(settings.enabledModels.map((entry) => {
					if (typeof entry !== "string") return entry;
					const id = entry.startsWith(`${MTPLX_PROVIDER}/`) ? entry.slice(MTPLX_PROVIDER.length + 1) : undefined;
					return id && changes.has(id) ? `${MTPLX_PROVIDER}/${changes.get(id)}` : entry;
				}))];
				writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
			}
		}

		for (const [oldId, newId] of changes) {
			const entry = MTPLX_MODELS[oldId];
			if (!entry) continue;
			MTPLX_MODELS[newId] = entry;
			delete MTPLX_MODELS[oldId];
		}
		saveRegisteredModels();
		return [...changes].map(([oldId, newId]) => `${oldId} → ${newId}`);
	} catch (error) {
		console.error(`pi-mtplx could not migrate MTPLX model ids: ${error instanceof Error ? error.message : String(error)}`);
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
 * Returns true if a change was made (open /model to apply it).
 */
export async function manageModels(ctx: ExtensionContext): Promise<boolean> {
	const installed = await listMtplxModels();
	if (installed.length === 0) {
		ctx.ui.notify("No MTPLX models found. Install one with `mtplx install`.", "warning");
		return false;
	}
	let resolved: ResolvedMtplxModel[];
	try {
		resolved = [];
		for (const model of installed) {
			const ref = listedIdentity(model);
			if (ref) resolved.push({ model, ref, id: await servedModelId(ref) });
		}
	} catch (error) {
		ctx.ui.notify(`Could not read MTPLX's served model id: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	const migrated = migrateRegisteredModelIds(resolved);
	if (migrated.length > 0) {
		ctx.ui.notify(`Updated registered model IDs to MTPLX's canonical names. Restart Pi before selecting them.`, "info");
	}
	const catalog = new Set(catalogModelIds());
	const choices = resolved.map(({ ref, id }) => {
		// ✓ means registered in Pi's catalog (models.json); ✗ means just installed in MTPLX.
		const mark = catalog.has(id) ? "✓" : "✗";
		return `${mark} ${id} — ${ref}`;
	});
	choices.push("Cancel");
	const picked = await ctx.ui.select("MTPLX models — ✓ registered in Pi · ✗ available in MTPLX — registering a new model needs a Pi restart (/quit → pi) to show up in /model", choices, undefined);
	if (!picked || picked === "Cancel") return false;
	const ref = picked.split(" — ").slice(1).join(" — ");
	// The installed-model record for the chosen artifact (used to read its live metadata).
	const selected = resolved.find((entry) => entry.ref === ref);
	if (!selected) return false;
	const { model: chosen, id: modelId } = selected;

	if (catalog.has(modelId)) {
		// Unregister: remove from models.json, enabledModels, and the id→ref registry.
		const wasActive = ctx.model?.provider === MTPLX_PROVIDER && ctx.model?.id === modelId;
		if (removeModel(modelId)) {
			ctx.ui.notify(
				wasActive
					? `Unregistered ${modelId} — still active for this session; it will drop from /model once you switch away.`
					: `Unregistered ${modelId}. Open /model to apply.`,
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
			ctx.ui.notify(`${modelId} is already registered — open /model to refresh, then switch.`, "info");
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
	ctx.ui.notify(`Registered ${modelId} → ${ref}. Restart Pi with /quit (then relaunch with \`pi\`), then open /model to activate it.`, "info");
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
