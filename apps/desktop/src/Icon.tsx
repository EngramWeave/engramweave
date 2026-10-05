import type { ReactNode } from 'react';

const shapes = {
  home: (
    <>
      <path d="m3 10 9-7 9 7" />
      <path d="M5 9v12h5v-7h4v7h5V9" />
    </>
  ),
  capture: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5" r="2" />
      <circle cx="17" cy="8" r="2" />
      <circle cx="7" cy="19" r="2" />
      <path d="M7 7v10M7 14h4a6 6 0 0 0 6-4" />
    </>
  ),
  layers: (
    <>
      <path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m15 15 6 6" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
      <path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2" />
    </>
  ),
  bell: (
    <>
      <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4" />
    </>
  ),
  link: (
    <>
      <path
        d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        transform="translate(1 -1) scale(.9)"
      />
    </>
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  chart: (
    <>
      <path d="M5 20V12M12 20V5M19 20V9" strokeWidth="4" />
    </>
  ),
  activity: <path d="M1 12h5l3-9 5 18 3-9h6" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m7 12 3 3 7-7" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7M21 3l-9 9M10 5H4v15h15v-6" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  refresh: (
    <>
      <path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  note: (
    <>
      <path d="M5 3h14v12l-6 6H5zM13 21v-6h6M9 8h6M9 12h3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17v.1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;
export function Icon({
  name,
  className = '',
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
