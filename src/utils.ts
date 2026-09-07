/**
 * Shared constants and small helpers for the pi-mtplx extension.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = 8000;
export const READY_TIMEOUT_MS = 180_000;
export const POLL_MS = 500;
export const PI_MODELS_FILE = join(homedir(), ".pi", "agent", "models.json");
export const PI_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

export type FanMode = "default" | "smart" | "max";
export const FAN_MODES: readonly FanMode[] = ["default", "smart", "max"];
export const DEFAULT_SSD_SESSION_CACHE = true;
export const DEFAULT_AUTO_SHUTDOWN = true;
export const DEFAULT_AUTO_START = true;
export const DEFAULT_MTPLX_API_KEY = "mtplx-local";

export type MtplxEndpoint = {
	baseUrl: string;
	origin: string;
	host: string;
	port: number;
	isLoopback: boolean;
};

/** Resolve the endpoint from Pi's provider configuration, with a local default. */
export function mtplxEndpointFromBaseUrl(baseUrl: unknown): MtplxEndpoint {
	const fallback = `http://${HOST}:${PORT}/v1`;
	let url: URL;
	try {
		url = new URL(typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : fallback);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
	} catch {
		url = new URL(fallback);
	}
	const host = url.hostname;
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	return {
		baseUrl: url.toString().replace(/\/$/, ""),
		origin: url.origin,
		host,
		port,
		isLoopback: host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost",
	};
}

export function loadMtplxEndpoint(): MtplxEndpoint {
	try {
		const catalog = JSON.parse(readFileSync(PI_MODELS_FILE, "utf8")) as { providers?: { mtplx?: { baseUrl?: unknown } } };
		return mtplxEndpointFromBaseUrl(catalog.providers?.mtplx?.baseUrl);
	} catch {
		return mtplxEndpointFromBaseUrl(undefined);
	}
}

// Fan mode ("fan curve") applied at autostart, live-updated from `/mtplx` while the
// server runs. Persisted to disk so the choice survives Pi restarts: `fanMode` is a
// module-level variable that would reset to "smart" on every fresh session, silently
// overriding the previous `/mtplx` pick (and mislabelling "(current)" on the wrong mode).
export const FANMODE_FILE = join(homedir(), ".pi", "agent", "mtplx-fanmode.json");

export function loadFanMode(): FanMode {
	try {
		const parsed = JSON.parse(readFileSync(FANMODE_FILE, "utf8")) as { fanMode?: unknown };
		if (typeof parsed.fanMode === "string" && (FAN_MODES as readonly string[]).includes(parsed.fanMode)) {
			return parsed.fanMode as FanMode;
		}
	} catch {
		// missing or corrupt file → fall back to the default
	}
	return "smart";
}

export function saveFanMode(fanMode: FanMode): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(FANMODE_FILE, JSON.stringify({ fanMode }, null, 2) + "\n");
	} catch (error) {
		console.error(`MTPLX could not persist fan mode: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// SSD session caching is deliberately opt-in for this extension. Persist the
// choice independently of the fan setting so a user can enable it without
// altering their existing thermal preference.
export const SSD_SESSION_CACHE_FILE = join(homedir(), ".pi", "agent", "mtplx-ssd-session-cache.json");

export function loadSsdSessionCache(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(SSD_SESSION_CACHE_FILE, "utf8")) as { enabled?: unknown };
		if (typeof parsed.enabled === "boolean") return parsed.enabled;
	} catch {
		// missing or corrupt file → fall back to the default
	}
	return DEFAULT_SSD_SESSION_CACHE;
}

export function saveSsdSessionCache(enabled: boolean): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(SSD_SESSION_CACHE_FILE, JSON.stringify({ enabled }, null, 2) + "\n");
	} catch (error) {
		console.error(`MTPLX could not persist SSD session-cache preference: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Whether Pi should stop the server during a normal process shutdown. Kept
// separate from the server's own settings so users can deliberately leave a
// loaded model available after Pi exits.
export const AUTO_SHUTDOWN_FILE = join(homedir(), ".pi", "agent", "mtplx-auto-shutdown.json");
export const AUTO_START_FILE = join(homedir(), ".pi", "agent", "mtplx-auto-start.json");

export function loadAutoStart(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(AUTO_START_FILE, "utf8")) as { enabled?: unknown };
		if (typeof parsed.enabled === "boolean") return parsed.enabled;
	} catch {
		// missing or corrupt file → fall back to the default
	}
	return DEFAULT_AUTO_START;
}

export function saveAutoStart(enabled: boolean): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(AUTO_START_FILE, JSON.stringify({ enabled }, null, 2) + "\n");
	} catch (error) {
		console.error(`MTPLX could not persist auto-start preference: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadAutoShutdown(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(AUTO_SHUTDOWN_FILE, "utf8")) as { enabled?: unknown };
		if (typeof parsed.enabled === "boolean") return parsed.enabled;
	} catch {
		// missing or corrupt file → default to cleaning up the Pi-managed server
	}
	return DEFAULT_AUTO_SHUTDOWN;
}

export function saveAutoShutdown(enabled: boolean): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(AUTO_SHUTDOWN_FILE, JSON.stringify({ enabled }, null, 2) + "\n");
	} catch (error) {
		console.error(`MTPLX could not persist auto-shutdown preference: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Read the provider-level key Pi uses for requests to the local MTPLX server. */
export function mtplxApiKeyFromCatalog(catalog: unknown): string | undefined {
	if (typeof catalog !== "object" || catalog === null) return undefined;
	const providers = (catalog as { providers?: unknown }).providers;
	if (typeof providers !== "object" || providers === null) return undefined;
	const provider = (providers as { mtplx?: unknown }).mtplx;
	if (typeof provider !== "object" || provider === null) return undefined;
	const apiKey = (provider as { apiKey?: unknown }).apiKey;
	return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
}

/**
 * Lifecycle calls reread this on every request. Pi's inference provider has
 * its own in-memory catalog, so a key changed here still requires a Pi restart
 * before model requests use it.
 */
export function loadMtplxApiKey(): string | undefined {
	try {
		return mtplxApiKeyFromCatalog(JSON.parse(readFileSync(PI_MODELS_FILE, "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

/** Every Pi-managed MTPLX connection has a deterministic key. */
export function resolveMtplxApiKey(apiKey: string | undefined): string {
	return apiKey ?? DEFAULT_MTPLX_API_KEY;
}

export function loadResolvedMtplxApiKey(): string {
	return resolveMtplxApiKey(loadMtplxApiKey());
}

/** A stable, non-secret identifier suitable for the interactive menu. */
export function maskMtplxApiKey(apiKey: string | undefined): string {
	if (!apiKey) return `default (${DEFAULT_MTPLX_API_KEY})`;
	return apiKey.length <= 4 ? "configured" : `••••${apiKey.slice(-4)}`;
}

/**
 * Pi gives a stored `auth.json` API-key credential precedence over models.json.
 * Keep an existing MTPLX credential in sync; do not create one, because the
 * provider-level key is sufficient when no stored credential exists.
 */
function syncStoredMtplxCredential(apiKey: string): void {
	if (!existsSync(PI_AUTH_FILE)) return;
	const parsed = JSON.parse(readFileSync(PI_AUTH_FILE, "utf8")) as Record<string, unknown>;
	// Current Pi stores credentials directly as { "mtplx": { ... } }. Accept
	// the older nested shape too, without changing either file's structure.
	const credentials = typeof parsed.auth === "object" && parsed.auth !== null && !Array.isArray(parsed.auth)
		? parsed.auth as Record<string, unknown>
		: parsed;
	const credential = credentials.mtplx;
	if (credential === undefined) return;
	if (typeof credential !== "object" || credential === null || Array.isArray(credential) || (credential as { type?: unknown }).type !== "api_key") {
		throw new Error("auth.json contains an MTPLX credential that is not an API key");
	}
	(credential as Record<string, unknown>).key = apiKey;
	writeFileSync(PI_AUTH_FILE, JSON.stringify(parsed, null, 2) + "\n");
}

/** Reconcile Pi's stored MTPLX credential with the configured provider key. */
export function syncMtplxStoredCredential(): void {
	try {
		syncStoredMtplxCredential(loadResolvedMtplxApiKey());
	} catch (error) {
		console.error(`MTPLX could not synchronize Pi's stored API key: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Update Pi's MTPLX provider and any stored MTPLX credential to the same key. */
export function saveMtplxApiKey(apiKey: string): boolean {
	const normalized = apiKey.trim();
	const resolved = resolveMtplxApiKey(normalized || undefined);
	try {
		let catalog: Record<string, unknown> = {};
		if (existsSync(PI_MODELS_FILE)) {
			const parsed = JSON.parse(readFileSync(PI_MODELS_FILE, "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("models.json is not an object");
			catalog = parsed as Record<string, unknown>;
		}
		let providers = catalog.providers;
		if (providers !== undefined && (typeof providers !== "object" || providers === null || Array.isArray(providers))) {
			throw new Error("models.json providers is not an object");
		}
		const providerCatalog = (providers ??= {}) as Record<string, unknown>;
		const existing = providerCatalog.mtplx;
		if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
			throw new Error("models.json mtplx provider is not an object");
		}
		const provider = (existing ?? {
			api: "openai-completions",
			authHeader: true,
			baseUrl: `http://${HOST}:${PORT}/v1`,
		}) as Record<string, unknown>;
		if (normalized) provider.apiKey = normalized;
		else delete provider.apiKey;
		providerCatalog.mtplx = provider;
		catalog.providers = providerCatalog;
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(PI_MODELS_FILE, JSON.stringify(catalog, null, 2) + "\n");
		syncStoredMtplxCredential(resolved);
		return true;
	} catch (error) {
		console.error(`MTPLX could not update API key: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Save the OpenAI-compatible base URL used by Pi and lifecycle health checks. */
export function saveMtplxEndpoint(baseUrl: string): boolean {
	const normalized = baseUrl.trim();
	if (!normalized) return false;
	let endpoint: MtplxEndpoint;
	try {
		const url = new URL(normalized);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		endpoint = mtplxEndpointFromBaseUrl(normalized);
	} catch {
		return false;
	}
	try {
		const catalog = existsSync(PI_MODELS_FILE)
			? JSON.parse(readFileSync(PI_MODELS_FILE, "utf8")) as Record<string, unknown>
			: {};
		if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) throw new Error("models.json is not an object");
		const providers = (catalog.providers ??= {}) as Record<string, unknown>;
		const provider = (providers.mtplx ?? { api: "openai-completions", authHeader: true }) as Record<string, unknown>;
		if (typeof provider !== "object" || provider === null || Array.isArray(provider)) throw new Error("models.json mtplx provider is not an object");
		provider.baseUrl = endpoint.baseUrl;
		providers.mtplx = provider;
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(PI_MODELS_FILE, JSON.stringify(catalog, null, 2) + "\n");
		return true;
	} catch (error) {
		console.error(`MTPLX could not update endpoint: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export function displayNameFromId(id: string): string {
	return id
		.replace(/^mtplx-/, "")
		.replace(/-+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isMtplxModel(model: { provider: string; id: string } | undefined): boolean {
	// The provider name is MTPLX's own PI_PROVIDER_ID (`mtplx`), matching the
	// provider block that `mtplx start pi` writes to models.json.
	return model?.provider === "mtplx";
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function commandError(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const details = error as { stderr?: string | Buffer; message?: string };
	const stderr = details.stderr?.toString().trim();
	return stderr || details.message || "unknown command failure";
}

export function portIsOccupied(endpoint = loadMtplxEndpoint()): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: endpoint.host, port: endpoint.port });
		const done = (occupied: boolean) => {
			socket.destroy();
			resolve(occupied);
		};
		socket.setTimeout(1_000);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}
