/**
 * Shared constants and small helpers for the pi-mtplx extension.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = 8000;
export const READY_TIMEOUT_MS = 180_000;
export const POLL_MS = 500;

export type FanMode = "default" | "smart" | "max";
export const FAN_MODES: readonly FanMode[] = ["default", "smart", "max"];

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

// Derive Pi's model id from an artifact ref: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality"
// → "mtplx-qwen38-27b-optimized-quality" (same scheme as the built-in entry).
export function modelIdFromRef(ref: string): string {
	const slug = ref
		.split("/")
		.pop() ?? ref
		.replace(/^mtplx/i, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return `mtplx-${slug || "model"}`.toLowerCase();
}

export function displayNameFromId(id: string): string {
	return id
		.replace(/^mtplx-/, "")
		.replace(/-+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function slugFromId(id: string): string {
	return id
		.replace(/^mtplx-/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
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

export function portIsOccupied(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: HOST, port: PORT });
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