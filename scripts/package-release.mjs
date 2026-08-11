import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2] ?? "0.3.0";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must use x.y.z format.");
const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "release");
const packageRoot = resolve(releaseRoot, `signal-expert-v${version}`);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });
for (const path of ["app", "public", "migrations", "docs", "README.md", ".env.example", "launcher.mjs", "START-SIGNAL-EXPERT.cmd", "start-signal-expert.sh"]) {
  cpSync(resolve(root, path), resolve(packageRoot, path), { recursive: true });
}
mkdirSync(resolve(packageRoot, "scripts"), { recursive: true });
cpSync(resolve(root, "scripts/migrate.mjs"), resolve(packageRoot, "scripts/migrate.mjs"));
writeFileSync(resolve(packageRoot, "package.json"), `${JSON.stringify({
  name: "signal-expert",
  version,
  private: true,
  type: "module",
  engines: { node: ">=22.5" },
  scripts: { start: "node launcher.mjs", server: "node app/server.mjs", "db:migrate": "node scripts/migrate.mjs" },
}, null, 2)}\n`);
console.log(packageRoot);
