import { cpSync, mkdirSync, rmSync } from "node:fs";
const destination = new URL("../dist/", import.meta.url);
rmSync(destination, { recursive: true, force: true }); mkdirSync(destination, { recursive: true });
for (const directory of ["app", "public", "migrations"]) cpSync(new URL(`../${directory}/`, import.meta.url), new URL(`${directory}/`, destination), { recursive: true });
cpSync(new URL("../package.json", import.meta.url), new URL("package.json", destination));
console.log("Production artifact created in dist/");
