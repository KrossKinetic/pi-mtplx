/**
 * pi-mtplx — zero-config MTPLX integration for the Pi coding agent.
 *
 * Pi package entry point: wires the MTPLX lifecycle (src/mtplx-process.ts),
 * HTTP client (src/mtplx-client.ts), model registry (src/model-discovery.ts)
 * and shared helpers (src/utils.ts) into Pi via before_agent_start,
 * agent_end and session_shutdown, plus the /mtplx command.
 */
import { acquire, isOwnedByThisSession, release, stopServer, validateServer } from "../src/mtplx-process.ts";
import { authenticationFailureMessage, getFanMode, health, healthProbe, setFanMode, setFanModeValue } from "../src/mtplx-client.ts";
import { MTPLX_PROVIDER, manageModels, removeModel, removePiMtplxProvider } from "../src/model-discovery.ts";
import { FAN_MODES, isMtplxModel, loadAutoShutdown, loadAutoStart, loadMtplxApiKey, loadMtplxEndpoint, loadSsdSessionCache, maskMtplxApiKey, mtplxEndpointFromBaseUrl, saveAutoShutdown, saveAutoStart, saveFanMode, saveMtplxApiKey, saveMtplxEndpoint, saveSsdSessionCache, syncMtplxStoredCredential, type FanMode } from "../src/utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function syncFanModeFromRunningServer(fanMode: string | undefined): { previous: FanMode; current: FanMode } | undefined {
	if (typeof fanMode !== "string" || !(FAN_MODES as readonly string[]).includes(fanMode)) return;
	const current = fanMode as FanMode;
	const previous = getFanMode();
	if (current === previous) return;
	setFanModeValue(current);
	saveFanMode(current);
	return { previous, current };
}

export default function mtplxAutostart(pi: ExtensionAPI): void {
	let lastServerNotice: string | undefined;

	// Pi's runtime may already have loaded auth.json for this process, but
	// syncing here ensures its next launch uses the same key as models.json.
	syncMtplxStoredCredential();

	pi.registerCommand("mtplx", {
		description: "MTPLX — view server status, configure its endpoint and lifecycle, manage models, or uninstall",
		handler: async (_args, ctx) => {
			const current = await health();
			const status = current ? "on" : "off";
			const fanSync = current ? syncFanModeFromRunningServer(current.fan_mode) : undefined;
			const server = current
				? `Server (serving: ${current.model})`
				: "Server (unavailable — check endpoint or API key)";
			await ctx.ui.setStatus("mtplx", `MTPLX: ${status}`);
			if (fanSync) {
				ctx.ui.notify(
					`MTPLX was already running with fan curve ${fanSync.current}, while Pi's saved default was ${fanSync.previous}. Pi left the server unchanged and updated its saved default to ${fanSync.current}.`,
					"info",
				);
			}
			const ssdSessionCache = loadSsdSessionCache();
			const autoShutdown = loadAutoShutdown();
			const autoStart = loadAutoStart();
			const apiKeyLabel = maskMtplxApiKey(loadMtplxApiKey());
			const endpoint = loadMtplxEndpoint();
			const topChoices = [
				server,
				`Toggle (${status})`,
				`API Key (current: ${apiKeyLabel})`,
				`Endpoint (current: ${endpoint.baseUrl})`,
				`Fan Curves (current: ${getFanMode()})`,
				`Auto Shutdown Pi-Owned Server (current: ${autoShutdown ? "on" : "off"})`,
				`Auto Start (current: ${autoStart ? "on" : "off"})`,
				`SSD Session Cache (current: ${ssdSessionCache ? "on" : "off"})`,
				"Models",
				"Uninstall (remove provider)",
			];
			const top = await ctx.ui.select("MTPLX", topChoices, undefined);
			if (!top) return;
			if (top === server) return;
			if (top.startsWith("Toggle")) {
				if (current) {
					const stopped = await stopServer();
					ctx.ui.notify(stopped ? "MTPLX server stopped" : "MTPLX is managed separately; pi-mtplx left it running.", stopped ? "info" : "warning");
				} else if (ctx.model && isMtplxModel(ctx.model)) {
					await acquire(ctx.model.id);
					ctx.ui.notify(`MTPLX server started (${ctx.model.id})`, "info");
				} else {
					ctx.ui.notify(`MTPLX not started — switch to an MTPLX (${MTPLX_PROVIDER}) model (active: ${ctx.model?.provider}/${ctx.model?.id})`, "warning");
				}
				return;
			}
			if (top.startsWith("Endpoint")) {
				const baseUrl = await ctx.ui.input("MTPLX endpoint", `Current: ${endpoint.baseUrl} — e.g. http://127.0.0.1:8001/v1`);
				if (baseUrl === undefined) return;
				try {
					const url = new URL(baseUrl.trim());
					if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
				} catch {
					ctx.ui.notify("MTPLX endpoint was not updated. Enter an http(s) URL.", "error");
					return;
				}
				if (mtplxEndpointFromBaseUrl(baseUrl).baseUrl === endpoint.baseUrl) {
					ctx.ui.notify("MTPLX endpoint is unchanged.", "info");
					return;
				}
				if (isOwnedByThisSession()) {
					try {
						await stopServer();
					} catch (error) {
						ctx.ui.notify(
							`MTPLX endpoint was not changed because Pi could not stop its running server: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
					ctx.ui.notify("Stopped Pi-owned MTPLX server before changing the endpoint.", "info");
				}
				if (!saveMtplxEndpoint(baseUrl)) {
					ctx.ui.notify("MTPLX endpoint was not updated. Enter an http(s) URL.", "error");
					return;
				}
				const probe = await healthProbe();
				ctx.ui.notify(probe.health ? "MTPLX endpoint saved and verified. Restart Pi before inference uses it." : "MTPLX endpoint saved, but health verification failed. Check its host, port, and API key; then restart Pi.", probe.health ? "info" : "warning");
				return;
			}
			if (top.startsWith("API Key")) {
				const apiKey = await ctx.ui.input(`MTPLX API Key — current: ${apiKeyLabel}`, "Paste a custom key, or leave blank for the default (visible while typing)");
				if (apiKey === undefined) return;
				if (!saveMtplxApiKey(apiKey)) {
					ctx.ui.notify("MTPLX API key was not updated. Check that models.json is valid.", "error");
					return;
				}
				const probe = await healthProbe();
				if (probe.health) {
					ctx.ui.notify("MTPLX API key updated and verified against the running server. Restart Pi before inference requests use the new key.", "info");
				} else if (probe.authenticationRejected) {
					ctx.ui.notify(`MTPLX API key was saved, but verification failed: ${authenticationFailureMessage()} Restart Pi after correcting it.`, "error");
				} else {
					ctx.ui.notify("MTPLX API key updated. No running server was available to verify it. Restart Pi before inference requests use the new key.", "warning");
				}
				return;
			}
			if (top.startsWith("Fan Curves")) {
				const choices = FAN_MODES.map((mode) => (mode === getFanMode() ? `${mode} (current)` : mode));
				const picked = await ctx.ui.select("MTPLX — fan mode for autostart", choices, undefined);
				if (!picked) return;
				const mode = picked.replace(" (current)", "") as FanMode;
				if (!(FAN_MODES as readonly string[]).includes(mode)) return;
				setFanModeValue(mode);
				saveFanMode(mode);
				if (current) await setFanMode();
				ctx.ui.notify(
					current
						? `MTPLX fan curve set to ${getFanMode()} and saved as Pi's default for future Pi-started servers.`
						: `MTPLX fan default saved as ${getFanMode()}. It applies the next time Pi starts MTPLX.`,
					"info",
				);
			}
			if (top.startsWith("Auto Shutdown")) {
				const choices = [
					autoShutdown ? "Off" : "Off (current)",
					autoShutdown ? "On (current)" : "On",
				];
				const picked = await ctx.ui.select("MTPLX — stop the Pi-owned server when Pi exits", choices, undefined);
				if (!picked) return;
				const enabled = picked.startsWith("On");
				saveAutoShutdown(enabled);
				ctx.ui.notify(`Pi will ${enabled ? "stop its own MTPLX server" : "leave its own MTPLX server running"} when Pi exits.`, "info");
			}
			if (top.startsWith("Auto Start")) {
				const choices = [
					autoStart ? "Off" : "Off (current)",
					autoStart ? "On (current)" : "On",
				];
				const picked = await ctx.ui.select("MTPLX — autostart MTPLX server when loading an MTPLX model", choices, undefined);
				if (!picked) return;
				const enabled = picked.startsWith("On");
				saveAutoStart(enabled);
				ctx.ui.notify(`MTPLX will ${enabled ? "autostart" : "not autostart"} when loading an MTPLX model.`, "info");
			}
			if (top.startsWith("SSD Session Cache")) {
				const choices = [
					ssdSessionCache ? "Off" : "Off (current)",
					ssdSessionCache ? "On (current)" : "On",
				];
				const picked = await ctx.ui.select("MTPLX — SSD session cache for future server starts", choices, undefined);
				if (!picked) return;
				const enabled = picked.startsWith("On");
				saveSsdSessionCache(enabled);
				ctx.ui.notify(`MTPLX SSD session cache will be ${enabled ? "on" : "off"} the next time the server starts.`, "info");
			}
			if (top.startsWith("Models")) {
				await manageModels(ctx);
			}
			if (top.startsWith("Uninstall")) {
				const ok = await ctx.ui.confirm(
					"pi-mtplx uninstall",
					`Remove the ${MTPLX_PROVIDER} provider (and all its models) from models.json and enabledModels? The model registry file (~/.pi/agent/mtplx-models.json) and installed MTPLX models are left in place.`,
					undefined,
				);
				if (!ok) return;
				if (removePiMtplxProvider()) {
					ctx.ui.notify(`Removed ${MTPLX_PROVIDER} provider from models.json and enabledModels. Run /reload (or restart Pi), then remove the pi-mtplx package.`, "info");
				} else {
					ctx.ui.notify(`Nothing to remove — the ${MTPLX_PROVIDER} provider is not in models.json.`, "info");
				}
			}
		},
	});

	// This must run in `input`, not `before_agent_start`: Pi reports errors
	// from before_agent_start but still sends the prompt to the provider.
	pi.on("input", async (_event, ctx) => {
		if (!ctx.model || !isMtplxModel(ctx.model)) return;
		const autoStart = loadAutoStart();
		try {
			const server = autoStart
				? await acquire(ctx.model.id)
				: await validateServer(ctx.model.id);
			const fanSync = server.alreadyRunning ? syncFanModeFromRunningServer(server.fanMode) : undefined;
			ctx.ui.setStatus("mtplx", `MTPLX: ${server.model}`);
			if (server.alreadyRunning) {
				const message = autoStart
					? `MTPLX is already running at ${server.endpoint.baseUrl}, serving ${JSON.stringify(server.model)}. Auto Start will not start MTPLX. The model selected in Pi matches; proceeding.`
					: `MTPLX is available at ${server.endpoint.baseUrl}, serving ${JSON.stringify(server.model)}. It matches Pi's selected model; Auto Start is off, so Pi will proceed without managing the server.`;
				const fanMessage = fanSync
					? ` Its fan curve is ${fanSync.current}, while Pi's saved default was ${fanSync.previous}; Pi left the server unchanged and updated its saved default to ${fanSync.current}.`
					: "";
				const notice = message + fanMessage;
				if (notice !== lastServerNotice) ctx.ui.notify(notice, "info");
				lastServerNotice = notice;
			} else {
				lastServerNotice = undefined;
			}
		} catch (error) {
			lastServerNotice = undefined;
			ctx.ui.notify(`MTPLX request blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model && isMtplxModel(ctx.model)) release();
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit" || !loadAutoShutdown()) return;
		try {
			await stopServer();
		} catch (error) {
			console.error(`MTPLX auto-shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
