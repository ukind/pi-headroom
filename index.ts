// headroom — manage a local Headroom compression proxy and route pi providers through it.
// This folder extension adds a tiny in-process path-rewrite shim so providers whose real
// chat path does not end in "/v1" (Z.ai: /api/coding/paas/v4) can route through Headroom:
//   pi -> headroom -> shim (127.0.0.1:<shimPort>/<id>/v1/*) -> <native-upstream>/<rest>
// Patterns: extensions/i-have-adhd.ts (factory shape), extensions/cbmem.ts (spawn/kill),
// extensions/mistral-glm/index.ts (apiKey-omitting registerProvider).
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------- types

export interface ProviderEntry {
  enabled?: boolean;
  baseUrl?: string;
  shim?: boolean;
}

export interface HeadroomConfig {
  port?: number;
  shimPort?: number;
  profile?: string;
  beacon?: string;
  telemetry?: string;
  command?: string;
  healthTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  rateLimit?: { rpm?: number; tpm?: number } | false;
  modelLimits?: Record<string, number> | false;
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

export interface ResolvedProvider {
  id: string;
  upstream: string;
  viaShim: boolean;
}

export interface HeadroomState {
  child: ChildProcess | null;
  adopted: boolean;
  registered: string[];
  version: string | null;
  shim: Server | null;
  shimPort: number | null;
  lastSpawnError: string | null;
}

// ---------------------------------------------------------------- constants

const CONFIG_URL = new URL("headroom.json", import.meta.url);
// models.json lives at the agent-dir root; this file sits at <agent>/extensions/headroom/.
const MANIFEST_URL = new URL("../../models.json", import.meta.url);
const PROXY_HOST = "127.0.0.1";

// Providers that stay direct by default (overridable in headroom.json):
// - freetoken: loopback upstream; Headroom's SSRF guard rejects loopback targets, and a
//   local relay gains nothing from token compression.
// - nube: upstream resets proxied requests (verified E2E 2026-09-26) regardless of path.
export const DEFAULT_DISABLED: Record<string, string> = {
  freetoken: "loopback upstream rejected by Headroom's SSRF guard; no compression value",
  nube: "upstream resets proxied requests (E2E 2026-09-26)",
};

export const DEFAULT_CONFIG = {
  port: 8787,
  shimPort: 8790,
  profile: "balanced",
  beacon: "off",
  telemetry: "on",
  command: "headroom",
  healthTimeoutMs: 20_000,
} as const;

export const DEFAULT_RATE_LIMIT = { rpm: 600, tpm: 10_000_000 } as const;
export const DEFAULT_UPSTREAM_ARG = "hyper";
export const MIN_VERSION = [0, 38, 0] as const;

const endsWithV1 = (upstream: string): boolean => /\/v1\/?$/.test(upstream);

// headroom 0.39.0 concatenates x-headroom-base-url with "/v1/chat/completions", so a
// direct header only works when the upstream's real chat path ends in "/v1".
export function stripTrailingV1(upstream: string): string {
  return upstream.replace(/\/v1\/?$/, "");
}

// ---------------------------------------------------------------- config layer

export function loadConfig(): HeadroomConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_URL, "utf-8")) as HeadroomConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = err instanceof Error ? err.message : String(err);
    if (code !== "ENOENT") {
      console.warn(`[headroom] ignoring broken headroom.json (${reason}); using built-in defaults`);
    }
    return {};
  }
}

// Provider inventory straight from pi's own models.json (single source of truth, no copies).
// Tolerant: missing or broken manifest -> no providers -> extension wires nothing.
export function readManifestProviders(): Record<string, { baseUrl: string; api?: string }> {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_URL, "utf-8")) as {
      providers?: Record<string, { baseUrl?: string; api?: string }>;
    };
    const out: Record<string, { baseUrl: string; api?: string }> = {};
    for (const [id, entry] of Object.entries(parsed.providers ?? {})) {
      if (entry && typeof entry.baseUrl === "string" && entry.baseUrl.length > 0) {
        out[id] = { baseUrl: entry.baseUrl, api: entry.api };
      }
    }
    return out;
  } catch (err) {
    // Silent is the worst outcome here: zero providers wired looks like a working extension.
    console.warn(
      `[headroom] cannot read the provider manifest at ${MANIFEST_URL} ` +
        `(${(err as Error).message}) — wiring ZERO providers. This path assumes the folder sits ` +
        `at <agent-dir>/extensions/headroom/.`,
    );
    return {};
  }
}

// Merge order: models.json (upstream truth) < headroom.json (flags + overrides).
// Only openai-completions providers are wireable (Headroom speaks the OpenAI path shape).
export function resolveProviders(config: HeadroomConfig): {
  enabled: ResolvedProvider[];
  skipped: string[];
} {
  const manifest = readManifestProviders();
  const enabled: ResolvedProvider[] = [];
  const skipped: string[] = [];
  const entries = config.providers ?? {};
  for (const id of Object.keys(manifest)) {
    const info = manifest[id]!;
    if (info.api && info.api !== "openai-completions") continue;
    const entry = entries[id] ?? {};
    const isEnabled = entry.enabled ?? !(id in DEFAULT_DISABLED);
    if (!isEnabled) {
      skipped.push(id);
      continue;
    }
    const upstream = entry.baseUrl ?? info.baseUrl;
    const viaShim = entry.shim ?? !endsWithV1(upstream);
    enabled.push({ id, upstream, viaShim });
  }
  return { enabled, skipped };
}

export function auditProxyEnv(): string | null {
  const proxy =
    process.env.HTTP_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.https_proxy;
  if (!proxy) return null;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").toLowerCase();
  const coversLoopback =
    noProxy.includes("*") || (noProxy.includes("127.0.0.1") && noProxy.includes("localhost"));
  if (coversLoopback) return null;
  return (
    `HTTP_PROXY/HTTPS_PROXY is set (${proxy}) but NO_PROXY does not cover 127.0.0.1,localhost. ` +
    "pi's undici dispatcher has no loopback bypass and would tunnel Headroom traffic through " +
    "the ambient proxy. Add 127.0.0.1,localhost to NO_PROXY."
  );
}

// ---------------------------------------------------------------- process manager

export function createState(): HeadroomState {
  return { child: null, adopted: false, registered: [], version: null, shim: null, shimPort: null, lastSpawnError: null };
}

export function proxyPort(config: HeadroomConfig): number {
  const port = config.port ?? DEFAULT_CONFIG.port;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.port;
}

export function shimPort(config: HeadroomConfig): number {
  const port = config.shimPort ?? DEFAULT_CONFIG.shimPort;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.shimPort;
}

export function proxyOrigin(config: HeadroomConfig): string {
  return `http://${PROXY_HOST}:${proxyPort(config)}`;
}

// Candidate ports: the configured shimPort first, then the next five — several pi
// sessions on one machine each get their own shim without colliding.
export function shimPortCandidates(config: HeadroomConfig): number[] {
  const base = shimPort(config);
  return [base, base + 1, base + 2, base + 3, base + 4, base + 5].filter((p) => p > 0 && p < 65536);
}

// Headroom's SSRF guard rejects loopback x-headroom-base-url targets, so shim-routed
// providers need the shim ports in HEADROOM_ALLOWED_BASE_URLS. The allow-list is baked
// into the spawned proxy's env before we know which port binds, so it covers every
// candidate. Union with the user's extraEnv value; explicit entries always survive.
// Authority (host, or host:port) of an upstream URL. Headroom matches the
// x-headroom-base-url target on this form, so the URL path is dropped.
function upstreamAuthority(upstream: string): string | null {
  try {
    const u = new URL(upstream);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

// headroom's token-bucket limiter defaults to 60 requests + 100,000 tokens per MINUTE,
// keyed per inbound API key, and it answers 429 itself without ever contacting the
// provider. A single pi turn legitimately carries 80K-120K tokens (measured 2026-09-27:
// PERF tok_before=87240/90396, inbound bodies up to 494KB; /stats reports
// rate_limited_by_source{source="headroom"}=167 vs {source="upstream"}=0), so ONE request
// can exceed the whole per-minute budget. pi's router then reads that local 429 as
// "provider rate-limited", walks every provider in the tier (hyper, ollama-cloud,
// zai-paas and zai-paasv2 were all rejected inside the same 150ms window), and dies with
// "429 status code (no body)". Raise the ceiling so headroom stops being the limit source
// and leave real limiting to the providers. Opt back down with rateLimit:false (headroom's
// own defaults) or an explicit { rpm, tpm }; extraEnv can still override either.
export function rateLimitEnv(config: HeadroomConfig): Record<string, string> {
  const rl = config.rateLimit;
  if (rl === false) return {};
  const rpm = rl?.rpm ?? DEFAULT_RATE_LIMIT.rpm;
  const tpm = rl?.tpm ?? DEFAULT_RATE_LIMIT.tpm;
  const env: Record<string, string> = {};
  if (Number.isInteger(rpm) && rpm > 0) env.HEADROOM_RPM = String(rpm);
  if (Number.isInteger(tpm) && tpm > 0) env.HEADROOM_TPM = String(tpm);
  return env;
}

// models.json model entries carry contextWindow; headroom defaults unknown models to
// 128,000 tokens, which is below real windows (glm-5.3-flash: 1,000,000) and above others,
// so its compression math runs against a wrong ceiling either way. Feed every manifest
// model in so the proxy sees the true window. Same id on two providers with different
// windows: take the minimum - headroom matches by id only and cannot tell providers
// apart, so the smallest window is the only safe ceiling. modelLimits:false restores
// headroom's defaults; explicit entries override the manifest.
export function readManifestModelLimits(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_URL, "utf-8")) as {
      providers?: Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>;
    };
    const out: Record<string, number> = {};
    for (const provider of Object.values(parsed.providers ?? {})) {
      for (const model of provider.models ?? []) {
        if (
          model &&
          typeof model.id === "string" &&
          model.id.length > 0 &&
          typeof model.contextWindow === "number" &&
          model.contextWindow > 0
        ) {
          const prev = out[model.id];
          out[model.id] = prev === undefined ? model.contextWindow : Math.min(prev, model.contextWindow);
        }
      }
    }
    return out;
  } catch (err) {
    console.warn(
      `[headroom] cannot read model limits from ${MANIFEST_URL} (${(err as Error).message}); ` +
        "headroom falls back to its 128,000-token default per unknown model",
    );
    return {};
  }
}

export function modelLimitsEnv(config: HeadroomConfig): Record<string, string> {
  if (config.modelLimits === false) return {};
  const limits = { ...readManifestModelLimits(), ...(config.modelLimits ?? {}) };
  if (Object.keys(limits).length === 0) return {};
  return { HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: limits }) };
}

// A CA-bundle path that does not exist is not inert: headroom's Python clients raise
// "Could not find a suitable TLS CA certificate bundle, invalid path ..." on EVERY
// upstream call, so a bundle path copied onto a machine that never exported one kills
// all proxied traffic there. Drop dead paths, and auto-use the README step 3 location
// (~/.headroom/win-ca-bundle.pem) when it exists, so a bare drop-in of this folder
// works with no config edits on both intercepted and plain machines.
const CA_KEYS = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"] as const;
const DEFAULT_CA_BUNDLE = `${homedir().replace(/\\/g, "/")}/.headroom/win-ca-bundle.pem`;

export function sanitizedExtraEnv(config: HeadroomConfig): Record<string, string> {
  const extra = { ...(config.extraEnv ?? {}) };
  for (const key of CA_KEYS) {
    const value = extra[key];
    if (value && !existsSync(value)) {
      console.warn(`[headroom] extraEnv.${key} points at a missing file (${value}); dropped so the proxy still works here`);
      delete extra[key];
    }
  }
  return extra;
}

export function caBundleEnv(extra: Record<string, string>): Record<string, string> {
  if (extra.SSL_CERT_FILE || !existsSync(DEFAULT_CA_BUNDLE)) return {};
  return { SSL_CERT_FILE: DEFAULT_CA_BUNDLE, REQUESTS_CA_BUNDLE: DEFAULT_CA_BUNDLE, CURL_CA_BUNDLE: DEFAULT_CA_BUNDLE };
}

function proxyEnv(config: HeadroomConfig, shimNeeded: boolean): Record<string, string> {
  const extra = sanitizedExtraEnv(config);
  const env: Record<string, string> = {
    ...rateLimitEnv(config),
    ...modelLimitsEnv(config),
    HEADROOM_SAVINGS_PROFILE: config.profile ?? DEFAULT_CONFIG.profile,
    HEADROOM_BEACON: config.beacon ?? DEFAULT_CONFIG.beacon,
    HEADROOM_TELEMETRY: config.telemetry ?? DEFAULT_CONFIG.telemetry,
    ...extra,
    ...caBundleEnv(extra),
  };
  if (shimNeeded) {
    // Setting HEADROOM_ALLOWED_BASE_URLS replaces Headroom's default allow-public policy with an
    // explicit allow-list. A base-url that is not listed is NOT rejected loudly: the proxy falls
    // back to its own --openai-api-url, so provider A's traffic leaves with provider B's key.
    // Listing only the shim ports broke every direct provider that way (2026-09-27: hyper's key
    // reached api.z.ai -> 401 "token expired or incorrect", and all traffic piled onto one
    // upstream -> repeated 429). Allow the shim ports AND every wired upstream.
    const ours = [
      ...shimPortCandidates(config).map((p) => `${PROXY_HOST}:${p}`),
      ...resolveProviders(config).enabled.map((p) => upstreamAuthority(p.upstream)).filter((a): a is string => a !== null),
    ];
    const theirs = env.HEADROOM_ALLOWED_BASE_URLS;
    env.HEADROOM_ALLOWED_BASE_URLS = theirs ? `${theirs},${ours.join(",")}` : ours.join(",");
  }
  return env;
}

function defaultUpstreamUrl(config: HeadroomConfig): string {
  const { enabled } = resolveProviders(config);
  return enabled[0]?.upstream ?? `https://${PROXY_HOST}/v1`;
}

export async function headroomVersion(config: HeadroomConfig): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(config.command ?? DEFAULT_CONFIG.command, ["--version"], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const match = out.match(/(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : out.trim() || null);
    });
  });
}

export function versionAtLeast(version: string | null, min: readonly [number, number, number]): boolean | null {
  if (!version) return null;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > min[i]) return true;
    if (parts[i]! < min[i]) return false;
  }
  return true;
}

export function fetchHealth(
  origin: string,
  timeoutMs: number,
  path = "/health",
): Promise<{ healthy: boolean; body: string | null }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      `${origin}${path}`,
      { timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ healthy: res.statusCode === 200, body: body || null }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ healthy: false, body: null });
    });
    req.on("error", () => resolve({ healthy: false, body: null }));
    req.end();
  });
}

export async function waitForHealthy(origin: string, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { healthy } = await fetchHealth(origin, Math.min(2000, intervalMs * 4));
    if (healthy) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function isAlive(state: HeadroomState): boolean {
  return state.child !== null && state.child.exitCode === null && !state.child.killed;
}

export function spawnProxy(
  config: HeadroomConfig,
  state: HeadroomState,
  defaultUpstream: string,
  onError?: (err: Error) => void,
): ChildProcess {
  const args = ["proxy", "--port", String(proxyPort(config)), "--openai-api-url", defaultUpstream];
  const child = spawn(config.command ?? DEFAULT_CONFIG.command, args, {
    shell: process.platform === "win32",
    env: { ...process.env, ...proxyEnv(config, needsShim(config)) },
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (err) => {
    if (onError) onError(err);
  });
  child.on("close", () => {
    if (state.child === child) state.child = null;
  });
  state.child = child;
  return child;
}

// Resolve the PID of the process listening on the proxy port — the port owner, whether
// pi spawned it or not. Runs only on explicit /headroom stop / restart, never on
// session_start (the hot path's only sensing primitive stays fetchHealth).
// Outcomes are distinct on purpose: null means "no listener on the port" (an observable,
// healthy state); "lookup-failed" means the lookup tool itself could not run. The two
// must never conflate, or stop would report "not running" over a live proxy.
// Modeled on headroomVersion's spawn-probe shape (spawn, capture stdout, resolve on
// failure). No shell:true — both probes are real executables on PATH, and a direct spawn
// keeps a cmd.exe wrapper out of the picture.
export async function findPortOwnerPid(
  config: HeadroomConfig,
): Promise<number | null | "lookup-failed"> {
  const port = proxyPort(config);
  const win32 = process.platform === "win32";
  return new Promise((resolve) => {
    const child = win32
      ? spawn(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
              "Select-Object -First 1 -ExpandProperty OwningProcess",
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        )
      : spawn("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve("lookup-failed"));
    child.on("close", (code) => {
      const pid = Number.parseInt(out.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return resolve(pid);
      // Windows: -ErrorAction SilentlyContinue makes a no-match exit 0 with empty stdout.
      // POSIX: lsof exits 1 when nothing is found. Both mean "no listener", not failure.
      if (code === 0 || (!win32 && code === 1)) return resolve(null);
      resolve("lookup-failed");
    });
  });
}

// Awaited, outcome-checked kill — the first in this file (the old stopProxy discarded the
// taskkill handle, so "stopped" stated intent, not outcome). Exit-code mapping:
// taskkill 0 -> killed, 128 (PID already gone) -> not-running, anything else -> kill-failed;
// POSIX ESRCH -> not-running, EPERM/anything else -> kill-failed. /T kills the whole tree,
// which is load-bearing on win32: shell:true makes the spawned pid a cmd.exe wrapper with
// the real proxy as a grandchild.
async function killProcess(pid: number): Promise<"killed" | "not-running" | "kill-failed"> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => resolve("kill-failed"));
      child.on("close", (code) => {
        if (code === 0) return resolve("killed");
        if (code === 128) return resolve("not-running");
        resolve("kill-failed");
      });
    });
  }
  try {
    process.kill(pid, "SIGTERM");
    return "killed";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "not-running" : "kill-failed";
  }
}

// The single kill authority. Own live child -> tree-kill via the child handle. Otherwise ->
// port-owner lookup + PID-scoped kill, which covers adopted, foreign, and manually-started
// instances. state.adopted is a status-rendering concern, not kill-routing: a stale
// adopted flag over a dead proxy resolves through the lookup's "no listener" outcome, and
// every external kill resets adopted here because no close event fires (there is no child
// handle to observe it).
export async function stopProxy(
  config: HeadroomConfig,
  state: HeadroomState,
): Promise<"stopped" | "stopped-external" | "not-running" | "lookup-failed" | "kill-failed"> {
  if (isAlive(state)) {
    const child = state.child!;
    if (!child.pid) return "kill-failed"; // cannot identify what to kill
    const result = await killProcess(child.pid);
    if (result === "killed") state.adopted = false;
    return result === "killed" ? "stopped" : result;
  }
  const pid = await findPortOwnerPid(config);
  if (pid === "lookup-failed") return "lookup-failed";
  if (pid === null) {
    state.adopted = false; // no listener: the proxy is already down (covers stale adopted)
    return "not-running";
  }
  const result = await killProcess(pid);
  if (result !== "kill-failed") state.adopted = false; // killed, or the PID was already gone
  return result === "killed" ? "stopped-external" : result;
}

// Poll until the port stops answering. Requires N consecutive failed probes before
// declaring the port free: a taskkill'd external process can keep answering /health
// while it dies, and a single early-exit probe plus ensureProxyRunning's 1500ms adopt
// probe (index.ts:470) would re-adopt the corpse (state.adopted = true over a dying
// process). Two failures is ~2.2s of observed silence at the 200ms poll / 1s probe
// timeout; the 5s deadline is unchanged. Timeout still returns void as before — the
// caller's next ensureProxyRunning probe is the real arbiter.
async function waitForPortFree(origin: string, timeoutMs = 5000, needed = 2): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  while (Date.now() < deadline) {
    const { healthy } = await fetchHealth(origin, 1000);
    if (!healthy) {
      failures++;
      if (failures >= needed) return;
    } else {
      failures = 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function ensureProxyRunning(
  config: HeadroomConfig,
  state: HeadroomState,
  onError?: (err: Error) => void,
): Promise<"adopted" | "spawned" | "unavailable"> {
  if (isAlive(state)) return "spawned";
  state.lastSpawnError = null;
  const origin = proxyOrigin(config);
  const first = await fetchHealth(origin, 1500);
  if (first.healthy) {
    state.adopted = true;
    state.version = await headroomVersion(config);
    return "adopted";
  }
  state.adopted = false;
  state.version = await headroomVersion(config);
  if (state.version === null) {
    // The CLI is absent or cannot run, so spawning the proxy cannot work either. Fail
    // now instead of burning healthTimeoutMs waiting on a port nothing will ever own.
    // shell:true on Windows means a missing command exits non-zero rather than raising
    // ENOENT, so the version probe is the only reliable signal on every platform.
    state.lastSpawnError = "cli-missing";
    return "unavailable";
  }
  spawnProxy(config, state, defaultUpstreamUrl(config), onError);
  const ok = await waitForHealthy(origin, config.healthTimeoutMs ?? DEFAULT_CONFIG.healthTimeoutMs);
  if (!ok) state.lastSpawnError = "unhealthy";
  return ok ? "spawned" : "unavailable";
}

export async function restartProxy(
  config: HeadroomConfig,
  state: HeadroomState,
  onError?: (err: Error) => void,
): Promise<"adopted" | "spawned" | "unavailable"> {
  // FR5: restart kills ANY running instance now — the old skip-wait guard that treated
  // an adopted proxy as untouchable made restart a no-op round-trip. Always wait for the
  // port to free afterwards: a "not-running" from the own-child branch means the wrapper PID is
  // gone (taskkill exit 128 / ESRCH), NOT that the port-owning grandchild released the
  // socket, so the probe gate (N=2 consecutive failures) is the only trusted evidence
  // the port is free. The ~0.2s cost when nothing was running (probes fail fast with
  // ECONNREFUSED) is acceptable on a manual command.
  // A failed kill or failed lookup aborts the restart: proceeding would re-adopt the
  // surviving instance and report success over an un-killed proxy — exactly the outcome
  // the kill-failed union member exists to surface. The command branch renders
  // "unavailable" as an error notify.
  const stopped = await stopProxy(config, state);
  if (stopped === "kill-failed" || stopped === "lookup-failed") return "unavailable";
  await waitForPortFree(proxyOrigin(config));
  return ensureProxyRunning(config, state, onError);
}

// ---------------------------------------------------------------- path-rewrite shim

export function needsShim(config: HeadroomConfig): boolean {
  return resolveProviders(config).enabled.some((p) => p.viaShim);
}

function isShimAlive(state: HeadroomState): boolean {
  return state.shim !== null && state.shim.listening;
}

// CA bundle for outbound TLS (corporate-intercepted machines): reuse the bundle already
// provisioned for the Headroom proxy via extraEnv.SSL_CERT_FILE. Missing file -> Node's
// default store.
function shimCaBundle(config: HeadroomConfig): string[] | undefined {
  const file = config.extraEnv?.SSL_CERT_FILE ?? process.env.SSL_CERT_FILE;
  if (!file) return undefined;
  try {
    return [readFileSync(file, "utf-8")];
  } catch {
    return undefined;
  }
}

export function createShimHandler(
  providers: Record<string, string>,
  config: HeadroomConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${PROXY_HOST}`);
    const [id, ...restSegments] = url.pathname.replace(/^\//, "").split("/");
    const upstream = id ? providers[id] : undefined;
    if (!upstream) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `headroom-shim: no upstream mapped for '${id ?? ""}'` } }));
      return;
    }
    // Headroom appended "/v1/<path>"; the native upstream expects its own path instead.
    const rest = restSegments.join("/").replace(/^v1\/?/, "");
    let target: URL;
    try {
      target = new URL(`${upstream.replace(/\/$/, "")}/${rest}${url.search}`);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "headroom-shim: bad upstream URL" } }));
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("x-headroom-")) delete headers[key];
    }
    const send = (isHttps: boolean) =>
      isHttps
        ? httpsRequest(target, { method: req.method, headers, ca: shimCaBundle(config) })
        : httpRequest(target, { method: req.method, headers });
    const outReq = send(target.protocol === "https:");
    outReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: `headroom-shim: upstream error: ${err.message}` } }));
    });
    // Abort propagation: if the client disconnects before the response finishes, kill the
    // upstream request. (req "close" fires as soon as the body is consumed — watching the
    // response socket is the reliable signal.)
    res.on("close", () => {
      if (!res.writableEnded) outReq.destroy();
    });
    outReq.on("response", (upRes) => {
      const outHeaders = { ...upRes.headers };
      delete outHeaders.connection;
      delete outHeaders["keep-alive"];
      delete outHeaders["transfer-encoding"];
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    });
    req.pipe(outReq);
  };
}

export function startShim(
  config: HeadroomConfig,
  state: HeadroomState,
  port = shimPort(config),
): Server {
  const providers: Record<string, string> = {};
  for (const p of resolveProviders(config).enabled) providers[p.id] = p.upstream;
  const server = createServer(createShimHandler(providers, config));
  state.shim = server;
  state.shimPort = port;
  return server;
}

export function stopShim(state: HeadroomState): void {
  if (state.shim) {
    const server = state.shim;
    state.shim = null;
    state.shimPort = null;
    try {
      server.closeAllConnections(); // drop keep-alive sockets so the port frees immediately
      server.close(() => {});
    } catch {
      // already closed
    }
  }
}

export async function ensureShimRunning(
  config: HeadroomConfig,
  state: HeadroomState,
): Promise<"running" | "started" | "failed"> {
  if (isShimAlive(state)) return "running";
  const base = shimPort(config);
  let lastErr = "unknown";
  // Walk the candidate ports; each gets two listen attempts (pi can fire shutdown ->
  // session_start back-to-back and the previous listener's port may be mid-release).
  for (const port of shimPortCandidates(config)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const server = startShim(config, state, port);
      const bound = await new Promise<boolean>((resolve) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          lastErr = err.code ?? err.message;
          stopShim(state);
          resolve(false);
        };
        server.once("error", onErr);
        server.listen(port, PROXY_HOST, () => {
          server.removeListener("error", onErr);
          resolve(true);
        });
      });
      if (bound) return "started";
    }
  }
  console.warn(`[headroom] path shim unavailable on 127.0.0.1:${base}-${base + 5} (${lastErr}); shim-routed providers stay DIRECT this session`);
  return "failed";
}

// ---------------------------------------------------------------- session wiring

// Wire every enabled provider through the proxy (apiKey omitted on purpose: the real
// credential keeps flowing from the models manifest). Direct providers carry the stripped
// upstream; non-/v1 providers carry the shim URL and need the shim listening.
export function registerOverrides(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  state: HeadroomState,
  shimOk = true,
): string[] {
  const { enabled } = resolveProviders(config);
  const proxyBase = `${proxyOrigin(config)}/v1`;
  const wired: string[] = [];
  for (const { id, upstream, viaShim } of enabled) {
    if (viaShim && !shimOk) continue;
    const header = viaShim
      ? `http://${PROXY_HOST}:${state.shimPort ?? shimPort(config)}/${id}`
      : stripTrailingV1(upstream);
    pi.registerProvider(id, {
      baseUrl: proxyBase,
      headers: { "x-headroom-base-url": header },
    });
    wired.push(id);
  }
  state.registered = wired;
  return state.registered;
}

export async function onSessionStart(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  state: HeadroomState,
  ctx?: ExtensionContext,
): Promise<void> {
  const warn = (msg: string) => {
    if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
    else console.warn(msg);
  };
  const envWarning = auditProxyEnv();
  if (envWarning) warn("[headroom] " + envWarning);

  const result = await ensureProxyRunning(config, state, (err) =>
    warn(`[headroom] proxy spawn error: ${err.message}`),
  );
  if (result === "unavailable") {
    for (const id of state.registered) {
      try {
        pi.unregisterProvider(id);
      } catch {
        // not registered in this runtime — nothing to undo
      }
    }
    state.registered = [];
    if (state.lastSpawnError === "cli-missing") {
      state.lastSpawnError = null;
      warn(
        "[headroom] the headroom CLI is missing or cannot run - providers left DIRECT. " +
          'Install it with: uv tool install "headroom-ai[proxy]" (or pip install the same), ' +
          "then start pi from a NEW terminal: PATH changes never reach an already-open shell.",
      );
      return;
    }
    warn(
      `[headroom] proxy unavailable after ${config.healthTimeoutMs ?? DEFAULT_CONFIG.healthTimeoutMs} ms — ` +
        'stale overrides removed, providers left DIRECT. Install with: uv tool install "headroom-ai[proxy]", ' +
        "or check the port in headroom.json.",
    );
    return;
  }

  const { enabled, skipped } = resolveProviders(config);
  const shimIds = enabled.filter((p) => p.viaShim).map((p) => p.id);
  const shimOk = shimIds.length === 0 || (await ensureShimRunning(config, state)) !== "failed";
  registerOverrides(pi, config, state, shimOk);
  if (!shimOk) {
    for (const id of shimIds) {
      try {
        pi.unregisterProvider(id); // drop a previous round's shim-header override — never route into a dead shim
      } catch {
        // not registered in this runtime — nothing to undo
      }
    }
    warn(`[headroom] NOT wired via shim (shim failed to start): ${shimIds.join(", ")} — these stay direct this session`);
  }

  const version = state.version ?? "unknown";
  if (versionAtLeast(version, MIN_VERSION) === false) {
    warn(
      `[headroom] headroom-ai ${version} < ${MIN_VERSION.join(".")}: this build may ignore ` +
        "x-headroom-base-url on the chat-completions path (traffic would all land on the default " +
        "upstream). Upgrade headroom-ai and restart the session.",
    );
  }
  const mode = result === "adopted" ? "adopted external proxy" : "proxy spawned";
  const shimNote = shimIds.length > 0 && shimOk ? `, ${shimIds.length} via path shim` : "";
  const msg = `[headroom] ${mode} on 127.0.0.1:${proxyPort(config)} (v${version}); ${state.registered.length} providers wired${shimNote}`;
  if (ctx?.hasUI) ctx.ui.notify(msg, "info");
  else console.log(msg);
  if (skipped.length > 0) {
    console.log(`[headroom] not wired (disabled in config): ${skipped.join(", ")}`);
  }
}

// FR3: the proxy is a machine-level singleton — session_shutdown fires on /new, /resume,
// AND process exit (prior FRD evidence: dist/core/agent-session.js:2606, CHANGELOG.md:2089),
// so killing here churned the proxy on every session change. Only /headroom stop ends it
// now. The shim stays per-session by design (its port ladder and closeAllConnections
// teardown are what make back-to-back /new rebinds work), and adopted/version bookkeeping
// self-heals on the next session_start re-probe.
export function onSessionShutdown(state: HeadroomState): void {
  stopShim(state);
  state.child = null;
  state.registered = [];
}

// ---------------------------------------------------------------- commands + factory

async function handleHeadroomCommand(
  args: string,
  ctx: ExtensionCommandContext,
  config: HeadroomConfig,
  state: HeadroomState,
): Promise<void> {
  const notify = (msg: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, level);
  const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "status";

  if (sub === "status") {
    const lines: string[] = [];
    if (state.adopted) {
      lines.push(`proxy: external instance on 127.0.0.1:${proxyPort(config)} (not spawned by pi; /headroom stop WILL kill it via the port-owner PID)`);
    } else if (isAlive(state)) {
      lines.push(`proxy: running (pid ${state.child?.pid}, port ${proxyPort(config)})`);
    } else {
      lines.push("proxy: DOWN — wired providers will error until /headroom restart");
    }
    if (state.version) {
      const gate = versionAtLeast(state.version, MIN_VERSION);
      lines.push(`version: ${state.version}${gate === false ? ` (below ${MIN_VERSION.join(".")}: chat-completions header support uncertain)` : ""}`);
    } else {
      lines.push("version: unknown");
    }
    const { enabled } = resolveProviders(config);
    const shimIds = enabled.filter((p) => p.viaShim).map((p) => p.id);
    if (shimIds.length > 0) {
      if (isShimAlive(state)) {
        lines.push(`shim: 127.0.0.1:${state.shimPort ?? shimPort(config)} (rewrites /v1/* to native paths) — ${shimIds.join(", ")}`);
      } else {
        lines.push(`shim: DOWN — ${shimIds.join(", ")} cannot route; /headroom restart or fix port ${shimPort(config)}`);
      }
    }
    lines.push(`wired (${state.registered.length}): ${state.registered.length > 0 ? state.registered.join(", ") : "none"}`);
    const { skipped } = resolveProviders(config);
    if (skipped.length > 0) lines.push(`not wired (disabled): ${skipped.join(", ")}`);
    const want = rateLimitEnv(config);
    const ml = modelLimitsEnv(config);
    if (ml.HEADROOM_MODEL_LIMITS) {
      try {
        const n = Object.keys(JSON.parse(ml.HEADROOM_MODEL_LIMITS).context_limits as Record<string, number>).length;
        lines.push(`model limits: ${n} models from models.json (headroom default is 128,000)`);
      } catch {
        // unreachable: modelLimitsEnv only emits valid JSON
      }
    }
    const stats = await fetchHealth(proxyOrigin(config), 2000, "/stats");
    if (stats.healthy && stats.body) {
      try {
        const rl = (JSON.parse(stats.body) as {
          rate_limiter?: { requests_per_minute?: number; tokens_per_minute?: number };
        }).rate_limiter;
        const tpm = rl?.tokens_per_minute;
        if (typeof tpm === "number") {
          lines.push(`rate limit: ${rl?.requests_per_minute} rpm / ${tpm} tpm (below these headroom 429s on its own)`);
          const wantTpm = want.HEADROOM_TPM ? Number(want.HEADROOM_TPM) : null;
          if (wantTpm && tpm < wantTpm) {
            lines.push(
              `WARNING: live proxy tpm=${tpm} < configured ${wantTpm}, so this proxy predates the config. ` +
                "Fix: /headroom restart — it now kills any running instance (including adopted ones) " +
                "and respawns with the current config (headroom.json is read once at load, so edit it first).",
            );
          }
        }
      } catch {
        // /stats not JSON -> skip the rate-limit line
      }
    }
    const { healthy, body } = await fetchHealth(proxyOrigin(config), 2000);
    if (healthy && body) {
      try {
        const stats = JSON.parse(body) as { stats?: { total_requests?: number; tokens_saved?: number } };
        if (stats.stats) {
          lines.push(`stats: ${stats.stats.total_requests ?? 0} requests, ${stats.stats.tokens_saved ?? 0} tokens saved`);
        }
      } catch {
        // body not JSON — skip the stats line
      }
    }
    notify(lines.join("\n"));
    return;
  }

  if (sub === "stop") {
    const result = await stopProxy(config, state);
    if (result === "stopped")
      notify("proxy stopped (pi-spawned instance); providers still wired — turns will error until /headroom restart");
    else if (result === "stopped-external")
      notify("proxy stopped (external instance killed via port-owner PID); providers still wired — turns will error until /headroom restart");
    else if (result === "not-running") notify("proxy not running", "warning");
    else if (result === "lookup-failed")
      notify(`proxy not stopped — the port-owner lookup failed on port ${proxyPort(config)} (is Get-NetTCPConnection/lsof available?)`, "error");
    else notify("proxy kill failed — the process may still be running; /headroom status to confirm", "error");
    return;
  }

  if (sub === "restart") {
    notify("restarting proxy...");
    const result = await restartProxy(config, state);
    if (result === "unavailable") {
      notify("proxy failed to come back healthy — /headroom status for detail", "error");
      return;
    }
    notify(`proxy ${result === "adopted" ? "re-adopted external instance" : "restarted"} on 127.0.0.1:${proxyPort(config)}; ${state.registered.length} providers wired`);
    return;
  }

  notify("Usage: /headroom status | stop | restart", "error");
}

// Factory: config read at top, registrations only — ZERO side effects (proxy and shim
// both start in the session_start hook, never here).
//
// pi re-runs the factory on session reload (agent-session.js reload() -> new extension
// runner). The process-wide singleton keeps the shim/proxy handles across reloads, so a
// reload round either finds the shim still listening or owns the rebinding — the old
// server can never be orphaned holding the port.
export default function headroomExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const g = globalThis as typeof globalThis & { __headroomState?: HeadroomState };
  const state = (g.__headroomState ??= createState());

  pi.registerCommand("headroom", {
    description: "Headroom proxy: /headroom status|stop|restart",
    handler: (args: string, ctx: ExtensionCommandContext) => handleHeadroomCommand(args, ctx, config, state),
  });

  // CCR redemption: the proxy compresses tool output and leaves a marker
  // (`<<ccr:HASH ...>>` or `Retrieve more: hash=HASH`). On pi's streaming chat
  // path the proxy deliberately does NOT inject its own headroom_retrieve tool
  // (headroom/proxy/handlers/openai.py: _should_inject_openai_chat_ccr_tool
  // returns `ccr_inject_tool and not stream`), so the model would hold markers
  // it cannot redeem. This tool closes that loop against the proxy's loopback
  // GET /v1/retrieve/{hash} endpoint.
  pi.registerTool({
    name: "headroom_retrieve",
    label: "Headroom Retrieve",
    description:
      "Retrieve the original, uncompressed content behind a Headroom CCR marker. " +
      "When Headroom compresses tool output it leaves a marker such as " +
      "`<<ccr:HASH N_items_offloaded>>` or `Retrieve more: hash=HASH`. " +
      "Call this with that hash to get the full original text back. " +
      "This is Headroom, not the accordion extension: accordion folds look like " +
      "`{#3f9a2c FOLDED}` and use the recall/unfold tools. Never pass a `<<ccr:...>>` " +
      "hash to recall or unfold — they cannot resolve it.",
    promptSnippet: "Retrieve original content behind a <<ccr:HASH>> compression marker",
    promptGuidelines: [
      "Two different compression markers can appear in tool output. `<<ccr:HASH ...>>` or " +
        "`[N items compressed to M. Retrieve more: hash=HASH]` is Headroom CCR: use headroom_retrieve.",
      "`{#3f9a2c FOLDED}` is an accordion fold: use recall or unfold. Never send a `<<ccr:...>>` hash " +
        "to recall or unfold, and never send a `{#... FOLDED}` code to headroom_retrieve.",
      "When you need the full text behind a `<<ccr:...>>` marker, call headroom_retrieve with the hash. " +
        "Do not assume the content is lost and do not re-run the original command.",
    ],
    parameters: Type.Object({
      hash: Type.String({
        description: "The hash from the marker (the `ccr:` prefix and surrounding text are ignored).",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const match = /[a-f0-9]{12,24}/i.exec(params.hash ?? "");
      if (!match) {
        return { content: [{ type: "text", text: `No hash found in "${params.hash}".` }] };
      }
      const hash = match[0];
      const origin = `http://${PROXY_HOST}:${config.port ?? DEFAULT_CONFIG.port}`;
      const { healthy, body } = await fetchHealth(origin, 5000, `/v1/retrieve/${hash}`);
      if (!healthy) {
        let detail = "";
        if (body) {
          try {
            detail = (JSON.parse(body) as { detail?: string }).detail ?? body;
          } catch {
            detail = body;
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `Headroom retrieve failed for ${hash}${detail ? `: ${detail}` : ": the proxy is not reachable."}`,
            },
          ],
        };
      }
      let parsed: { original_content?: unknown };
      try {
        parsed = JSON.parse(body) as { original_content?: unknown };
      } catch {
        return { content: [{ type: "text", text: body }] };
      }
      const original = parsed.original_content;
      const text = typeof original === "string" ? original : JSON.stringify(original ?? parsed, null, 2);
      return { content: [{ type: "text", text }] };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await onSessionStart(pi, config, state, ctx);
  });

  pi.on("session_shutdown", async () => {
    onSessionShutdown(state);
  });
}
