/**
 * MTPLX process lifecycle: start / stop / ensure, with ownership tracking.
 *
 * Ownership model (important — see README):
 *   - This module spawns the server itself (`mtplx quickstart ...`), keeps a
 *     reference to the child, and passes `--model-id` so `/health` reports
 *     Pi's model id — a positive fingerprint that a given healthy server on
 *     the port is one this extension owns.
 *   - Cleanup is therefore precise: a server only gets shut down if the
 *     extension spawned it in this session, or if `/health` positively
 *     identifies it as an MTPLX server serving one of the extension's model
 *     ids. A foreign service on the port is never touched, and a manually
 *     started MTPLX server (no matching --model-id fingerprint) is never
 *     killed — it is simply served from as-is.
 *   - Stop goes through `mtplx stop --host --port --json` (MTPLX's own
 *     graceful-stop mechanism: SIGTERM → grace → SIGKILL), which targets the
 *     server answering on that exact host:port, not arbitrary processes.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import { getFanMode, health, setFanMode, type Health } from "./mtplx-client.ts";
import { MTPLX_MODELS } from "./model-discovery.ts";
import { HOST, PORT, READY_TIMEOUT_MS, POLL_MS, loadSsdSessionCache, sleep, commandError, portIsOccupied } from "./utils.ts";

const execFileAsync = promisify(execFile);

/**
 * Child process handle of the server this Pi session spawned, if any.
 * Kept in parallel with the /health fingerprint: the handle covers "we
 * spawned it", the fingerprint covers "a previous Pi session spawned it".
 */
let ownedChild: ChildProcess | undefined;

/** True when the extension spawned the currently-healthy server in this session. */
export function isOwnedByThisSession(): boolean {
	return ownedChild !== undefined;
}

export function startupError(cause: Error): Error {
	return new Error(`MTPLX startup failed: ${cause.message}. Check \`mtplx status --deep\` for MTPLX diagnostics.`);
}

/**
 * Shut down the server on HOST:PORT — but only if we can positively identify
 * it as MTPLX (via /health). A healthy, non-MTPLX listener is an error, never
 * a kill target.
 */
export async function stopServer(): Promise<void> {
	const current = await health();
	if (!current) {
		if (await portIsOccupied()) {
			throw new Error(`MTPLX cannot use ${HOST}:${PORT}: another, non-MTPLX service is listening there.`);
		}
		// Nothing listening (or not MTPLX): nothing to stop. Drop any stale handle.
		ownedChild = undefined;
		return;
	}

	// /health says an MTPLX server is answering here.
	if (!isOwnedByThisSession() && !currentModelIsOurs(current.model)) {
		// An MTPLX server the extension does not own (e.g. started manually by
		// the user). MTPLX exposes no reliable way to distinguish it from a
		// Pi-managed one at the port level beyond --model-id, so do not kill
		// it. If a Pi-owned one is still needed, the user can run /mtplx →
		// Toggle.
		console.warn(
			`pi-mtplx: leaving MTPLX server on ${HOST}:${PORT} (model ${JSON.stringify(current.model)}) untouched — not owned by this Pi session. Use /mtplx → Toggle to stop it.`,
		);
		return;
	}

	try {
		await execFileAsync("mtplx", ["stop", "--host", HOST, "--port", String(PORT), "--json"], { timeout: 20_000 });
	} catch (error) {
		throw new Error(`MTPLX shutdown failed: ${commandError(error)}`);
	}
	ownedChild = undefined;

	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (!(await health())) return;
		await sleep(POLL_MS);
	}
	throw new Error(`MTPLX shutdown timed out; ${HOST}:${PORT} is still healthy.`);
}

/** Positive ownership fingerprint: /health model id belongs to this extension's registry. */
function currentModelIsOurs(model: string): boolean {
	return Object.keys(MTPLX_MODELS).includes(model);
}

/**
 * Spawn the MTPLX server for a registered model and wait until /health
 * confirms it serves exactly that model. The child is spawned detached so it
 * outlives Pi's event-loop teardown, and unref'd so it never blocks Pi exit.
 */
export async function startServer(modelId: string): Promise<void> {
	const configured = MTPLX_MODELS[modelId];
	if (!configured) {
		throw new Error(`MTPLX model ${JSON.stringify(modelId)} is not mapped to an installed MTPLX artifact. Update the pi-mtplx model registry after adding it to Pi.`);
	}

	let exited: Error | undefined;
	const child = spawn(
		"mtplx",
		[
			"quickstart",
			"--model",
			configured.ref,
			"--model-id",
			modelId,
			"--profile",
			"sustained",
			"--fan-mode",
			getFanMode(),
			"--host",
			HOST,
			"--port",
			String(PORT),
			// Explicitly pass the user's persisted choice; this extension defaults it to on.
			"--ssd-session-cache",
			loadSsdSessionCache() ? "on" : "off",
		],
		{ detached: true, stdio: "ignore" },
	);
	ownedChild = child;
	child.once("error", (error) => {
		exited = new Error(`could not launch mtplx: ${error.message}`);
	});
	child.once("exit", (code, signal) => {
		if (code !== 0) exited = new Error(`mtplx exited before becoming ready (code ${code ?? "none"}, signal ${signal ?? "none"})`);
	});
	child.unref();

	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited) throw startupError(exited);
		const current = await health();
		if (current?.model === modelId) {
			if (current.fan_mode !== getFanMode()) await setFanMode();
			return;
		}
		if (current) throw new Error(`MTPLX became healthy with ${JSON.stringify(current.model)}, not the requested ${JSON.stringify(modelId)}.`);
		await sleep(POLL_MS);
	}
	throw startupError(new Error(`timed out after ${READY_TIMEOUT_MS / 1000}s`));
}

/**
 * Ensure the server on HOST:PORT serves `modelId`, transparently switching
 * models: stop the current (identified) server, then start the requested one.
 */
export async function ensureServer(modelId: string): Promise<void> {
	const current = await health();
	if (current?.model === modelId) {
		if (current.fan_mode !== getFanMode()) await setFanMode();
		return;
	}
	if (current) await stopServer();
	else if (await portIsOccupied()) {
		throw new Error(`MTPLX cannot start because ${HOST}:${PORT} is occupied by a non-MTPLX service.`);
	}
	await startServer(modelId);
	await setFanMode();
}

let transition: Promise<void> | undefined;
let transitionModel: string | undefined;
let activeModel: string | undefined;
let activeAgents = 0;
let idleWaiters: Array<() => void> = [];

export function ensureOnce(modelId: string): Promise<void> {
	if (transition) {
		if (transitionModel === modelId) return transition;
		return transition.then(() => ensureOnce(modelId));
	}
	transitionModel = modelId;
	transition = ensureServer(modelId).finally(() => {
		transition = undefined;
		transitionModel = undefined;
	});
	return transition;
}

export async function acquire(modelId: string): Promise<void> {
	// Never replace a model while an already-admitted MTPLX agent is running.
	// Same-model requests share both this lease and any in-flight start Promise.
	while (activeAgents > 0 && activeModel !== modelId) {
		await new Promise<void>((resolve) => idleWaiters.push(resolve));
	}
	// Reserve the model before awaiting startup. This closes the gap where a
	// different request could otherwise begin a replacement between readiness
	// and this request entering Pi's provider path.
	activeModel = modelId;
	activeAgents += 1;
	try {
		await ensureOnce(modelId);
	} catch (error) {
		release();
		throw error;
	}
}

export function release(): void {
	if (activeAgents === 0) return;
	activeAgents -= 1;
	if (activeAgents === 0) {
		activeModel = undefined;
		for (const resolve of idleWaiters.splice(0)) resolve();
	}
}
