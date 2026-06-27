'use client';

/**
 * Semicircular gauge for a 0-100 percentage (e.g. AI autonomy rate).
 * Pure SVG — no chart library required. Colours come from the theme tokens.
 */
export function Gauge({
  value,
  label,
  size = 200,
  thickness = 18,
}: {
  value: number;
  label?: string;
  size?: number;
  thickness?: number;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = Math.PI; // 180° (left)
  const endAngle = Math.PI - (pct / 100) * Math.PI;

  const point = (angle: number) => ({ x: cx + radius * Math.cos(angle), y: cy - radius * Math.sin(angle) });
  const start = point(startAngle);
  const end = point(endAngle);
  const trackEnd = point(0);
  const largeArc = pct > 50 ? 1 : 0;

  const color =
    pct >= 75 ? 'hsl(var(--success))' : pct >= 50 ? 'hsl(var(--primary))' : pct >= 25 ? 'hsl(var(--warning))' : 'hsl(var(--danger))';

  return (
    <svg width={size} height={size / 2 + thickness} viewBox={`0 0 ${size} ${size / 2 + thickness}`}>
      <path
        d={`M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${trackEnd.x} ${trackEnd.y}`}
        fill="none"
        stroke="hsl(var(--muted))"
        strokeWidth={thickness}
        strokeLinecap="round"
      />
      {pct > 0 && (
        <path
          d={`M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
      )}
      <text x={cx} y={cy - 2} textAnchor="middle" className="fill-foreground" style={{ fontSize: size * 0.17, fontWeight: 700 }}>
        {pct.toFixed(0)}%
      </text>
      {label && (
        <text x={cx} y={cy + size * 0.1} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.065 }}>
          {label}
        </text>
      )}
    </svg>
  );
}
