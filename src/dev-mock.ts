/* معاينة التصميم في المتصفح فقط (npm run dev خارج Tauri): بيانات تجريبية بدل Rust.
   لا تدخل في نسخة التطبيق لأن main.tsx يستوردها فقط في وضع التطوير. */
type Handler = (e: { event: string; payload: unknown }) => void;

const callbacks = new Map<number, Handler>();
const listeners = new Map<string, number[]>();
let nextCb = 1;
let nextJob = 100;

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
  convertDest: "source",
  convertPreset: "editing",
  convertHw: false,
  watchFolders: [],
  filenameTemplate: "{title}",
  siteFolders: false,
  rateLimit: 0,
  notify: true,
  closeToTray: false,
  watchClipboard: false,
  recentDirs: ["C:\\Users\\me\\Videos\\Khama", "D:\\Projects\\Reel-14\\footage"],
  wantSubs: false,
  subLangs: [],
  wantThumb: false,
  wantInfo: false,
  projects: [],
  activeProject: null,
};

const thumb = (seed: string) => `https://picsum.photos/seed/${seed}/320/180`;

const history = [
  { id: 1, title: "لقطات جوية لمدينة الرياض وقت الغروب 4K", url: "https://youtu.be/a", file: "C:\\x\\a.mp4", kind: "video", meta: "MP4 · 4K", thumbnail: thumb("riyadh"), date: Date.now() - 3600e3, exists: true },
  { id: 2, title: "Ambient drone pad — free for editing", url: "https://soundcloud.com/b", file: "C:\\x\\b.mp3", kind: "audio", meta: "MP3", thumbnail: thumb("pad"), date: Date.now() - 5 * 3600e3, exists: true },
  { id: 3, title: "مقابلة كاملة: كيف تبني قصة في ٦٠ ثانية", url: "https://x.com/c", file: "C:\\x\\c.mp4", kind: "video", meta: "MP4 · 1080p", thumbnail: thumb("talk"), date: Date.now() - 30 * 3600e3, exists: false },
];

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload });
}

function fakeJob(id: number) {
  let p = 0;
  emit("job-update", { id, state: "analyzing" });
  const t = setInterval(() => {
    p += 7;
    if (p >= 100) {
      clearInterval(t);
      emit("job-update", { id, state: "done", percent: 100, file: "C:\\x\\done.mp4" });
    } else emit("job-update", { id, state: "downloading", stage: "video", percent: p, speed: 4.2e6, eta: (100 - p) / 7 });
  }, 600);
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  switch (cmd) {
    case "get_settings":
      return structuredClone(settings);
    case "default_output_dir":
      return "C:\\Users\\me\\Downloads";
    case "get_history":
      return history;
    case "tools_info":
      return { ytdlp: "2026.10.22", ffmpeg: "7.1", deno: "2.4" };
    case "hw_encoders":
      return ["h264_nvenc"];
    case "has_saved_cookies":
      return false;
    case "probe": {
      const url = String(args.url);
      if (url.includes("bad")) throw { code: "unavailable", detail: "ERROR: [youtube] xyz: Video unavailable" };
      await new Promise((r) => setTimeout(r, 700));
      return {
        title: "كيف تصوّر لقطات سينمائية بهاتفك — دليل كامل للمبتدئين",
        thumbnail: thumb("cine"),
        duration: 754,
        uploader: "استوديو الضوء",
        site: "YouTube",
        heights: [2160, 1440, 1080, 720, 480],
        isLive: false,
        subtitles: [{ code: "ar", name: "العربية", auto: false }, { code: "en", name: "English", auto: true }],
        previewUrl: null,
        original: false,
      };
    }
    case "start_download":
    case "start_convert": {
      const id = nextJob++;
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
