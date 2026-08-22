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

- **Model discovery** — `/mtplx` → **Models** scans what you've downloaded (`mtplx list`) and registers any of them with Pi. No model is bundled or pre-hardcoded: each Pi model id and its capabilities (context window, vision, reasoning) are derived live from the installed artifact, so models beyond the MTPLX stock set work too.
- **Auto-start** — The MTPLX server starts when you switch to an `mtplx` model and shuts down cleanly when Pi exits.
- **Token speed** — A `⚡N.N tk/s` indicator appears in the footer showing the generation speed of the last assistant turn.

## Commands

Run `/mtplx` to open an interactive menu:

| Option | What it does |
| -------- | ------------- |
| **Toggle (on/off)** | Start or stop the MTPLX server |
| **Fan Curves** | Set the thermal profile (`default`, `smart`, `max`) |
| **Models** | Register or unregister models — ✓ means registered (click to unregister), ✗ means available (click to register) |
| **Uninstall** | Remove the `mtplx` provider from Pi's config |

> **To activate a model** after registering or unregistering it, open **`/model`** (or `/scoped-models`). pi-mtplx writes Pi's config files immediately, but Pi loads them into memory on startup — so a **newly registered** MTPLX model only appears in `/model` after you restart Pi with **`/quit`** and relaunch it (`pi`). Unregistering/re-registering an existing model is picked up by opening `/model`, but a brand-new model id requires the restart.

## Configuration

### Model registry

Models are registered in `~/.pi/agent/mtplx-models.json`. Each entry maps a Pi model ID to an MTPLX artifact ref:

```json
{
  "mtplx-qwen3.8-27b-mtplx-optimized-quality": {
    "ref": "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality"
  }
}
```

Register new models via the `/mtplx` → **Models** menu, or add entries manually to this file. To activate a **newly added** model, restart Pi with `/quit` and relaunch it (`pi`), then open `/model` (or `/scoped-models`) — Pi reads this file at startup, so a brand-new model id won't show up in `/model` otherwise.

### Fan mode

Controls the thermal profile of your MTPLX server. Saved to `~/.pi/agent/mtplx-fanmode.json` and persists across restarts.

| Mode | Behavior |
| ------ | ---------- |
| `default` | System default fan curve |
| `smart` | Default — adaptive thermal management |
| `max` | Maximum fan, fastest inference |

## Troubleshooting

| Problem | Fix |
| --------- | ----- |
| **"MTPLX not started"** — Pi warns when you ask an MTPLX model to respond | Run `/mtplx` → **Toggle** to start the server |
| **"No MTPLX models registered"** | Run `/mtplx` → **Models** to discover and register one |
| **MTPLX startup timed out after 180s** | Run `mtplx status --deep` for MTPLX-side diagnostics (model validation, memory, thermal) |

## License

MIT — see [LICENSE](./LICENSE).
