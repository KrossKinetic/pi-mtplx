/**
 * pi-mtplx — zero-config MTPLX integration for the Pi coding agent.
 *
 * Pi package entry point: wires the MTPLX lifecycle (src/mtplx-process.ts),
 * HTTP client (src/mtplx-client.ts), model registry (src/model-discovery.ts)
 * and shared helpers (src/utils.ts) into Pi via before_agent_start,
 * agent_end and session_shutdown, plus the /mtplx command.
 */
import { acquire, release, stopServer } from "../src/mtplx-process.ts";
import { getFanMode, health, setFanMode, setFanModeValue } from "../src/mtplx-client.ts";
import { MTPLX_PROVIDER, manageModels, removeModel, removePiMtplxProvider } from "../src/model-discovery.ts";
import { FAN_MODES, isMtplxModel, loadSsdSessionCache, saveFanMode, saveSsdSessionCache, type FanMode } from "../src/utils.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mtplxAutostart(pi: ExtensionAPI): void {
	pi.registerCommand("mtplx", {
		description: "MTPLX — toggle the server, configure fan and SSD cache, manage models, or uninstall",
		handler: async (_args, ctx) => {
			const current = await health();
			const status = current ? "on" : "off";
			await ctx.ui.setStatus("mtplx", `MTPLX: ${status}`);
			const ssdSessionCache = loadSsdSessionCache();
			const topChoices = [
				`Toggle (${status})`,
				`Fan Curves (current: ${getFanMode()})`,
				`SSD Session Cache (current: ${ssdSessionCache ? "on" : "off"})`,
				"Models",
				"Uninstall (remove provider)",
			];
			const top = await ctx.ui.select("MTPLX", topChoices, undefined);
			if (!top) return;
			if (top.startsWith("Toggle")) {
				if (current) {
					await stopServer();
					ctx.ui.notify("MTPLX server stopped", "info");
				} else if (ctx.model && isMtplxModel(ctx.model)) {
					await acquire(ctx.model.id);
					ctx.ui.notify(`MTPLX server started (${ctx.model.id})`, "info");
				} else {
					ctx.ui.notify(`MTPLX not started — switch to an MTPLX (${MTPLX_PROVIDER}) model (active: ${ctx.model?.provider}/${ctx.model?.id})`, "warning");
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
				if (current) {
					await setFanMode();
				}
				ctx.ui.notify(`MTPLX fan mode set to ${getFanMode()}`, "info");
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

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ctx.model || !isMtplxModel(ctx.model)) return;
		try {
			await acquire(ctx.model.id);
		} catch (error) {
			throw new Error(`MTPLX request blocked: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model && isMtplxModel(ctx.model)) release();
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		try {
			await stopServer();
		} catch (error) {
			console.error(`MTPLX cleanup on quit failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
