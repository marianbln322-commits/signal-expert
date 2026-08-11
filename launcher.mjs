import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const dataDirectory = resolve(root, "data");
const lockPath = resolve(dataDirectory, "launcher.lock");
const statePath = resolve(dataDirectory, "server.json");
mkdirSync(dataDirectory, { recursive: true });

function fail(message) {
  console.error(`\nSignal Expert: ${message}\n`);
  if (process.platform === "win32") console.error("Press any key to close this window.");
  process.exitCode = 1;
}

function requireNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    fail(`Node.js 22.5+ is required. Installed: ${process.versions.node}. Download it from https://nodejs.org/`);
    return false;
  }
  return true;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function existingInstance() {
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (processAlive(lock.pid)) return lock;
  } catch {}
  rmSync(lockPath, { force: true });
  return null;
}

function acquireLock() {
  const existing = existingInstance();
  if (existing) return { existing };
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(descriptor);
    return { existing: null };
  } catch (error) {
    const concurrent = existingInstance();
    if (concurrent) return { existing: concurrent };
    throw error;
  }
}

function portAvailable(port) {
  return new Promise((resolvePort) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolvePort(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolvePort(true)));
  });
}

async function findPort(start, attempts = 40) {
  for (let port = start; port < start + attempts; port += 1) if (await portAvailable(port)) return port;
  throw new Error(`No free local port found between ${start} and ${start + attempts - 1}.`);
}

function openBrowser(url) {
  if (process.env.NO_BROWSER === "1") return;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  opener.on("error", () => console.log(`Open this URL in your browser: ${url}`));
  opener.unref();
}

async function waitForHealth(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local server stopped with code ${child.exitCode}.`);
    try { const response = await fetch(`${url}/health`); if (response.ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Local server did not become healthy within 20 seconds.");
}

if (requireNode()) {
  const { existing } = acquireLock();
  if (existing) {
    let url = existing.url;
    try { url ??= JSON.parse(readFileSync(statePath, "utf8")).url; } catch {}
    console.log(`Signal Expert is already running${url ? ` at ${url}` : ""}.`);
    if (url) openBrowser(url);
  } else {
    let child = null;
    const cleanup = () => { rmSync(lockPath, { force: true }); rmSync(statePath, { force: true }); };
    const stop = (signal = "SIGTERM") => { if (child && child.exitCode === null) child.kill(signal); else cleanup(); };
    process.once("SIGINT", () => stop("SIGINT")); process.once("SIGTERM", () => stop("SIGTERM")); process.once("exit", cleanup);
    try {
      const preferred = Number(process.env.SIGNAL_EXPERT_PORT ?? process.env.API_PORT ?? 4100);
      const port = await findPort(Number.isInteger(preferred) && preferred > 0 && preferred < 65536 ? preferred : 4100);
      const url = `http://127.0.0.1:${port}`;
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }), { mode: 0o600 });
      writeFileSync(statePath, JSON.stringify({ pid: process.pid, url, port, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      child = spawn(process.execPath, [resolve(root, "app/server.mjs")], {
        cwd: root, stdio: "inherit", windowsHide: false,
        env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: String(port), DATABASE_PATH: resolve(dataDirectory, "signal-expert.db"), PUBLIC_DIRECTORY: resolve(root, "public"), MIGRATION_DIRECTORY: resolve(root, "migrations") },
      });
      child.once("exit", (code, signal) => { cleanup(); if (code && code !== 0) console.error(`Signal Expert server exited with code ${code}${signal ? ` (${signal})` : ""}.`); process.exitCode = code ?? 0; });
      await waitForHealth(url, child);
      console.log(`\nSignal Expert is ready: ${url}`);
      console.log("Keep this window open. Press Ctrl+C to stop the local server.\n");
      openBrowser(url);
    } catch (error) { stop(); fail(error instanceof Error ? error.message : "Launcher failed."); }
  }
}
