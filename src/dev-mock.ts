/* معاينة التصميم في المتصفح فقط (npm run dev خارج Tauri): بيانات تجريبية بدل Rust.
   لا تدخل في نسخة التطبيق لأن main.tsx يستوردها فقط في وضع التطوير. */
import type { HistoryEntry } from "./api";

type Handler = (e: { event: string; payload: unknown }) => void;

const callbacks = new Map<number, Handler>();
const listeners = new Map<string, number[]>();
let nextCb = 1;
let nextJob = 100;

const SAVED = "khama.mock.settings";

const settings = {
  outputDir: "C:\\Users\\me\\Videos\\Khama",
  language: "ar",
  theme: "dark",
  layoutDir: "rtl",
  kind: "video",
  videoFormat: "mp4",
  audioFormat: "mp3",
  quality: "1080",
  editorReady: true,
  cookiesMode: "none",
  cookiesBrowser: "chrome",
  acceptedNotice: true,
  seenTour: false,
  convertDest: "output",
  convertPreset: "editing",
  convertHw: false,
  watchFolders: [],
  filenameTemplate: "{title}",
  siteFolders: false,
  kindFolders: false,
  rateLimitKb: 0,
  notify: true,
  closeToTray: false,
  watchClipboard: false,
  clipboardOnFocus: true,
  checkUpdates: true,
  recentDirs: ["C:\\Users\\me\\Videos\\Khama", "D:\\Projects\\Reel-14\\footage"],
  wantSubs: false,
  subLangs: [],
  wantThumb: false,
  wantInfo: false,
  projects: [],
  activeProject: null,
  mobileBase: "Download",
  mobileFolder: "Khama",
};

// يحفظ ما يغيّره المستخدم في المتصفح كما يفعل التطبيق على القرص، فتبقى اللغة والثيم بعد إعادة التحميل.
// اختبارات الطرف للطرف (e2e/) تزرع هذا المفتاح لبدء كل اختبار بإعدادات معروفة.
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SAVED) ?? "{}"));
} catch {
  /* لا تخزين: تبقى الافتراضيات */
}

/** معاينة وهمية: الناتج يتبع النسبة والتدوير حتى يظهر أثر الخيارات في المتصفح */
function mockPreview(o: Record<string, unknown>) {
  const svg = (w: number, h: number, label: string, tint: string) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#1e3a5f"/><stop offset="1" stop-color="${tint}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(h / 10)}" text-anchor="middle">${label}</text></svg>`,
    );
  let [w, h] = [480, 270];
  const aspect = typeof o.aspect === "string" ? o.aspect.split(":").map(Number) : null;
  if (aspect)
    [w, h] = aspect[0] / aspect[1] > w / h ? [w, Math.round(w / (aspect[0] / aspect[1]))] : [Math.round(h * (aspect[0] / aspect[1])), h];
  if (o.rotate === "90" || o.rotate === "270") [w, h] = [h, w];
  const tags = [
    o.aspect,
    o.rotate && `rot ${o.rotate}`,
    o.lut && "LUT",
    o.watermark && "logo",
    o.timecode && "TC",
    o.enhance && `enhance ${o.enhance}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { source: svg(480, 270, "source", "#7c3aed"), output: svg(w, h, tags || "output", o.lut ? "#d97706" : "#7c3aed") };
}

const thumb = (seed: string) => {
  const h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},45%,35%)"/><stop offset="1" stop-color="hsl(${(h + 60) % 360},50%,20%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>`,
    )
  );
};

{
  const q = new URLSearchParams(location.search);
  if (q.get("lang")) settings.language = q.get("lang") as string;
  if (q.get("theme")) settings.theme = q.get("theme") as string;
  if (q.get("dir")) settings.layoutDir = q.get("dir") as string;
  settings.seenTour = !q.get("tour");
}
const history: HistoryEntry[] = [
  {
    id: 1,
    title: "لقطات جوية لمدينة الرياض وقت الغروب 4K",
    url: "https://youtu.be/a",
    file: "C:\\x\\a.mp4",
    kind: "video",
    meta: "MP4 · 4K",
    thumbnail: thumb("riyadh"),
    date: Date.now() - 3600e3,
    exists: true,
  },
  {
    id: 2,
    title: "Ambient drone pad — free for editing",
    url: "https://soundcloud.com/b",
    file: "C:\\x\\b.mp3",
    kind: "audio",
    meta: "MP3",
    thumbnail: thumb("pad"),
    date: Date.now() - 5 * 3600e3,
    exists: true,
  },
  {
    id: 3,
    title: "مقابلة كاملة: كيف تبني قصة في ٦٠ ثانية",
    url: "https://x.com/c",
    file: "C:\\x\\c.mp4",
    kind: "video",
    meta: "MP4 · 1080p",
    thumbnail: thumb("talk"),
    date: Date.now() - 30 * 3600e3,
    exists: false,
  },
];

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload });
}

/** ما سيُكتب في السجلّ عند انتهاء العملية (يكتبه Rust في التطبيق) */
type Pending = { title: string; meta: string; thumbnail?: string | null; url: string; kind: string };
const pending = new Map<number, Pending>();

function fakeJob(id: number) {
  let p = 0;
  emit("job-update", { id, state: "analyzing" });
  const t = setInterval(() => {
    p += 7;
    if (p >= 100) {
      clearInterval(t);
      const h = pending.get(id);
      if (h) {
        const file = "C:\\x\\done.mp4";
        history.unshift({
          id,
          title: h.title,
          url: h.url,
          file,
          kind: h.kind as HistoryEntry["kind"],
          meta: h.meta,
          thumbnail: h.thumbnail ?? undefined,
          date: Date.now(),
          exists: true,
        });
      }
      emit("job-update", { id, state: "done", percent: 100, file: "C:\\x\\done.mp4" });
    } else emit("job-update", { id, state: "downloading", stage: "video", percent: p, speed: 4.2e6, eta: (100 - p) / 7 });
  }, 600);
}

/** كشف الصمت: وقفات ومستوى صوت مصطنع (كلام بين −22 و−14 dB، وخلفية −64 dB في الوقفات) لـ 40 ث */
function fakeSilence(id: number) {
  const markers: [number, number][] = [
    [3.1, 4.4],
    [9.8, 10.6],
    [17.2, 19.9],
    [26.4, 27.3],
    [33, 34.8],
  ];
  const step = 0.04;
  const envelope = Array.from({ length: 1000 }, (_, i) => {
    const t = i * step;
    return markers.some(([s, e]) => t >= s && t < e) ? -64 + Math.sin(i) * 2 : -18 + Math.sin(i / 3) * 4;
  });
  emit("job-update", { id, state: "analyzing", percent: 60 });
  setTimeout(
    () =>
      emit("job-update", {
        id,
        state: "done",
        percent: 100,
        markers,
        levels: { noise: -63.8, speech: -18.3, threshold: -50.1, manual: false, envelope, envStart: 0, envStep: step },
      }),
    600,
  );
}

/** تحليل المواضيع: نتيجة حقيقية من khama-bench على فيديو كلام (مختصرة) */
function fakeTopics(id: number) {
  emit("job-update", { id, state: "analyzing", percent: 40 });
  setTimeout(
    () =>
      emit("job-update", {
        id,
        state: "done",
        percent: 100,
        transcript: "captions",
        levels: { noise: -63.8, speech: -18.3, threshold: -50.1, manual: false },
        markers: [
          [60.2, 63.4],
          [120.5, 121.6],
          [180.4, 181.6],
          [300.1, 302.9],
        ],
        cues: [
          { start: 0.2, end: 4, text: "what are seven tips for presenting on camera?" },
          { start: 4.2, end: 9, text: "let's find out." },
          { start: 140, end: 179.9, text: "it's not supposed to be in the middle." },
          { start: 182, end: 230, text: "this does not look good, so move it." },
          { start: 282, end: 290, text: "أن العلاقة مع الذات قائمة على التزكية." },
        ],
        topics: [
          { start: 0.2, end: 51, title: "passionate · seven · tips", text: "what are seven tips for presenting on camera let's find out…" },
          {
            start: 51,
            end: 89.8,
            title: "gotta · boring · business",
            text: "business presentation in front of the camera they're not passionate…",
          },
          {
            start: 89.8,
            end: 137.8,
            title: "almost · touching · head",
            text: "here's what a lot of people do they're presenting like this…",
          },
          {
            start: 137.8,
            end: 231.9,
            title: "looking · lens · look",
            text: "it's not supposed to be in the middle this does not look good…",
          },
          {
            start: 282,
            end: 319.9,
            title: "يسيء · بنفسه · الظن",
            text: "أن العلاقة مع الذات قائمة على التزكية. تقول أن الذات جسد وشيء آخر…",
          },
        ],
      }),
    800,
  );
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  switch (cmd) {
    case "get_settings":
    case "read_settings_file":
      return structuredClone(settings);
    case "save_settings":
      Object.assign(settings, args.settings);
      try {
        localStorage.setItem(SAVED, JSON.stringify(settings));
      } catch {
        /* لا تخزين */
      }
      return null;
    case "default_output_dir":
      return "C:\\Users\\me\\Downloads";
    case "get_history":
      return history;
    case "remove_history_many": {
      const ids = new Set((args as { ids: number[] }).ids);
      for (let i = history.length - 1; i >= 0; i--) if (ids.has(history[i].id)) history.splice(i, 1);
      return null;
    }
    case "get_scheduled":
      return [];
    case "tools_info":
      return { ytdlp: "2026.10.22", ffmpeg: "7.1", deno: "2.4" };
    case "hw_encoders":
      return ["h264_nvenc"];
    case "has_saved_cookies":
      return false;
    case "probe": {
      const url = String(args.url);
      if (url.includes("bad")) throw { code: "unavailable", detail: "ERROR: [youtube] xyz: Video unavailable" };
      if (url.includes("offline")) throw { code: "network", detail: "ERROR: Unable to download webpage: <urlopen error [Errno -3]>" };
      await new Promise((r) => setTimeout(r, 700));
      // قائمة تشغيل كبيرة لتجربة «اعرض المزيد»
      if (url.includes("list="))
        return {
          title: "قائمة طويلة",
          site: "YouTube",
          heights: [1080, 720],
          isLive: false,
          subtitles: [],
          entries: Array.from({ length: 450 }, (_, i) => ({ url: `https://youtu.be/v${i}`, title: `فيديو ${i + 1}`, duration: 60 + i })),
        };
      return {
        title: "كيف تصوّر لقطات سينمائية بهاتفك — دليل كامل للمبتدئين",
        thumbnail: thumb("cine"),
        duration: 754,
        uploader: "استوديو الضوء",
        site: "YouTube",
        heights: [2160, 1440, 1080, 720, 480],
        isLive: false,
        subtitles: [
          { code: "ar", name: "العربية", auto: false },
          { code: "en", name: "English", auto: true },
        ],
        previewUrl: null,
        original: false,
      };
    }
    // المحوّل في المتصفح: اختيار ملف وهمي وتحليله
    case "plugin:dialog|open":
      // «أضف مجلدًا» يعطي مجلدًا يتوسّع إلى ملفين (expand_media_paths أدناه)
      if ((args.options as { directory?: boolean } | undefined)?.directory) return ["C:\\Users\\me\\Videos\\Shoot"];
      return ["C:\\Users\\me\\Videos\\clip-phone.mp4"];
    case "sample_estimate":
      return { bytes: 41_500_000, seconds: (args.options as { enhance?: string }).enhance === "strong" ? 412 : 95 };
    case "preview_frame":
      return mockPreview(args.options as Record<string, unknown>);
    case "analyze_file":
      return {
        path: String(args.path),
        name: String(args.path).split("\\").pop(),
        size: 184_000_000,
        duration: 95,
        container: "mp4",
        bitrate: 15_000_000,
        video: {
          codec: "hevc",
          width: 1920,
          height: 1080,
          fps: 29.97,
          vfr: true,
          pixFmt: "yuv420p10le",
          bitDepth: 10,
          hdr: false,
          interlaced: false,
        },
        audio: [{ codec: "aac", channels: 2, sampleRate: 48000 }],
        subtitles: 0,
        thumbnail: null,
        issues: ["vfr", "tenBit", "heavyCodec"],
      };
    case "ai_ready":
      return false;
    // تايم لاين للمونتاج (R3-F10): الملفات التي كان Rust سيكتبها بجانب الإعدادات
    case "export_timeline": {
      const req = (args.request ?? {}) as { name?: string; cues?: unknown[]; markers?: unknown[]; markersOnly?: boolean };
      const base = `C:\\Users\\me\\Downloads\\Khama\\${req.name ?? "timeline"}`;
      const marks = req.markersOnly ? [".csv"] : req.markers?.length ? [" markers.edl"] : [];
      return [".xml", ".edl", ...marks, ...(req.cues?.length ? [".srt"] : [])].map((e) => `${base}${e}`);
    }
    // تصدير موضوع باسم عنوانه (R3-U5): المجلد نفسه والامتداد نفسه
    case "rename_export": {
      const p = String(args.path ?? "");
      const ext = p.includes(".") ? p.slice(p.lastIndexOf(".")) : "";
      return `${p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1)}${String(args.name ?? "clip")}${ext}`;
    }
    case "counter_next":
      return 4;
    case "reset_counter":
      return 1;
    case "new_job_id":
      return nextJob++;
    // المتصفح لا يقرأ المجلدات: الملف كما هو، والمجلد (بلا امتداد) ملفان وهميان
    case "expand_media_paths":
      return ((args.paths as string[] | undefined) ?? []).flatMap((p) =>
        /[.][^\\/]+$/.test(p) ? [p] : [`${p}\\interview-a.mp4`, `${p}\\interview-b.mp4`],
      );
    case "find_subtitles":
      // الملف الأول في القائمة له ترجمة بجانبه، والباقي بلا
      return ((args.paths as string[] | undefined) ?? []).map((p, i) => (i === 0 ? p.replace(/[.][^.]+$/, ".srt") : null));
    case "start_download":
    case "start_convert": {
      const id = typeof args.id === "number" ? args.id : nextJob++;
      const req = (args.request ?? {}) as {
        url?: string;
        kind?: string;
        history?: { title: string; meta: string; thumbnail?: string | null };
      };
      if (req.history)
        pending.set(id, { ...req.history, url: req.url ?? "", kind: cmd === "start_convert" ? "convert" : (req.kind ?? "video") });
      const preset = (args.request as { preset?: string } | undefined)?.preset;
      if (preset === "topics") setTimeout(() => fakeTopics(id), 50);
      else if (preset === "detect_silence") setTimeout(() => fakeSilence(id), 50);
      else setTimeout(() => fakeJob(id), 50);
      return id;
    }
    case "plugin:event|listen": {
      const ev = String(args.event);
      listeners.set(ev, [...(listeners.get(ev) ?? []), Number(args.handler)]);
      return Number(args.handler);
    }
    // بلا نسخة لا يظهر «ما الجديد» في المعاينة؛ لتجربته: localStorage["khama.mockVersion"] = "0.3.47"
    case "plugin:app|version":
      return localStorage.getItem("khama.mockVersion");
    default:
      return null;
  }
}

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: Handler) => {
      const id = nextCb++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

export {};
