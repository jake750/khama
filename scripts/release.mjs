#!/usr/bin/env node
// رفع رقم الإصدار بأمر واحد:
//   npm run release -- [patch|minor|major|X.Y.Z] [--no-git] [--dry-run]
// يغيّر الرقم في الملفات الخمسة فقط (بلا مساس بنهايات الأسطر)، ثم commit فوق HEAD الحالي
// (الذي يجب أن يحتوي origin/main) ودفع مباشر إلى main. يعمل من worktree أيضًا.
// بعدها يبني workflow "Build" كل الأنظمة والـ APK وينشر الإصدار وينشئ الوسم vX.Y.Z.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--")) ?? "patch";
const noGit = args.includes("--no-git");
const dryRun = args.includes("--dry-run");

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts })?.trim() ?? "";

const read = (f) => readFileSync(join(root, f), "utf8");
const current = JSON.parse(read("src-tauri/tauri.conf.json")).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) die(`رقم الإصدار الحالي غير مفهوم: ${current}`);
let [maj, min, pat] = m.slice(1).map(Number);

let next;
if (bump === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (bump === "minor") next = `${maj}.${min + 1}.0`;
else if (bump === "major") next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else die(`نوع رفع غير معروف: ${bump}`);
if (next === current) die(`الإصدار هو ${current} بالفعل`);

const esc = current.replace(/\./g, "\\.");
// كل ملف: نمط يطابق موضع رقم الإصدار بالضبط، وعدد المطابقات المتوقع
const targets = [
  ["src-tauri/tauri.conf.json", new RegExp(`^(\\s*"version":\\s*")${esc}(")`, "m"), 1],
  ["package.json", new RegExp(`^(\\s*"version":\\s*")${esc}(")`, "m"), 1],
  ["package-lock.json", new RegExp(`("name":\\s*"khama",\\r?\\n\\s*"version":\\s*")${esc}(")`, "g"), 2],
  ["src-tauri/Cargo.toml", new RegExp(`^(version\\s*=\\s*")${esc}(")`, "m"), 1],
  ["src-tauri/Cargo.lock", new RegExp(`(name = "khama"\\r?\\nversion = ")${esc}(")`, "g"), 1],
];

const files = targets.map(([file, re, expected]) => {
  const text = read(file);
  const found = text.match(new RegExp(re.source, "gm"))?.length ?? 0;
  if (found !== expected) die(`${file}: وُجد ${found} موضع للرقم ${current} بدل ${expected}`);
  return [file, text.replace(re, `$1${next}$2`)];
});

console.log(`${current} → ${next}`);
if (dryRun) process.exit(0);

if (!noGit) {
  if (sh("git", ["status", "--porcelain"])) die("في الشجرة تعديلات غير محفوظة: اعمل commit أولًا");
  sh("git", ["fetch", "-q", "origin", "main"]);
  try {
    sh("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  } catch {
    die("HEAD لا يحتوي origin/main: اعمل rebase على origin/main أولًا");
  }
  if (sh("git", ["ls-remote", "--tags", "origin", `refs/tags/v${next}`])) die(`الوسم v${next} موجود بالفعل`);
}

for (const [file, text] of files) writeFileSync(join(root, file), text);
console.log(`✓ عُدّلت ${files.length} ملفات`);
if (noGit) process.exit(0);

sh("git", ["add", "--", ...files.map(([f]) => f)]);
sh("git", ["commit", "-q", "-m", `الإصدار ${next}`]);
sh("git", ["push", "-q", "origin", "HEAD:main"], { stdio: "inherit" });
console.log(`✓ دُفع ${next} إلى main؛ GitHub يبني كل الأنظمة وينشر الإصدار v${next}`);
