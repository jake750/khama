// رسوم توضيحية صغيرة لكل خاصية في الدليل والجولة.
// عند أول فتح لا يوجد فيديو ولا قائمة، فالرسم يُريك شكل الخاصية بدلًا منها.
// كلها SVG بألوان الثيم (متغيرات CSS في guide.css) فتتبع الوضع الفاتح والداكن، وبلا نصوص لغوية.

import type { ReactNode } from "react";

export type ArtName =
  | "link"
  | "format"
  | "trim"
  | "playlist"
  | "stems"
  | "stills"
  | "extras"
  | "timeline"
  | "schedule"
  | "convert"
  | "checks"
  | "hw"
  | "more"
  | "detect"
  | "history"
  | "drag"
  | "projects"
  | "watch"
  | "mini"
  | "background"
  | "names"
  | "cookies"
  | "update"
  | "tabs"
  | "guide";

/** سطر نصّ وهمي */
const Bar = ({ x, y, w, h = 6, c = "il-ink" }: { x: number; y: number; w: number; h?: number; c?: string }) => (
  <rect className={c} x={x} y={y} width={w} height={h} rx={h / 2} />
);

/** صورة مصغّرة لفيديو بزر تشغيل */
const Thumb = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
  <g>
    <rect className="il-thumb" x={x} y={y} width={w} height={h} rx={5} />
    <path className="il-on-thumb" d={`M${x + w / 2 - 4} ${y + h / 2 - 5}v10l8-5z`} />
  </g>
);

/** ملف صغير عليه اسم صيغة (لاتيني فلا يحتاج ترجمة) */
const Doc = ({ x, y, label, accent }: { x: number; y: number; label: string; accent?: boolean }) => (
  <g>
    <path className={accent ? "il-card il-stroke-acc" : "il-card il-stroke"} d={`M${x} ${y}h28l10 10v36h-38z`} />
    <path className="il-stroke" d={`M${x + 28} ${y}v10h10`} fill="none" />
    <rect className={accent ? "il-acc" : "il-chip"} x={x + 4} y={y + 30} width={30} height={11} rx={3} />
    <text className={accent ? "il-label il-label-ink" : "il-label"} x={x + 19} y={y + 38.5} textAnchor="middle">
      {label}
    </text>
  </g>
);

/** شريط أفلام (إطارات متتالية) */
const Strip = ({ x, y, w, h, n }: { x: number; y: number; w: number; h: number; n: number }) => (
  <g>
    <rect className="il-thumb" x={x} y={y} width={w} height={h} rx={4} />
    {Array.from({ length: n - 1 }, (_, i) => (
      <line key={i} className="il-gap" x1={x + ((i + 1) * w) / n} x2={x + ((i + 1) * w) / n} y1={y} y2={y + h} />
    ))}
  </g>
);

/** أعمدة موجة صوتية بارتفاعات ثابتة */
const WAVE = [6, 12, 20, 9, 16, 26, 14, 8, 18, 24, 10, 15, 22, 7, 13, 19, 11, 25, 9, 14];
const Wave = ({ x, y, n, c, gap = 6, scale = 1 }: { x: number; y: number; n: number; c: string; gap?: number; scale?: number }) => (
  <g>
    {WAVE.slice(0, n).map((h, i) => (
      <rect key={i} className={c} x={x + i * gap} y={y - (h * scale) / 2} width={3} height={h * scale} rx={1.5} />
    ))}
  </g>
);

const Check = ({ x, y, on = true }: { x: number; y: number; on?: boolean }) => (
  <g>
    <rect className={on ? "il-acc" : "il-card il-stroke"} x={x} y={y} width={12} height={12} rx={3.5} />
    {on && <path className="il-tick" d={`M${x + 3} ${y + 6.2}l2.2 2.3 4-4.6`} />}
  </g>
);

const ART: Record<ArtName, ReactNode> = {
  link: (
    <>
      <rect className="il-card il-stroke-acc" x={18} y={18} width={204} height={30} rx={9} />
      <path className="il-line-acc" d="M33 33h0" />
      <circle className="il-acc" cx={34} cy={33} r={4} />
      <Bar x={46} y={30} w={96} />
      <rect className="il-acc il-blink" x={146} y={26} width={2} height={14} rx={1} />
      <rect className="il-acc" x={172} y={24} width={42} height={18} rx={6} />
      <Bar x={182} y={30} w={22} c="il-ink-on" />
      <g className="il-rise">
        <Thumb x={18} y={62} w={76} h={46} />
        <Bar x={106} y={70} w={92} h={7} c="il-ink-strong" />
        <Bar x={106} y={84} w={60} />
        <Bar x={106} y={96} w={40} c="il-ink-soft" />
      </g>
    </>
  ),
  format: (
    <>
      <rect className="il-chip" x={18} y={20} width={124} height={26} rx={8} />
      <rect className="il-acc" x={21} y={23} width={58} height={20} rx={6} />
      <Bar x={34} y={30} w={32} c="il-ink-on" />
      <Bar x={94} y={30} w={34} />
      {["4K", "1080", "720"].map((q, i) => (
        <g key={q}>
          <rect className={i === 1 ? "il-soft il-stroke-acc" : "il-card il-stroke"} x={18 + i * 46} y={60} width={40} height={22} rx={7} />
          <text className={i === 1 ? "il-label il-label-acc" : "il-label"} x={38 + i * 46} y={74.5} textAnchor="middle">
            {q}
          </text>
        </g>
      ))}
      <rect className="il-card il-stroke" x={18} y={94} width={204} height={20} rx={7} />
      <Bar x={28} y={101} w={70} />
      <rect className="il-acc" x={190} y={98} width={24} height={12} rx={6} />
      <circle className="il-on-thumb" cx={208} cy={104} r={4} />
      <rect className="il-ok-soft" x={156} y={22} width={66} height={22} rx={7} />
      <path className="il-tick-ok" d="M165 33l3 3 6-7" />
      <Bar x={180} y={30} w={34} c="il-ok" />
    </>
  ),
  trim: (
    <>
      <Strip x={14} y={42} w={212} h={36} n={8} />
      <rect className="il-select" x={58} y={42} width={70} height={36} />
      <rect className="il-select" x={164} y={42} width={40} height={36} />
      {[58, 128, 164, 204].map((x) => (
        <rect key={x} className="il-acc" x={x - 3} y={38} width={6} height={44} rx={3} />
      ))}
      <g className="il-scan">
        <line className="il-playhead" x1={70} x2={70} y1={30} y2={90} />
        <circle className="il-spark" cx={70} cy={30} r={4} />
      </g>
      <rect className="il-soft" x={58} y={94} width={70} height={18} rx={6} />
      <Bar x={70} y={100} w={46} c="il-acc" />
      <rect className="il-soft" x={164} y={94} width={40} height={18} rx={6} />
      <Bar x={172} y={100} w={24} c="il-acc" />
      <Bar x={14} y={20} w={60} c="il-ink-soft" />
    </>
  ),
  playlist: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} className="il-rise" style={{ animationDelay: `${i * 90}ms` }}>
          <rect className="il-card il-stroke" x={18} y={16 + i * 34} width={204} height={28} rx={8} />
          <Check x={28} y={24 + i * 34} on={i !== 2} />
          <Thumb x={48} y={20 + i * 34} w={34} h={20} />
          <Bar x={92} y={23 + i * 34} w={[96, 72, 84][i]} c={i === 2 ? "il-ink-soft" : "il-ink-strong"} />
          <Bar x={92} y={33 + i * 34} w={40} c="il-ink-soft" h={5} />
        </g>
      ))}
    </>
  ),
  stems: (
    <>
      <Wave x={16} y={64} n={12} c="il-ink-strong" />
      <path className="il-line" d="M92 64h18m-6-6 6 6-6 6" />
      <rect className="il-soft" x={120} y={22} width={104} height={34} rx={9} />
      <Wave x={130} y={39} n={14} c="il-acc" />
      <rect className="il-chip" x={120} y={72} width={104} height={34} rx={9} />
      <Wave x={130} y={89} n={14} c="il-ink-soft" scale={0.35} />
      <line className="il-strike" x1={128} x2={216} y1={89} y2={89} />
    </>
  ),
  stills: (
    <>
      <Strip x={14} y={18} w={212} h={30} n={10} />
      {[56, 120, 184].map((x) => (
        <rect key={x} className="il-spark" x={x - 1.5} y={12} width={3} height={42} rx={1.5} />
      ))}
      {[0, 1, 2].map((i) => (
        <g key={i} className="il-rise" style={{ animationDelay: `${120 + i * 110}ms` }}>
          <rect className="il-card il-stroke" x={34 + i * 62} y={64} width={52} height={48} rx={6} transform={`rotate(${[-5, 2, 6][i]} ${60 + i * 62} 88)`} />
          <rect className="il-thumb" x={38 + i * 62} y={68} width={44} height={30} rx={3} transform={`rotate(${[-5, 2, 6][i]} ${60 + i * 62} 88)`} />
        </g>
      ))}
    </>
  ),
  extras: (
    <>
      <Thumb x={18} y={30} w={72} h={44} />
      <Bar x={18} y={84} w={60} c="il-ink-soft" />
      <g className="il-rise">
        <Doc x={104} y={18} label="SRT" accent />
        <Doc x={150} y={18} label="JPG" />
        <Doc x={104} y={70} label="TXT" />
        <Doc x={150} y={70} label="XML" />
      </g>
      <path className="il-line" d="M94 52h6" />
    </>
  ),
  timeline: (
    <>
      <rect className="il-card il-stroke" x={14} y={16} width={212} height={96} rx={10} />
      <Bar x={26} y={26} w={50} c="il-ink-soft" />
      {[0, 1, 2].map((r) => (
        <rect key={r} className="il-chip" x={26} y={44 + r * 20} width={188} height={14} rx={4} />
      ))}
      <g className="il-rise">
        <rect className="il-acc" x={26} y={44} width={52} height={14} rx={4} />
        <rect className="il-acc-2" x={80} y={44} width={40} height={14} rx={4} />
        <rect className="il-acc" x={122} y={44} width={64} height={14} rx={4} />
        <rect className="il-spark" x={26} y={64} width={160} height={14} rx={4} opacity={0.55} />
      </g>
      <line className="il-playhead" x1={100} x2={100} y1={38} y2={102} />
    </>
  ),
  schedule: (
    <>
      <circle className="il-card il-stroke" cx={64} cy={64} r={40} />
      <circle className="il-soft" cx={64} cy={64} r={32} />
      <g className="il-tick-hand">
        <line className="il-hand" x1={64} y1={64} x2={64} y2={40} />
      </g>
      <line className="il-hand" x1={64} y1={64} x2={80} y2={72} />
      <circle className="il-acc" cx={64} cy={64} r={4} />
      <rect className="il-card il-stroke" x={128} y={34} width={94} height={30} rx={9} />
      <text className="il-big" x={175} y={55} textAnchor="middle">
        02:30
      </text>
      <rect className="il-chip" x={128} y={76} width={94} height={8} rx={4} />
      <rect className="il-spark" x={128} y={76} width={0} height={8} rx={4} />
      <Bar x={128} y={94} w={60} c="il-ink-soft" />
    </>
  ),
  convert: (
    <>
      <Doc x={20} y={36} label="MOV" />
      <path className="il-line" d="M70 60h22m-7-7 7 7-7 7" />
      {["H.264", "ProRes", "MP3"].map((p, i) => (
        <g key={p}>
          <rect className={i === 0 ? "il-acc" : "il-card il-stroke"} x={102} y={20 + i * 32} width={68} height={24} rx={8} />
          <text className={i === 0 ? "il-label il-label-ink" : "il-label"} x={136} y={36 + i * 32} textAnchor="middle">
            {p}
          </text>
        </g>
      ))}
      <path className="il-line" d="M176 32h12" />
      <g className="il-rise" style={{ animationDelay: "160ms" }}>
        <Doc x={190} y={36} label="MP4" accent />
      </g>
    </>
  ),
  checks: (
    <>
      <rect className="il-card il-stroke" x={14} y={16} width={212} height={56} rx={10} />
      <Thumb x={24} y={26} w={52} h={36} />
      <Bar x={88} y={30} w={90} c="il-ink-strong" />
      {["VFR", "HDR"].map((w, i) => (
        <g key={w}>
          <rect className="il-warn-soft" x={88 + i * 46} y={44} width={40} height={16} rx={5} />
          <text className="il-label il-label-warn" x={108 + i * 46} y={55.5} textAnchor="middle">
            {w}
          </text>
        </g>
      ))}
      <g className="il-rise" style={{ animationDelay: "160ms" }}>
        <rect className="il-soft il-stroke-acc" x={14} y={82} width={212} height={32} rx={10} />
        <circle className="il-acc" cx={32} cy={98} r={6} />
        <Bar x={46} y={95} w={100} />
        <rect className="il-acc" x={170} y={88} width={46} height={20} rx={6} />
        <Bar x={180} y={95} w={26} c="il-ink-on" />
      </g>
    </>
  ),
  hw: (
    <>
      <rect className="il-card il-stroke" x={34} y={28} width={72} height={72} rx={10} />
      <rect className="il-soft il-stroke-acc" x={50} y={44} width={40} height={40} rx={6} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect className="il-ink-soft" x={44 + i * 16} y={18} width={4} height={10} rx={2} />
          <rect className="il-ink-soft" x={44 + i * 16} y={100} width={4} height={10} rx={2} />
        </g>
      ))}
      <g className="il-speed">
        {[0, 1, 2].map((i) => (
          <rect key={i} className={i === 1 ? "il-acc" : "il-ink-soft"} x={124 + i * 8} y={40 + i * 20} width={[76, 90, 60][i]} height={8} rx={4} />
        ))}
      </g>
    </>
  ),
  more: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <Bar x={18} y={26 + i * 32} w={44} c="il-ink-soft" />
          <rect className="il-chip" x={78} y={27 + i * 32} width={144} height={6} rx={3} />
          <rect className="il-acc" x={78} y={27 + i * 32} width={[60, 110, 34][i]} height={6} rx={3} />
          <circle className="il-card il-stroke-acc" cx={78 + [60, 110, 34][i]} cy={30 + i * 32} r={8} />
        </g>
      ))}
      <rect className="il-thumb" x={178} y={92} width={22} height={30} rx={3} opacity={0} />
    </>
  ),
  detect: (
    <>
      <Strip x={14} y={20} w={212} h={30} n={7} />
      <Wave x={16} y={84} n={20} c="il-ink-soft" gap={10.6} scale={0.9} />
      {[74, 136, 196].map((x, i) => (
        <g key={x} className="il-rise" style={{ animationDelay: `${i * 120}ms` }}>
          <line className="il-marker" x1={x} x2={x} y1={14} y2={110} />
          <circle className="il-spark" cx={x} cy={14} r={4} />
        </g>
      ))}
    </>
  ),
  history: (
    <>
      <rect className="il-card il-stroke" x={18} y={14} width={204} height={24} rx={8} />
      <circle className="il-line" cx={32} cy={26} r={5} fill="none" />
      <Bar x={44} y={23} w={70} c="il-ink-soft" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <Thumb x={18} y={48 + i * 26} w={34} h={20} />
          <Bar x={62} y={52 + i * 26} w={[110, 86, 98][i]} c="il-ink-strong" />
          <Bar x={62} y={61 + i * 26} w={44} h={4} c="il-ink-soft" />
        </g>
      ))}
    </>
  ),
  drag: (
    <>
      <rect className="il-card il-stroke" x={130} y={26} width={96} height={86} rx={10} />
      {[0, 1, 2].map((r) => (
        <rect key={r} className="il-chip" x={140} y={60 + r * 14} width={76} height={9} rx={3} />
      ))}
      <rect className="il-acc" x={140} y={60} width={34} height={9} rx={3} />
      <Bar x={140} y={38} w={40} c="il-ink-soft" />
      <g className="il-drag">
        <rect className="il-card il-stroke-acc il-lift" x={14} y={44} width={92} height={34} rx={8} />
        <Thumb x={20} y={50} w={30} h={22} />
        <Bar x={58} y={54} w={40} c="il-ink-strong" />
        <Bar x={58} y={64} w={24} h={4} c="il-ok" />
      </g>
    </>
  ),
  projects: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <path
            className={i === 1 ? "il-soft il-stroke-acc" : "il-card il-stroke"}
            d={`M${20 + i * 70} 40h20l6 7h30a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4h-56a4 4 0 0 1-4-4v-45a4 4 0 0 1 4-4z`}
          />
          <Bar x={28 + i * 70} y={78} w={30} c={i === 1 ? "il-acc" : "il-ink-soft"} />
        </g>
      ))}
      <rect className="il-acc" x={90} y={104} width={60} height={4} rx={2} />
    </>
  ),
  watch: (
    <>
      <path className="il-card il-stroke-acc" d="M18 40h24l6 7h28a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4h-54a4 4 0 0 1-4-4v-45a4 4 0 0 1 4-4z" />
      <path className="il-line-acc" d="M34 70s6-9 14-9 14 9 14 9-6 9-14 9-14-9-14-9z" />
      <circle className="il-acc" cx={48} cy={70} r={3} />
      <path className="il-line" d="M90 66h22m-7-7 7 7-7 7" />
      <g className="il-rise">
        <path className="il-soft il-stroke-acc" d="M124 40h24l6 7h64a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4h-90a4 4 0 0 1-4-4v-45a4 4 0 0 1 4-4z" />
        <Doc x={140} y={56} label="MP4" />
        <Doc x={180} y={56} label="MP4" />
      </g>
    </>
  ),
  mini: (
    <>
      <rect className="il-card il-stroke" x={14} y={16} width={170} height={96} rx={10} />
      <Bar x={26} y={28} w={60} c="il-ink-soft" />
      <rect className="il-chip" x={26} y={44} width={146} height={56} rx={6} />
      <g className="il-rise">
        <rect className="il-card il-stroke-acc il-lift" x={140} y={52} width={86} height={58} rx={9} />
        <rect className="il-chip" x={150} y={64} width={66} height={14} rx={5} />
        <rect className="il-chip" x={150} y={90} width={66} height={6} rx={3} />
        <rect className="il-acc il-grow" x={150} y={90} width={40} height={6} rx={3} />
      </g>
    </>
  ),
  background: (
    <>
      <rect className="il-chip" x={14} y={16} width={212} height={96} rx={10} />
      <g className="il-rise">
        <rect className="il-card il-stroke il-lift" x={96} y={26} width={120} height={40} rx={9} />
        <circle className="il-soft" cx={116} cy={46} r={11} />
        <path className="il-line-acc" d="M111 50v-5a5 5 0 0 1 10 0v5l1.5 1.5h-13zM114.5 54h3" />
        <Bar x={134} y={38} w={60} c="il-ink-strong" />
        <Bar x={134} y={50} w={40} c="il-ink-soft" h={5} />
      </g>
      <rect className="il-card il-stroke" x={24} y={88} width={192} height={16} rx={5} />
      <circle className="il-acc" cx={200} cy={96} r={4} />
    </>
  ),
  names: (
    <>
      <rect className="il-card il-stroke" x={14} y={20} width={212} height={28} rx={8} />
      {[
        ["{title}", 22, 52],
        ["{date}", 80, 46],
        ["{n}", 132, 30],
      ].map(([l, x, w]) => (
        <g key={l as string}>
          <rect className="il-soft" x={x as number} y={26} width={w as number} height={16} rx={5} />
          <text className="il-label il-label-acc" x={(x as number) + (w as number) / 2} y={37.5} textAnchor="middle">
            {l}
          </text>
        </g>
      ))}
      <path className="il-card il-stroke" d="M14 64h22l5 6h26a3 3 0 0 1 3 3v34a3 3 0 0 1-3 3h-50a3 3 0 0 1-3-3v-40a3 3 0 0 1 3-3z" />
      <Bar x={84} y={70} w={120} c="il-ink-strong" />
      <Bar x={84} y={84} w={100} c="il-ink-soft" />
      <Bar x={84} y={98} w={110} c="il-ink-soft" />
    </>
  ),
  cookies: (
    <>
      <rect className="il-card il-stroke" x={14} y={16} width={212} height={96} rx={10} />
      <rect className="il-chip" x={14} y={16} width={212} height={20} rx={10} />
      {[0, 1, 2].map((i) => (
        <circle key={i} className="il-ink-soft" cx={28 + i * 10} cy={26} r={3} />
      ))}
      <circle className="il-spark-soft" cx={120} cy={72} r={24} />
      {[
        [110, 64],
        [128, 66],
        [118, 80],
        [131, 78],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} className="il-spark" cx={x} cy={y} r={3} />
      ))}
      <rect className="il-acc" x={160} y={84} width={20} height={16} rx={4} />
      <path className="il-line-acc" d="M164 84v-4a6 6 0 0 1 12 0v4" />
    </>
  ),
  update: (
    <>
      <circle className="il-soft" cx={66} cy={64} r={40} />
      <g className="il-spin">
        <path className="il-line-acc il-thick" d="M46 58a21 21 0 0 1 38-6m4 18a21 21 0 0 1-38 6" />
        <path className="il-line-acc il-thick" d="M86 42v11h-11M46 86v-11h11" />
      </g>
      <rect className="il-card il-stroke" x={124} y={46} width={98} height={36} rx={9} />
      <text className="il-big" x={173} y={69} textAnchor="middle">
        yt-dlp
      </text>
    </>
  ),
  tabs: (
    <>
      <rect className="il-card il-stroke" x={14} y={40} width={212} height={48} rx={14} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          {i === 1 && <rect className="il-soft" x={20 + i * 52} y={46} width={44} height={36} rx={10} />}
          <circle className={i === 1 ? "il-acc" : "il-ink-soft"} cx={42 + i * 52} cy={58} r={6} />
          <Bar x={30 + i * 52} y={70} w={24} h={5} c={i === 1 ? "il-acc" : "il-ink-soft"} />
        </g>
      ))}
    </>
  ),
  guide: (
    <>
      <rect className="il-card il-stroke" x={40} y={16} width={160} height={96} rx={10} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect className={i === 0 ? "il-soft" : "il-chip"} x={52} y={28 + i * 26} width={20} height={20} rx={6} />
          <Bar x={82} y={32 + i * 26} w={[90, 70, 80][i]} c="il-ink-strong" />
          <Bar x={82} y={42 + i * 26} w={50} h={4} c="il-ink-soft" />
        </g>
      ))}
      <circle className="il-acc" cx={196} cy={20} r={14} />
      <text className="il-big il-label-ink" x={196} y={26} textAnchor="middle">
        ?
      </text>
    </>
  ),
};

export function GuideArt({ name, className = "" }: { name: ArtName; className?: string }) {
  return (
    <svg className={`guide-art ${className}`} viewBox="0 0 240 128" aria-hidden="true" focusable="false">
      {ART[name]}
    </svg>
  );
}
