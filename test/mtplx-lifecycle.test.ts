import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { getFanMode, healthProbe } from "../src/mtplx-client.ts";
import { ensureServer, validateServer } from "../src/mtplx-process.ts";
import { mtplxEndpointFromBaseUrl, type MtplxEndpoint } from "../src/utils.ts";

type HealthResponse =
	| { status: 200; model: string; fanMode?: string }
	| { status: 401 };

type MockEndpoint = {
	endpoint: MtplxEndpoint;
	close: () => Promise<void>;
};

async function startMockEndpoint(response: HealthResponse): Promise<MockEndpoint> {
	const server = createServer((request, reply) => {
		if (request.url !== "/health") {
			reply.writeHead(404).end();
			return;
		}
		if (response.status === 401) {
			reply.writeHead(401).end();
			return;
		}
		reply.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
			ok: true,
			model: response.model,
			fan_mode: response.fanMode ?? getFanMode(),
		}));
	});
	await listen(server);
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		endpoint: mtplxEndpointFromBaseUrl(`http://127.0.0.1:${address.port}/v1`),
		close: () => close(server),
	};
}

function listen(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("a matching endpoint is accepted with Auto Start on or off", async () => {
	const mock = await startMockEndpoint({ status: 200, model: "model-a" });
	try {
		assert.equal((await healthProbe(mock.endpoint)).health?.model, "model-a");
		assert.deepEqual(await ensureServer("model-a", mock.endpoint), {
			endpoint: mock.endpoint,
			model: "model-a",
			fanMode: getFanMode(),
			alreadyRunning: true,
		});
		assert.deepEqual(await validateServer("model-a", mock.endpoint), {
			endpoint: mock.endpoint,
			model: "model-a",
			fanMode: getFanMode(),
			alreadyRunning: true,
		});
	} finally {
		await mock.close();
	}
});

test("an existing server's fan curve is reported without changing the server", async () => {
	const runningFanMode = getFanMode() === "max" ? "smart" : "max";
	const mock = await startMockEndpoint({ status: 200, model: "model-a", fanMode: runningFanMode });
	try {
		assert.equal((await ensureServer("model-a", mock.endpoint)).fanMode, runningFanMode);
	} finally {
		await mock.close();
	}
});

test("a separately managed model mismatch is blocked with Auto Start on or off", async () => {
	const mock = await startMockEndpoint({ status: 200, model: "model-b" });
	try {
		const mismatch = /serving "model-b", but Pi has "model-a" selected/;
		await assert.rejects(() => ensureServer("model-a", mock.endpoint), mismatch);
		await assert.rejects(() => validateServer("model-a", mock.endpoint), mismatch);
	} finally {
		await mock.close();
	}
});

test("an authentication failure is reported before Auto Start", async () => {
	const mock = await startMockEndpoint({ status: 401 });
	try {
		assert.deepEqual(await healthProbe(mock.endpoint), { health: undefined, authenticationRejected: true });
		await assert.rejects(() => validateServer("model-a", mock.endpoint), /rejected Pi's API key/);
	} finally {
		await mock.close();
	}
});

test("an unavailable endpoint is reported when Auto Start is off", async () => {
	const mock = await startMockEndpoint({ status: 200, model: "model-a" });
	const endpoint = mock.endpoint;
	await mock.close();
	await assert.rejects(
		() => validateServer("model-a", endpoint),
		/MTPLX is unavailable at .*Auto Start is off, so Pi will not start a server/,
	);
});
