// Unit suite for the headroom extension's testable surface (F005).
// Run: npm test (node --test "test/**/*.test.ts"). Type-checked by the harness gate: npm run check.
//
// Scope follows the research artifact's purity audit and the solutions artifact's
// Testing Strategy:
//   - the genuinely pure helpers (stripTrailingV1, the port helpers, rateLimitEnv,
//     versionAtLeast, createState/isAlive)
//   - the two Slice-4 DI seams (resolveProviders / modelLimitsEnv take an injected
//     manifest). The seam is mandatory, not stylistic: without it the suite reads the
//     machine's live models.json, so results would turn on whichever providers happen
//     to be installed here rather than on the code under test.
//   - the env-coupled fixtures (auditProxyEnv, resolvePython) with save/restore
//   - the env-assembly first-targets (rateLimitEnv / modelLimitsEnv / caBundleEnv /
//     sanitizedExtraEnv) - the highest-risk pure surface per precedents e5ca275,
//     9e6a651, e84f929
//   - the loopback probes (fetchHealth / waitForHealthy). fetchHealth's empty-200 ->
//     body:null resolution is the exact F043 crash precondition, and the chunked
//     multi-byte case pins the FR2 buffer-decode fix.
//   - the shim error paths against local servers (F031 400, 404, 502, F002 mid-stream
//     abort) plus the F001 listenerCount regression net.
//
// Every loopback fixture binds port 0 (ephemeral) - nothing here can collide with
// the production proxy on 127.0.0.1:8787 or the shim ladder 8790-8795.

import { deepStrictEqual, match, notEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  auditProxyEnv,
  caBundleEnv,
  createShimHandler,
  createState,
  fetchHealth,
  isAlive,
  modelLimitsEnv,
  proxyOrigin,
  proxyPort,
  rateLimitEnv,
  resolveProviders,
  resolvePython,
  sanitizedExtraEnv,
  shimPort,
  shimPortCandidates,
  startShim,
  stopShim,
  stripTrailingV1,
  versionAtLeast,
  waitForHealthy,
} from "../index.ts";

// ---------------------------------------------------------------- pure helpers

test("stripTrailingV1: strips a trailing /v1 or /v1/", () => {
  strictEqual(stripTrailingV1("https://api.openai.com/v1"), "https://api.openai.com");
  strictEqual(stripTrailingV1("https://api.openai.com/v1/"), "https://api.openai.com");
});

test("stripTrailingV1: leaves non-/v1-suffixed upstreams untouched", () => {
  strictEqual(stripTrailingV1("https://api.z.ai/api/coding/paas/v4"), "https://api.z.ai/api/coding/paas/v4");
  strictEqual(stripTrailingV1("https://api.openai.com/v1beta"), "https://api.openai.com/v1beta");
});

test("proxyPort: default, valid, and invalid values", () => {
  strictEqual(proxyPort({}), 8787);
  strictEqual(proxyPort({ port: 9000 }), 9000);
  strictEqual(proxyPort({ port: 0 }), 8787);
  strictEqual(proxyPort({ port: 65536 }), 8787);
  strictEqual(proxyPort({ port: 1.5 }), 8787);
});

test("shimPort: default, valid, and invalid values", () => {
  strictEqual(shimPort({}), 8790);
  strictEqual(shimPort({ shimPort: 8795 }), 8795);
  strictEqual(shimPort({ shimPort: -1 }), 8790);
});

test("proxyOrigin: builds the loopback origin from the validated port", () => {
  strictEqual(proxyOrigin({}), "http://127.0.0.1:8787");
  strictEqual(proxyOrigin({ port: 9000 }), "http://127.0.0.1:9000");
  strictEqual(proxyOrigin({ port: 0 }), "http://127.0.0.1:8787"); // invalid falls back to the default
});

test("shimPortCandidates: six-port ladder from the configured base", () => {
  deepStrictEqual(shimPortCandidates({}), [8790, 8791, 8792, 8793, 8794, 8795]);
  deepStrictEqual(shimPortCandidates({ shimPort: 8793 }), [8793, 8794, 8795, 8796, 8797, 8798]);
});

test("shimPortCandidates: truncates at the 65535 ceiling", () => {
  deepStrictEqual(shimPortCandidates({ shimPort: 65535 }), [65535]);
  deepStrictEqual(shimPortCandidates({ shimPort: 65534 }), [65534, 65535]);
});

// ---------------------------------------------------------------- env assembly (highest-risk pure surface)

test("rateLimitEnv: emits the raised defaults", () => {
  deepStrictEqual(rateLimitEnv({}), { HEADROOM_RPM: "600", HEADROOM_TPM: "10000000" });
});

test("rateLimitEnv: false restores headroom's own defaults (no env keys)", () => {
  deepStrictEqual(rateLimitEnv({ rateLimit: false }), {});
});

test("rateLimitEnv: partial config fills the rest from defaults", () => {
  deepStrictEqual(rateLimitEnv({ rateLimit: { rpm: 120 } }), { HEADROOM_RPM: "120", HEADROOM_TPM: "10000000" });
  deepStrictEqual(rateLimitEnv({ rateLimit: { tpm: 500_000 } }), { HEADROOM_RPM: "600", HEADROOM_TPM: "500000" });
});

test("rateLimitEnv: non-positive values are dropped, not emitted", () => {
  deepStrictEqual(rateLimitEnv({ rateLimit: { rpm: 0, tpm: -1 } }), {});
});

test("modelLimitsEnv: injected manifest becomes HEADROOM_MODEL_LIMITS", () => {
  deepStrictEqual(modelLimitsEnv({}, { "glm-5.3-flash": 1_000_000 }), {
    HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: { "glm-5.3-flash": 1000000 } }),
  });
});

test("modelLimitsEnv: false restores headroom's defaults (no env key)", () => {
  deepStrictEqual(modelLimitsEnv({ modelLimits: false }, { "glm-5.3-flash": 1_000_000 }), {});
});

test("modelLimitsEnv: empty limits emit nothing", () => {
  deepStrictEqual(modelLimitsEnv({}, {}), {});
});

test("modelLimitsEnv: explicit entries override the manifest and merge", () => {
  deepStrictEqual(modelLimitsEnv({ modelLimits: { custom: 100 } }, { "glm-5.3-flash": 1_000_000 }), {
    HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: { "glm-5.3-flash": 1000000, custom: 100 } }),
  });
  deepStrictEqual(modelLimitsEnv({ modelLimits: { "glm-5.3-flash": 500_000 } }, { "glm-5.3-flash": 1_000_000 }), {
    HEADROOM_MODEL_LIMITS: JSON.stringify({ context_limits: { "glm-5.3-flash": 500000 } }),
  });
});

test("sanitizedExtraEnv: drops CA-bundle paths that do not exist on this machine", () => {
  const dead = join(tmpdir(), "headroom-test-definitely-missing-ca-bundle.pem");
  deepStrictEqual(sanitizedExtraEnv({ extraEnv: { SSL_CERT_FILE: dead, CUSTOM: "keep" } }), { CUSTOM: "keep" });
});

test("sanitizedExtraEnv: keeps CA-bundle paths that exist", () => {
  deepStrictEqual(sanitizedExtraEnv({ extraEnv: { SSL_CERT_FILE: tmpdir(), CUSTOM: "keep" } }), {
    SSL_CERT_FILE: tmpdir(),
    CUSTOM: "keep",
  });
});

test("caBundleEnv: an explicit extraEnv CA path short-circuits auto-injection", () => {
  // Deterministic branch: the guard fires on the explicit value alone. The other
  // branch depends on whether ~/.headroom/win-ca-bundle.pem exists on the machine,
  // so it is deliberately not asserted here.
  deepStrictEqual(caBundleEnv({ SSL_CERT_FILE: "/any/configured/path.pem" }), {});
});

// ---------------------------------------------------------------- version gate (F033 tri-state)

test("versionAtLeast: equal, newer, and older", () => {
  strictEqual(versionAtLeast("0.38.0", [0, 38, 0]), true);
  strictEqual(versionAtLeast("0.38.1", [0, 38, 0]), true);
  strictEqual(versionAtLeast("0.39.0", [0, 38, 0]), true);
  strictEqual(versionAtLeast("1.0.0", [0, 38, 0]), true);
  strictEqual(versionAtLeast("0.37.9", [0, 38, 0]), false);
});

test("versionAtLeast: null for absent or unparseable versions (the F033 blind spot)", () => {
  strictEqual(versionAtLeast(null, [0, 38, 0]), null);
  strictEqual(versionAtLeast("", [0, 38, 0]), null);
  strictEqual(versionAtLeast("0.38", [0, 38, 0]), null);
  strictEqual(versionAtLeast("0.38.x", [0, 38, 0]), null);
  strictEqual(versionAtLeast("abc", [0, 38, 0]), null);
});

test("versionAtLeast: a prerelease suffix parses as its numeric prefix", () => {
  // parseInt stops at the first non-digit, so "0.38.0-beta" compares as 0.38.0.
  strictEqual(versionAtLeast("0.38.0-beta", [0, 38, 0]), true);
  strictEqual(versionAtLeast("0.37.9-rc1", [0, 38, 0]), false);
});

test("versionAtLeast: extra version parts do not change the first-three comparison", () => {
  strictEqual(versionAtLeast("0.38.0.1", [0, 38, 0]), true);
});

// ---------------------------------------------------------------- state

test("createState: fresh state is empty", () => {
  deepStrictEqual(createState(), {
    child: null,
    adopted: false,
    registered: [],
    version: null,
    shim: null,
    shimPort: null,
    lastSpawnError: null,
  });
});

test("isAlive: false without a child handle", () => {
  strictEqual(isAlive(createState()), false);
});

test("isAlive: true only for a live, unkilled child", () => {
  const live = { ...createState(), child: { exitCode: null, killed: false } as unknown as ChildProcess };
  strictEqual(isAlive(live), true);
  const exited = { ...createState(), child: { exitCode: 0, killed: false } as unknown as ChildProcess };
  strictEqual(isAlive(exited), false);
  const killed = { ...createState(), child: { exitCode: null, killed: true } as unknown as ChildProcess };
  strictEqual(isAlive(killed), false);
});

// ---------------------------------------------------------------- DI seam: resolveProviders (Slice 4)
// The manifest is injected on every call: without the seam these tests would pass
// vacuously against the swallowed-empty {} from readManifestProviders' catch.

const MANIFEST = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4" },
};

test("resolveProviders: wires openai-completions providers and detects the shim need from the /v1 suffix", () => {
  deepStrictEqual(resolveProviders({}, MANIFEST), {
    enabled: [
      { id: "openai", upstream: "https://api.openai.com/v1", viaShim: false },
      { id: "zai", upstream: "https://api.z.ai/api/coding/paas/v4", viaShim: true },
    ],
    skipped: [],
  });
});

test("resolveProviders: DEFAULT_DISABLED ids are skipped unless explicitly enabled", () => {
  const manifest = { freetoken: { baseUrl: "http://127.0.0.1:1234/v1" } };
  deepStrictEqual(resolveProviders({}, manifest), { enabled: [], skipped: ["freetoken"] });
  deepStrictEqual(resolveProviders({ providers: { freetoken: { enabled: true } } }, manifest), {
    enabled: [{ id: "freetoken", upstream: "http://127.0.0.1:1234/v1", viaShim: false }],
    skipped: [],
  });
});

test("resolveProviders: non-openai-completions api entries appear in neither list (F050)", () => {
  const manifest = { anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" } };
  deepStrictEqual(resolveProviders({}, manifest), { enabled: [], skipped: [] });
});

test("resolveProviders: headroom.json baseUrl overrides the manifest", () => {
  const { enabled } = resolveProviders({ providers: { openai: { baseUrl: "https://custom.example/v1" } } }, MANIFEST);
  strictEqual(enabled[0]?.upstream, "https://custom.example/v1");
});

test("resolveProviders: explicit shim flag overrides the /v1-suffix inference in both directions", () => {
  const forcedShim = resolveProviders({ providers: { openai: { shim: true } } }, MANIFEST);
  strictEqual(forcedShim.enabled[0]?.viaShim, true);
  const forcedDirect = resolveProviders({ providers: { zai: { shim: false } } }, MANIFEST);
  strictEqual(forcedDirect.enabled.find((p) => p.id === "zai")?.viaShim, false);
});

test("resolveProviders: an empty manifest wires nothing", () => {
  deepStrictEqual(resolveProviders({}, {}), { enabled: [], skipped: [] });
});

// ---------------------------------------------------------------- env fixtures (save/restore around every mutation)

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

function withProxyEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("auditProxyEnv: no proxy variables -> null", () => {
  withProxyEnv(() => strictEqual(auditProxyEnv(), null));
});

test("auditProxyEnv: proxy set without loopback NO_PROXY coverage -> warning", () => {
  withProxyEnv(() => {
    process.env.HTTP_PROXY = "http://corp-proxy:8080";
    const warning = auditProxyEnv();
    notEqual(warning, null);
    match(warning!, /127\.0\.0\.1/);
  });
});

test("auditProxyEnv: NO_PROXY star or both loopback hosts -> null", () => {
  withProxyEnv(() => {
    process.env.HTTP_PROXY = "http://corp-proxy:8080";
    process.env.NO_PROXY = "*";
    strictEqual(auditProxyEnv(), null);
    process.env.NO_PROXY = "127.0.0.1,localhost";
    strictEqual(auditProxyEnv(), null);
  });
});

test("auditProxyEnv: partial loopback coverage still warns (both hosts required)", () => {
  withProxyEnv(() => {
    process.env.HTTPS_PROXY = "http://corp-proxy:8080";
    process.env.NO_PROXY = "127.0.0.1";
    notEqual(auditProxyEnv(), null);
  });
});

test("auditProxyEnv: lowercase variables are read too", () => {
  withProxyEnv(() => {
    process.env.http_proxy = "http://corp-proxy:8080";
    notEqual(auditProxyEnv(), null);
  });
});

// ---------------------------------------------------------------- F006: python resolution (Slice 4 export, consumed here)

test("resolvePython: HEADROOM_PYTHON override wins over every probe", () => {
  const saved = process.env.HEADROOM_PYTHON;
  try {
    process.env.HEADROOM_PYTHON = "C:/custom-interpreter/python.exe";
    strictEqual(resolvePython(), "C:/custom-interpreter/python.exe");
  } finally {
    if (saved === undefined) delete process.env.HEADROOM_PYTHON;
    else process.env.HEADROOM_PYTHON = saved;
  }
});

test("resolvePython: bare interpreter name when the uv layout is absent", () => {
  const savedPython = process.env.HEADROOM_PYTHON;
  const savedAppdata = process.env.APPDATA;
  const savedHome = process.env.HOME;
  try {
    delete process.env.HEADROOM_PYTHON;
    // Point the home-layout probe at a directory that cannot hold the uv tool, so
    // existsSync fails and the chain must fall through to the bare interpreter name.
    const emptyHome = join(tmpdir(), "headroom-test-no-uv-layout");
    if (process.platform === "win32") process.env.APPDATA = emptyHome;
    else process.env.HOME = emptyHome;
    strictEqual(resolvePython(), process.platform === "win32" ? "python" : "python3");
  } finally {
    if (savedPython === undefined) delete process.env.HEADROOM_PYTHON;
    else process.env.HEADROOM_PYTHON = savedPython;
    if (savedAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppdata;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

// ---------------------------------------------------------------- loopback probes (fetchHealth's empty-200 is the F043 precondition)

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, fn: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function ephemeralPort(): Promise<number> {
  // Bind port 0, read the ephemeral port, release it - the caller dials a port that
  // is free (or freshly dead), never a fixed one.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("fetchHealth: 200 with a body resolves healthy + body", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    },
    async (origin) => {
      const { healthy, body } = await fetchHealth(origin, 2000);
      strictEqual(healthy, true);
      strictEqual(body, '{"ok":true}');
    },
  );
});

test("fetchHealth: 200 with an empty body resolves healthy + body null (the F043 crash precondition)", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end();
    },
    async (origin) => {
      const { healthy, body } = await fetchHealth(origin, 2000);
      strictEqual(healthy, true);
      strictEqual(body, null);
    },
  );
});

test("fetchHealth: non-200 resolves unhealthy", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end("not found");
    },
    async (origin) => {
      const { healthy } = await fetchHealth(origin, 2000);
      strictEqual(healthy, false);
    },
  );
});

test("fetchHealth: multi-byte UTF-8 split across chunks decodes without U+FFFD (FR2)", async () => {
  const payload = "héllo → 世界 🚀";
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      const buf = Buffer.from(payload, "utf-8");
      // Split inside the 2-byte "é" sequence: a per-chunk toString() would emit U+FFFD.
      res.write(buf.subarray(0, 2), () => {
        setTimeout(() => res.end(buf.subarray(2)), 5);
      });
    },
    async (origin) => {
      const { body } = await fetchHealth(origin, 2000);
      strictEqual(body, payload);
      ok(!body!.includes("\uFFFD"));
    },
  );
});

test("fetchHealth: connection refused resolves unhealthy + null body", async () => {
  const port = await ephemeralPort();
  const { healthy, body } = await fetchHealth(`http://127.0.0.1:${port}`, 2000);
  strictEqual(healthy, false);
  strictEqual(body, null);
});

test("waitForHealthy: true as soon as the endpoint answers 200", async () => {
  await withServer((req, res) => res.end("ok"), async (origin) => {
    strictEqual(await waitForHealthy(origin, 2000, 50), true);
  });
});

test("waitForHealthy: false when the endpoint never comes up", async () => {
  const port = await ephemeralPort();
  strictEqual(await waitForHealthy(`http://127.0.0.1:${port}`, 300, 100), false);
});

// ---------------------------------------------------------------- shim error paths (Slice 1 code, local-server regression net)

async function withShim(providers: Record<string, string>, fn: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(createShimHandler(providers, {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("shim: unknown provider id answers 404 JSON", async () => {
  await withShim({}, async (origin) => {
    const res = await fetch(`${origin}/nope/v1/chat/completions`, { method: "POST", body: "{}" });
    strictEqual(res.status, 404);
    match(await res.text(), /no upstream mapped for 'nope'/);
  });
});

test("shim: malformed request target answers 400 JSON (F031)", async () => {
  await withShim({}, async (origin) => {
    const port = Number(new URL(origin).port);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(port, "127.0.0.1", () => {
        // A request target that is not a parseable URL: new URL() throws inside the
        // handler, which must answer 400 instead of crashing the process. Sent over a
        // raw socket because fetch/undici reject the target client-side first.
        socket.write("GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.setTimeout(5000, () => socket.destroy());
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    match(raw, /^HTTP\/1\.[01] 400/);
    match(raw, /malformed request target/);
  });
});

test("shim: an unparseable upstream URL answers 502 JSON", async () => {
  await withShim({ bad: "not-a-url" }, async (origin) => {
    const res = await fetch(`${origin}/bad/v1/chat/completions`, { method: "POST", body: "{}" });
    strictEqual(res.status, 502);
    match(await res.text(), /bad upstream URL/);
  });
});

test("shim: upstream connection refused answers 502 JSON (outReq error before headers)", async () => {
  const deadPort = await ephemeralPort();
  await withShim({ dead: `http://127.0.0.1:${deadPort}` }, async (origin) => {
    const res = await fetch(`${origin}/dead/v1/chat/completions`, { method: "POST", body: "{}" });
    strictEqual(res.status, 502);
    match(await res.text(), /upstream error/);
  });
});

test("shim: upstream reset mid-stream closes the response without crashing (F002)", async () => {
  // Mock upstream: sends response headers, then destroys the socket mid-stream. The
  // shim must attach upRes.on("error") before pipe and destroy res - an unhandled
  // upRes "error" is an uncaught exception that would fail this whole test run.
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    setTimeout(() => res.socket?.destroy(), 10);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  try {
    await withShim({ mock: `http://127.0.0.1:${upstreamPort}` }, async (origin) => {
      // The body read is chained inside rejects: fetch() resolves at response headers,
      // so only reading the text observes the mid-stream truncation.
      await rejects(
        fetch(`${origin}/mock/v1/chat/completions`, { method: "POST", body: "{}" }).then((r) => r.text()),
      );
    });
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

// ---------------------------------------------------------------- F001 regression net

test("startShim: a permanent error listener survives the bind probe's removeListener", () => {
  // The bind probe in ensureShimRunning registers once("error") and removes it on a
  // successful bind; without startShim's own permanent handler the bound Server would
  // have zero error listeners and any post-bind error would crash pi (F001).
  const state = createState();
  const server = startShim({}, state, 0);
  try {
    ok(server.listenerCount("error") > 0);
  } finally {
    stopShim(state);
  }
});
