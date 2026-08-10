import { formatInTimeZone } from 'date-fns-tz';

const IST = 'Asia/Kolkata';

/**
 * Convert a monetary amount in paise (the API's storage unit) to a human-readable
 * INR string, e.g. 1050000 → "₹10,500.00". This is the single authorised
 * paise→rupees display conversion in the frontend.
 */
export function paiseToRupees(paise: number | undefined | null): string {
  const value = (paise ?? 0) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);
}

/** Compact INR for KPI cards: ₹1.2L, ₹3.4Cr, etc. */
export function paiseToCompactRupees(paise: number | undefined | null): string {
  const rupees = (paise ?? 0) / 100;
  if (rupees >= 1e7) return `₹${(rupees / 1e7).toFixed(2)}Cr`;
  if (rupees >= 1e5) return `₹${(rupees / 1e5).toFixed(2)}L`;
  if (rupees >= 1e3) return `₹${(rupees / 1e3).toFixed(1)}K`;
  return `₹${rupees.toFixed(0)}`;
}

/** Format a UTC ISO timestamp as IST date+time, e.g. "27 Jun 2026, 4:30 PM". */
export function formatDateTimeIST(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return formatInTimeZone(new Date(iso), IST, 'd MMM yyyy, h:mm a');
  } catch {
    return '—';
  }
}

/** Format a UTC ISO timestamp as an IST date only, e.g. "27 Jun 2026". */
export function formatDateIST(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return formatInTimeZone(new Date(iso), IST, 'd MMM yyyy');
  } catch {
    return '—';
  }
}

/** Format a UTC ISO timestamp as IST time only, e.g. "4:30 PM". */
export function formatTimeIST(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return formatInTimeZone(new Date(iso), IST, 'h:mm a');
  } catch {
    return '—';
  }
}

/** Stable IST calendar-day key (yyyy-MM-dd) — used to group messages by day. */
export function istDayKey(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    return formatInTimeZone(new Date(iso), IST, 'yyyy-MM-dd');
  } catch {
    return '';
  }
}

/**
 * Human day label for a chat date divider: "Today", "Yesterday", or an absolute
 * IST date like "3 Jul 2026". Comparisons are done on IST calendar days so a
 * message just before midnight IST groups under the correct local day.
 */
export function formatDayLabelIST(iso: string | undefined | null): string {
  const key = istDayKey(iso);
  if (!key) return '';
  const now = Date.now();
  if (key === istDayKey(new Date(now).toISOString())) return 'Today';
  if (key === istDayKey(new Date(now - 86_400_000).toISOString())) return 'Yesterday';
  return formatDateIST(iso);
}

/** Relative "time ago" string, e.g. "2m", "3h", "5d". */
export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  return formatDateIST(iso);
}

/** Format a millisecond duration into a compact human string, e.g. "2m 30s", "1.5h". */
export function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = (min / 60).toFixed(1);
  return `${hr}h`;
}

/** Format a 0–1 ratio as a percentage, e.g. 0.873 → "87.3%". */
export function formatRatioPct(ratio: number | undefined | null, digits = 1): string {
  if (ratio === undefined || ratio === null || Number.isNaN(ratio)) return '—';
  // Accept either a 0–1 ratio or an already-scaled 0–100 value.
  const pct = ratio <= 1 ? ratio * 100 : ratio;
  return `${pct.toFixed(digits)}%`;
}

/** Format an integer with Indian-style grouping, e.g. 1234567 → "12,34,567". */
export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN').format(n);
}

/** Turn an UPPER_SNAKE enum value into Title Case, e.g. "PENDING_PAYMENT" → "Pending Payment". */
export function humanizeEnum(value: string | undefined | null): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
