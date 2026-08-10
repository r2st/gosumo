// Lightweight inline SVG icon set (stroke-based, inherits currentColor).
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
}

export function Icon({ name, className = 'w-6 h-6' }) {
  const paths = ICONS[name] || ICONS.stethoscope
  return (
    <svg {...base} className={className} aria-hidden="true">
      {paths}
    </svg>
  )
}

const ICONS = {
  stethoscope: (
    <>
      <path d="M4.5 3v5a4 4 0 0 0 8 0V3" />
      <path d="M8.5 16a5.5 5.5 0 0 0 11 0v-2" />
      <circle cx="19.5" cy="11" r="2" />
    </>
  ),
  heart: <path d="M12 20s-7-4.4-7-9.5A3.5 3.5 0 0 1 12 7a3.5 3.5 0 0 1 7 3.5C19 15.6 12 20 12 20z" />,
  baby: (
    <>
      <circle cx="12" cy="6" r="2.5" />
      <path d="M9 12c1 1 2 1.5 3 1.5s2-.5 3-1.5M7 21l1.5-5.5M17 21l-1.5-5.5M9 15h6" />
    </>
  ),
  bone: (
    <>
      <path d="M7 17a2.2 2.2 0 1 1-2.5-3.6L13.4 4.5A2.2 2.2 0 1 1 17 7l-8.9 8.9A2.2 2.2 0 0 1 7 17z" />
    </>
  ),
  female: (
    <>
      <circle cx="12" cy="8" r="4.5" />
      <path d="M12 12.5V21M9 18h6" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" />
      <path d="M7.5 14h9" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </>
  ),
  phone: (
    <path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  star: (
    <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.3-4.1 5.9-.9L12 3.5z" />
  ),
  chat: (
    <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
  ),
  send: <path d="M5 12 21 4l-6 16-3.5-6L5 12z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  award: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="m8.5 13.5-1.5 7 5-3 5 3-1.5-7" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3.2 3.2 0 0 1 0 6.4M20.5 20a5.5 5.5 0 0 0-3.5-5.1" />
    </>
  ),
}
