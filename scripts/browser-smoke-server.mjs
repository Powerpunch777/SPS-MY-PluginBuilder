import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const diagnosticLimit = 12_000;
const readinessTimeoutMs = 60_000;
const requestTimeoutMs = 3_000;
const smokeTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

function observe(child) {
  const state = { error: null, close: null };
  state.closed = new Promise(resolve => {
    child.once("error", error => { state.error = error; });
    child.once("close", (code, signal) => {
      state.close = { code, signal };
      resolve(state.close);
    });
  });
  return state;
}

function appendDiagnostic(current, chunk) {
  const combined = current + chunk;
  return combined.length > diagnosticLimit ? combined.slice(-diagnosticLimit) : combined;
}

function pipeOutput(stream, destination, append) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    append(chunk);
    destination.write(chunk);
  });
}

async function waitForClose(state, timeoutMs) {
  if (state.close) return state.close;
  let timer;
  try {
    return await Promise.race([
      state.closed,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedProcess(child, state, name) {
  if (state.close) return;
  child.kill("SIGTERM");
  if (await waitForClose(state, shutdownTimeoutMs)) return;
  child.kill("SIGKILL");
  if (await waitForClose(state, shutdownTimeoutMs)) return;
  throw new Error(`${name} did not close after SIGTERM and SIGKILL.`);
}

const server = spawn(process.execPath, ["scripts/dev.mjs"], {
  cwd: root,
  env: { ...process.env, SPS_BUILDER_DEV_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverState = observe(server);
let serverDiagnostics = "";
let serverOutput = "";
pipeOutput(server.stdout, process.stdout, chunk => {
  serverDiagnostics = appendDiagnostic(serverDiagnostics, chunk);
  serverOutput = appendDiagnostic(serverOutput, chunk);
});
pipeOutput(server.stderr, process.stderr, chunk => {
  serverDiagnostics = appendDiagnostic(serverDiagnostics, chunk);
});

let smoke;
let smokeState;
let smokeDiagnostics = "";
let interrupted;
const stopOnSignal = signal => {
  interrupted = signal;
  if (smoke && smokeState && !smokeState.close) smoke.kill(signal);
  if (!serverState.close) server.kill(signal);
};
process.once("SIGINT", stopOnSignal);
process.once("SIGTERM", stopOnSignal);

async function waitForServer() {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
    if (serverState.error) throw new Error(`Could not start preview server: ${serverState.error.message}`);
    if (serverState.close) {
      throw new Error(`Preview server closed (${serverState.close.signal ?? `code ${serverState.close.code}`}).`);
    }
    const match = serverOutput.match(/SPS Builder UI Preview: (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match) {
      try {
        const response = await fetch(match[1], { signal: AbortSignal.timeout(requestTimeoutMs) });
        if (response.ok) return match[1];
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the preview server after ${readinessTimeoutMs}ms.`);
}

async function runSmoke(origin) {
  smoke = spawn(process.execPath, ["scripts/smoke-ui.mjs"], {
    cwd: root,
    env: { ...process.env, BUILDER_SMOKE_ORIGIN: origin, BUILDER_SMOKE_BROWSER: "chromium" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  smokeState = observe(smoke);
  pipeOutput(smoke.stdout, process.stdout, chunk => {
    smokeDiagnostics = appendDiagnostic(smokeDiagnostics, chunk);
  });
  pipeOutput(smoke.stderr, process.stderr, chunk => {
    smokeDiagnostics = appendDiagnostic(smokeDiagnostics, chunk);
  });

  const close = await waitForClose(smokeState, smokeTimeoutMs);
  if (!close) {
    await stopOwnedProcess(smoke, smokeState, "Browser smoke");
    throw new Error(`Browser smoke exceeded its ${smokeTimeoutMs}ms deadline.`);
  }
  if (smokeState.error) throw new Error(`Could not start browser smoke: ${smokeState.error.message}`);
  if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
  if (close.code !== 0) {
    throw new Error(`Browser smoke exited with ${close.signal ?? `code ${close.code}`}.`);
  }
}

let failure;
try {
  const origin = await waitForServer();
  await runSmoke(origin);
} catch (error) {
  failure = error;
} finally {
  process.removeListener("SIGINT", stopOnSignal);
  process.removeListener("SIGTERM", stopOnSignal);
  for (const [child, state, name] of [
    [smoke, smokeState, "Browser smoke"],
    [server, serverState, "Preview server"],
  ]) {
    if (!child || !state || state.close) continue;
    try {
      await stopOwnedProcess(child, state, name);
    } catch (error) {
      failure ??= error;
    }
  }
}

if (failure) {
  console.error(failure.message);
  if (smokeDiagnostics) console.error(`Browser smoke output (last ${diagnosticLimit} characters):\n${smokeDiagnostics}`);
  if (serverDiagnostics) console.error(`Preview server output (last ${diagnosticLimit} characters):\n${serverDiagnostics}`);
  process.exitCode = 1;
}
