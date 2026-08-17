import { cpSync, mkdirSync, rmSync } from "node:fs";
const destination = new URL("../dist/", import.meta.url);
rmSync(destination, { recursive: true, force: true }); mkdirSync(destination, { recursive: true });
for (const directory of ["app", "public", "migrations", "docs"]) cpSync(new URL(`../${directory}/`, import.meta.url), new URL(`${directory}/`, destination), { recursive: true });
for (const file of ["package.json", "README.md", ".env.example", "launcher.mjs", "START-SIGNAL-EXPERT.cmd", "start-signal-expert.sh"]) cpSync(new URL(`../${file}`, import.meta.url), new URL(file, destination));
console.log("Production artifact created in dist/");
