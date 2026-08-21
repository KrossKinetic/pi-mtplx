/**
 * tk/s Extension — MTPLX
 *
 * Reports the token generation rate of the LAST completed assistant turn as a
 * status segment ("⚡NN.N tk/s"). pi-zentui's footer merges extension statuses
 * (same mechanism pi-lens uses for "LSP Inactive"), so this shows up in the
 * existing zentui footer without fighting setFooter ownership.
 *
 * tk/s = usage.output of the last assistant message / (message.timestamp -
 * stream start), where stream start is captured on message_start (assistant).
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tkps";

let streamStartMs: number | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			streamStartMs = Date.now();
		}
	});

	pi.on("message_end", (event, ctx) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		const msg = m as AssistantMessage;
		if (streamStartMs !== undefined && msg.usage?.output > 0) {
			// msg.timestamp is set by pi-ai at STREAM START, not end — the end time
			// must be captured here. (Using msg.timestamp yields a clamped 0.01s
			// duration and bogus tk/s.)
			const durationSec = Math.max((Date.now() - streamStartMs) / 1000, 0.01);
			const rate = msg.usage.output / durationSec;
			ctx.ui.setStatus(STATUS_KEY, `⚡${rate.toFixed(1)} tk/s`);
			streamStartMs = undefined;
		}
	});
}
