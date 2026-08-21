# pi-mtplx

Zero-config [MTPLX](https://github.com/youssofal/MTPLX) integration for the [Pi](https://pi.dev) coding agent. Install it, switch to a `mtplx` model, and pi-mtplx handles the rest: discovering installed MTPLX models, booting a local MTPLX OpenAI-compatible server on demand, switching models transparently, live fan-curve control, and clean shutdown when Pi exits — without ever touching MTPLX processes that Pi doesn't own.

```
pi install npm:pi-mtplx
```

Or from GitHub:

```
pi install git:github.com/KrossKinetic/pi-mtplx
```

## Features

- **Zero-config model discovery** — `/mtplx → Models` lists every model in your MTPLX cache and registers the one you pick into Pi's catalog (`~/.pi/agent/models.json`), no manual provider setup.
- **On-demand autostart** — the first time you run an agent with a `mtplx` model, the local MTPLX server boots itself and waits until `/health` confirms it's serving exactly that model.
- **Transparent model switching** — switch from model A to model B with `/model`; pi-mtplx stops A and starts B before the next request proceeds.
- **Process ownership** — pi-mtplx only ever stops servers it can positively identify as its own (see [Automatic MTPLX Lifecycle](#automatic-mtplx-lifecycle)). Manually started MTPLX servers are left alone.
- **Fan-curve controls** — pick `default`, `smart`, or `max` fan modes; applied at boot and live-updated over the MTPLX thermal endpoint while the server runs.
- **Clean shutdown** — `/quit` stops the MTPLX server this Pi session owns; no orphaned processes.
- **tk/s footer** — a companion extension reports the token generation rate of the last assistant turn (`⚡NN.N tk/s`) in the footer.

## Requirements

- macOS on Apple Silicon (MTPLX requirement)
- The `mtplx` CLI on your `PATH` (pi-mtplx shells out to `mtplx quickstart/stop/list` and reads `GET /health` / `POST /v1/mtplx/thermal/fan_mode`)
- Node.js ≥ 20 (Pi requirement)
- At least one MTPLX model installed (`mtplx install <repo>` or `mtplx models --update`)

## Installation

```
pi install npm:pi-mtplx
```

or:

```
pi install git:github.com/KrossKinetic/pi-mtplx
```

After installing, make sure `mtplx` is on the PATH that Pi runs under, then restart Pi (or `/reload`).

## Quick Start

1. Ensure a model is installed: `mtplx models` (or `mtplx install <repo-id>`).
2. In Pi, run `/mtplx` → **Models (register)** and pick your model. This maps your Pi model id to the MTPLX artifact and adds the `mtplx` provider to `~/.pi/agent/models.json`.
3. `/reload` (or restart Pi), then switch to the model with `/model`.
4. Send a message. On the first request pi-mtplx boots the MTPLX server and waits for it to be ready.
5. `/mtplx` → **Toggle (off)** to stop it, or just `/quit` — the server shuts down with Pi.

## How It Works

pi-mtplx runs an OpenAI-compatible MTPLX server at `http://127.0.0.1:8000` and registers a `mtplx` provider in Pi's model catalog pointing at it. Every time an agent turn starts on a `mtplx` model, the extension checks the server's `/health` endpoint; if the right model isn't being served, it fixes that before the request is admitted (see [Automatic MTPLX Lifecycle](#automatic-mtplx-lifecycle)). Model ids are stable: the server is started with `mtplx quickstart --model <ref> --model-id <pi-model-id>`, so `/health` and `/v1/models` report Pi's id and the extension can always tell which model a healthy server is serving.

## `/mtplx` Commands

`/mtplx` opens a menu:

| Choice | What it does |
| --- | --- |
| **Toggle (on/off)** | Starts or stops the MTPLX server. Stopping only affects servers pi-mtplx owns (see below). Starting with a `mtplx` model active boots that model. |
| **Fan Curves** | Choose `default`, `smart`, or `max`. Persisted to `~/.pi/agent/mtplx-fanmode.json`, applied at next boot, and pushed live to a running server via `POST /v1/mtplx/thermal/fan_mode`. |
| **Models (register)** | Lists models from your MTPLX cache (`mtplx list --json`), marks which are already registered in Pi, and registers your pick: saved to `~/.pi/agent/mtplx-models.json` and added to the `mtplx` provider in `~/.pi/agent/models.json`. |
| **Uninstall** | Removes the `mtplx` provider (and only that provider) from `~/.pi/agent/models.json` after a confirmation. The registry file and installed MTPLX models are untouched. |

## Model Discovery

`/mtplx → Models` shells out to `mtplx list --json`, which reports every artifact in the local MTPLX model cache (`~/.mtplx/models`). Each entry's `repo_id` (or path) is mapped to a Pi model id with the scheme `mtplx-<slug>`, e.g. `Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality` → `mtplx-qwen38-27b-optimized-quality`.

Two files back this:

- `~/.pi/agent/mtplx-models.json` — Pi model id → MTPLX artifact ref. This is pi-mtplx's own registry; new registrations are appended here. (A built-in fallback map ships in the package for `mtplx-qwen38-27b-optimized-quality`.)
- `~/.pi/agent/models.json` — Pi's model catalog. pi-mtplx only ever adds to or removes its own `mtplx` provider entry there; it never rewrites other providers.

Registered models are OpenAI-completions models with a 262144 context window, 65536 max output tokens, zero cost (local), and reasoning enabled.

## Automatic MTPLX Lifecycle

- **Boot**: on the first `before_agent_start` for a `mtplx` model, if nothing healthy is on port 8000, pi-mtplx runs `mtplx quickstart --model <ref> --model-id <id> --profile sustained --fan-mode <mode> --host 127.0.0.1 --port 8000 --ssd-session-cache off`, detached and unref'd, then polls `/health` (500 ms) until it reports the requested model id, up to 3 minutes.
- **Switching**: if `/health` reports a *different* model, pi-mtplx stops it first, then starts the requested one. Requests are serialized: a model is never swapped out while an agent already admitted on the current model is still running.
- **Stopping**: goes through `mtplx stop --host 127.0.0.1 --port 8000 --json` (MTPLX's own graceful stop: SIGTERM → grace period → SIGKILL), then polls `/health` until the port stops answering.
- **Shutdown**: on `/quit` (`session_shutdown` with reason `quit`), pi-mtplx stops the server it can identify as its own. If nothing is running, this is a no-op.

### Process ownership

pi-mtplx distinguishes *its* MTPLX process from one you started manually, and cleanup only touches the former:

1. **Session handle** — when pi-mtplx spawns the server, it keeps the child handle. A server it spawned in this session is always owned.
2. **Health fingerprint** — pi-mtplx always starts its server with `--model-id <pi-model-id>`, and only model ids from its own registry qualify. If `/health` reports a model id that is in pi-mtplx's registry, the server is treated as Pi-owned even across Pi restarts (the process handle doesn't survive a restart, the fingerprint does).

What this means in practice:

- A **manually started** MTPLX server (e.g. `mtplx quickstart` with its own flags, or no `--model-id` matching a pi-mtplx registry id) is **never killed** by pi-mtplx — neither on model switch, `/mtplx → Toggle` stop, nor `/quit`. You'll get a console note telling you to use `/mtplx → Toggle` if you want it stopped. If you rely on a manual server, keep its `--model-id` out of pi-mtplx's registry ids, or just run `/mtplx → Toggle` manually.
- A **non-MTPLX** service on port 8000 is never touched; pi-mtplx refuses to start and tells you the port is occupied.
- If MTPLX ever changes what `/health` reports, ownership may degrade to the session handle only — in that case pi-mtplx is conservative and will not stop cross-session servers.

## Model Switching

Switch with `/model` as usual. Behind the scenes, on the next agent turn:

1. `before_agent_start` acquires the model lease.
2. `/health` is checked. If the running server serves a different `mtplx` model, pi-mtplx stops it (ownership rules above) and starts the new one.
3. Only once `/health` confirms the requested model is served does the request proceed.
4. On `agent_end` the lease is released; a different model can then be started for the next turn.

Concurrent same-model requests share the in-flight start; different-model requests queue behind running agents instead of swapping the model out from under them.

## Configuration

There is no config file to write. The extension uses fixed, documented defaults:

| Setting | Value |
| --- | --- |
| Server host:port | `127.0.0.1:8000` (MTPLX default) |
| Quickstart profile | `sustained` |
| SSD session cache | `off` |
| Boot readiness timeout | 180 s |
| Health poll interval | 500 ms |
| Fan mode | `smart` (persisted choice wins; set via `/mtplx → Fan Curves`) |

Persisted state (all under `~/.pi/agent/`):

- `mtplx-fanmode.json` — chosen fan mode.
- `mtplx-models.json` — model id → artifact ref registry.
- `models.json` — Pi's catalog; pi-mtplx manages only the `mtplx` provider entry.

To change the port or profile, edit `src/utils.ts` / `src/mtplx-process.ts` — these are the only two constants the whole package depends on.

## Troubleshooting

- **"MTPLX cannot use 127.0.0.1:8000: another, non-MTPLX service is listening there."** — something else owns the port. Stop it, or change `PORT` in `src/utils.ts`.
- **"MTPLX startup failed … timed out after 180s"** — check `mtplx status --deep` for MTPLX-side diagnostics (model validation, memory, thermal).
- **"MTPLX model … is not mapped to an installed MTPLX artifact"** — the model id isn't in `~/.pi/agent/mtplx-models.json`; register it via `/mtplx → Models`.
- **Model registered but `/model` doesn't list it** — run `/reload` (or restart Pi) after registration; `models.json` is read at load time.
- **Fan mode change didn't apply to a running server** — the MTPLX thermal endpoint requires the server to be healthy; if `/health` fails, the new fan mode applies at next boot.
- **`mtplx: command not found`** — make sure the PATH Pi runs under includes the directory with `mtplx` (`which mtplx`).
- **Uninstalling** — `/mtplx → Uninstall` removes the `mtplx` provider from `models.json`; the registry file and installed models stay. Then remove the package from Pi.

## Development

```bash
git clone https://github.com/KrossKinetic/pi-mtplx
cd pi-mtplx
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx (tests for the pure helpers)
```

To load the extension locally without publishing, point Pi at it as a package in a test directory, or symlink `extensions/mtplx.ts` and `extensions/mtplx-tkps-footer.ts` into `~/.pi/agent/extensions/` and `/reload`.

## Publishing

```bash
npm version <next>    # or edit package.json
npm login
npm publish           # name is unscoped, so no --access flag needed
```

For GitHub, push the `main` branch and users can `pi install git:github.com/KrossKinetic/pi-mtplx`. The package is tagged `pi-package` in `keywords`, so it shows up in the [package gallery](https://pi.dev/packages).

## License

MIT — see [LICENSE](./LICENSE).