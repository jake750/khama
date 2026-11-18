#!/usr/bin/env node
// Longest functions and largest files in src/ and src-tauri/src (M-78).
//   node scripts/code-metrics.mjs [count]
// A rough brace counter, not a parser: good enough to see what grew too long.
// Rule of thumb: a function past 80 lines or a file past 800 is worth splitting when next touched.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const top = Number(process.argv[2] ?? 15);

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|rs)$/.test(f) && !/\.test\.tsx?$|tests\.rs$/.test(f) ? [p] : [];
  });

const START = [
  /^\s*(pub(\([a-z]+\))?\s+)?(async\s+)?fn\s+(\w+)/, // Rust
  /^\s*(export\s+)?(default\s+)?function\s+(\w+)/, // function name()
  /^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/, // const name = (…) =>
];

const fns = [];
const files = [];
for (const file of [...walk(join(root, "src")), ...walk(join(root, "src-tauri/src"))]) {
  const lines = readFileSync(file, "utf8").split("\n");
  const rel = relative(root, file).replace(/\\/g, "/");
  files.push([lines.length, rel]);
  for (let i = 0; i < lines.length; i++) {
    const m = START.map((re) => lines[i].match(re)).find(Boolean);
    if (!m) continue;
    // const f = (…) => value: an expression with no body of its own
    if (/const\s/.test(lines[i]) && /=>/.test(lines[i]) && !/=>\s*\{\s*$/.test(lines[i])) continue;
    const name = m[4] ?? m[3] ?? m[2];
    let depth = 0;
    let opened = false;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\/\/.*$/g, "")) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) break;
      if (!opened && j > i && /;\s*$/.test(lines[j])) break; // a declaration with no body
    }
    if (opened) fns.push([j - i + 1, `${rel}:${i + 1}`, name]);
  }
}

console.log(`Longest functions (top ${top})`);
for (const [n, at, name] of fns.sort((a, b) => b[0] - a[0]).slice(0, top)) console.log(`${String(n).padStart(5)}  ${name}  ${at}`);
console.log(`\nLargest files (top ${top})`);
for (const [n, f] of files.sort((a, b) => b[0] - a[0]).slice(0, top)) console.log(`${String(n).padStart(5)}  ${f}`);
