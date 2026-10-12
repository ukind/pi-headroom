// Part B: live wire-level end-to-end for the round-4 retrieve re-compression
// fix (acceptance a6, session 01a10644's actual wire form).
// argv: [proxyPort, mockPort]   e.g. node driver_e2e.mjs 18787 18788
import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePython } from "../index.ts";

const PROXY_PORT = Number(process.argv[2] ?? 18787);
const MOCK_PORT = Number(process.argv[3] ?? 18788);
const PROXY_ORIGIN = `http://127.0.0.1:${PROXY_PORT}`;
// F006: the pinned absolute python.exe path existed only on the machine that
// first wrote this file. resolvePython (index.ts) resolves the interpreter the
// way sanitizedExtraEnv resolves CA bundles: the HEADROOM_PYTHON override is
// primary, then the uv tool layout probed with existsSync, then a bare
// interpreter name that must be on PATH.
const PYTHON = resolvePython();

const HEADER = "Script completed\nWall time 0.1 seconds\nOutput:\n\n";
const ORIGINALS = {
  ctx: "E2E_CTX_ORIGINAL:" + "a".repeat(700),
  ls: "E2E_LS_ORIGINAL:" + "b".repeat(650),
  git: "E2E_GIT_ORIGINAL:" + "c".repeat(600),
};
const envelopeBody = () =>
  HEADER +
  JSON.stringify(
    Object.fromEntries(
      Object.entries(ORIGINALS).map(([k, v]) => [k, v + "\n"]),
    ),
  );
const sha = (s, n) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);

// --- mock upstream: captures the request bodies the proxy actually sends ---
const captured = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mock-completion",
        object: "chat.completion",
        created: 1,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

// --- seed the store through the patched mirror path (dual-key asserted) ---
const seedScript = `
import hashlib, json
from headroom.transforms.smart_crusher import SmartCrusher
from headroom.cache.compression_store import get_compression_store
originals = json.loads(${JSON.stringify(JSON.stringify(ORIGINALS))})
store = get_compression_store()
for name, original in originals.items():
    ccr_hash = hashlib.sha256(original.encode()).hexdigest()[:12]
    class _FakeRust:
        def ccr_get(self, h):
            return original if h == ccr_hash else None
    crusher = SmartCrusher.__new__(SmartCrusher)
    crusher._rust = _FakeRust()
    crusher._mirror_single_hash_to_python_store(ccr_hash, "string_ccr", "", "codemode")
    assert store.exists(ccr_hash), "12-hex mirror key missing for " + name
    assert store.exists(hashlib.sha256(original.encode()).hexdigest()[:24]), "24-hex dual-key alias missing for " + name
print("SEEDED")
`;

const post = (body, extraMessages = []) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${PROXY_ORIGIN}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-headroom-session-id": "e2e-round4-retrieve",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        model: "mock-model",
        messages: [
          { role: "user", content: "run the retrieval script" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "codemode", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: body },
          ...extraMessages,
        ],
      }),
    );
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "hdrv-e2e-"));
  await new Promise((r) => upstream.listen(MOCK_PORT, "127.0.0.1", r));

  const seedOut = execFileSync(PYTHON, ["-c", seedScript], {
    encoding: "utf8",
    env: { ...process.env, HEADROOM_WORKSPACE_DIR: workspace },
  });
  if (!seedOut.includes("SEEDED")) throw new Error("seed failed: " + seedOut);

  const proxy = spawn(
    PYTHON,
    [
      // headroom ships no __main__ (entry point is headroom.cli:main per
      // entry_points.txt), so `-m headroom` fails; invoke the CLI main
      // through -c instead. Still a direct python.exe child with
      // shell:false, so proxy.kill() reaps the real process.
      "-c",
      "import sys; from headroom.cli import main; sys.exit(main())",
      "proxy",
      "--port",
      String(PROXY_PORT),
      "--openai-api-url",
      `http://127.0.0.1:${MOCK_PORT}`,
    ],
    {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HEADROOM_WORKSPACE_DIR: workspace,
        HEADROOM_SAVINGS_PROFILE: "balanced",
        HEADROOM_BEACON: "off",
        HEADROOM_TELEMETRY: "on",
      },
    },
  );

  try {
    // Pre-flight 1: proxy healthy AND the 24-hex dual-key alias redeems
    // (fails loudly if the mirror patch is missing or the store is not
    // shared between seeder and proxy).
    // 150 × 300ms ≈ 45s: a cold first start on this machine exceeded the
    // original 100 × 200ms budget (banner printed but socket not yet
    // listening at 12s); warm starts listen in ~2s.
    let healthy = false;
    for (let i = 0; i < 150 && !healthy; i++) {
      const status = await fetch(
        `${PROXY_ORIGIN}/v1/retrieve/${sha(ORIGINALS.ctx, 24)}`,
      )
        .then((r) => r.status)
        .catch(() => 0);
      healthy = status === 200;
      if (!healthy) await sleep(300);
    }
    if (!healthy)
      throw new Error(
        `proxy did not become healthy/redeem the dual-key alias on ${PROXY_PORT}`,
      );

    // Pre-flight 2: the seeded 12-hex Rust key redeems through the proxy —
    // the mirror + explicit_hash redemption path works live.
    const redeem = await fetch(
      `${PROXY_ORIGIN}/v1/retrieve/${sha(ORIGINALS.ctx, 12)}`,
    );
    const redeemJson = await redeem.json();
    if (redeem.status !== 200 || redeemJson.original_content !== ORIGINALS.ctx) {
      throw new Error(`12-hex redemption failed: status=${redeem.status}`);
    }

    // Turn 1 and turn 2: the session's actual wire form — one codemode tool
    // result aggregating three retrieved originals — replayed across turns
    // as pi does (history grows: turn 2 appends the follow-up user message,
    // so the request bytes differ and the proxy's exact-response cache
    // cannot serve turn 2 without forwarding). The tool-result body itself
    // is byte-identical in both turns — that is the body the fix must
    // keep intact.
    const t1 = await post(envelopeBody());
    const t2 = await post(envelopeBody(), [
      { role: "user", content: "continue" },
    ]);
    if (t1.status !== 200 || t2.status !== 200) {
      throw new Error(`upstream turns failed: t1=${t1.status} t2=${t2.status}`);
    }
    if (captured.length !== 2)
      throw new Error(
        `expected 2 captured upstream requests, got ${captured.length}`,
      );

    let pass = true;
    captured.forEach((wire, i) => {
      const turn = i + 1;
      if (wire.includes("<<ccr:")) {
        console.log(`FAIL turn ${turn}: fresh CCR marker reached the upstream`);
        pass = false;
      }
      for (const [name, original] of Object.entries(ORIGINALS)) {
        if (!wire.includes(original)) {
          console.log(`FAIL turn ${turn}: original ${name} not intact on the wire`);
          pass = false;
        }
      }
    });
    if (!pass) process.exit(1);
    console.log(
      "PASS e2e: aggregated retrieve form survived turns 1 and 2 with no fresh markers",
    );
  } finally {
    proxy.kill();
    upstream.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("ERROR " + (err && err.message ? err.message : err));
    process.exit(1);
  });