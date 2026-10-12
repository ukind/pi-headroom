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
import { join } from "node:path";
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
  // F028: set HEADROOM_NO_CCR=1 on the spawned proxy - the escape hatch
  // headroom_retrieve's byte-differentiation guard already names, for the day some
  // layer starts trimming trailing whitespace. Off by default: the trailing newline
  // is the working fix (F-V07). Reaches only pi-spawned proxies (adopted ones never
  // see proxyEnv).
  noCcr?: boolean;
  // F011: headroom.json's own prose comments. Declared explicitly so dropping the
  // index signature below does not make the file's own keys unknown.
  _comment?: string[];
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
export const MIN_VERSION = [0, 38, 0] as const;

const endsWithV1 = (upstream: string): boolean => /\/v1\/?$/.test(upstream);

// headroom 0.39.0 concatenates x-headroom-base-url with "/v1/chat/completions", so a
// direct header only works when the upstream's real chat path ends in "/v1".
export function stripTrailingV1(upstream: string): string {
  return upstream.replace(/\/v1\/?$/, "");
}

// F037: every diagnostic used to go to console or a transient ui.notify, so after a bad
// session start the reason was gone once the notification cleared. This bounded ring
// keeps the last N messages in memory for /headroom status to print. Module-level on
// purpose: the factory re-runs on every pi reload but the module evaluates once per
// process, so the ring survives reloads exactly like the process-wide singleton state
// does. It is deliberately NOT a HeadroomState field — the locked unit suite pins
// createState()'s exact shape (test/index.test.ts, "createState: fresh state is empty").
const DIAGNOSTIC_RING_LIMIT = 20;
const diagnosticRing: string[] = [];

function recordDiagnostic(msg: string): void {
  diagnosticRing.push(msg);
  if (diagnosticRing.length > DIAGNOSTIC_RING_LIMIT) diagnosticRing.shift();
}

// ---------------------------------------------------------------- config layer

// F011: the known top-level keys of headroom.json. With HeadroomConfig's index
// signature gone, a typo is a compile error at every internal use site - but
// headroom.json is user data parsed at runtime, so loadConfig also warns on unknown
// keys instead of silently falling back to the default (the "healthTimoutMs" case:
// accepted, ignored, no message).
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "port",
  "shimPort",
  "profile",
  "beacon",
  "telemetry",
  "command",
  "healthTimeoutMs",
  "extraEnv",
  "rateLimit",
  "modelLimits",
  "providers",
  "noCcr",
  "_comment",
]);

export function loadConfig(): HeadroomConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_URL, "utf-8")) as HeadroomConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    for (const key of Object.keys(parsed)) {
      if (!CONFIG_KEYS.has(key)) {
        // F037: ring the warning so /headroom status can show it after the fact.
        const msg = `[headroom] ignoring unknown headroom.json key '${key}'`;
        console.warn(msg);
        recordDiagnostic(msg);
      }
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = err instanceof Error ? err.message : String(err);
    if (code !== "ENOENT") {
      const msg = `[headroom] ignoring broken headroom.json (${reason}); using built-in defaults`;
      console.warn(msg);
      recordDiagnostic(msg);
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
    const msg =
      `[headroom] cannot read the provider manifest at ${MANIFEST_URL} ` +
      `(${(err as Error).message}) — wiring ZERO providers. This path assumes the folder sits ` +
      `at <agent-dir>/extensions/headroom/.`;
    console.warn(msg);
    // F037: this is THE session-start failure worth surviving the notification.
    recordDiagnostic(msg);
    return {};
  }
}

// Merge order: models.json (upstream truth) < headroom.json (flags + overrides).
// Only openai-completions providers are wireable (Headroom speaks the OpenAI path shape).
// The optional manifest parameter is the DI seam (D5): tests inject a manifest
// instead of reading the machine's live models.json, so the suite is hermetic and
// cannot pass or fail on whichever providers happen to be installed here.
// F009: resolveProviders re-read and re-parsed the 38,975-byte models.json on every
// call - eight call sites plus modelLimitsEnv's two, so one session start performed
// ten synchronous reads of the same file, and the shim-failure path's up-to-12
// startShim attempts multiplied it. Memoize per config object: the factory creates
// one config per load (index.ts:1011) and the restart-branch re-read creates a fresh
// object, so object identity is a safe key (D9). The DI seam (D5) is preserved
// exactly - an injected manifest always computes fresh, so tests cannot pass
// vacuously against a stale entry; only the default read is memoized. Callers treat
// the result as read-only.
const providerResolutionCache = new WeakMap<
  HeadroomConfig,
  { enabled: ResolvedProvider[]; skipped: string[] }
>();

export function resolveProviders(
  config: HeadroomConfig,
  manifest?: Record<string, { baseUrl: string; api?: string }>,
): {
  enabled: ResolvedProvider[];
  skipped: string[];
} {
  if (manifest === undefined) {
    const cached = providerResolutionCache.get(config);
    if (cached) return cached;
  }
  const source = manifest ?? readManifestProviders();
  const enabled: ResolvedProvider[] = [];
  const skipped: string[] = [];
  const entries = config.providers ?? {};
  for (const id of Object.keys(source)) {
    const info = source[id]!;
    if (info.api && info.api !== "openai-completions") {
      // F050: non-openai-completions providers used to vanish silently - neither
      // enabled nor skipped - so /headroom status could not account for them. They
      // cannot be wired (Headroom speaks the OpenAI path shape), so say so once
      // instead of dropping them.
      console.warn(
        `[headroom] provider '${id}' uses api '${info.api}', not openai-completions; not wired`,
      );
      continue;
    }
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
  // F012: the loop iterates manifest keys, so a providers.<id> block whose id is
  // absent from models.json was never visited - a renamed provider lost all its
  // flags with no signal. Warn on the difference.
  for (const id of Object.keys(entries)) {
    if (!(id in source)) {
      console.warn(
        `[headroom] providers.${id} in headroom.json is not in models.json; ignored`,
      );
    }
  }
  const result = { enabled, skipped };
  if (manifest === undefined) providerResolutionCache.set(config, result);
  return result;
}

export function auditProxyEnv(): string | null {
  const proxy =
    process.env.HTTP_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.https_proxy;
  if (!proxy) return null;
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").toLowerCase();
  // F024: split on commas and compare trimmed entries exactly. The old substring test
  // (noProxy.includes("127.0.0.1") && noProxy.includes("localhost")) matched inside
  // longer entries: NO_PROXY=my-localhost-cache.internal passed the localhost test and
  // 127.0.0.1.evil.invalid passed the loopback test, so a proxy that did NOT cover
  // loopback looked covered and Headroom's traffic tunneled through the ambient proxy.
  // Exact entries only; "*" still short-circuits.
  const entries = noProxy.split(",").map((entry) => entry.trim()).filter(Boolean);
  const coversLoopback =
    entries.includes("*") || (entries.includes("127.0.0.1") && entries.includes("localhost"));
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
    const msg =
      `[headroom] cannot read model limits from ${MANIFEST_URL} (${(err as Error).message}); ` +
      "headroom falls back to its 128,000-token default per unknown model";
    console.warn(msg);
    recordDiagnostic(msg);
    return {};
  }
}

// The optional manifestLimits parameter is the DI seam (D5): same hidden-fs dependency
// as resolveProviders - readManifestModelLimits reads MANIFEST_URL, which no test file
// can resolve.
// F009: same per-config memoization as resolveProviders above - readManifestModelLimits
// re-read models.json on every call, and modelLimitsEnv ran twice per session start.
// An injected map always computes fresh (D5 non-vacuity).
const modelLimitsCache = new WeakMap<HeadroomConfig, Record<string, string>>();

export function modelLimitsEnv(
  config: HeadroomConfig,
  manifestLimits?: Record<string, number>,
): Record<string, string> {
  if (config.modelLimits === false) return {};
  if (manifestLimits === undefined) {
    const cached = modelLimitsCache.get(config);
    if (cached) return cached;
  }
  const limits = { ...(manifestLimits ?? readManifestModelLimits()), ...(config.modelLimits ?? {}) };
  const result: Record<string, string> =
    Object.keys(limits).length === 0 ? {} : { HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: limits }) };
  if (manifestLimits === undefined) modelLimitsCache.set(config, result);
  return result;
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

// F023: the guard checked only SSL_CERT_FILE, so a user who set REQUESTS_CA_BUNDLE (or
// CURL_CA_BUNDLE) to a valid custom bundle and left SSL_CERT_FILE unset got all three
// keys overwritten with DEFAULT_CA_BUNDLE - their custom bundle silently replaced by
// the auto-detected one. Guard on any of the three CA_KEYS: if the user configured any
// CA path, respect it; auto-inject only when none is set.
export function caBundleEnv(extra: Record<string, string>): Record<string, string> {
  if (CA_KEYS.some((key) => extra[key]) || !existsSync(DEFAULT_CA_BUNDLE)) return {};
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
  // F028: HEADROOM_NO_CCR=1 - the escape hatch headroom_retrieve's guard comment
  // already names - existed nowhere in the repo, so the documented contingency was
  // manual, undocumented in the README, and blind for adopted proxies (which never
  // see proxyEnv). Wire it behind the noCcr config flag. Off by default: the
  // trailing-newline mechanism is the working fix (F-V07); this exists for the day
  // some layer starts trimming trailing whitespace. An explicit extraEnv value still
  // works - extra spreads above, and this only fires when the flag is set.
  if (config.noCcr) env.HEADROOM_NO_CCR = "1";
  return env;
}

// F025: this value reaches spawn(..., { shell: true }) as the --openai-api-url argument
// (spawnProxy, index.ts:433-435). Node does not quote arguments for cmd.exe, so a
// models.json baseUrl containing shell metacharacters would reach the shell - the
// manifest is third-party data any tool install can write. Validate before the spawn:
// parse with new URL(), accept only http:/https:, and reject the metacharacters that
// survive URL parsing (& and | pass through raw; " ^ < > are percent-encoded by the
// parser but the raw string is what would reach the shell, so they are rejected too).
// An unusable upstream falls back to the same safe default the no-providers case uses
// and warns - the proxy still starts, and provider traffic (which carries its own
// x-headroom-base-url header) is unaffected. shell:true itself stays: F-V02 - it is
// what makes a missing CLI exit non-zero instead of raising ENOENT, powering the
// CLI-absent fast-fail. This validation is additive to the spawn, never a change to
// the flag.
function defaultUpstreamUrl(config: HeadroomConfig): string {
  const { enabled } = resolveProviders(config);
  const candidate = enabled[0]?.upstream;
  if (candidate) {
    try {
      const protocol = new URL(candidate).protocol;
      if ((protocol === "http:" || protocol === "https:") && !/[&|<>^"\s]/.test(candidate)) {
        return candidate;
      }
    } catch {
      // not a parseable URL - fall through to the safe default
    }
    console.warn(
      `[headroom] ignoring unusable default upstream '${candidate}' (not a clean http(s) URL); ` +
        "the proxy starts with its built-in default upstream instead",
    );
  }
  return `https://${PROXY_HOST}/v1`;
}

// F006: the e2e driver pinned an absolute python.exe path that exists only on the
// machine that wrote it (.rpiv/tmp/hdrv/driver_e2e.mjs:14-15). Resolve the
// interpreter the way sanitizedExtraEnv (index.ts:298-308) resolves CA bundles:
// the explicit HEADROOM_PYTHON override is primary (the driver needs an interpreter
// to run `python -c`, not just the CLI binary), then the uv tool layout probed with
// existsSync so a dead path is dropped rather than spawned into ENOENT, then a bare
// interpreter name that must be on PATH.
export function resolvePython(): string {
  const fromEnv = process.env.HEADROOM_PYTHON;
  if (fromEnv) return fromEnv;
  const uvLayout =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? homedir(), "uv/tools/headroom-ai/Scripts/python.exe")
      : join(homedir(), ".local/share/uv/tools/headroom-ai/bin/python");
  if (existsSync(uvLayout)) return uvLayout;
  return process.platform === "win32" ? "python" : "python3";
}

// F038: headroomVersion and findPortOwnerPid were the same spawn-capture-parse shape
// twice - the second even carried a comment saying it was modeled on the first. One
// probe, two callers. `shell` stays per-call because the two probes deliberately differ:
// headroomVersion needs shell:true on win32 (F-V02 - a missing command must exit
// non-zero instead of raising ENOENT, which is what makes it the CLI-absent signal),
// while the port-owner probes are real executables on PATH and a cmd.exe wrapper would
// put a shell PID between the lookup and the listener. windowsHide is a win32-only
// option (ignored on POSIX), so it is unconditional here.
async function spawnProbe(
  command: string,
  args: string[],
  opts: { shell?: boolean } = {},
): Promise<{ out: string; code: number | null; failed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: opts.shell ?? false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    // A spawn failure (ENOENT under no-shell) resolves failed - each caller maps it to
    // its own sentinel (null / "lookup-failed").
    child.on("error", () => resolve({ out, code: null, failed: true }));
    child.on("close", (code) => resolve({ out, code, failed: false }));
  });
}

export async function headroomVersion(config: HeadroomConfig): Promise<string | null> {
  const { out, code, failed } = await spawnProbe(config.command ?? DEFAULT_CONFIG.command, ["--version"], {
    shell: process.platform === "win32",
  });
  if (failed || code !== 0) return null;
  const match = out.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : out.trim() || null;
}

// F033: null is a real outcome — "cannot confirm" (absent or unparseable version) —
// and it is NOT false. Callers must warn on null too; the locked unit suite pins this
// boolean | null shape (test/index.test.ts, "versionAtLeast: null for absent or
// unparseable versions"), so the fix lands at the call sites: the gate in
// onSessionStart and the annotation in renderStatus.
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

// F014: one generic GET served /health, /stats, and /v1/retrieve/{hash}, but the
// resolution collapsed the response to healthy = statusCode === 200 - so a 404
// retrieve (entry expired) and a dead proxy rendered the same "the proxy is not
// reachable". Return the status code and let callers branch. fetchHealth stays as
// the thin 200-ness wrapper every health probe keeps using, so the health paths and
// their tests are untouched.
export function httpGetStatus(
  origin: string,
  timeoutMs: number,
  path = "/health",
  signal?: unknown,
): Promise<{ status: number | null; body: string | null }> {
  return new Promise((resolve) => {
    // F027: an already-aborted call never dials. pi passes an AbortSignal to every
    // tool execute; headroom_retrieve used to discard it, so a cancelled turn still
    // waited out the full 5 s dial. The signal arrives typed as unknown (the ambient
    // pi stub declares it so), narrowed to the AbortSignal surface here.
    const abortSignal = signal as AbortSignal | undefined;
    if (abortSignal?.aborted) {
      resolve({ status: null, body: null });
      return;
    }
    const req = httpRequest(
      `${origin}${path}`,
      { timeout: timeoutMs },
      (res) => {
        // FR2: accumulate raw Buffers and decode once — per-chunk toString() splits
        // multi-byte UTF-8 sequences at chunk boundaries (U+FFFD). JSON structure is
        // ASCII so JSON.parse still succeeds: the corruption is silent, in the content
        // the success path returns.
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? null, body: body || null });
        });
      },
    );
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          req.destroy();
          resolve({ status: null, body: null });
        },
        { once: true },
      );
    }
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: null, body: null });
    });
    req.on("error", () => resolve({ status: null, body: null }));
    req.end();
  });
}

export function fetchHealth(
  origin: string,
  timeoutMs: number,
  path = "/health",
): Promise<{ healthy: boolean; body: string | null }> {
  return httpGetStatus(origin, timeoutMs, path).then(({ status, body }) => ({
    healthy: status === 200,
    body,
  }));
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
  // F046: stdio was "ignore", so a pi-spawned proxy's stdout and stderr were discarded —
  // a proxy that crashes on boot (bad env, missing Python dep, port race) left no trace
  // and the only signal was the 20 s health timeout. Pipe stderr and keep the first
  // line: on a non-zero exit it lands in state.lastSpawnError, which F045 renders in
  // the unavailable warning and /headroom status. stdout stays ignored — the proxy's
  // banner is noise on this path.
  const child = spawn(config.command ?? DEFAULT_CONFIG.command, args, {
    shell: process.platform === "win32",
    env: { ...process.env, ...proxyEnv(config, needsShim(config)) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    // Bounded: a proxy spamming stderr must not grow this buffer for the whole wait.
    if (stderr.length < 4096) stderr += chunk.toString();
  });
  child.on("error", (err) => {
    // A spawn failure after a successful version probe (POSIX ENOENT race) is the same
    // class of missing trace — record it where the health-wait failure will look.
    state.lastSpawnError = err.message;
    if (onError) onError(err);
  });
  child.on("close", (code) => {
    if (state.child === child) state.child = null;
    // F046: the first stderr line, trimmed and bounded — the only trace of a boot crash.
    // Split on \r?\n so a win32 proxy's CRLF does not leave a stray carriage return in
    // the rendered reason.
    if (code !== 0 && stderr.trim()) {
      state.lastSpawnError = stderr.trim().split(/\r?\n/)[0]!.slice(0, 200);
    }
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
// Shares spawnProbe with headroomVersion (F038). No shell for the port-owner probes —
// they are real executables on PATH, and a direct spawn keeps a cmd.exe wrapper out of
// the picture (headroomVersion keeps its win32 shell: F-V02).
export async function findPortOwnerPid(
  config: HeadroomConfig,
): Promise<number | null | "lookup-failed"> {
  const port = proxyPort(config);
  const win32 = process.platform === "win32";
  const command = win32 ? "powershell" : "lsof";
  const args = win32
    ? [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          "Select-Object -First 1 -ExpandProperty OwningProcess",
      ]
    : ["-ti", `tcp:${port}`, "-sTCP:LISTEN"];
  const { out, code, failed } = await spawnProbe(command, args);
  if (failed) return "lookup-failed";
  const pid = Number.parseInt(out.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return pid;
  // Windows: -ErrorAction SilentlyContinue makes a no-match exit 0 with empty stdout.
  // POSIX: lsof exits 1 when nothing is found. Both mean "no listener", not failure.
  if (code === 0 || (!win32 && code === 1)) return null;
  return "lookup-failed";
}

// Awaited, outcome-checked kill — the first in this file (the old stopProxy discarded the
// taskkill handle, so "stopped" stated intent, not outcome). Exit-code mapping:
// taskkill 0 -> killed, 128 (PID already gone) -> not-running, anything else -> kill-failed;
// POSIX ESRCH -> not-running, EPERM/anything else -> kill-failed. /T kills the whole tree,
// which is load-bearing on win32: shell:true makes the spawned pid a cmd.exe wrapper with
// the real proxy as a grandchild.
// F049: SIGTERM is advisory. A process that installs its own handler keeps the port, and
// the old fire-and-forget return reported "killed" while the listener survived - the
// restart path's waitForPortFree then masked it by polling the port, not the PID. Poll
// process.kill(pid, 0) for the exit, escalate to SIGKILL on expiry, then re-check. The
// escalation stays inside waitForPortFree's 5 s budget (index.ts:558) so a slow kill
// cannot starve the port-free probe, and ensureProxyRunning's 1500 ms adopt probe
// (index.ts:581) still sees a genuinely dead port. A PID that survives SIGKILL plus the
// grace window is reported kill-failed rather than killed: that is the outcome the old
// code could not express.
const KILL_TERM_GRACE_MS = 2000;
const KILL_KILL_GRACE_MS = 1000;
const KILL_POLL_MS = 100;

// ESRCH is the only "gone" signal; anything else (EPERM on a process we cannot signal)
// means it is still there.
async function pidGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

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
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "not-running" : "kill-failed";
  }
  const termDeadline = Date.now() + KILL_TERM_GRACE_MS;
  while (!(await pidGone(pid))) {
    if (Date.now() >= termDeadline) break;
    await new Promise((r) => setTimeout(r, KILL_POLL_MS));
  }
  if (await pidGone(pid)) return "killed";
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "killed" : "kill-failed";
  }
  const killDeadline = Date.now() + KILL_KILL_GRACE_MS;
  while (!(await pidGone(pid))) {
    if (Date.now() >= killDeadline) break;
    await new Promise((r) => setTimeout(r, KILL_POLL_MS));
  }
  return (await pidGone(pid)) ? "killed" : "kill-failed";
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
// probe would re-adopt the corpse (state.adopted = true over a dying
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
  onProgress?: (msg: string) => void,
): Promise<"adopted" | "spawned" | "unavailable" | "already-running"> {
  // F035: isAlive only inspects an in-memory child handle, so it is also true for an
  // adopted or dying process. Reporting that as "spawned" made the startup banner claim
  // pi had started something it never touched; a distinct outcome keeps it honest.
  if (isAlive(state)) return "already-running";
  state.lastSpawnError = null;
  const origin = proxyOrigin(config);
  const first = await fetchHealth(origin, 1500);
  if (first.healthy) {
    state.adopted = true;
    // F010: the adopt branch re-spawned `headroom --version` on every session_start
    // (/new and /resume re-fire the hook) even though the proxy is a machine singleton
    // whose version cannot have changed underneath it. Reuse the known version; the
    // spawn branch below keeps its unconditional probe because that one is the
    // CLI-presence signal feeding the cli-missing diagnostic.
    if (state.version === null) state.version = await headroomVersion(config);
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
  // F026: the wait below blocks for the full healthTimeoutMs (20 s default) with no
  // signal, freezing session startup. Announce it so the block is visible. The default
  // stays 20 s: lowering it turns a slow cold start into a false "unavailable", which is
  // the tradeoff TECH_DEBT_AUDIT.md:78 says must be reported rather than hidden.
  onProgress?.(
    `[headroom] waiting up to ${config.healthTimeoutMs ?? DEFAULT_CONFIG.healthTimeoutMs} ms for the proxy on ${origin} to become healthy...`,
  );
  spawnProxy(config, state, defaultUpstreamUrl(config), onError);
  const ok = await waitForHealthy(origin, config.healthTimeoutMs ?? DEFAULT_CONFIG.healthTimeoutMs);
  // F046: spawnProxy's close handler may already have captured the proxy's first
  // stderr line into lastSpawnError. That line is strictly more informative than the
  // "unhealthy" sentinel, so only fall back to the sentinel when nothing was captured.
  if (!ok && state.lastSpawnError === null) state.lastSpawnError = "unhealthy";
  return ok ? "spawned" : "unavailable";
}

export async function restartProxy(
  config: HeadroomConfig,
  state: HeadroomState,
  onError?: (err: Error) => void,
): Promise<"adopted" | "spawned" | "unavailable" | "already-running"> {
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
// provisioned for the Headroom proxy via extraEnv. F022: consume sanitizedExtraEnv's
// output instead of reading config.extraEnv raw - a CA path that does not exist is not
// inert (headroom's Python clients raise on every upstream call), and the sanitizer
// drops dead paths with a warning; the old raw read bypassed that, so the shim and the
// proxy treated the same configured value differently. Called once per shim start now
// (F044), so the sanitizer's warning fires once, not per request. Missing file ->
// Node's default store.
function shimCaBundle(config: HeadroomConfig): string[] | undefined {
  const file = sanitizedExtraEnv(config).SSL_CERT_FILE ?? process.env.SSL_CERT_FILE;
  if (!file) return undefined;
  try {
    return [readFileSync(file, "utf-8")];
  } catch {
    return undefined;
  }
}

// F032: the shim is an unauthenticated loopback relay, and that is a documented trust
// assumption rather than an oversight. It binds 127.0.0.1 only, so no off-machine
// process can reach it; every request on that port is trusted as pi's own, which is
// why there is no auth token - there is no reachable attacker to authenticate against.
// Path segments are confined to the mapped origin by the new URL construction below,
// so it is not an open proxy. What was missing is a bound on the request body: any
// local process could stream unbounded data through the shim to a mapped upstream.
// SHIM_MAX_BODY_BYTES is that bound - it sits far above observed pi traffic (inbound
// bodies up to ~494KB, measured 2026-09-27), so no legitimate turn can trip it. A
// chunked upload declares no content-length and is not bounded by this check; pi's
// client always sends content-length for its JSON bodies, and a local process bent on
// flooding an upstream can dial it directly without the shim.
const SHIM_MAX_BODY_BYTES = 10 * 1024 * 1024;
// F007: the shim's outbound requests were the only network dials in the file without a
// timeout - a hung upstream held a socket, a request object, and the buffered body
// indefinitely, while every other dial goes through fetchHealth's timeout discipline.
// This is a socket-idle timeout: once the response streams, each chunk resets it, so
// it bounds hangs, not slow streams. The destroy routes into the existing outReq
// "error" handler below (verified: destroy() emits ECONNRESET on the request), which
// answers 502 before headers and destroys the response after. Single knob - tune here.
const SHIM_TIMEOUT_MS = 120_000;

export function createShimHandler(
  providers: Record<string, string>,
  config: HeadroomConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  // F044+F022: shimCaBundle did a synchronous readFileSync of the root CA bundle inside
  // the per-request send closure - every shim-routed token (all zai-paas traffic) paid
  // a blocking disk read of a several-hundred-KB PEM on the request path. Read once
  // here instead: createShimHandler runs once per shim start (startShim's createServer
  // call), so the closure below sees a stable value for the server's lifetime.
  // F022 is why this cannot land alone: the old read took config.extraEnv?.SSL_CERT_FILE
  // raw, bypassing sanitizedExtraEnv's dead-path drop - hoisting that read unchanged
  // would have cached a dead path as a permanently broken value. shimCaBundle now
  // consumes the sanitized map, so a dead path is dropped (with the sanitizer's
  // warning) before the read.
  const caBundle = shimCaBundle(config);
  return (req, res) => {
    // F031: the request-target parse sat outside any guard - a malformed target threw an
    // uncaught TypeError and killed pi. Guarded here with a 400; the upstream-target parse
    // below keeps its own 502 guard.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${PROXY_HOST}`);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "headroom-shim: malformed request target" } }));
      return;
    }
    // F032: bound the request body at the door - a declared content-length over the cap
    // is rejected before any upstream work happens.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > SHIM_MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "headroom-shim: request body too large" } }));
      return;
    }
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
        ? httpsRequest(target, { method: req.method, headers, ca: caBundle, timeout: SHIM_TIMEOUT_MS })
        : httpRequest(target, { method: req.method, headers, timeout: SHIM_TIMEOUT_MS });
    const outReq = send(target.protocol === "https:");
    // F007: idle-socket timeout -> destroy, which emits 'error' on outReq and routes
    // into the handler below.
    outReq.on("timeout", () => outReq.destroy());
    outReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `headroom-shim: upstream error: ${err.message}` } }));
      } else {
        // F008: res.end after headersSent (and after writableEnded) emits "error" on res,
        // which has no listener - the error handler itself crashed the process. Destroy
        // instead; composes with the res.on("close") abort propagation below.
        res.destroy();
      }
    });
    // Abort propagation: if the client disconnects before the response finishes, kill the
    // upstream request. (req "close" fires as soon as the body is consumed - watching the
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
      // F002: once "response" fires, mid-stream socket errors are delivered to the response
      // stream, not re-emitted on the request - outReq.on("error") does not cover them. An
      // unhandled upRes "error" is an uncaught exception that kills pi (the Critical).
      upRes.on("error", () => res.destroy());
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
  // F001: after the bind probe removes its one-shot "error" listener on successful bind,
  // a bound Server with zero "error" listeners turns any post-bind server-level error
  // into an uncaught exception that kills pi. This permanent handler keeps a listener
  // attached for the server's lifetime. It must stay log-only: the bind-probe retry in
  // ensureShimRunning depends on its own onErr resolving false, on stopShim clearing
  // state.shim, and on the 250 ms backoff - none of which this handler disturbs
  // (verified against index.ts:733-762). EADDRINUSE is skipped: it can only fire during
  // a listen attempt, which the bind probe owns and reports.
  // (The err shape is spelled out structurally rather than as NodeJS.ErrnoException: the
  // ambient @types/node is not installed until the Phase-4 harness, and referencing the
  // NodeJS namespace here would add one TS2503 to the F-V10 baseline this slice must hold.)
  server.on("error", (err: Error & { code?: string }) => {
    if (err.code === "EADDRINUSE") return;
    console.warn(`[headroom] shim server error on 127.0.0.1:${port} (${err.code ?? err.message})`);
  });
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
    // F029: this was the only registration call in the file without a guard, while every
    // pi.unregisterProvider had one. A throw here (duplicate id, runtime mid-reload)
    // escaped onSessionStart and killed the whole session-start hook; now the provider is
    // skipped and reported instead of taking the round down.
    try {
      pi.registerProvider(id, {
        baseUrl: proxyBase,
        headers: { "x-headroom-base-url": header },
      });
    } catch (err) {
      console.warn(
        `[headroom] could not wire provider '${id}' (${(err as Error).message}); it stays direct this session`,
      );
      continue;
    }
    wired.push(id);
  }
  state.registered = wired;
  return state.registered;
}

function unregisterStale(pi: ExtensionAPI, ids: readonly string[], keep: readonly string[]): void {
  for (const id of ids) {
    if (keep.includes(id)) continue;
    try {
      pi.unregisterProvider(id);
    } catch {
      // not registered in this runtime - nothing to undo
    }
  }
}

// F030: a provider disabled in headroom.json while the proxy stays healthy kept its
// previous-round override, because unregistering only ever ran in the unavailable and
// !shimOk branches. One diff per round fixes it: whatever was registered last round and
// is not wired this round goes. Replaces the two ad-hoc unregister loops
// (index.ts:820-826, index.ts:849-857) and the restart handler's re-wiring.
export function syncOverrides(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  state: HeadroomState,
  shimOk = true,
): string[] {
  const previous = state.registered;
  const wired = registerOverrides(pi, config, state, shimOk);
  unregisterStale(pi, previous, wired);
  return wired;
}

// Proxy-down path: nothing is wireable, so the whole previous round goes. Separate from
// syncOverrides because registerOverrides must not run at all when the proxy is down -
// it would wire providers onto a base URL nothing is listening on.
export function clearOverrides(pi: ExtensionAPI, state: HeadroomState): void {
  unregisterStale(pi, state.registered, []);
  state.registered = [];
}

export async function onSessionStart(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  state: HeadroomState,
  ctx?: ExtensionContext,
): Promise<void> {
  const warn = (msg: string) => {
    // F037: this channel's messages land in the ring /headroom status prints. The
    // manifest/config readers ring their own warnings directly; the spawn-time
    // env-assembly warnings (resolveProviders, sanitizedExtraEnv, ensureShimRunning,
    // registerOverrides, startShim) stay console-only by scope.
    recordDiagnostic(msg);
    if (ctx?.hasUI) ctx.ui.notify(msg, "warning");
    else console.warn(msg);
  };
  // F026: the progress channel for the proxy health wait. Same guard shape as warn
  // (index.ts:800-803) so a headless session logs instead of throwing on ctx.ui.
  const note = (msg: string) => {
    recordDiagnostic(msg);
    if (ctx?.hasUI) ctx.ui.notify(msg, "info");
    else console.log(msg);
  };
  const envWarning = auditProxyEnv();
  if (envWarning) warn("[headroom] " + envWarning);

  // FR5: activate headroom_retrieve directly in every session. Extension tools start
  // inactive (pi 1.0.1: agent-session.js's initial active tool set covers only read/bash/edit/write), so the
  // tool was reachable only via tool_search or codemode nesting — and a codemode-nested
  // result is named "codemode", which the proxy's name-keyed CCR exemption misses.
  // session_start re-fires on /new and /resume, so activation re-applies however the
  // runtime resets actives. Placed before the proxy checks: the tool stays callable
  // when the proxy is down, and its "proxy is not reachable" error is the diagnostic.
  pi.setActiveTools([...pi.getActiveTools(), "headroom_retrieve"]);

  const result = await ensureProxyRunning(
    config,
    state,
    (err) => warn(`[headroom] proxy spawn error: ${err.message}`),
    note,
  );
  if (result === "unavailable") {
    // F003: the old loop iterated state.registered after onSessionShutdown had already
    // emptied it (index.ts:887), so it unregistered nothing while the warning claimed
    // "stale overrides removed". clearOverrides does the same job against a ledger that
    // now survives shutdown.
    clearOverrides(pi, state);
    if (state.lastSpawnError === "cli-missing") {
      state.lastSpawnError = null;
      warn(
        "[headroom] the headroom CLI is missing or cannot run - providers left DIRECT. " +
          'Install it with: uv tool install "headroom-ai[proxy]" (or pip install the same), ' +
          "then start pi from a NEW terminal: PATH changes never reach an already-open shell.",
      );
      return;
    }
    // F045: name the reason — "unhealthy" (spawned, never healthy) or the captured first
    // stderr line (F046) — instead of the same generic line a never-started proxy gets.
    const reason = spawnErrorReason(state.lastSpawnError);
    warn(
      `[headroom] proxy unavailable after ${config.healthTimeoutMs ?? DEFAULT_CONFIG.healthTimeoutMs} ms` +
        `${reason ? ` (${reason})` : ""} — ` +
        'stale overrides removed, providers left DIRECT. Install with: uv tool install "headroom-ai[proxy]", ' +
        "or check the port in headroom.json.",
    );
    return;
  }

  const { enabled, skipped } = resolveProviders(config);
  const shimIds = enabled.filter((p) => p.viaShim).map((p) => p.id);
  const shimOk = shimIds.length === 0 || (await ensureShimRunning(config, state)) !== "failed";
  // F030: the every-round diff. A provider disabled since the last round is not in this
  // round's wired set, so syncOverrides unregisters it here - the old dedicated !shimOk
  // loop is gone with it.
  syncOverrides(pi, config, state, shimOk);
  if (!shimOk) {
    warn(`[headroom] NOT wired via shim (shim failed to start): ${shimIds.join(", ")} — these stay direct this session`);
  }

  const version = state.version ?? "unknown";
  // F033: the gate tested === false, so an unparseable version (null) silently skipped
  // the warning — the exact blind spot the audit names. Warn on null too.
  const gate = versionAtLeast(version, MIN_VERSION);
  if (gate === false) {
    warn(
      `[headroom] headroom-ai ${version} < ${MIN_VERSION.join(".")}: this build may ignore ` +
        "x-headroom-base-url on the chat-completions path (traffic would all land on the default " +
        "upstream). Upgrade headroom-ai and restart the session.",
    );
  } else if (gate === null) {
    warn(
      `[headroom] cannot parse the headroom-ai version '${version}'; cannot confirm ` +
        `x-headroom-base-url support (needs >= ${MIN_VERSION.join(".")}).`,
    );
  }
  const mode =
    result === "adopted"
      ? "adopted external proxy"
      : result === "already-running"
        ? "proxy already running"
        : "proxy spawned";
  const shimNote = shimIds.length > 0 && shimOk ? `, ${shimIds.length} via path shim` : "";
  note(
    `[headroom] ${mode} on 127.0.0.1:${proxyPort(config)} (v${version}); ${state.registered.length} providers wired${shimNote}`,
  );
  if (skipped.length > 0) {
    // F036: this line always used console.log, so a UI user never saw which providers
    // were left unwired. Route it through the same guarded helper as the banner.
    note(`[headroom] not wired (disabled in config): ${skipped.join(", ")}`);
  }
}

// FR3: the proxy is a machine-level singleton — session_shutdown fires on /new, /resume,
// AND process exit (prior FRD evidence, verified against pi 1.0.1: agent-session.js emits session_shutdown; CHANGELOG.md:2089),
// so killing here churned the proxy on every session change. Only /headroom stop ends it
// now. The shim stays per-session by design (its port ladder and closeAllConnections
// teardown are what make back-to-back /new rebinds work), and adopted/version bookkeeping
// self-heals on the next session_start re-probe.
export function onSessionShutdown(state: HeadroomState): void {
  stopShim(state);
  state.child = null;
  // F003: this clear emptied the rollback ledger before the next session_start could
  // diff it, so a provider disabled while the proxy stayed healthy kept routing through
  // the proxy across pi's reload() while the warning claimed its override was removed.
  // syncOverrides' every-round diff is the cleanup authority now; shutdown only drops
  // the per-session shim and the child handle.
}

// ---------------------------------------------------------------- commands + factory

// F045: prose for the lastSpawnError sentinels and the F046-captured stderr line,
// shared by the unavailable warning in onSessionStart, restartHandler, and renderStatus.
// Function declaration (hoisted) so onSessionStart can call it from above — the same
// pattern spawnProxy already uses with needsShim.
function spawnErrorReason(err: string | null): string | null {
  if (err === null) return null;
  if (err === "unhealthy") return "the proxy process spawned but never became healthy";
  if (err === "cli-missing") return "the headroom CLI is missing or cannot run";
  return `proxy stderr: ${err}`;
}

// F017: extracted from handleHeadroomCommand's ~70-line status branch. Rendering plus
// two loopback probes — no notify, no ctx: the caller decides how to show the returned
// string. The /stats and /health probes used to run sequentially (2 s each, up to 4 s of
// blocking inside a UI command handler); they now run together, fired before the
// synchronous line-building so they overlap it. Output line order is unchanged.
export async function renderStatus(config: HeadroomConfig, state: HeadroomState): Promise<string> {
  const origin = proxyOrigin(config);
  const [statsProbe, healthProbe] = await Promise.all([
    fetchHealth(origin, 2000, "/stats"),
    fetchHealth(origin, 2000),
  ]);
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
    // F033: null (unparseable) used to render bare, indistinguishable from a good
    // version. Say so.
    const gateNote =
      gate === false
        ? ` (below ${MIN_VERSION.join(".")}: chat-completions header support uncertain)`
        : gate === null
          ? ` (unparseable: cannot confirm ${MIN_VERSION.join(".")}+ header support)`
          : "";
    lines.push(`version: ${state.version}${gateNote}`);
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
  if (skipped.length > 0) {
    // F013: DEFAULT_DISABLED carries a reason per id, but only key membership was
    // ever read, so the reasons were dead data and status printed bare ids. Show
    // them; a config-disabled provider (not in DEFAULT_DISABLED) says so.
    const withReasons = skipped.map((id) => {
      const reason = DEFAULT_DISABLED[id];
      return reason ? `${id} (${reason})` : `${id} (disabled in headroom.json)`;
    });
    lines.push(`not wired (disabled): ${withReasons.join(", ")}`);
  }
  // F045: lastSpawnError was written and never read — a proxy that spawned but never
  // became healthy rendered exactly like one that never started. Show it.
  const spawnReason = spawnErrorReason(state.lastSpawnError);
  if (spawnReason) lines.push(`last spawn error: ${spawnReason}`);
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
  if (statsProbe.healthy && statsProbe.body) {
    try {
      const rl = (JSON.parse(statsProbe.body) as {
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
              "and respawns with the current config.",
          );
        }
      }
    } catch {
      // /stats not JSON -> skip the rate-limit line
    }
  }
  if (healthProbe.healthy && healthProbe.body) {
    try {
      const stats = JSON.parse(healthProbe.body) as { stats?: { total_requests?: number; tokens_saved?: number } };
      if (stats.stats) {
        lines.push(`stats: ${stats.stats.total_requests ?? 0} requests, ${stats.stats.tokens_saved ?? 0} tokens saved`);
      }
    } catch {
      // body not JSON — skip the stats line
    }
  }
  // F037: the ring — the session-start diagnostics that used to vanish with the
  // notification. Newest last.
  if (diagnosticRing.length > 0) {
    lines.push(`recent diagnostics (last ${diagnosticRing.length}):`);
    for (const entry of diagnosticRing) lines.push(`  ${entry}`);
  }
  return lines.join("\n");
}

// F017: the stop branch, extracted. notify is the guarded helper from
// handleHeadroomCommand (F047) so a headless dispatch still reaches the console.
async function stopHandler(
  config: HeadroomConfig,
  state: HeadroomState,
  notify: (msg: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  const result = await stopProxy(config, state);
  if (result === "stopped")
    notify("proxy stopped (pi-spawned instance); providers still wired — turns will error until /headroom restart");
  else if (result === "stopped-external")
    notify("proxy stopped (external instance killed via port-owner PID); providers still wired — turns will error until /headroom restart");
  else if (result === "not-running") notify("proxy not running", "warning");
  else if (result === "lookup-failed")
    notify(`proxy not stopped — the port-owner lookup failed on port ${proxyPort(config)} (is Get-NetTCPConnection/lsof available?)`, "error");
  else notify("proxy kill failed — the process may still be running; /headroom status to confirm", "error");
}

// F017: the restart branch, extracted. Carries the locked Slice-7 F004 reload + F030
// re-sync verbatim, plus F045's reason on the unavailable notify.
async function restartHandler(
  pi: ExtensionAPI,
  config: HeadroomConfig,
  state: HeadroomState,
  notify: (msg: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  notify("restarting proxy...");
  // F004: re-read headroom.json here. The factory's config snapshot is frozen at load
  // (index.ts:1011), so the old code respawned with stale limits after an edit and the
  // status WARNING plus README both half-admitted it in self-contradictory prose.
  // Scope of the reload (D3): the fresh config reaches the proxy AND the provider wiring
  // below. It does NOT reach the retrieve tool (index.ts:1060) or /headroom status
  // (index.ts:907, :939, :961), which keep the factory's frozen port - so after a port edit
  // this command names the new port while status still prints "proxy: running ... port
  // <old>" (its liveness comes from the in-memory child handle, index.ts:445, not the
  // port) and its probes plus headroom_retrieve dial the old port and fail. A full pi
  // restart remains the only complete re-read; that is the documented tradeoff, not a
  // defect.
  const fresh = loadConfig();
  const result = await restartProxy(fresh, state);
  if (result === "unavailable") {
    // F045: name the reason instead of the generic line.
    const reason = spawnErrorReason(state.lastSpawnError);
    notify(`proxy failed to come back healthy${reason ? ` (${reason})` : ""} — /headroom status for detail`, "error");
    return;
  }
  // F030 across restarts: the fresh config may enable or disable providers, so re-diff
  // the wiring instead of reporting the previous round's count. The shim is per-session
  // and untouched by restartProxy, so its liveness is the shimOk input.
  syncOverrides(pi, fresh, state, isShimAlive(state));
  const label =
    result === "adopted"
      ? "re-adopted external instance"
      : result === "already-running"
        ? "already running"
        : "restarted";
  notify(`proxy ${label} on 127.0.0.1:${proxyPort(fresh)}; ${state.registered.length} providers wired`);
}

async function handleHeadroomCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  config: HeadroomConfig,
  state: HeadroomState,
): Promise<void> {
  // F047: mirror onSessionStart's warn guard (index.ts:800-803) — a headless dispatch
  // (no dialog-capable UI) must fall back to the console instead of throwing a TypeError
  // out of the command handler. Severity maps onto the matching console method.
  const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx?.hasUI) ctx.ui.notify(msg, level);
    else if (level === "error") console.error(msg);
    else if (level === "warning") console.warn(msg);
    else console.log(msg);
  };
  const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "status";

  // F017: the 108-line handler is now a router; each branch lives in its own function.
  if (sub === "status") {
    notify(await renderStatus(config, state));
    return;
  }
  if (sub === "stop") {
    await stopHandler(config, state, notify);
    return;
  }
  if (sub === "restart") {
    await restartHandler(pi, config, state, notify);
    return;
  }

  notify("Usage: /headroom status | stop | restart", "error");
}

// Factory: config read at top, registrations only — ZERO side effects (proxy and shim
// both start in the session_start hook, never here).
//
// pi re-runs the factory on session reload (pi 1.0.1: agent-session.js reload() -> new extension
// runner). The process-wide singleton keeps the shim/proxy handles across reloads, so a
// reload round either finds the shim still listening or owns the rebinding — the old
// server can never be orphaned holding the port.
export default function headroomExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const g = globalThis as typeof globalThis & { __headroomState?: HeadroomState };
  const state = (g.__headroomState ??= createState());

  pi.registerCommand("headroom", {
    description: "Headroom proxy: /headroom status|stop|restart",
    handler: (args: string, ctx: ExtensionCommandContext) => handleHeadroomCommand(pi, args, ctx, config, state),
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // F048: the old unanchored /[a-f0-9]{12,24}/i took the first 12-24 hex chars of
      // any longer run - a pasted 40-char SHA silently truncated to 24 and 404'd as
      // "entry expired", indistinguishable from genuine expiry. The proxy's two real
      // key forms are 12-hex (Rust mirror) and 24-hex (sha256 alias), so accept
      // exactly those, delimited so a longer run cannot match (D7). Surrounding text
      // is still ignored, as the tool's description promises.
      const match = /(?<![a-f0-9])(?:[a-f0-9]{12}|[a-f0-9]{24})(?![a-f0-9])/i.exec((params.hash ?? "").trim());
      if (!match) {
        return {
          content: [
            { type: "text", text: `No 12- or 24-character hash found in "${params.hash}".` },
          ],
        };
      }
      const hash = match[0];
      // FR4: validated accessor path — the raw config.port dial bypassed proxyPort's
      // integer/range validation (the lone outlier among the call sites).
      const origin = proxyOrigin(config);
      // F014+F027: branch on the status code - a 404 means the proxy answered and the
      // entry is gone, anything else (5xx, or null = transport failure/abort) means
      // the proxy itself is unreachable - and thread the abort signal so a cancelled
      // turn does not wait out the 5 s dial.
      const { status, body } = await httpGetStatus(origin, 5000, `/v1/retrieve/${hash}`, signal);
      if (status !== 200) {
        let detail = "";
        if (body) {
          try {
            detail = (JSON.parse(body) as { detail?: string }).detail ?? body;
          } catch {
            detail = body;
          }
        }
        const cause = status === 404 ? "entry expired or unknown hash" : "the proxy is not reachable";
        return {
          content: [
            {
              type: "text",
              text: `Headroom retrieve failed for ${hash}${detail ? `: ${detail}` : `: ${cause}.`}`,
            },
          ],
        };
      }
      // F043: a 200 with an empty body resolves body = null (httpGetStatus maps an empty
      // body to null; fetchHealth is the thin 200-ness wrapper over it). JSON.parse(null)
      // coerces null to the string "null" and parses it to null WITHOUT throwing - the
      // catch below never fires, and parsed.original_content throws an uncaught
      // TypeError that kills pi. TS2345 (JSON.parse(string | null)) is the same site.
      // This explicit branch narrows body to string for the try below - no cast - and
      // answers a usable message instead of crashing the session.
      if (body === null) {
        return {
          content: [
            { type: "text", text: `Empty response from the proxy for ${hash}.` },
          ],
        };
      }
      let parsed: { original_content?: unknown };
      try {
        parsed = JSON.parse(body) as { original_content?: unknown };
      } catch {
        // Same byte-differentiation as the success return below — see the guard comment there.
        return { content: [{ type: "text", text: body + "\n" }] };
      }
      const original = parsed.original_content;
      // Byte-differentiation guard: the proxy's CompressionCache re-hashes this result next turn (raw-byte md5) and swaps it back to its <<ccr:...>> marker before the router's name exemption runs; one trailing newline breaks the hash.
      // Ceiling: if any layer trims trailing whitespace before hashing, byte-equality is restored and this fails silently.
      // Contingency: HEADROOM_NO_CCR=1 — extension-spawned proxies only (adopted ones
      // never see the proxyEnv assembly; the flag is wired there behind config.noCcr).
      const text =
        (typeof original === "string" ? original : JSON.stringify(original ?? parsed, null, 2)) + "\n";
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
