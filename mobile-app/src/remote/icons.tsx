import type { ReactNode } from "react";
const paths: Record<string, ReactNode> = {
  settings: (
    <>
      <path d="m10 3-1 3-3 1-3-1-1 3 2 3-1 3 2 3 3-1 3 1 2 3 3-1 1-3 3-1 1-3-2-3-3-1-1-3z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-4a6 6 0 0 1 12 0v4M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2" />
    </>
  ),
  back: <path d="m14 6-6 6 6 6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  add: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  desktop: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  message: (
    <path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z" />
  ),
  inbox: (
    <>
      <path d="m6 4-4 10v6h20v-6L18 4z" />
      <path d="M2 14h6l2 3h4l2-3h6" />
    </>
  ),
  file: (
    <>
      <path d="M13 3H6v18h12V8zM13 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  folder: <path d="M3 5h7l2 3h9v12H3z" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  arrow: <path d="m6 12 6-6 6 6M12 6v13" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  activity: (
    <>
      <path d="M5 5v14M12 5v14M19 5v14" />
      <circle cx="5" cy="9" r="2" />
      <circle cx="12" cy="15" r="2" />
      <circle cx="19" cy="8" r="2" />
    </>
  ),
  retry: (
    <>
      <path d="M20 11a8 8 0 1 0-1 5M20 4v7h-7" />
    </>
  ),
  moon: <path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  link: (
    <>
      <path
        d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        transform="translate(1 0) scale(.9)"
      />
    </>
  ),
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Mark() {
  return (
    <svg
      className="rw-mark"
      viewBox="0 0 1024 1024"
      fill="none"
      aria-hidden="true"
    >
      <g
        stroke="currentColor"
        strokeWidth="64"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M462 236 L462 420 L624 420" />
        <path d="M276 732 L424 644 L356 512" />
        <path d="M540 676 L622 546 L786 640" />
      </g>
    </svg>
  );
}
