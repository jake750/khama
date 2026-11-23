#!/usr/bin/env node
// يُنزّل الأدوات المضمّنة مع التطبيق من مصادرها الرسمية، بالإصدارات المثبّتة في
// scripts/binaries.lock.json، ويتحقق من بصمة SHA-256 المحفوظة في المستودع لكل ملف
// (لا من ملف بصمات على نفس الخادم). نفس الكود = نفس الأدوات في كل بناء:
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
//   node scripts/fetch-binaries.mjs --update-lock         ← ابحث عن أحدث الإصدارات واكتب ملف القفل
//                                                           (راجع الفرق ثم اعمل commit)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src-tauri", "binaries");
const FF_DIR = path.join(OUT, "ffmpeg");
const LOCK = path.join(ROOT, "scripts", "binaries.lock.json");

const args = process.argv.slice(2);
const force = args.includes("--force");

// مصادر الإصدارات (يقرؤها --update-lock فقط؛ التنزيل العادي يقرأ ملف القفل)
// بناءات FFmpeg (GPL، نسخة "shared" لتقليل الحجم):
// Windows من yt-dlp/FFmpeg-Builds (التي يوصي بها yt-dlp)، و Linux من BtbN/FFmpeg-Builds
// (المصدر الأصلي لتلك البناءات، لأن yt-dlp لا ينشر نسخة shared لـ Linux).
// نثبّت وسم autobuild-… (محتواه لا يتغيّر) لا "latest".
// macOS: لا توجد بناءات رسمية، نستخدم martin-riedl.de (FFmpeg 9.0.2، لكل معمارية)
const MRIEDL = "https://ffmpeg.martin-riedl.de/download/macos";

const SOURCES = {
  "x86_64-pc-windows-msvc": {
    ytdlp: "yt-dlp.exe",
    ffmpeg: { repo: "yt-dlp/FFmpeg-Builds", asset: /^ffmpeg-N-.*-win64-gpl-shared\.zip$/ },
    deno: "deno-x86_64-pc-windows-msvc.zip",
  },
  "x86_64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux",
    ffmpeg: { repo: "BtbN/FFmpeg-Builds", asset: /^ffmpeg-N-.*-linux64-gpl-shared\.tar\.xz$/ },
    deno: "deno-x86_64-unknown-linux-gnu.zip",
  },
  "aarch64-unknown-linux-gnu": {
    ytdlp: "yt-dlp_linux_aarch64",
    ffmpeg: { repo: "BtbN/FFmpeg-Builds", asset: /^ffmpeg-N-.*-linuxarm64-gpl-shared\.tar\.xz$/ },
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

/** ينزّل ملفًا من ملف القفل ويرفضه إن لم تطابق بصمته البصمة المحفوظة في المستودع */
async function fetchLocked({ url, sha256: hash }) {
  let buf;
  try {
    buf = await download(url);
  } catch (e) {
    throw new Error(`${e.message}\n  (إن حُذف هذا الإصدار من مصدره: node scripts/fetch-binaries.mjs --update-lock)`);
  }
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
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
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

// ---------- تحديث ملف القفل ----------

async function github(pathname) {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${pathname}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${pathname}: HTTP ${res.status}`);
  return res.json();
}

/**
 * أحدث بناء تلقائي بوسم ثابت (لا "latest" الذي يتغيّر محتواه)، من بناءات آخر الشهر فقط:
 * المستودعان يحذفان البناءات اليومية بعد أسبوعين تقريبًا ويُبقيان بناء آخر يوم من كل شهر لسنتين،
 * فوسم يومي في ملف القفل يعطي 404 بعد أيام ويوقف بناء الإصدارات كله
 */
function isMonthEnd(tag) {
  const m = /^autobuild-(\d{4})-(\d{2})-(\d{2})/.exec(tag);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate() === d;
}

async function latestAutobuild(repo) {
  const releases = await github(`${repo}/releases?per_page=100`);
  const rel = releases.filter((r) => isMonthEnd(r.tag_name)).sort((a, b) => b.tag_name.localeCompare(a.tag_name))[0];
  if (!rel) throw new Error(`لا يوجد autobuild لآخر الشهر في ${repo}`);
  return rel;
}

async function updateLock() {
  const yt = (await github("yt-dlp/yt-dlp/releases/latest")).tag_name;
  const ytBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${yt}`;
  const deno = (await github("denoland/deno/releases/latest")).tag_name;
  const denoBase = `https://github.com/denoland/deno/releases/download/${deno}`;
  const builds = {};
  const targets = {};
  for (const [t, src] of Object.entries(SOURCES)) {
    console.log(`• ${t}`);
    let ffmpeg;
    if (src.ffmpeg.mac) {
      ffmpeg = [];
      for (const tool of ["ffmpeg", "ffprobe"]) {
        const url = `${src.ffmpeg.mac}/${tool}.zip`;
        ffmpeg.push({ url, sha256: await expectedHash(`${url}.sha256`, `${tool}.zip`) });
      }
    } else {
      builds[src.ffmpeg.repo] ??= await latestAutobuild(src.ffmpeg.repo);
      const rel = builds[src.ffmpeg.repo];
      const asset = rel.assets.find((a) => src.ffmpeg.asset.test(a.name));
      const sums = rel.assets.find((a) => a.name === "checksums.sha256");
      if (!asset || !sums) throw new Error(`لم أجد ${src.ffmpeg.asset} أو بصماته في ${src.ffmpeg.repo} ${rel.tag_name}`);
      ffmpeg = [{ url: asset.browser_download_url, sha256: await expectedHash(sums.browser_download_url, asset.name) }];
    }
    const denoUrl = `${denoBase}/${src.deno}`;
    targets[t] = {
      ytdlp: { url: `${ytBase}/${src.ytdlp}`, sha256: await expectedHash(`${ytBase}/SHA2-256SUMS`, src.ytdlp) },
      deno: { url: denoUrl, sha256: await expectedHash(`${denoUrl}.sha256sum`, src.deno) },
      ffmpeg,
    };
  }
  const lock = {
    comment: "يُكتب بـ node scripts/fetch-binaries.mjs --update-lock — لا تعدّله يدويًا",
    versions: { "yt-dlp": yt, deno, ffmpeg: Object.fromEntries(Object.entries(builds).map(([r, b]) => [r, b.tag_name])) },
    targets,
  };
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`✔ ${path.relative(ROOT, LOCK)}: yt-dlp ${yt}، deno ${deno}`);
}

if (args.includes("--update-lock")) {
  try {
    await updateLock();
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exitCode = 1;
  }
} else {
  await fetchAll();
}

// ---------- التنزيل ----------

async function fetchAll() {
  const target = args.find((a) => !a.startsWith("--")) ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];
  const plan = JSON.parse(fs.readFileSync(LOCK, "utf8")).targets[target];
  if (!plan) {
    console.error(`✖ نظام غير مدعوم: ${target}`);
    process.exitCode = 1;
    return;
  }
  const exe = target.includes("windows") ? ".exe" : "";
  const sidecar = (name) => path.join(OUT, `${name}-${target}${exe}`);

  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "khama-bin-"));
  console.log(`تجهيز الأدوات لـ ${target}`);

  // تغيّرت الإصدارات في ملف القفل منذ آخر تنزيل؟ نعيد تنزيل كل شيء
  const applied = path.join(OUT, `.lock-${target}`);
  const want = JSON.stringify(plan);
  const redo = force || !fs.existsSync(applied) || fs.readFileSync(applied, "utf8") !== want;

  try {
    // 1) yt-dlp
    if (redo || !fs.existsSync(sidecar("khama-yt-dlp"))) {
      console.log("• yt-dlp");
      const buf = await fetchLocked(plan.ytdlp);
      fs.writeFileSync(path.join(work, "yt-dlp"), buf);
      place(path.join(work, "yt-dlp"), sidecar("khama-yt-dlp"));
    }

    // 2) deno
    if (redo || !fs.existsSync(sidecar("khama-deno"))) {
      console.log("• deno (يحتاجه yt-dlp لفك حماية يوتيوب)");
      const buf = await fetchLocked(plan.deno);
      extract(buf, path.basename(plan.deno.url), path.join(work, "deno"));
      place(findFile(path.join(work, "deno"), `/deno${exe}`), sidecar("khama-deno"));
    }

    // 3) ffmpeg + ffprobe (+ مكتباتهما)
    const marker = path.join(FF_DIR, ".target");
    const haveFF = fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === target;
    if (redo || !haveFF) {
      console.log("• ffmpeg + ffprobe");
      fs.rmSync(FF_DIR, { recursive: true, force: true });
      const src = path.join(work, "ff");

      if (target.includes("apple")) {
        for (const item of plan.ffmpeg) {
          const tool = path.basename(item.url, ".zip");
          extract(await fetchLocked(item), `${tool}.zip`, path.join(src, tool));
          place(findFile(path.join(src, tool), `/${tool}`), path.join(FF_DIR, "bin", tool));
        }
      } else {
        const [item] = plan.ffmpeg;
        extract(await fetchLocked(item), path.basename(new URL(item.url).pathname), src);
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
    fs.writeFileSync(applied, want);
    console.log("جاهز ✔");
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
