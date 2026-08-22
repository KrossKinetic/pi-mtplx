# pi-mtplx

Run local MLX models with Pi — zero config, automatic model discovery, and live token-speed monitoring.

## Install

```bash
pi install npm:pi-mtplx
```

Restart Pi after installation.

## What happens on first run

Once installed, Pi automatically manages your MTPLX workflow:

- **Model discovery** — Pi scans your MTPLX model registry (`~/.pi/agent/mtplx-models.json`) and registers each model as a Pi model under the `mtplx` provider.
- **Auto-start** — The MTPLX server starts automatically when you switch to an `mtplx` model and shuts down cleanly when Pi exits.
- **Token speed** — A `⚡N.N tk/s` indicator appears in the footer showing the generation speed of the last assistant turn.

## Commands

| Command | What it does |
| --------- | ------------- |
| `/mtplx models` | List all registered MTPLX models |
| `/mtplx register <path>` | Register a new model (scans the path, registers it) |
| `/mtplx unregister <model-id>` | Remove a model from Pi |
| `/mtplx fan <mode>` | Set fan curve: `quiet`, `balanced` (default), `performance` |
| `/mtplx health` | Check if the MTPLX server is running and healthy |

## Configuration

### Model registry

Models are registered in `~/.pi/agent/mtplx-models.json`. Each entry maps a Pi model ID to an MTPLX artifact path:

```json
{
  "mtplx/qwen2.5-7b": "/Users/you/.mlx/models/qwen2.5-7b"
}
```

Register models with `/mtplx register` or add entries manually.

### Fan mode

Controls the thermal profile of your MTPLX server. Saved to `~/.pi/agent/mtplx-fan-mode.json` and persists across restarts.

| Mode | Behavior |
| ------ | ---------- |
| `quiet` | Minimal fan, slower inference |
| `balanced` | Default — balanced thermal/headroom |
| `performance` | Maximum fan, fastest inference |

### Provider name

The provider is named `mtplx` by default. Override it with `MTPLX_PROVIDER` in your environment.

## Troubleshooting

| Problem | Fix |
| --------- | ----- |
| **"MTPLX not started"** — Pi warns when you ask an MTPLX model to respond | Register a model first with `/mtplx register` |
| **"No MTPLX models registered"** | Run `/mtplx models` to see what's registered, or `/mtplx register <path>` |
| **MTPLX startup timed out after 180s** | Run `mtplx status --deep` for MTPLX-side diagnostics (model validation, memory, thermal) |

## License

MIT — see [LICENSE](./LICENSE).
