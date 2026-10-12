// F040: runner for the two manual harness deliverables. Generates two free ports (the
// driver's argv contract is [proxyPort, mockPort]) and spawns the driver DIRECTLY -
// wrapping it in cmd /c would break the driver's finally { proxy.kill() } guarantee
// (test/driver_e2e.mjs:241-243), because shell:false + direct-child kill is the shared
// invariant with index.ts's killProcess.
// Usage: node test/harness.mjs [all|--python|--driver]   (default: all)
// The Python interpreter is resolved the way the extension resolves it (resolvePython,
// index.ts): HEADROOM_PYTHON, then the uv tool layout, then a bare name on PATH.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePython } from "../index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Bind port 0, read the ephemeral port, release it - the caller dials a port that is
// free (or freshly dead), never a fixed one. Same mechanic as the unit suite's
// ephemeralPort helper (test/index.test.ts).
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(command, args) {
  return new Promise((resolve) => {
    // stdio inherited so the suite's PASS/FAIL lines and the driver's output stream
    // through; a direct spawn (no shell) keeps the kill guarantee above.
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.on("error", (err) => {
      console.error(`harness: could not run ${command} (${err.message})`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const mode = process.argv[2] ?? "all";
  let failed = 0;

  if (mode === "all" || mode === "--python") {
    const python = resolvePython();
    console.log(`harness: python falsification suite (${python})`);
    const code = await run(python, [join(here, "test_retrieve_forms.py"), "all"]);
    if (code !== 0) failed++;
  }

  if (mode === "all" || mode === "--driver") {
    const proxyPort = await freePort();
    const mockPort = await freePort();
    console.log(`harness: e2e driver on ports ${proxyPort}/${mockPort}`);
    const code = await run(process.execPath, [join(here, "driver_e2e.mjs"), String(proxyPort), String(mockPort)]);
    if (code !== 0) failed++;
  }

  if (failed > 0) {
    console.error(`harness: FAIL (${failed} step(s) failed)`);
    process.exit(1);
  }
  console.log("harness: PASS");
}

// freePort() can reject (a bind failure); without this the rejection escapes as an
// unhandled rejection instead of the clean FAIL path above.
main().catch((err) => {
  console.error(`harness: ERROR ${err && err.message ? err.message : err}`);
  process.exit(1);
});
