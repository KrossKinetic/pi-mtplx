/**
 * MTPLX process lifecycle: start / stop / ensure, with ownership tracking.
 *
 * Ownership model (important — see README):
 *   - This module spawns the server itself (`mtplx quickstart ...`), keeps a
 *     reference to the child, and passes `--model-id` so `/health` reports
 *     Pi's model id — a positive fingerprint that a given healthy server on
 *     the port is one this extension owns.
 *   - Cleanup is therefore precise: a server only gets shut down if the
 *     extension spawned it in this Pi session. A manually or separately
 *     started server is never killed, even when it serves a registered model.
 *   - A server launched by this Pi session is stopped through its own detached
 *     process group. This avoids relying on a second `mtplx` CLI invocation
 *     during shutdown.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import { authenticationFailureMessage, getFanMode, health, healthProbe, setFanMode } from "./mtplx-client.ts";
import { MTPLX_MODELS } from "./model-discovery.ts";
import { READY_TIMEOUT_MS, POLL_MS, loadMtplxEndpoint, loadResolvedMtplxApiKey, loadSsdSessionCache, sleep, commandError, portIsOccupied, type MtplxEndpoint } from "./utils.ts";

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
 * Shut down the server at the configured endpoint, but only when this Pi
 * session launched it. A healthy external listener is never a kill target.
 */
export async function stopServer(): Promise<boolean> {
	const endpoint = loadMtplxEndpoint();
	const probe = await healthProbe();
	const current = probe.health;
	if (!current) {
		if (await portIsOccupied(endpoint)) {
			if (probe.authenticationRejected) throw new Error(authenticationFailureMessage());
			throw new Error(`MTPLX cannot use ${endpoint.host}:${endpoint.port}: another, non-MTPLX service is listening there.`);
		}
		// Nothing listening (or not MTPLX): nothing to stop. Drop any stale handle.
		ownedChild = undefined;
		return true;
	}

	if (!isOwnedByThisSession()) {
	// A separately started server can deliberately use the same model id as a
	// Pi-managed one, so model identity is not ownership.
		console.warn(
			`pi-mtplx: leaving MTPLX server on ${endpoint.host}:${endpoint.port} (model ${JSON.stringify(current.model)}) untouched — not owned by this Pi session.`,
		);
		return false;
	}

	let stopError: unknown;
	const childPid = ownedChild?.pid;
	let signalledOwnedProcess = false;
	if (isOwnedByThisSession() && childPid) {
		try {
			// `detached: true` gives this child its own POSIX process group. Signal
			// that group so a quickstart wrapper and its server are stopped together.
			process.kill(-childPid, "SIGTERM");
			signalledOwnedProcess = true;
		} catch (error) {
			// The child may have already exited while its server survived. In that
			// case, fall through to MTPLX's host-and-port stop command below.
			if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
				stopError = error;
			}
		}
	}

	if (!signalledOwnedProcess) {
		try {
			if (!endpoint.isLoopback) throw new Error("MTPLX endpoint is remote; pi-mtplx will not stop a server it did not launch.");
			await execFileAsync("mtplx", ["stop", "--host", endpoint.host, "--port", String(endpoint.port), "--json"], { timeout: 20_000 });
			stopError = undefined;
		} catch (error) {
			// Some MTPLX CLI failures occur after it has already signalled the server.
			// Confirm the listener state before reporting shutdown as failed.
			stopError = error;
		}
	}

	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (!(await portIsOccupied(endpoint))) {
			ownedChild = undefined;
			return true;
		}
		await sleep(POLL_MS);
	}
	if (stopError) throw new Error(`MTPLX shutdown failed: ${commandError(stopError)}`);
	if (signalledOwnedProcess) {
		throw new Error(`MTPLX shutdown timed out after signalling Pi's server process; ${endpoint.host}:${endpoint.port} is still occupied.`);
	}
	throw new Error(`MTPLX shutdown timed out; ${endpoint.host}:${endpoint.port} is still occupied.`);
}

function unmanagedServerModelError(runningModel: string, requestedModel: string, endpoint: MtplxEndpoint): Error {
	return new Error(
		`MTPLX is already running on ${endpoint.host}:${endpoint.port} with model ${JSON.stringify(runningModel)}, but Pi requested ${JSON.stringify(requestedModel)}. ` +
		`Pi will not replace this server because it is not managed by pi-mtplx. Stop it from the MTPLX app, or identify its listener with \`lsof -nP -iTCP:${endpoint.port} -sTCP:LISTEN\` and run \`kill -TERM <PID>\`; then retry so Pi can start and manage the requested model.`,
	);
}

/**
 * Spawn the MTPLX server for a registered model and wait until /health
 * confirms it serves exactly that model. The child is spawned detached so it
 * outlives Pi's event-loop teardown, and unref'd so it never blocks Pi exit.
 */
export async function startServer(modelId: string): Promise<void> {
	const endpoint = loadMtplxEndpoint();
	const configured = MTPLX_MODELS[modelId];
	if (!configured) {
		throw new Error(`MTPLX model ${JSON.stringify(modelId)} is not mapped to an installed MTPLX artifact. Update the pi-mtplx model registry after adding it to Pi.`);
	}

	const args = [
		"quickstart",
		"--model",
		configured.ref,
		"--model-id",
		modelId,
		"--fan-mode",
		getFanMode(),
		"--host",
		endpoint.host,
		"--port",
		String(endpoint.port),
		// Explicitly pass the user's persisted choice; this extension defaults it to on.
		"--ssd-session-cache",
		loadSsdSessionCache() ? "on" : "off",
	];
	args.push("--api-key", loadResolvedMtplxApiKey());

	let exited: Error | undefined;
	const child = spawn(
		"mtplx",
		args,
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
	const endpoint = loadMtplxEndpoint();
	const probe = await healthProbe();
	const current = probe.health;
	if (current?.model === modelId) {
		if (current.fan_mode !== getFanMode()) await setFanMode();
		return;
	}
	if (current) {
		if (!isOwnedByThisSession()) {
			throw unmanagedServerModelError(current.model, modelId, endpoint);
		}
		await stopServer();
	}
	else if (await portIsOccupied(endpoint)) {
		if (probe.authenticationRejected) throw new Error(authenticationFailureMessage());
		throw new Error(`MTPLX cannot start because ${endpoint.host}:${endpoint.port} is occupied by a non-MTPLX service.`);
	}
	if (!endpoint.isLoopback) {
		throw new Error(`MTPLX endpoint ${endpoint.baseUrl} is unavailable. pi-mtplx only auto-starts loopback servers; start this endpoint separately.`);
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
