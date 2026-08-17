import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

function parseArguments(argumentsList) {
  const options = { instance: process.env.SIGNAL_EXPERT_INSTANCE ?? "default", port: null, strictPort: false, database: null, stream: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = () => { const next = argumentsList[++index]; if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value.`); return next; };
    if (argument === "--instance") options.instance = value();
    else if (argument === "--port") options.port = Number(value());
    else if (argument === "--strict-port") options.strictPort = true;
    else if (argument === "--database") options.database = value();
    else if (argument === "--stream") options.stream = true;
    else throw new Error(`Unknown launcher option: ${argument}`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(options.instance)) throw new Error("Instance must use 1-48 letters, digits, underscores or dashes.");
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error("Port must be an integer between 1 and 65535.");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const dataRoot = resolve(root, "data");
const instanceDirectory = options.instance === "default" ? dataRoot : resolve(dataRoot, "instances", options.instance);
const lockPath = resolve(instanceDirectory, "launcher.lock");
const statePath = resolve(instanceDirectory, "server.json");
const databasePath = options.database ? (isAbsolute(options.database) ? options.database : resolve(root, options.database)) : resolve(instanceDirectory, "signal-expert.db");
mkdirSync(instanceDirectory, { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });

function fail(message) {
  console.error(`\nSignal Expert: ${message}\n`);
  if (process.platform === "win32") console.error("Press any key to close this window.");
  process.exitCode = 1;
}
function requireNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) { fail(`Node.js 22.5+ is required. Installed: ${process.versions.node}. Download it from https://nodejs.org/`); return false; }
  return true;
}
function processAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function existingInstance() {
  if (!existsSync(lockPath)) return null;
  try { const lock = JSON.parse(readFileSync(lockPath, "utf8")); if (processAlive(lock.pid)) return lock; } catch {}
  rmSync(lockPath, { force: true }); return null;
}
function acquireLock() {
  const existing = existingInstance(); if (existing) return { existing };
  try { const descriptor = openSync(lockPath, "wx", 0o600); writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instance: options.instance, startedAt: new Date().toISOString() })); closeSync(descriptor); return { existing: null }; }
  catch (error) { const concurrent = existingInstance(); if (concurrent) return { existing: concurrent }; throw error; }
}
function portAvailable(port) {
  return new Promise((resolvePort) => { const probe = net.createServer(); probe.unref(); probe.once("error", () => resolvePort(false)); probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolvePort(true))); });
}
async function findPort(start, attempts = 40) {
  for (let port = start; port < start + attempts; port += 1) if (await portAvailable(port)) return port;
  throw new Error(`No free local port found between ${start} and ${start + attempts - 1}.`);
}
function openBrowser(url) {
  if (process.env.NO_BROWSER === "1") return;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }); opener.on("error", () => console.log(`Open this URL in your browser: ${url}`)); opener.unref();
}
async function waitForHealth(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error(`Local server stopped with code ${child.exitCode}.`); try { const response = await fetch(`${url}/health`); if (response.ok) return; } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 250)); }
  throw new Error("Local server did not become healthy within 20 seconds.");
}

if (requireNode()) {
  const { existing } = acquireLock();
  if (existing) {
    let url = existing.url; try { url ??= JSON.parse(readFileSync(statePath, "utf8")).url; } catch {}
    console.log(`Signal Expert instance ${options.instance} is already running${url ? ` at ${url}` : ""}.`); if (url) openBrowser(url);
  } else {
    let child = null;
    const cleanup = () => { rmSync(lockPath, { force: true }); rmSync(statePath, { force: true }); };
    const stop = (signal = "SIGTERM") => { if (child && child.exitCode === null) child.kill(signal); else cleanup(); };
    process.once("SIGINT", () => stop("SIGINT")); process.once("SIGTERM", () => stop("SIGTERM")); process.once("exit", cleanup);
    try {
      const configured = options.port ?? Number(process.env.SIGNAL_EXPERT_PORT ?? process.env.API_PORT ?? 4100);
      const preferred = Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : 4100;
      const port = options.strictPort ? (await portAvailable(preferred) ? preferred : (() => { throw new Error(`Strict port ${preferred} is already in use; no fallback port was selected.`); })()) : await findPort(preferred);
      const url = `http://127.0.0.1:${port}`; const startedAt = new Date().toISOString();
      const state = { pid: process.pid, instance: options.instance, url, port, databasePath, streamEnabled: options.stream, startedAt };
      writeFileSync(lockPath, JSON.stringify(state), { mode: 0o600 }); writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
      child = spawn(process.execPath, [resolve(root, "app/server.mjs")], { cwd: root, stdio: "inherit", windowsHide: false, env: { ...process.env, SIGNAL_EXPERT_INSTANCE: options.instance, API_HOST: "127.0.0.1", API_PORT: String(port), DATABASE_PATH: databasePath, MARKET_STREAM_ENABLED: options.stream ? "true" : process.env.MARKET_STREAM_ENABLED, PUBLIC_DIRECTORY: resolve(root, "public"), MIGRATION_DIRECTORY: resolve(root, "migrations") } });
      child.once("exit", (code, signal) => { cleanup(); if (code && code !== 0) console.error(`Signal Expert server exited with code ${code}${signal ? ` (${signal})` : ""}.`); process.exitCode = code ?? 0; });
      await waitForHealth(url, child);
      console.log(`\nSignal Expert instance ${options.instance} is ready: ${url}`); console.log(`Database: ${databasePath}`); console.log("Keep this window open. Press Ctrl+C to stop the local server.\n"); openBrowser(url);
    } catch (error) { stop(); fail(error instanceof Error ? error.message : "Launcher failed."); }
  }
}
