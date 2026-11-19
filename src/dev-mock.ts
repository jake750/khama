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
  const tags = [o.aspect, o.rotate && `rot ${o.rotate}`, o.lut && "LUT", o.watermark && "logo", o.timecode && "TC"]
    .filter(Boolean)
    .join(" · ");
  return { source: svg(480, 270, "source", "#7c3aed"), output: svg(w, h, tags || "output", o.lut ? "#d97706" : "#7c3aed") };
}

const thumb = (seed: string) => `https://picsum.photos/seed/${seed}/320/180`;

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
      return ["C:\\Users\\me\\Videos\\clip-phone.mp4"];
    case "sample_estimate":
      return 41_500_000;
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
    case "counter_next":
      return 4;
    case "reset_counter":
      return 1;
    case "new_job_id":
      return nextJob++;
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
      setTimeout(() => fakeJob(id), 50);
      return id;
    }
    case "plugin:event|listen": {
      const ev = String(args.event);
      listeners.set(ev, [...(listeners.get(ev) ?? []), Number(args.handler)]);
      return Number(args.handler);
    }
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
