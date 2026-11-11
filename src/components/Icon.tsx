// أيقونات SVG خفيفة مرسومة يدويًا (بلا مكتبة خارجية)

const paths = {
  download: "M12 3v12m0 0-5-5m5 5 5-5M4 19h16",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7.4 7.4 0 0 0-2-1.2L14.5 3h-5l-.4 2.5a7.4 7.4 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-.9a7.4 7.4 0 0 0 2 1.2l.4 2.5h5l.4-2.5a7.4 7.4 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  paste: "M9 4h6m-6 0a2 2 0 0 0-2 2v0H5v15h14V6h-2v0a2 2 0 0 0-2-2m-6 0a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z",
  x: "M6 6l12 12M18 6 6 18",
  retry: "M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0 0 12.2 2.3M18.5 9A7 7 0 0 0 6.3 6.7",
  check: "M5 12.5 10 17l9-10",
  alert: "M12 8v5m0 3.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  trash: "M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3",
  convert: "M4 9h13l-4-4M20 15H7l4 4",
  scissors: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.1 8.1 20 20M8.1 15.9 20 4",
  plus: "M12 5v14M5 12h14",
  chevron: "m6 9 6 6 6-6",
  file: "M14 3H6v18h12V7l-4-4Zm0 0v4h4",
  chip: "M7 7h10v10H7zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4",
  flagStart: "M6 4v16M6 5h11l-3 4 3 4H6",
  flagEnd: "M18 4v16M18 5H7l3 4-3 4h11",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 3",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01",
  captions: "M3 6h18v12H3zM7 11h3m4 0h3M7 14h6m3 0h1",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-11v6m0-9v.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5",
  minimize: "M9 4v5H4m11-5v5h5M9 20v-5H4m11 5v-5h5",
  maximize: "M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  layers: "M12 3 2 8l10 5 10-5-10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5",
  timeline: "M3 7h8M13 7h8M3 12h5m2 0h11M3 17h12m2 0h4",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
