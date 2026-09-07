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
 *   - A server launched by this Pi session is stopped through its own detached
 *     process group. This avoids relying on a second `mtplx` CLI invocation
 *     during shutdown. A positively identified server from an earlier Pi
 *     session still uses MTPLX's host-and-port stop command.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import { authenticationFailureMessage, getFanMode, health, healthProbe, setFanMode } from "./mtplx-client.ts";
import { MTPLX_MODELS } from "./model-discovery.ts";
import { HOST, PORT, READY_TIMEOUT_MS, POLL_MS, loadResolvedMtplxApiKey, loadSsdSessionCache, sleep, commandError, portIsOccupied } from "./utils.ts";

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
	const probe = await healthProbe();
	const current = probe.health;
	if (!current) {
		if (await portIsOccupied()) {
			if (probe.authenticationRejected) throw new Error(authenticationFailureMessage());
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

	if (!isOwnedByThisSession() && await signalMtplxListener()) {
		signalledOwnedProcess = true;
	}

	if (!signalledOwnedProcess) {
		try {
			await execFileAsync("mtplx", ["stop", "--host", HOST, "--port", String(PORT), "--json"], { timeout: 20_000 });
			stopError = undefined;
		} catch (error) {
			// Some MTPLX CLI failures occur after it has already signalled the server.
			// Confirm the listener state before reporting shutdown as failed.
			stopError = error;
		}
	}

	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (!(await portIsOccupied())) {
			ownedChild = undefined;
			return;
		}
		await sleep(POLL_MS);
	}
	if (stopError) throw new Error(`MTPLX shutdown failed: ${commandError(stopError)}`);
	if (signalledOwnedProcess) {
		throw new Error(`MTPLX shutdown timed out after signalling Pi's server process; ${HOST}:${PORT} is still occupied.`);
	}
	throw new Error(`MTPLX shutdown timed out; ${HOST}:${PORT} is still occupied.`);
}

/** Positive ownership fingerprint: /health model id belongs to this extension's registry. */
function currentModelIsOurs(model: string): boolean {
	return Object.keys(MTPLX_MODELS).includes(model);
}

/**
 * Signal the process listening on the managed MTPLX port. This is used only
 * after an authenticated health check and a pi-mtplx model fingerprint have
 * proved the listener is one we are allowed to stop. It covers a server that
 * a previous Pi session left running, which has no child handle in this one.
 */
async function signalMtplxListener(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("lsof", ["-t", "-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { timeout: 5_000 });
		const pids = stdout
			.split(/\s+/)
			.map(Number)
			.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
		if (pids.length === 0) return false;
		for (const pid of pids) process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

function unmanagedServerModelError(runningModel: string, requestedModel: string): Error {
	return new Error(
		`MTPLX is already running on ${HOST}:${PORT} with model ${JSON.stringify(runningModel)}, but Pi requested ${JSON.stringify(requestedModel)}. ` +
		`Pi will not replace this server because it is not managed by pi-mtplx. Stop it from the MTPLX app, or identify its listener with \`lsof -nP -iTCP:${PORT} -sTCP:LISTEN\` and run \`kill -TERM <PID>\`; then retry so Pi can start and manage the requested model.`,
	);
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

	// Check if a server is already running and serving this model
	const current = await health();
	if (current?.model === modelId) {
		if (current.fan_mode !== getFanMode()) await setFanMode();
		return;
	}
	// If a server is running but with a different model, don't try to replace it
	// This allows reusing an existing MTPLX instance when autostart is disabled
	if (current) {
		console.warn(
			`MTPLX server on ${HOST}:${PORT} is running with model ${JSON.stringify(current.model)}, not ${JSON.stringify(modelId)}. ` +
			`Cannot start a new server. Use /mtplx → Toggle to stop the running server first.`,
		);
		throw new Error(`MTPLX server is already running with a different model. Stop it via /mtplx → Toggle first.`);
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
		HOST,
		"--port",
		String(PORT),
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
	const probe = await healthProbe();
	const current = probe.health;
	if (current?.model === modelId) {
		if (current.fan_mode !== getFanMode()) await setFanMode();
		return;
	}
	if (current) {
		if (!isOwnedByThisSession() && !currentModelIsOurs(current.model)) {
			throw unmanagedServerModelError(current.model, modelId);
		}
		await stopServer();
	}
	else if (await portIsOccupied()) {
		if (probe.authenticationRejected) throw new Error(authenticationFailureMessage());
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
