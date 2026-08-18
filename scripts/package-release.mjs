import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2] ?? "0.9.0";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must use x.y.z format.");
const root = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(root, "release");
const packageRoot = resolve(releaseRoot, `signal-expert-v${version}`);
rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });
for (const path of ["app", "public", "migrations", "docs", "README.md", ".env.example", "launcher.mjs", "START-SIGNAL-EXPERT-4020.cmd", "start-signal-expert-4020.sh"]) {
  cpSync(resolve(root, path), resolve(packageRoot, path), { recursive: true });
}
mkdirSync(resolve(packageRoot, "scripts"), { recursive: true });
for (const script of ["migrate.mjs", "replay.mjs"]) {
  cpSync(resolve(root, `scripts/${script}`), resolve(packageRoot, `scripts/${script}`));
}
writeFileSync(resolve(packageRoot, "package.json"), `${JSON.stringify({
  name: "signal-expert",
  version,
  private: true,
  type: "module",
  engines: { node: ">=22.5" },
  scripts: { start: "node launcher.mjs --instance phase2 --port 4020 --strict-port --database data/instances/phase2/signal-expert.db --stream", "start:4020": "node launcher.mjs --instance phase2 --port 4020 --strict-port --database data/instances/phase2/signal-expert.db --stream", "db:migrate": "node scripts/migrate.mjs", replay: "node scripts/replay.mjs" },
}, null, 2)}\n`);
console.log(packageRoot);
