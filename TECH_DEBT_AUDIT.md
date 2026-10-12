# Tech Debt Audit — pi-headroom (`~/.pi/agent/extensions/headroom`)

Generated: 2026-10-10 · HEAD `b25e4b6` · branch `main` · working tree clean (only this file is untracked)

> **Post-audit note (committed with the remediation):** the two harness deliverables cited below at `.rpiv/tmp/hdrv/` moved to `test/` (finding F041) and the `.gitignore` negation ladder collapsed to `.pi/` + `.rpiv/`. Every `file:line` citation in this document is point-in-time at HEAD `b25e4b6`.
**Repeat run.** Previous audit: 2026-10-05 at the same HEAD `b25e4b6`. No commits landed in between, so **0 of 42 prior findings are RESOLVED**. 9 findings are NEW (F043–F051), 4 prior findings are updated with corrected citations or wider scope (F004, F009, F016, F-V10), and F002 is re-graded High → **Critical**. Prior IDs are preserved so the two documents diff cleanly.

Scope: whole repo. Tracked source = `index.ts` (1104 lines), `README.md` (130), `headroom.json` (47), `.gitignore` (13), plus two test files under `.rpiv/tmp/hdrv/`.
Evidence tier: Verify (Tier 2). Graph tools were not used — this repo is 6 tracked files and one 1104-line module, so direct source reads over `index.ts` plus `git log` are the ground truth. Every finding below cites a `file:line` I read. Type claims were checked by actually running `tsc --noEmit`; pi-internals claims were checked against the installed pi 1.0.1 bundle.

---

## Executive summary

- **One finding can kill the pi process, and its trigger is routine.** `upRes.pipe(res)` at `index.ts:700` has no `error` listener. An upstream reset mid-stream emits `error` on a stream with no listener, which is an uncaught exception in Node. Re-graded Critical this run: ECONNRESET on a streaming response is a normal network event, not an edge case.
- **A new crash the previous run missed.** `index.ts:1082` calls `JSON.parse(body)` where `body` is `string | null`. A 200 response with an empty body makes `parsed` `null`, and `index.ts:1087` then throws `TypeError: Cannot read properties of null`. `tsc` reports this as a real `TS2345` — the previous audit claimed the file "types cleanly."
- **The previous audit's type-clean claim was wrong in two ways.** `tsc --noEmit` emits **46** errors, not 44, and one of them is the `TS2345` above rather than module-resolution noise. The other 45 are missing-`@types/node` / missing-pi-types fallout.
- **Two documented recovery paths do not work.** `/headroom restart` respawns with the config captured at factory time (`index.ts:1011`), so the "edit `headroom.json`, then restart" advice in `README.md:120` and `index.ts:953` cannot take effect. And the rollback loop at `index.ts:820` iterates a list that `index.ts:887` already emptied.
- **`index.ts` has zero tests.** 1104 lines of process lifecycle, port ladders, and kill routing, with no test runner, no `package.json`, and no CI. The two tracked test files verify headroom's Python proxy, not this extension.
- **A committed file hardcodes this machine's path.** `.rpiv/tmp/hdrv/driver_e2e.mjs:15` pins `C:/Users/utama/AppData/Roaming/uv/tools/...python.exe`, the exact class of machine-specific value `README.md:49` claims the extension eliminates.
- **The shim reads the CA bundle from disk on every request.** `shimCaBundle` (`index.ts:638-646`) is called inside the per-request handler at `index.ts:679`, so every shim-routed token pays a synchronous `readFileSync` of a root bundle.
- **The silent-re-compression fix rests on a trailing newline and an env var nobody sets** (`index.ts:1087-1090`).
- **`models.json` is read and parsed synchronously 10 times per session start** (`index.ts:335,344,628,712,776,845,917,927` for `resolveProviders`, plus `index.ts:319,930` for `modelLimitsEnv`), and `headroom --version` spawns a child process on every session start even when the version is already known (`index.ts:584,588`).
- Config accepts any typo. `[key: string]: unknown` (`index.ts:36`) plus no unknown-key warning means `healthTimoutMs` silently falls back to the default.

Severity spread: 1 Critical · 9 High · 25 Medium · 16 Low. (51 findings; the previous run's 0-Critical calibration was too lenient for an uncaught-exception class of bug.)

---

## Architectural mental model

This is a single-file pi folder extension with no build step. pi loads `index.ts` directly through Node's native TypeScript stripping. There is no `package.json`, so the module's 43 `export` markers exist purely for testability, and nothing imports them.

The extension is a control plane around one machine-level singleton: a `headroom proxy` process on `127.0.0.1:8787`. It does four jobs.

1. **Config resolution.** `headroom.json` (behavior flags) merges over `~/.pi/agent/models.json` (upstream truth: 7 providers, 71 models, 38,975 bytes). `resolveProviders` (`index.ts:139`) is the single join point. It is called from eight other functions, each of which re-reads `models.json` from disk.
2. **Proxy lifecycle.** `ensureProxyRunning` (`index.ts:573`) either adopts a live proxy or spawns one. Killing routes through one authority, `stopProxy` (`index.ts:529`), which uses the child handle for its own process and a port-owner PID lookup (`findPortOwnerPid`, `index.ts:458`) for everything else. The proxy deliberately outlives sessions.
3. **Path-rewrite shim.** Headroom 0.39.0 appends `/v1/chat/completions` to `x-headroom-base-url`. Providers whose real path is not `/v1`-shaped (Z.ai: `/api/coding/paas/v4`) cannot use that header. So the extension runs an in-process HTTP relay on `127.0.0.1:8790`-`8795` that strips `/v1/` and forwards to the native path. This is the cleverest and least-tested part of the file, and it is where both the Critical finding and the new per-request disk read live.
4. **CCR redemption.** `headroom_retrieve` (`index.ts:1027`) redeems `<<ccr:HASH>>` markers through the proxy's loopback `GET /v1/retrieve/{hash}`, because the proxy does not inject its own retrieve tool on pi's streaming chat path.

State lives in a process-wide singleton on `globalThis.__headroomState` (`index.ts:1012-1013`), while `config` lives in the factory closure (`index.ts:1011`). Those two have different lifetimes, and several bugs below come from that split.

The mental model matches the README. No contradiction to flag. The README is accurate about behavior and wrong about one recovery procedure (F004).

**Environment note that is not a repo finding:** two pi installs exist on this machine — the running one is global at `C:\nvm4w\nodejs\node_modules\@earendil-works\pi-coding-agent@1.0.1`, and a stale `0.79.9` copy sits at `~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent`. Every pi-internals citation below was verified against **1.0.1**. The 0.79.9 copy has different line numbers for the same symbols, which is exactly the rot F016 describes.

---

## Findings

| ID | Category | File:Line | Sev | Effort | Description | Recommendation |
|----|----------|-----------|-----|--------|-------------|----------------|
| F002 | Error handling | `index.ts:700` | **Critical** | S | `upRes.pipe(res)` with no `upRes.on("error")`. An upstream reset mid-stream emits `error` on a stream with no listener → uncaught exception → pi dies. Re-graded from High: ECONNRESET on a streaming response is routine, not an edge case. | Add `upRes.on("error", () => res.destroy())` before the pipe. |
| F001 | Error handling | `index.ts:752` | High | S | `ensureShimRunning` registers `server.once("error", onErr)` and removes it after a successful bind (`index.ts:757`). The bound `Server` then has no `error` listener. A later async server error is an uncaught exception and kills pi. | Attach a permanent `server.on("error", ...)` in `startShim` (`index.ts:706`) that logs and calls `stopShim`. Keep the one-shot listener only for the bind probe. |
| F003 | Architectural decay | `index.ts:887` vs `index.ts:820` | High | S | `onSessionShutdown` sets `state.registered = []`. The next `session_start` runs the unavailable-branch rollback over that empty list, so no override is removed. The warning at `index.ts:838` then claims "stale overrides removed, providers left DIRECT". pi 1.0.1 keeps extension overrides in `ModelRuntime.extensionProviders`, which survives `reload()`. Providers can stay wired to a dead proxy. | Do not clear `state.registered` in `onSessionShutdown`. Let `registerOverrides` (`index.ts:770`) own the list, and unregister from `resolveProviders(config).enabled` ids instead of `state.registered`. |
| F004 | Documentation drift | `index.ts:1011`, `README.md:120`, `index.ts:991`, `index.ts:950-952` | High | S | `config` is read once per factory run. `/headroom restart` passes that closure value to `restartProxy` (`index.ts:991`). Editing `headroom.json` and running `/headroom restart` respawns the proxy with the OLD limits. **Updated this run:** the status WARNING at `index.ts:950-952` and `README.md:120` now half-admit the bug — they say restart "respawns with the current config" and, in the same sentence, "(headroom.json is read once at load, so edit it first)". The message contradicts itself and still tells the user to do the thing that cannot work. | Call `loadConfig()` inside the `restart` branch (`index.ts:989`) and re-derive the env. Or state plainly that a pi restart is required — but pick one and make both texts agree. |
| F005 | Test debt | `index.ts` (whole file) | High | M | Zero tests cover this module. 43 exported functions, no runner, no `package.json`, no CI. `test_retrieve_forms.py` and `driver_e2e.mjs` exercise headroom's Python modules and a live proxy. Neither imports `index.ts`. The untested surface is the kill routing, the port ladder, and the shim. | Add a `package.json` with `node --test` and a `test/index.test.ts`. Start with the pure functions that already have no I/O: `stripTrailingV1`, `versionAtLeast`, `proxyPort`, `shimPortCandidates`, `rateLimitEnv`, `resolveProviders` with an injected manifest. |
| F006 | Dependency & config debt | `.rpiv/tmp/hdrv/driver_e2e.mjs:15` | High | S | A committed test file pins `C:/Users/utama/AppData/Roaming/uv/tools/headroom-ai/Scripts/python.exe`. It cannot run on any other machine. This directly contradicts `README.md:49`, which makes portability the design goal. | Read it from `process.env.HEADROOM_PYTHON ?? "headroom"`, or resolve the uv tool path the way `sanitizedExtraEnv` (`index.ts:298`) resolves CA paths. |
| F007 | Performance & resource hygiene | `index.ts:679-680` | High | S | Neither `httpsRequest` nor `httpRequest` in the shim gets a `timeout`. A hung upstream holds a socket, a request object, and the buffered body indefinitely. Every other network call in the file sets one (`index.ts:381`). | Pass `{ timeout: ... }`, add `outReq.on("timeout", () => outReq.destroy())`, and make the value configurable. |
| F008 | Error handling | `index.ts:682-688` | High | S | `outReq.on("error")` guards `writeHead` with `!res.headersSent` but calls `res.end(JSON.stringify(...))` unconditionally. After the pipe starts, headers are already sent, so the error JSON is appended into a live response body. | Split the two paths: `if (res.headersSent) return res.destroy();` before the writeHead/end pair. |
| F043 | Type & contract debt | `index.ts:1082`, `index.ts:1087` | High | S | **NEW.** `fetchHealth` returns `body: string \| null` (`index.ts:406`), and `body` is `null` whenever the response body is empty. `index.ts:1082` passes it straight to `JSON.parse`. `JSON.parse(null)` does not throw — it returns `null` — so the `catch` at `index.ts:1083` never fires, `parsed` is `null`, and `index.ts:1087` (`parsed.original_content`) throws an unhandled `TypeError`. Reachable whenever the proxy answers 200 with an empty body. `tsc` flags it as a real `TS2345`, which the previous audit's "types cleanly" claim missed. Also `index.ts:1085` renders a null body as the literal string `"null"`. | Guard the null before parsing and return a clear message. See Top 5 #2 for the diff. |
| F044 | Performance | `index.ts:638-646`, `index.ts:679` | High | S | **NEW.** `shimCaBundle` does a synchronous `readFileSync(file, "utf-8")` of the Windows root bundle, and it is called from `send()` inside the per-request handler at `index.ts:679`. Every shim-routed token — all zai-paas traffic — pays a blocking disk read of a several-hundred-KB PEM on the request path. | Read the bundle once in `startShim` (`index.ts:706`) and close over it, or memoize on a module-level `Map` keyed by `path + mtimeMs`. |
| F009 | Performance | `index.ts:335,344,628,712,776,845,917,927` + `index.ts:319,930` | Medium | S | **Updated this run — wider than previously stated.** `resolveProviders` re-reads and re-parses `models.json` (38,975 bytes) on every call, and there are **eight** call sites, plus two `modelLimitsEnv` calls that each re-read it via `readManifestModelLimits` (`index.ts:289`). One session start performs ten synchronous reads of the same file. `ensureShimRunning`'s failure path makes it worse: up to 12 `startShim` attempts, each calling `resolveProviders` at `index.ts:712`. | Memoize the manifest read per config object, or resolve once in `onSessionStart` and pass the result down as a parameter. |
| F010 | Performance | `index.ts:584,588` | Medium | S | Both branches of `ensureProxyRunning` overwrite `state.version` with a fresh `headroomVersion()` spawn. `session_start` re-fires on `/new` and `/resume`, so every one pays a `cmd.exe` spawn on Windows. The proxy is a machine singleton, so the version cannot change underneath it. | Reuse `state.version` when it is non-null. Refresh only after a spawn or a `/headroom restart`. |
| F011 | Type & contract debt | `index.ts:36` | Medium | S | `[key: string]: unknown` on `HeadroomConfig` disables typo detection for the whole file. `loadConfig` (`index.ts:95`) validates only that the value is a non-array object. `"healthTimoutMs": 5000` is accepted and ignored with no message. | Drop the index signature. Keep `_comment` legal with one explicit `comment?: string[]` field. Add a pass that warns on any top-level key outside the known set. |
| F012 | Type & contract debt | `index.ts:147-150` | Medium | S | `resolveProviders` iterates `Object.keys(manifest)`. A `providers.<id>` block whose id is absent from `models.json` is silently dropped. A renamed provider therefore loses all its flags with no signal. | After the loop, warn on every key in `config.providers` that is not in the manifest. |
| F013 | Consistency rot | `index.ts:66-69` used at `index.ts:151` | Medium | S | `DEFAULT_DISABLED` maps two provider ids to reason strings. Only key membership is ever read (`id in DEFAULT_DISABLED`). Both reason values are dead data, and `/headroom status` prints the skipped ids with no reason (`index.ts:928`). | Print the reason in the `skipped` list, or change the map to `Set<string>` and move the reasons into the README. |
| F014 | Consistency rot | `index.ts:379`, `index.ts:939`, `index.ts:961`, `index.ts:1061` | Medium | S | `fetchHealth` is a generic GET used for `/health`, `/stats`, and `/v1/retrieve/{hash}`. Its `healthy` flag only means `statusCode === 200`. A 404 retrieve with an empty body reports "the proxy is not reachable" (`index.ts:1075`) when the proxy answered fine and the entry simply expired. | Rename to `httpGetStatus` and return `statusCode`. Have callers branch on the code. Keep a thin `fetchHealth` wrapper for the two health probes. |
| F015 | Documentation drift | `index.ts:554`, `index.ts:1090` | Medium | S | Self-referential line numbers in comments have rotted. `index.ts:554` cites `index.ts:470` for the 1500 ms adopt probe. That probe is at `index.ts:581`, and line 470 is now PowerShell argument text. `index.ts:1090` cites `index.ts:322/:427-429` for `proxyEnv`/`spawnProxy`, which start at `index.ts:315`/`index.ts:426`. | Replace numeric citations with symbol names ("the 1500 ms probe in `ensureProxyRunning`"). Line numbers in comments are guaranteed to rot. |
| F016 | Documentation drift | `index.ts:808`, `index.ts:879`, `index.ts:1006` | Medium | S | Comments cite pi internals by line number. **Updated this run with verified numbers:** against the running pi 1.0.1, `setActiveToolsByName` is at `dist/core/agent-session.js:1084` (the comment at `index.ts:808` cites `agent-session.js:2890-2892`, which is the *initial active set* line, not the setter), and `session_shutdown` is emitted at `:2902` (the comment at `index.ts:879` cites `:2606`, now unrelated code). `index.ts:1006` cites `agent-session.js reload()` with no line. | Cite symbol names and the pi version they were verified against. `index.ts:879` already does the version part badly; it names no version at all. |
| F017 | Architectural decay | `index.ts:892-1000` | Medium | M | `handleHeadroomCommand` is a 108-line function. The `status` branch alone is ~70 lines and performs two sequential network probes with 2 s timeouts each (`index.ts:939`, `index.ts:961`), inside a UI command handler — up to 4 s of blocking. | Split into `renderStatus(config, state)`, `stopHandler(...)`, `restartHandler(...)`. Run the `/stats` and `/health` probes with `Promise.all`. |
| F018 | Architectural decay | `index.ts` (1104 lines) | Medium | M | One file holds eight responsibilities: config load, manifest read, provider resolution, env assembly, process lifecycle, port ladders, HTTP shim, and command rendering. It is over the 500-line god-file threshold by 2×. Churn confirms it: 9 of 11 commits touch it. | Split along the section banners already in the file (`index.ts:16,55,93,181,625,765,890`) into `config.ts`, `lifecycle.ts`, `shim.ts`, `session.ts`, `commands.ts`. Do this only after F005 lands, or the split has no safety net. |
| F019 | Consistency rot | `index.ts:71-81`, `headroom.json:2-23`, `README.md:73-90` | Medium | S | The same defaults and the same provider rationale exist in three places. `headroom.json._comment` is 21 prose strings that wrap mid-sentence across array entries (entries 12-13 read "…to pick your own. Applies only to a" / "proxy this extension spawns"). Any default change needs three edits. | Keep the README table as the only prose. Make `_comment` a one-line pointer at it. |
| F020 | Dependency & config debt | repo root (no `package.json`) | Medium | S | `npm audit`, `npx knip`, `npx madge --circular`, and `npx depcheck` cannot run. `tsc --noEmit` on the bare file emits 46 errors (see F-V10), so there is no usable local type gate. | Add a dev-only `package.json` with `@types/node`, `typescript`, and a `check` script pointing at a real `tsconfig.json`. This makes F005 and the type gate possible in one step. |
| F021 | Documentation drift | repo root (no `LICENSE`) | Medium | S | `README.md:37` publishes a clone URL for public use, and the repo declares no license. Consumers have no grant. | Add a `LICENSE` file. Pick MIT or BSM explicitly. |
| F022 | Consistency rot | `index.ts:638-646` vs `index.ts:298` | Medium | S | `sanitizedExtraEnv` exists to drop CA paths that do not exist, because a dead path breaks every upstream call. `shimCaBundle` reads `config.extraEnv?.SSL_CERT_FILE` raw and bypasses that sanitizer. The two paths treat the same value differently. | Have `shimCaBundle` consume the sanitized map, or hoist one `resolveCaBundle(config)` helper both call. |
| F023 | Error handling | `index.ts:310-314` | Medium | S | `caBundleEnv` returns early only when `extra.SSL_CERT_FILE` is set. A user who sets `REQUESTS_CA_BUNDLE` to a valid custom bundle and leaves `SSL_CERT_FILE` unset gets all three keys overwritten with `DEFAULT_CA_BUNDLE`. | Guard on any of the three `CA_KEYS` being present, not just `SSL_CERT_FILE`. |
| F024 | Security hygiene | `index.ts:171-172` | Medium | S | `auditProxyEnv` decides loopback coverage with `noProxy.includes("127.0.0.1") && noProxy.includes("localhost")`. Substring matching on a comma list is wrong: `NO_PROXY=my-localhost-cache.internal` satisfies the second test, and `127.0.0.1.evil.invalid` satisfies the first. | Split on `,` and compare trimmed entries against the exact set. |
| F025 | Security hygiene | `index.ts:432`, `index.ts:435`, `index.ts:344` | Medium | S | Both spawns use `shell: process.platform === "win32"` while passing `--openai-api-url <upstream>`, where `upstream` comes from `models.json` (`defaultUpstreamUrl`, `index.ts:344`). With `shell: true`, Node does not quote arguments for `cmd.exe`, so a `baseUrl` containing `&` or `"` reaches the shell. | Validate the upstream with `new URL()` and reject non-`https?:` protocols before the spawn. Keep `shell: true` — F-V02 below explains why it is load-bearing. |
| F026 | Performance | `index.ts:794-800`, `index.ts:598` | Medium | M | `onSessionStart` awaits `ensureProxyRunning`, which can block for the full `healthTimeoutMs` of 20 s (`index.ts:598`). Startup is frozen for that window with no progress signal. | Report the tradeoff deliberately. Either lower the default, or wire providers after the probe resolves and notify on completion. Do not silently keep a 20 s blocking hook. |
| F027 | Error handling | `index.ts:1052` | Medium | S | `execute(_toolCallId, params, _signal, ...)` discards the abort signal. The 5 s retrieve (`index.ts:1061`) cannot be cancelled by the user. | Thread `_signal` into `fetchHealth` and destroy the request on abort. |
| F028 | Architectural decay | `index.ts:1087-1090` | Medium | L | The whole re-compression fix is one trailing `\n`. The comment states the ceiling honestly: any layer that trims trailing whitespace restores byte equality and the failure returns silently. The stated contingency, `HEADROOM_NO_CCR=1`, appears nowhere else in the repo and is never set by `proxyEnv` (`index.ts:315`). So the documented escape hatch is manual, undocumented in the README, and blind for adopted proxies. | Add `HEADROOM_NO_CCR` support to `proxyEnv` behind a config flag, document it in `README.md` Troubleshooting, and file the real fix upstream against `CompressionCache.apply_cached`. |
| F029 | Consistency rot | `index.ts:784-787` vs `index.ts:820-824` | Medium | S | Every `pi.unregisterProvider` call is wrapped in try/catch. `pi.registerProvider` is not. A throw mid-loop leaves `state.registered` short of what pi actually accepted, and the failure surfaces as a raw extension error instead of a warning. | Wrap the register call and route failures through the same `warn()` used at `index.ts:800`. |
| F030 | Architectural decay | `index.ts:819`, `index.ts:852` | Medium | S | `onSessionStart` unregisters providers only in the `unavailable` branch and the `!shimOk` branch. If a user disables a provider in `headroom.json` while the proxy stays healthy, that provider's previous-round override is never removed. It keeps routing through the proxy. | Compute the previously-registered set, diff it against the new one, and unregister the difference on every round. |
| F045 | Observability | `index.ts:599` | Medium | S | **NEW.** `state.lastSpawnError = "unhealthy"` is written and never read. The only consumer (`index.ts:828`) tests for `"cli-missing"`. A proxy that spawns but never becomes healthy produces the same generic "proxy unavailable after 20000 ms" message as a proxy that never started, with no hint that a child process exists and died. | Render `lastSpawnError` in the unavailable warning and in `/headroom status`. |
| F046 | Observability | `index.ts:436` | Medium | S | **NEW.** `spawnProxy` uses `stdio: "ignore"`, so a pi-spawned proxy's stdout and stderr are discarded. A proxy that crashes on boot (bad env, missing Python dep, port race) leaves no trace; the only signal is a 20 s timeout. `README.md:117` points users at "proxy logs", which only exist for adopted or manually-started proxies. | Use `stdio: ["ignore", "ignore", "pipe"]`, capture the first stderr line into `state.lastSpawnError`, and surface it. |
| F047 | Error handling | `index.ts:894` | Medium | S | **NEW.** `handleHeadroomCommand`'s `notify` helper calls `ctx.ui.notify(...)` unconditionally, while `onSessionStart` guards the same call with `ctx?.hasUI` (`index.ts:800-803`). Any dispatch of `/headroom` without a UI throws a `TypeError` out of the command handler. | Apply the same `hasUI` guard, or route through a shared `notify(ctx, msg, level)` helper both call sites use. |
| F031 | Error handling | `index.ts:653` | Low | S | `new URL(req.url ?? "/", ...)` sits outside the try/catch that guards the target build at `index.ts:664`. A request target `URL` rejects throws out of the handler. | Move it inside the existing try, or wrap the handler body. |
| F032 | Security hygiene | `index.ts:648-703` | Low | M | The shim is an unauthenticated loopback relay. Any local process can POST through it to a mapped upstream, and there is no request body size cap. Path segments are confined to the mapped origin by `new URL`, so it is not an open proxy. | Document the loopback trust assumption. Add a content-length cap if any non-pi process can reach the port. |
| F033 | Type & contract debt | `index.ts:368`, `index.ts:861` | Low | S | `versionAtLeast` returns `boolean \| null`. `index.ts:861` tests `=== false`, so the `null` case (unparseable version) silently skips the warning. `index.ts:912` renders the same `null` as "uncertain". | Return a discriminated result, or warn on `null` too. |
| F034 | Architectural decay | `index.ts:82` | Low | S | `DEFAULT_UPSTREAM_ARG = "hyper"` is exported and referenced nowhere in the repo. | Delete it, or record why the name is reserved. |
| F035 | Error handling | `index.ts:578` | Low | S | `ensureProxyRunning` returns `"spawned"` whenever `isAlive(state)` is true, including a child that is exiting. The startup banner then reports "proxy spawned" for an adopted or dying process. | Return a distinct `"already-running"` outcome. |
| F036 | Observability | `index.ts:870-874` | Low | S | The startup banner routes through `ctx.ui.notify` when `hasUI` is true, but the `skipped` line at `index.ts:874` always uses `console.log`. A UI user never sees which providers were left unwired. | Route both through the same `warn`-style helper. |
| F037 | Observability | `index.ts:95`, `index.ts:114`, `index.ts:252` | Low | S | All diagnostics go to `console` or a transient `ui.notify`. Nothing is persisted. After a bad session start, the reason is gone once the notification clears. | Keep a bounded in-memory ring of the last N decisions and print it in `/headroom status`. |
| F038 | Architectural decay | `index.ts:348-366`, `index.ts:458-500` | Low | M | `headroomVersion` and `findPortOwnerPid` are the same shape twice: spawn, accumulate stdout, resolve `null`/sentinel on error, parse on close. The second one even says it was modeled on the first. | Extract `spawnProbe(command, args): Promise<{ out: string; code: number \| null; failed: boolean }>`. |
| F039 | Documentation drift | `headroom.json:2-23` | Low | S | 21 prose strings in a config array, no consumer, and sentences split mid-clause across entries. Grep for `rateLimit` returns a fragment. | See F019. |
| F040 | Test debt | `.rpiv/tmp/hdrv/test_retrieve_forms.py:1-13` | Low | M | Both test files are manual. There is no runner, no dependency pin for the `headroom` import, and `driver_e2e.mjs` needs two free ports passed by hand. Nothing verifies they still pass after a change. | Add `npm test` that runs the Python suite and the e2e driver with generated ports. |
| F041 | Consistency rot | `.gitignore:2-13` | Low | S | Six negation lines exist only to keep two files visible under `.rpiv/tmp/`. The comment explains the git rule that forces the shape. Permanent deliverables living in a `tmp/` directory is the cause. | Move them to `test/`. The ignore file collapses back to `.rpiv/`. |
| F042 | Dependency & config debt | `README.md:129` | Low | S | Requirements say `pi >= 0.87`. The running runtime is pi 1.0.1, and a stale 0.79.9 copy also exists on this machine — below the stated floor. The code comments describe pi behavior verified against 1.0.1 (F016). | Re-verify against 1.0.1 and raise the floor to a version actually tested. |
| F048 | Error handling | `index.ts:1053` | Low | S | **NEW.** The hash regex `/[a-f0-9]{12,24}/i` silently truncates a longer hex string to its first 12 characters. A pasted 40-char SHA produces a wrong hash and a 404 that reads as "entry expired". | Anchor the match and validate the length, or report the truncation in the error text. |
| F049 | Error handling | `index.ts:517-527` | Low | S | **NEW.** The POSIX branch of `killProcess` sends `SIGTERM` and returns `"killed"` immediately, without waiting for exit or escalating to `SIGKILL`. A process that ignores SIGTERM is reported as stopped. `restartProxy`'s `waitForPortFree` masks this, but `/headroom stop` does not. | Poll for exit with a short deadline, then `SIGKILL`, before returning `"killed"`. |
| F050 | Observability | `index.ts:148` | Low | S | **NEW.** `resolveProviders` silently `continue`s past providers whose `api` is not `"openai-completions"`. They land in neither `enabled` nor `skipped`, so `/headroom status` gives no signal that N manifest providers were ignored. Currently latent — all 7 providers in this machine's `models.json` are openai-completions. | Return a third `incompatible` list and print it in the status output. |
| F051 | Process | `TECH_DEBT_AUDIT.md` (untracked) | Low | S | **NEW.** This document is untracked (`git status` shows `?? TECH_DEBT_AUDIT.md`). Repeat-run mode is designed to make it a living document tracked over time, but nothing commits it, so it is lost on a fresh clone. | Commit it, or add it to `.gitignore` deliberately and say so in the README. |

---

## Top 5 — if you fix nothing else, fix these

### 1. F002 + F001 + F008: the shim has three unhandled-error paths, one of which kills pi

`index.ts:706-717` builds the server and `index.ts:733-762` binds it. The bind probe removes its own handler on success, and nothing replaces it.

```ts
// index.ts:706 — startShim: add before the return
export function startShim(config: HeadroomConfig, state: HeadroomState, port = shimPort(config)): Server {
  const providers: Record<string, string> = {};
  for (const p of resolveProviders(config).enabled) providers[p.id] = p.upstream;
  const server = createServer(createShimHandler(providers, config));
  // A permanent handler: after ensureShimRunning removes its bind probe, an async
  // server error with no listener is an uncaught exception and takes pi with it.
  server.on("error", (err) => {
    console.warn(`[headroom] path shim error on :${state.shimPort ?? port} (${err.message}); tearing down`);
    stopShim(state);
  });
  state.shim = server;
  state.shimPort = port;
  return server;
}
```

```ts
// index.ts:682 — outReq error: never append an error body to a response that already started
outReq.on("error", (err) => {
  if (res.headersSent) { res.destroy(); return; }          // F008
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `headroom-shim: upstream error: ${err.message}` } }));
});

// index.ts:694 — response path: close the stream when the upstream resets  (F002, Critical)
outReq.on("response", (upRes) => {
  upRes.on("error", () => res.destroy());                   // F002
  const outHeaders = { ...upRes.headers };
  // ... unchanged
});
```

Then F007 in the same pass: add `timeout` to both request builders at `index.ts:679-680`.

### 2. F043: a 200 with an empty body throws an unhandled TypeError out of `headroom_retrieve`

`fetchHealth` returns `body: string | null` and `null` means "empty body", not "no response". `JSON.parse(null)` returns `null` rather than throwing, so the existing `catch` is dead code on this path.

```ts
// index.ts:1080-1087
let parsed: { original_content?: unknown } | null = null;
try {
  parsed = body === null ? null : (JSON.parse(body) as { original_content?: unknown });
} catch {
  // Same byte-differentiation as the success return below — see the guard comment there.
  return { content: [{ type: "text", text: (body ?? "") + "\n" }] };   // F043: was `body + "\n"`
}
if (!parsed) {
  return {
    content: [{ type: "text", text: `Headroom retrieve returned an empty body for ${hash} (entry expired?).` }],
  };
}
const original = parsed.original_content;
```

Three lines, no behavior change on the working path, and it removes the only real type error in the file.

### 3. F003: stop clearing `state.registered` at shutdown

The rollback at `index.ts:820` cannot see what the last round registered.

```ts
// index.ts:884 — onSessionShutdown
export function onSessionShutdown(state: HeadroomState): void {
  stopShim(state);
  state.child = null;
  // Do NOT clear state.registered. pi keeps extension provider overrides in the
  // ModelRuntime, which outlives a reload. The next session_start's unavailable
  // branch reads this list to undo them; emptying it here makes that rollback a no-op
  // and leaves providers wired to a dead proxy.
}
```

`registerOverrides` (`index.ts:790`) already overwrites the list on the next healthy round, so nothing else needs to change.

### 4. F004 + F020: make config reloadable, and give the repo a type gate

`/headroom restart` should re-read the file it claims to apply.

```ts
// index.ts:989 — restart branch of handleHeadroomCommand
if (sub === "restart") {
  const fresh = loadConfig();          // index.ts:1011 captures config once per factory run
  notify("restarting proxy...");
  const result = await restartProxy(fresh, state);
  // ...
}
```

Then fix the two texts that currently contradict each other (`index.ts:950-952`, `README.md:120`), and add `package.json` + `tsconfig.json` with `@types/node` and pi as a dev dependency, so `tsc --noEmit` reports real errors instead of the 45 module-resolution errors it emits today.

### 5. F005 + F006: put real tests on the untested surface, and unpin the test path

The pure functions already exported and never imported are the cheap start: `stripTrailingV1` (`index.ts:89`), `versionAtLeast` (`index.ts:368`), `proxyPort`/`shimPort`/`shimPortCandidates` (`index.ts:187-207`), `rateLimitEnv` (`index.ts:234`), `modelLimitsEnv` (`index.ts:282`), `resolveProviders` (`index.ts:139`). Each takes a config object and returns a value, so they need no mocks.

Then fix the committed path:

```js
// .rpiv/tmp/hdrv/driver_e2e.mjs:15
const PYTHON = process.env.HEADROOM_PYTHON ?? "headroom";
```

---

## Quick wins (Low effort × Medium+ severity)

- [ ] F002 — `upRes.on("error", () => res.destroy())` (`index.ts:700`) — **Critical, one line**
- [ ] F043 — null-guard `body` before `JSON.parse` (`index.ts:1082`) — **new, three lines**
- [ ] F001 — permanent `server.on("error")` in `startShim` (`index.ts:706`)
- [ ] F003 — delete `state.registered = []` from `onSessionShutdown` (`index.ts:887`)
- [ ] F004 — `loadConfig()` inside the `restart` branch (`index.ts:989`)
- [ ] F007 — add `timeout` to the two shim request builders (`index.ts:679-680`)
- [ ] F008 — `res.destroy()` when headers are already sent (`index.ts:682`)
- [ ] F044 — read the CA bundle once instead of per request (`index.ts:638`, `index.ts:679`) — **new**
- [ ] F045 — render `lastSpawnError` instead of dropping it (`index.ts:599`) — **new**
- [ ] F046 — capture proxy stderr instead of `stdio: "ignore"` (`index.ts:436`) — **new**
- [ ] F047 — `hasUI` guard on the command `notify` helper (`index.ts:894`) — **new**
- [ ] F009 — resolve providers once per session (`index.ts:139` call sites)
- [ ] F010 — reuse `state.version` instead of re-spawning `headroom --version` (`index.ts:584,588`)
- [ ] F011 — drop `[key: string]: unknown` and warn on unknown config keys (`index.ts:36`)
- [ ] F012 — warn on `providers.<id>` entries with no matching manifest id (`index.ts:147`)
- [ ] F013 — print the `DEFAULT_DISABLED` reasons in `/headroom status` (`index.ts:66,928`)
- [ ] F014 — rename `fetchHealth` to `httpGetStatus` and branch on the status code (`index.ts:379`)
- [ ] F015 — replace numeric line citations with symbol names (`index.ts:554,1090`)
- [ ] F016 — replace pi line-number citations with symbol plus version (`index.ts:808,879`)
- [ ] F020 — add `package.json` + `tsconfig.json` so `tsc --noEmit` is usable
- [ ] F021 — add `LICENSE`
- [ ] F022 — make `shimCaBundle` use the sanitized CA value (`index.ts:638`)
- [ ] F023 — guard `caBundleEnv` on all three `CA_KEYS` (`index.ts:310`)
- [ ] F024 — split `NO_PROXY` on `,` instead of substring matching (`index.ts:171`)
- [ ] F025 — validate the upstream URL before the `shell: true` spawn (`index.ts:344`)
- [ ] F027 — honor the abort signal in `headroom_retrieve` (`index.ts:1052`)
- [ ] F029 — wrap `pi.registerProvider` in try/catch (`index.ts:784`)
- [ ] F030 — diff registered sets per round and unregister the difference (`index.ts:819`)
- [ ] F031 — move `new URL(req.url)` inside a try (`index.ts:653`)
- [ ] F048 — stop silently truncating long hashes (`index.ts:1053`) — **new**
- [ ] F034 — delete the unused `DEFAULT_UPSTREAM_ARG` (`index.ts:82`)
- [ ] F036 — route the `skipped` line through the UI helper (`index.ts:874`)
- [ ] F041 — move the two test files out of `.rpiv/tmp/` and simplify `.gitignore`
- [ ] F051 — commit or deliberately ignore this audit file

---

## Things that look bad but are actually fine

- **F-V01 — `pi.setActiveTools([...pi.getActiveTools(), "headroom_retrieve"])` (`index.ts:814`) is not an unbounded append.** It looks like every `/new` adds a duplicate entry. pi 1.0.1's `setActiveToolsByName` does `[...new Set(toolNames)]` (`dist/core/agent-session.js:1122`), so duplicates collapse. **Corrected this run:** the previous audit named the symbol `_applyToolLoadout`, which does not exist; the dedup lives in `setActiveToolsByName`. The conclusion holds, the citation did not. Leave it.
- **F-V02 — `shell: true` on Windows (`index.ts:352,433`) is load-bearing, not sloppy.** `index.ts:592-593` explains it: with `shell: true` a missing command exits non-zero instead of raising `ENOENT`, which makes the `headroomVersion` probe the one reliable "CLI absent" signal on every platform. Removing it re-breaks the ~50 ms fast fail the README advertises. Fix the injection surface (F025) without touching the flag.
- **F-V03 — not killing the proxy in `session_shutdown` (`index.ts:884`) is correct.** It looks like a leaked process. `session_shutdown` fires on `/new`, `/resume`, and reload, so a kill there churned the singleton on every session change. `index.ts:876-883` records that history, and the earlier behavior is in commit `189bbc2`.
- **F-V04 — `waitForPortFree` returning `void` on timeout (`index.ts:558-571`) is a considered choice.** A silent void looks like a swallowed error. The comment at `index.ts:551-557` gives the reason: the caller's next `ensureProxyRunning` probe is the real arbiter, and the `needed = 2` consecutive-failure gate exists to stop re-adoption of a dying process.
- **F-V05 — the eleven empty `catch {}` blocks are mostly justified.** `index.ts:823` and `index.ts:853` mean "not registered in this runtime, nothing to undo". `index.ts:935` and `index.ts:957,968` guard JSON from an external proxy. Each carries a comment naming the case. I am not flagging them.
- **F-V06 — `modelLimits` taking the minimum on a cross-provider id collision (`index.ts:268`) is right.** It looks like a data-loss bug. headroom matches by model id only and cannot tell providers apart, so the smallest window is the only safe ceiling. `index.ts:245-251` states this.
- **F-V07 — the trailing-newline hack (`index.ts:1087-1093`) is honest about its own fragility.** I flag the missing escape hatch in F028, but the comment names both the ceiling and the contingency. That is better documentation than most workarounds get.
- **F-V08 — `HEADROOM_ALLOWED_BASE_URLS` unioning the user's value instead of replacing it (`index.ts:337-338`) is the correct fix.** The narrower version shipped first and is commit `e5ca275`: listing only the shim ports let unknown bases fall back to the proxy's own `--openai-api-url`, which sent hyper's key to `api.z.ai`. Widening the list is the cure, not the disease.
- **F-V09 — `stripTrailingV1` plus the shim split (`index.ts:89`, `index.ts:662`) is the right shape.** It reads like two competing path normalizations. headroom 0.39.0 concatenates `/v1/chat/completions` onto the header value, so a `/v1`-terminated upstream and a non-`/v1` upstream genuinely need different handling.
- **F-V10 — corrected: the `tsc` errors are *almost* all noise, and the count was wrong.** I ran `tsc --noEmit --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck index.ts`: **46** errors, not the 44 the previous audit reported. 45 are `TS2591`/`TS2307`/`TS1470`/`TS2503` from a missing `@types/node` and missing pi type declarations, plus 13 `TS7006` implicit-`any` parameters that are downstream of the same missing types. **One is a real defect:** the `TS2345` at `index.ts:1082`, now F043. The file has no `any`, no `@ts-ignore`, and only three deliberate `unknown` uses (`index.ts:36,1080,1082`). The debt is the absent harness (F020), not the types — with one exception.
- **F-V11 — reading upstreams from `models.json` rather than copying them into `headroom.json` is the right call.** It costs ten re-reads per session (F009), but the single-source-of-truth design removes the drift that the README's step 3 exists to prevent. Fix the read count, keep the design.
- **F-V12 — the `.gitignore` negation ladder (`.gitignore:7-13`) is ugly but forced.** Six lines of `!.rpiv/...` look like a mistake. Git cannot re-include a path below a fully-ignored directory, so the `/*` restructure plus per-file negations is the only shape that keeps two deliverables tracked while `.rpiv/artifacts`, `.rpiv/tmp/hdrv/node_modules`, and the rest stay local. The fix is F041 (move the files), not simplifying the ignores.

---

## Open questions for the maintainer

1. **Does `telemetry: "on"` (`index.ts:76`, `README.md:83`) send anything off the machine?** `README.md:83` says it "Powers `/stats`", which reads as local-only. If it does report off-box, that needs to be stated next to the default, and `beacon: "off"` needs a matching explanation of the difference between the two.
2. **Is `/headroom restart` supposed to rebind the shim?** `restartProxy` (`index.ts:603-623`) only touches the proxy. Yet `index.ts:923` tells the user "shim: DOWN … /headroom restart or fix port". Running that command cannot fix a down shim. Is the message wrong, or is the shim rebinding missing?
3. **Is `state.adopted` reset enough?** `stopProxy` clears it on every external kill (`index.ts:543,547`), and `ensureProxyRunning` sets it on a successful adopt (`index.ts:583`). But an adopted proxy that dies on its own leaves the flag set until the next `session_start` re-probes. Does `/headroom status` need to re-probe rather than trust the flag?
4. **Is the stale `.rpiv/tmp/hdrv/index.ts` snapshot (46,641 bytes, Oct 2) a test fixture or leftover?** It is untracked and ignored. It is a full older copy of the module under test, which invites someone to edit the wrong file. Same question for `.rpiv/tmp/hdrv/driver.mjs` (2,281 bytes, Oct 2), which `driver_e2e.mjs` appears to supersede.
5. **Is `providers.<id>.shim: false` a supported escape hatch?** `resolveProviders` (`index.ts:157`) computes `viaShim = entry.shim ?? !endsWithV1(upstream)`, so forcing `false` on a non-`/v1` provider sends a header headroom will mis-route. Intentional power-user override, or should it warn?
6. **What is the supported way to run two pi sessions that need different `headroom.json` values?** The proxy is a machine singleton and only the first session spawns it. The second adopts it with the first session's env, and `index.ts:953` warns about exactly that mismatch. Is per-session isolation ever intended, or is "one config per machine" the rule?
7. **Is `freetoken` / `nube` disablement provider knowledge that belongs in code?** `DEFAULT_DISABLED` (`index.ts:66`) hardcodes two ids plus an E2E verification date. A user with a different provider set carries dead entries, and a provider whose behavior changes needs a code release to re-enable.
8. **Is headless `/headroom` dispatch reachable?** F047 flags the missing `hasUI` guard. I could not determine from this repo alone whether pi ever invokes extension commands without a UI context. If it cannot, F047 drops to Low and the fix is cosmetic consistency.
9. **Which pi install is authoritative?** The running pi is 1.0.1 (global, nvm). A stale 0.79.9 copy sits at `~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` with different line numbers for every symbol F016 cites. Is the local copy load-bearing for anything, or is it safe to remove so the citations have one target?
