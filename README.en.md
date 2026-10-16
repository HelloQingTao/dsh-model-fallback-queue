# dsh-model-fallback-queue

> A [DeepSeek Harness](https://dsh-plugin.org) (dsh) plugin: when your current model hits its quota, gets rate-limited or becomes unavailable, requests automatically fail over to the next model in your queue — the session keeps going.
> Everything is configured from the Settings UI, no CLI needed.

- npm: `@helloqingtao/dsh-model-fallback-queue`
- Host plugin + Web client plugin (settings page + an input-box status chip)
- Zero dependencies, writes no files, patches nothing in dsh core

## The problem

While a session is on a model that runs out of its 5-hour / weekly / monthly quota (`QUOTA` / `ACCOUNT_QUOTA`), gets rate limited (`RATE_LIMIT`) or has broken credentials (`AUTH` / `INVALID_CREDENTIAL`), the request just fails and the session stalls until you manually switch models.

This plugin automates that switch: request fails → the current route is tripped → the same step is retried on the next available model in the queue → the session stays on the new route.

## Features

- **Per-request failover.** Immediate trip on known error codes; two consecutive failures of any other kind also trip the route (soft trip).
- **Queue P1 → Pn.** P1 follows the current session model by default (switch models in the picker and P1 follows); entries you add are the backups P2, P3…
- **Three recovery modes.** Sticky (default), probe-back, manual.
- **Input-box status chip.** Shows the active route and its health; a red “all tripped” badge when nothing is left; click to open the queue panel with a “back to P1” action and a settings shortcut.
- **Degrades safely.** When every route is tripped the original config is passed through untouched — this plugin never blocks a request.
- **Does not fight `dsh-llm-retry`.** Non-fatal errors always `next()` through; same-route backoff retries stay with the core retry plugin.

## Install

```sh
dsh plugin --profile web add @helloqingtao/dsh-model-fallback-queue
```

Restart dsh (or reload the Web GUI). The bundle registers itself through the `cordis.patch.yml` shipped with the package.

## Usage

1. **Settings → Failover** → turn on “Enable failover”.
2. **+ Add model** to add backups (P2, P3…); reorder with ↑ / ↓, remove with the trash action.
3. Pick a P1 recovery mode.
4. Back in the conversation, the chip next to the input box shows the active P1 route.

On every switch the core “model switched” notice appears in the session and the chip follows.

### Chip states

| Chip | Meaning |
| --- | --- |
| `P1` green dot | Running on P1 |
| `P2` amber dot | Switched to P2; amber dot means a half-open probe is in flight |
| `P!` red dot | Every route tripped — original config passed through |
| `P` grey dot | Plugin disabled |

The panel lists each route with priority, provider/model and a health badge (🟢 healthy / 🟡 probing / 🔴 tripped, plus consecutive failure count), marks the active row, and shows the last switch (`P1 → P2 (QUOTA)`) next to a “Back to P1” button and a settings shortcut.

### Recovery modes

| Mode | Behaviour |
| --- | --- |
| **Sticky** (default) | Once on P2 it stays there while P2 works, even after P1 recovers; if P2 also fails it walks forward and only wraps back to P1 as a last resort. Zero flapping, best cache reuse. |
| **Probe back** | After P1's cooldown expires, the next real request probes P1; success keeps it, failure returns to P2 (5-minute debounce, no extra probe traffic). |
| **Manual** | Never returns to P1 automatically — use “Back to P1” in the chip panel. |

## Configuration

| Field | Default | Description | In Settings UI |
| --- | --- | --- | --- |
| `enabled` | `false` | Master switch | ✅ |
| `queue` | `[]` | Backups, array order = priority | ✅ |
| `failbackMode` | `sticky` | `sticky` / `probe` / `manual` | ✅ |
| `p1Follow` | `true` | P1 follows the current session model | — |
| `immediateCodes` | `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`, `AUTH`, `INVALID_CREDENTIAL`, `NO_ADAPTER` | Codes that trip a route immediately | — |
| `failureThreshold` | `2` | Consecutive failures for a soft trip | — |
| `cooldownMs` | `60000` | Circuit cooldown in ms | — |
| `failbackDelayMs` | `300000` | Probe-back debounce in ms | — |

> Advanced knobs marked “—” live in the plugin row's `config` inside `~/.dsh/profiles/<profile>/cordis.patch.yml`; the defaults suit almost everyone. The everyday switch, queue and recovery mode are all in the Settings UI.

## How it works

Three host extension points, all wrapped in try/catch so nothing ever blocks a request:

- `agent/request` (waterfall): when the active route is not P1, returns `{...cfg, provider, model}` for that request;
- `agent/request-error` (prepend): classifies the failure, trips the route and returns `{ kind: 'retry' }` so the agent loop retries the same step on a new route; non-fatal codes `next()` through;
- `agent/assistant-stream`: an `end` frame counts as success and resets the breaker.

The breaker is a three-state (closed / half-open / open) in-memory circuit, reset on restart. Runtime state is exposed to the Web client over typert Remote as `snapshot` / `probe` / `manualFailback`.

## Compatibility

- Works alongside `dsh-client-auto-continue` (auto-continue rides the same request waterfall).
- Layered with `dsh-llm-retry`: it handles same-route backoff, this plugin handles cross-route failover.
- Breaker state is not persisted; a restart starts clean.
- No switching happens with an empty or single-entry queue.
- If you run another failover plugin, keep only one — two plugins competing on `agent/request-error` is not useful.

## Development

```sh
git clone https://github.com/HelloQingTao/dsh-model-fallback-queue.git
cd dsh-model-fallback-queue
```

Reference it from a profile with a `link:` dependency to iterate live:

```json
"dependencies": { "@helloqingtao/dsh-model-fallback-queue": "link:/path/to/dsh-model-fallback-queue" }
```

Design notes: [docs/design-plan.md](docs/design-plan.md) (Chinese).

## License

[MIT](LICENSE)
