import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2] ?? "0.1.0";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must use x.y.z format.");
const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "release");
const packageRoot = resolve(releaseRoot, `signal-expert-v${version}`);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });
for (const path of ["app", "public", "migrations", "docs", "package.json", "README.md", ".env.example", "launcher.mjs", "START-SIGNAL-EXPERT.cmd", "start-signal-expert.sh"]) {
  cpSync(resolve(root, path), resolve(packageRoot, path), { recursive: true });
}
console.log(packageRoot);
