import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("distribution includes cross-platform conflict-resistant launchers", () => {
  const launcher = readFileSync("launcher.mjs", "utf8");
  const windows = readFileSync("START-SIGNAL-EXPERT.cmd", "utf8");
  const unix = readFileSync("start-signal-expert.sh", "utf8");
  assert.match(launcher, /findPort/);
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /launcher\.lock/);
  assert.match(launcher, /waitForHealth/);
  assert.match(windows, /node launcher\.mjs/);
  assert.match(unix, /exec node launcher\.mjs/);
});
