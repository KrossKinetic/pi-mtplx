/**
 * Minimal HTTP client for the locally-running MTPLX server (OpenAI-compatible
 * endpoint on 127.0.0.1:8000). Only touches endpoints that MTPLX exposes:
 *   GET  /health
 *   POST /v1/mtplx/thermal/fan_mode
 */
import { HOST, PORT, type FanMode, loadFanMode, loadResolvedMtplxApiKey } from "./utils.ts";

export type Health = { ok: true; model: string; model_path?: string; fan_mode?: string };
export type HealthProbe = { health: Health | undefined; authenticationRejected?: true };

// Current fan curve for autostart and live updates. Loaded from disk so the
// choice survives Pi restarts (see FANMODE_FILE in utils.ts).
let fanMode: FanMode = loadFanMode();

export function getFanMode(): FanMode {
	return fanMode;
}

export function setFanModeValue(mode: FanMode): void {
	fanMode = mode;
}

/**
 * Pi's own model requests use the configured key, or pi-mtplx's deterministic
 * local fallback. Mirror that header for every lifecycle endpoint.
 */
function authRequest(): { headers: Record<string, string> } {
	return { headers: { authorization: `Bearer ${loadResolvedMtplxApiKey()}` } };
}

export function authenticationFailureMessage(): string {
	return "MTPLX rejected Pi's API key. Update it via /mtplx → API Key.";
}

export async function healthProbe(): Promise<HealthProbe> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1_500);
	try {
		const auth = authRequest();
		const response = await fetch(`http://${HOST}:${PORT}/health`, {
			headers: auth.headers,
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return { health: undefined, authenticationRejected: true };
		}
		if (!response.ok) return { health: undefined };
		const body = (await response.json()) as { ok?: unknown; model?: unknown; model_path?: unknown; fan_mode?: unknown };
		if (body.ok !== true || typeof body.model !== "string") return { health: undefined };
		return {
			health: {
				ok: true,
				model: body.model,
				model_path: typeof body.model_path === "string" ? body.model_path : undefined,
				fan_mode: typeof body.fan_mode === "string" ? body.fan_mode : undefined,
			},
		};
	} catch {
		return { health: undefined };
	} finally {
		clearTimeout(timeout);
	}
}

export async function health(): Promise<Health | undefined> {
	return (await healthProbe()).health;
}

export async function setFanMode(): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const auth = authRequest();
		const response = await fetch(`http://${HOST}:${PORT}/v1/mtplx/thermal/fan_mode`, {
			method: "POST",
			headers: { "content-type": "application/json", ...auth.headers },
			body: JSON.stringify({ mode: fanMode }),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(authenticationFailureMessage());
		}
		const body = (await response.json()) as { verified?: unknown; current_mode?: unknown; error?: unknown };
		if (!response.ok || body.verified !== true || body.current_mode !== fanMode) {
			throw new Error(`MTPLX fan mode could not be set to ${fanMode}: ${typeof body.error === "string" ? body.error : "unverified response"}`);
		}
	} catch (error) {
		throw new Error(`MTPLX fan control failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timeout);
	}
}
