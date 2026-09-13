# pi-mtplx

Run local MLX models with Pi — zero config, automatic model discovery, and live token-speed monitoring.

## Install

```bash
pi install npm:pi-mtplx
```

Restart Pi after installation.

## Prerequisites

**pi-mtplx ships no model.** It only wires Pi to MTPLX, the inference engine — which you must install separately, and whose model weights you must download yourself. The extension has nothing to run until you do:

1. Install MTPLX (see its own docs).
2. Download the model(s) you want, e.g. `mtplx install Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality`.
3. Register a downloaded model with Pi via `/mtplx` → **Models** (or add it manually to `~/.pi/agent/mtplx-models.json`), then open `/model` to activate it.

If you pick an MTPLX model that isn't installed, the server won't start — Pi will warn you. Use `mtplx list` to see what you've downloaded.

## What happens on first run

Once installed, Pi automatically manages your MTPLX workflow:

- **Model discovery** — `/mtplx` → **Models** scans what you've downloaded (`mtplx list`) and registers any of them with Pi. Each Pi model ID comes from MTPLX's own `quickstart --dry-run` plan, while capabilities (context window, vision, reasoning) are read from the installed artifact. Models beyond the MTPLX stock set work too.
- **Auto-start** — The MTPLX server starts when you switch to an `mtplx` model. Auto-start and auto-shutdown are on by default and can be changed in `/mtplx`.
- **Token speed** — A `⚡N.N tk/s` indicator appears in the footer showing the generation speed of the last assistant turn.

## Commands

Run `/mtplx` to open an interactive menu:

| Option | What it does |
| -------- | ------------- |
| **Server** | Read-only status showing the model currently served at the configured endpoint, or that the endpoint is unavailable |
| **Toggle (on/off)** | Start or stop an MTPLX server launched by this Pi session; separately managed servers are left running |
| **API Key** | View a masked identifier for, or replace, the API key Pi uses for the local MTPLX server |
| **Endpoint** | Set the OpenAI-compatible MTPLX base URL; useful for a separately started server |
| **Fan Curves** | Set the thermal profile (`default`, `smart`, `max`) |
| **Auto Shutdown Pi-Owned Server** | Choose whether Pi stops an MTPLX server it launched on `/quit` or a normal terminal-close shutdown (on by default); separately managed and remote servers are always left running |
| **Auto Start** | Choose whether Pi starts or switches MTPLX when loading an MTPLX model (on by default) |
| **SSD Session Cache** | Enable or disable MTPLX's SSD-backed session cache for subsequent server starts (on by default) |
| **Models** | Register or unregister models — ✓ means registered (click to unregister), ✗ means available (click to register) |
| **Uninstall** | Remove the `mtplx` provider from Pi's config |

> **To activate a model** after registering or unregistering it, open **`/model`** (or `/scoped-models`). pi-mtplx writes Pi's config files immediately, but Pi loads them into memory on startup — so a **newly registered** MTPLX model only appears in `/model` after you restart Pi with **`/quit`** and relaunch it (`pi`). Unregistering/re-registering an existing model is picked up by opening `/model`, but a brand-new model id requires the restart.

## Configuration

### Model registry

Models are registered in `~/.pi/agent/mtplx-models.json`. Each entry maps MTPLX's canonical served model ID to an MTPLX artifact ref:

```json
{
  "mtplx-qwen38-27b-optimized-quality": {
    "ref": "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality"
  }
}
```

Register new models via the `/mtplx` → **Models** menu; it asks MTPLX for the exact served ID. Opening this menu also migrates older ref-derived IDs to their canonical MTPLX names. Restart Pi after a migration or registration, then open `/model` (or `/scoped-models`) to activate the model.

### Fan mode

Controls the thermal profile used when Pi starts an MTPLX server. Saved to `~/.pi/agent/mtplx-fanmode.json` and persists across restarts. When Pi discovers a server that is already running—whether it is local, remote, or Pi-owned—it does not automatically change the fan curve; if the server reports a supported curve that differs from Pi's saved default, Pi adopts that curve as its new default for future Pi-started servers. Choosing `/mtplx` → **Fan Curves** is an explicit override and changes the fan curve of the active healthy server.

| Mode | Behavior |
| ------ | ---------- |
| `default` | System default fan curve |
| `smart` | Default — adaptive thermal management |
| `max` | Maximum fan, fastest inference |

### Server authentication

pi-mtplx always uses an API key. It uses `providers.mtplx.apiKey` from `~/.pi/agent/models.json` when configured; otherwise it uses the local default `mtplx-local`. The resolved key is passed to Pi-managed MTPLX startup and sent with health, fan-control, and inference requests. If Pi already has a stored MTPLX API-key credential, pi-mtplx synchronizes it with this key at startup and whenever `/mtplx` → **API Key** saves a change. Restart Pi after changing the key so its in-memory inference provider reloads the configuration. The menu only shows a masked suffix for custom keys, never the full secret.

### Standalone MTPLX

To use an MTPLX server that you start outside Pi, set `/mtplx` → **Auto Start** to off, then set `/mtplx` → **Endpoint** to that server's OpenAI base URL (for example, `http://127.0.0.1:8001/v1`). Restart Pi after changing it. The endpoint, health checks, and fan controls all use `providers.mtplx.baseUrl`; its default is `http://127.0.0.1:8000/v1`. pi-mtplx never stops a server it did not launch, including on normal Pi shutdown.

The served model ID must be the same ID selected in Pi. Before every MTPLX request, pi-mtplx verifies this through `/health` and reports both IDs if they differ. A separately managed server is never switched; start it with `--model-id <Pi model ID>` if its artifact's default identity differs. Use the same API key in both the MTPLX launch command and `/mtplx` → **API Key**.

### Auto start

Auto Start is on by default. Pi first checks the selected endpoint before starting anything. If a healthy MTPLX server is already there and serves the selected model, Pi uses it without replacing it. If it serves a different model, Pi switches it only when that server was started by the current Pi session; separately managed and remote servers are left alone, and Pi blocks the request with both model IDs. Pi starts MTPLX only when no MTPLX server is available at a loopback endpoint. With Auto Start off, Pi performs the same health and model-match check but never starts or switches a server; it instead tells you to start MTPLX at the configured endpoint.

### Auto shutdown Pi-owned server

Auto shutdown is on by default. When enabled, pi-mtplx stops an MTPLX server it launched during the current Pi session when Pi exits via `/quit` or a normal terminal-close shutdown. It never stops a separately managed or remote server. Turn it off in `/mtplx` → **Auto Shutdown Pi-Owned Server** to leave the Pi-launched server running after Pi exits. It cannot handle abrupt termination such as `SIGKILL` or a power loss.

## Troubleshooting

| Problem | Fix |
| --------- | ----- |
| **"MTPLX not started"** — Pi warns when you ask an MTPLX model to respond | Run `/mtplx` → **Toggle** to start the server |
| **"No MTPLX models registered"** | Run `/mtplx` → **Models** to discover and register one |
| **"MTPLX is already running ... but Pi requested ..."** | A manually started MTPLX server is serving a different, unmanaged model. Stop it in the MTPLX app, or find it with `lsof -nP -iTCP:8000 -sTCP:LISTEN` and run `kill -TERM <PID>`, then retry so Pi can start and manage the selected model. |
| **"MTPLX rejected the API key"** | The running server requires a different key. Use `/mtplx` → **API Key** to enter its current key, then retry. |
| **"Connection error"** with standalone MTPLX | Pi's configured endpoint has no listener. Set `/mtplx` → **Endpoint** to the standalone server's exact URL (including `/v1`), then restart Pi. |
| **MTPLX startup timed out after 180s** | Run `mtplx status --deep` for MTPLX-side diagnostics (model validation, memory, thermal) |

## License

MIT — see [LICENSE](./LICENSE).
