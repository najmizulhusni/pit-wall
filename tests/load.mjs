/*
  Loads the browser scripts into Node the same way the nightly snapshot does: as classic scripts
  sharing one global. Each call gets a fresh global so tests can't leak state into each other.
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* Values made inside the sandbox have the sandbox's Array and Object; compare them as plain data. */
export const plain = v => JSON.parse(JSON.stringify(v));

export function load(files, globals = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, performance, AbortController, URL, ...globals });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), ctx, { filename: f });
  return ctx;
}
