#!/usr/bin/env node
// يُنزّل الأدوات المضمّنة مع التطبيق من مصادرها الرسمية ويتحقق من بصمة SHA-256 لكل ملف:
//
//   src-tauri/binaries/yt-dlp-<triple>[.exe]   ← sidecar (يُنسخ لاحقًا لمجلد التطبيق ليُحدَّث)
//   src-tauri/binaries/deno-<triple>[.exe]     ← sidecar (يحتاجه yt-dlp مع يوتيوب)
//   src-tauri/binaries/ffmpeg/bin/ffmpeg ...   ← مجلد كامل يُضمَّن كـ resource
//   src-tauri/binaries/ffmpeg/lib/*.so         ← (Linux فقط) المكتبات المشتركة
//
// الاستخدام:
//   node scripts/fetch-binaries.mjs                       ← لنظام جهازك
//   node scripts/fetch-binaries.mjs aarch64-apple-darwin  ← لنظام آخر (يُستخدم في CI)
//   node scripts/fetch-binaries.mjs --force               ← أعد التنزيل

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src-tauri", "binaries");
const FF_DIR = path.join(OUT, "ffmpeg");

const args = process.argv.slice(2);
const force = args.includes("--force");
const target =
  args.find((a) => !a.startsWith("--")) ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];

const YTDLP = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
// بناءات FFmpeg (GPL، نسخة "shared" لتقليل الحجم):
// Windows من yt-dlp/FFmpeg-Builds (التي يوصي بها yt-dlp)، و Linux من BtbN/FFmpeg-Builds
// (المصدر الأصلي لتلك البناءات، لأن yt-dlp لا ينشر نسخة shared لـ Linux)
const FFB = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const DENO = "https://github.com/denoland/deno/releases/latest/download";
// macOS: لا توجد بناءات رسمية، نستخدم martin-riedl.de (FFmpeg 9.0.2، لكل معمارية)
const MRIEDL = "https://ffmpeg.martin-riedl.de/download/macos";

const PLAN = {
  "x86_64-pc-windows-msvc": {
    ytdlp: "yt-dlp.exe",
    ffmpeg: { base: FFB, archive: "ffmpeg-master-latest-win64-gpl-shared.zip" },
    deno: "deno-x86_64-pc-windows-msvc.zip",
  },
  "x86_64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux",
    ffmpeg: { base: BTBN, archive: "ffmpeg-master-latest-linux64-gpl-shared.tar.xz" },
    deno: "deno-x86_64-unknown-linux-gnu.zip",
  },
  "aarch64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux_aarch64",
    ffmpeg: { base: BTBN, archive: "ffmpeg-master-latest-linuxarm64-gpl-shared.tar.xz" },
    deno: "deno-aarch64-unknown-linux-gnu.zip",
  },
  "aarch64-apple-darwin": {
    ytdlp: "yt-dlp_macos",
    ffmpeg: { mac: `${MRIEDL}/arm64/1789931890_9.0.2` },
    deno: "deno-aarch64-apple-darwin.zip",
  },
  "x86_64-apple-darwin": {
    ytdlp: "yt-dlp_macos",
    ffmpeg: { mac: `${MRIEDL}/amd64/1789931006_9.0.2` },
    deno: "deno-x86_64-apple-darwin.zip",
  },
};

const plan = PLAN[target];
if (!plan) {
  console.error(`✖ نظام غير مدعوم: ${target}`);
  process.exit(1);
}
const exe = target.includes("windows") ? ".exe" : "";
const sidecar = (name) => path.join(OUT, `${name}-${target}${exe}`);

// ---------- أدوات مساعدة ----------

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`فشل تنزيل ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// يقرأ ملف بصمات بأي من الصيغتين:
//   "<hash>  <name>" (سطر لكل ملف) أو ملف فيه بصمة واحدة فقط (مثل صيغة PowerShell عند Deno)
async function expectedHash(sumsUrl, fileName) {
  const text = (await download(sumsUrl)).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2] === fileName) return m[1].toLowerCase();
  }
  const all = text.match(/\b[0-9a-fA-F]{64}\b/g) ?? [];
  if (all.length === 1) return all[0].toLowerCase();
  throw new Error(`لم أجد بصمة ${fileName} في ${sumsUrl}`);
}

async function fetchVerified(url, sumsUrl, nameInSums = path.basename(url)) {
  const [buf, hash] = await Promise.all([download(url), expectedHash(sumsUrl, nameInSums)]);
  const got = sha256(buf);
  if (got !== hash) throw new Error(`بصمة غير مطابقة لـ ${url}\n  متوقّع: ${hash}\n  الفعلي: ${got}`);
  return buf;
}

function extract(buf, name, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  if (name.endsWith(".zip") && process.platform === "linux") {
    execFileSync("unzip", ["-o", "-q", file, "-d", dir]);
  } else {
    // tar على Windows 10+ و macOS يفك zip أيضًا.
    // على Windows نستدعي نسخة النظام صراحة، لأن tar الخاص بـ Git Bash لا يفهم مسارات C:\
    const tar =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    execFileSync(tar, ["-xf", file, "-C", dir]);
  }
  fs.rmSync(file);
}

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

function findFile(dir, suffix) {
  const hit = walk(dir).find((f) => f.replaceAll("\\", "/").endsWith(suffix));
  if (!hit) throw new Error(`لم أجد ${suffix} داخل الأرشيف`);
  return hit;
}

const mb = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;

function place(src, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
  fs.chmodSync(to, 0o755);
  console.log(`  ✔ ${path.relative(ROOT, to)}  (${mb(to)})`);
}

function dirSize(dir) {
  return walk(dir).reduce((s, f) => s + fs.statSync(f).size, 0);
}

// ---------- التنزيل ----------

fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "khama-bin-"));
console.log(`تجهيز الأدوات لـ ${target}`);

try {
  // 1) yt-dlp
  if (force || !fs.existsSync(sidecar("khama-yt-dlp"))) {
    console.log("• yt-dlp");
    const buf = await fetchVerified(`${YTDLP}/${plan.ytdlp}`, `${YTDLP}/SHA2-256SUMS`);
    fs.writeFileSync(path.join(work, "yt-dlp"), buf);
    place(path.join(work, "yt-dlp"), sidecar("khama-yt-dlp"));
  }

  // 2) deno
  if (force || !fs.existsSync(sidecar("khama-deno"))) {
    console.log("• deno (يحتاجه yt-dlp لفك حماية يوتيوب)");
    const url = `${DENO}/${plan.deno}`;
    const buf = await fetchVerified(url, `${url}.sha256sum`, plan.deno);
    extract(buf, plan.deno, path.join(work, "deno"));
    place(findFile(path.join(work, "deno"), `/deno${exe}`), sidecar("khama-deno"));
  }

  // 3) ffmpeg + ffprobe (+ مكتباتهما)
  const marker = path.join(FF_DIR, ".target");
  const haveFF = fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === target;
  if (force || !haveFF) {
    console.log("• ffmpeg + ffprobe");
    fs.rmSync(FF_DIR, { recursive: true, force: true });
    const src = path.join(work, "ff");

    if (plan.ffmpeg.mac) {
      for (const tool of ["ffmpeg", "ffprobe"]) {
        const url = `${plan.ffmpeg.mac}/${tool}.zip`;
        const buf = await fetchVerified(url, `${url}.sha256`, `${tool}.zip`);
        extract(buf, `${tool}.zip`, path.join(src, tool));
        place(findFile(path.join(src, tool), `/${tool}`), path.join(FF_DIR, "bin", tool));
      }
    } else {
      const { base, archive } = plan.ffmpeg;
      const buf = await fetchVerified(`${base}/${archive}`, `${base}/checksums.sha256`);
      extract(buf, archive, src);
      const binDir = path.dirname(findFile(src, `/bin/ffmpeg${exe}`));
      const root = path.dirname(binDir);
      // ننسخ ffmpeg و ffprobe فقط (لا ffplay)، ومعهما المكتبات المشتركة
      for (const f of walk(binDir)) {
        const n = path.basename(f);
        if (n === `ffmpeg${exe}` || n === `ffprobe${exe}` || n.endsWith(".dll")) {
          fs.mkdirSync(path.join(FF_DIR, "bin"), { recursive: true });
          fs.copyFileSync(f, path.join(FF_DIR, "bin", n));
        }
      }
      const libDir = path.join(root, "lib");
      if (fs.existsSync(libDir)) {
        fs.mkdirSync(path.join(FF_DIR, "lib"), { recursive: true });
        for (const e of fs.readdirSync(libDir, { withFileTypes: true })) {
          if (!/\.so(\.|$)/.test(e.name)) continue;
          // نتبع الروابط الرمزية وننسخ الملف الحقيقي (المُثبِّت لا يحفظ الروابط دائمًا)
          fs.copyFileSync(fs.realpathSync(path.join(libDir, e.name)), path.join(FF_DIR, "lib", e.name));
        }
      }
      for (const f of walk(FF_DIR)) fs.chmodSync(f, 0o755);
      console.log(`  ✔ src-tauri/binaries/ffmpeg/  (${(dirSize(FF_DIR) / 1e6).toFixed(1)} MB)`);
    }
    fs.writeFileSync(marker, target);
  }
  console.log("جاهز ✔");
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
