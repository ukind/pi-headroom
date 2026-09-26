# headroom — pi extension

A [pi](https://github.com/badlogic/pi-mono) folder extension that runs the [Headroom](https://docs.headroomlabs.ai) token-compression proxy in front of your pi providers — plus a built-in **path shim** that lets providers like Z.ai (whose chat path is not `/v1`-shaped) route through Headroom too.

One folder, no `settings.json` or `models.json` edits. Delete the folder to roll back — the extension writes nothing.

## How it works

```
pi ──> headroom proxy (127.0.0.1:8787) ──> upstream
              │
              ├─ header route:  <upstream>/v1/chat/completions          (hyper, stepfun, ollama-cloud)
              └─ shim route:    127.0.0.1:8790/<id>/v1/*                (zai-paas, zai-paasv2)
                                      │ rewrites to the native path
                                      └─> https://api.z.ai/api/coding/paas/v4/chat/completions
```

- `session_start`: the extension adopts or spawns `headroom proxy`, health-gates it, starts the in-process shim (only if any provider needs it), and override-registers every enabled provider via `pi.registerProvider` (baseUrl -> proxy, `x-headroom-base-url` header -> upstream). API keys never leave your `models.json`.
- `session_shutdown`: kills only the proxy this extension spawned, stops the shim. An external proxy you started yourself is adopted, never killed.
- Upstream addresses are read **directly from `~/.pi/agent/models.json`** — no URL copies to maintain.

## Install (end to end)

### 1. Install the Headroom CLI

```powershell
uv tool install "headroom-ai[proxy]"     # or: pip install "headroom-ai[proxy]"
```

Open a **fresh terminal** afterwards — `uv tool install` does not update the PATH of already-open terminals, and pi spawned from a stale terminal fails the health gate with providers left direct.

Check: `headroom --version` prints 0.38.0 or higher (the extension warns below that; the dedicated chat-completions header handler needs a recent build).

### 2. Drop the folder into your pi extensions

```powershell
git clone https://github.com/ukind/pi-headroom "$env:USERPROFILE\.pi\agent\extensions\headroom"
# or copy the folder manually — same result
```

### 3. (Only on TLS-intercepted machines) export the Windows root bundle

If your network TLS-intercepts HTTPS (corporate root in the Windows store), Headroom's Python clients fail with `certificate verify failed`. Export the Windows roots once:

```powershell
python -c "import ssl, pathlib; certs=[]; [certs.extend(ssl.enum_certificates(s)) for s in ('ROOT','CA')]; p=pathlib.Path.home()/'.headroom'; p.mkdir(exist_ok=True); (p/'win-ca-bundle.pem').write_text(''.join(ssl.DER_cert_to_PEM_cert(c[0]) for c in dict.fromkeys(certs)))"
```

The shipped `headroom.json` already points `extraEnv.SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` at `~/.headroom/win-ca-bundle.pem`. Skip this step on machines without TLS interception (then remove the `extraEnv` block).

### 4. Start pi

```
[headroom] adopted external proxy on 127.0.0.1:8787 (v0.39.0); 5 providers wired, 2 via path shim
[headroom] not wired (disabled in config): freetoken, nube
```

### 5. Verify

```
/headroom status                 # proxy pid/version, shim line, wired + disabled lists
curl -s http://127.0.0.1:8787/health       # "status":"healthy"
curl -s http://127.0.0.1:8787/stats        # compression counters (see below)
```

Run a few turns, then check compression actually engaged in `/stats` under `summary.compression`:

- `requests_compressed` > 0 — the proxy rewrote context
- `total_tokens_saved_all_layers` > 0 — tokens actually removed

Both stay `0` until a request is large enough for the profile to compress (short sessions never cross the threshold — that is expected, not a fault). `headroom --version` 0.39.0 note: per-provider attribution does not exist yet; `requests.by_provider` groups by API family (`{"openai": N}`).

## Configuration — `headroom.json`

Upstreams come from `models.json`. This file carries only behavior:

| key | default | meaning |
| --- | --- | --- |
| `port` | `8787` | Headroom proxy port |
| `shimPort` | `8790` | Path-shim port (loopback only) |
| `profile` | `balanced` | Headroom savings profile (read at proxy startup only) |
| `beacon` | `off` | Headroom telemetry beacon |
| `telemetry` | `on` | Powers `/stats` |
| `command` | `headroom` | CLI binary to spawn |
| `healthTimeoutMs` | `20000` | Health-gate budget at session start |
| `extraEnv` | — | Extra env vars for the spawned proxy (CA bundle, allow-lists) |
| `providers.<id>.enabled` | `true` | Route this provider through Headroom |
| `providers.<id>.baseUrl` | from `models.json` | Upstream override |
| `providers.<id>.shim` | auto | Force shim on/off; auto = shim when the chat path does not end in `/v1` |

Default provider behavior (out of the box):

| provider | route | note |
| --- | --- | --- |
| hyper | direct header | |
| stepfun | direct header | |
| ollama-cloud | direct header | |
| zai-paas / zai-paasv2 | **path shim** | native path `/api/coding/paas/v4/chat/completions` |
| nube | disabled | upstream resets proxied requests (verified E2E) |
| freetoken | disabled | loopback upstream; Headroom's SSRF guard rejects it |

Shim-routed providers need Headroom to accept a loopback target: the extension adds `127.0.0.1:<shimPort>` to `HEADROOM_ALLOWED_BASE_URLS` in the spawned proxy's env automatically (your own `extraEnv` value is preserved and extended).

## Commands

- `/headroom status` — proxy state, version, shim state, wired/disabled lists
- `/headroom stop` — stop the proxy (only one this extension spawned); providers stay wired until restart
- `/headroom restart` — stop + health-gated start

## Troubleshooting

- **`proxy unavailable after 20000 ms`** — the `headroom` binary is not on PATH (fresh terminal after install), or the port sits in a Windows excluded port range (Headroom issue #589 — set `"port": 8788`).
- **`path shim unavailable ... (EADDRINUSE)`** — something else holds `8790`; set `"shimPort": 8791`. Shim-routed providers fall back to direct for that session.
- **`HTTP_PROXY/HTTPS_PROXY ... NO_PROXY` warning at startup** — add `127.0.0.1,localhost` to `NO_PROXY`; pi's dispatcher has no loopback bypass.
- **`certificate verify failed` in proxy logs** — TLS interception; do step 3.
- **Provider turns fail with 401** — Headroom relays your `Authorization` header to the upstream; check the key in `models.json` for that provider.

## Rollback

Delete the folder. The extension persists nothing — no `models.json` or `settings.json` edits ever happen — so the next session talks to every provider directly. Kill any Headroom proxy you started yourself (`Get-NetTCPConnection -LocalPort 8787`).

## Requirements

- pi >= 0.87, Node >= 23.6 (native TypeScript stripping)
- headroom-ai >= 0.38.0 (`uv tool install "headroom-ai[proxy]"`)
