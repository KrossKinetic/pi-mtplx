# pi-mtplx

Run local MLX models with Pi — zero config, automatic model discovery, and live token-speed monitoring.

## Install

```bash
pi install npm:pi-mtplx
```

Restart Pi after installation.

## What happens on first run

Once installed, Pi automatically manages your MTPLX workflow:

- **Model discovery** — A built-in model (`mtplx-qwen38-27b-optimized-quality`) is pre-registered. More are discoverable via `/mtplx`.
- **Auto-start** — The MTPLX server starts when you switch to an `mtplx` model and shuts down cleanly when Pi exits.
- **Token speed** — A `⚡N.N tk/s` indicator appears in the footer showing the generation speed of the last assistant turn.

## Commands

Run `/mtplx` to open an interactive menu:

| Option | What it does |
| -------- | ------------- |
| **Toggle (on/off)** | Start or stop the MTPLX server |
| **Fan Curves** | Set the thermal profile (`default`, `smart`, `max`) |
| **Models (register)** | Scan installed MTPLX models and register one with Pi |
| **Remove Model** | Unregister a model from Pi |
| **Uninstall** | Remove the `mtplx` provider from Pi's config |

## Configuration

### Model registry

Models are registered in `~/.pi/agent/mtplx-models.json`. Each entry maps a Pi model ID to an MTPLX artifact ref:

```json
{
  "mtplx-qwen38-27b-optimized-quality": {
    "ref": "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality"
  }
}
```

Register new models via the `/mtplx` → **Models** menu, or add entries manually to this file (then run `/reload`).

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
