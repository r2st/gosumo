import { Skeleton } from './skeleton';
import { Table, TBody, TD, TH, THead, TR } from './table';
import { cn } from '@/lib/utils';

/**
 * Content-shaped loading placeholders.
 *
 * The dashboard's data surfaces used to show a centred spinner while their
 * first page loaded. That reads as "something is happening" but not as "what
 * is coming", and because the spinner occupies a fixed block rather than the
 * shape of the result, the whole surface jumps when the data lands. These
 * placeholders reserve the real layout instead, so the page settles in place.
 *
 * Every element here is decorative: the wrappers carry `aria-hidden` and the
 * container exposes a single `status` role, so a screen reader hears "Loading"
 * once rather than reading out dozens of empty boxes.
 */

function SkeletonRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/**
 * Rows of avatar + two text lines — the shape of the conversation inbox and
 * any other identity-led list.
 */
export function ListRowsSkeleton({
  rows = 6,
  label = 'Loading…',
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} className={className}>
      <ul className="divide-y divide-border">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex gap-3 px-3 py-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-2.5 w-10 shrink-0" />
              </div>
              <Skeleton className="h-3 w-full max-w-[15rem]" />
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-3.5 w-3.5 rounded-full" />
                <Skeleton className="h-4 w-16 rounded-full" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </SkeletonRegion>
  );
}

/**
 * A real table carrying the caller's headers, with placeholder cells beneath.
 * Keeping the headers visible means the column widths — and so the horizontal
 * scroll position on mobile — do not shift when the rows arrive.
 */
export function TableSkeleton({
  headers,
  rows = 6,
  label = 'Loading…',
}: {
  headers: string[];
  rows?: number;
  label?: string;
}) {
  return (
    <SkeletonRegion label={label}>
      <Table>
        <THead>
          <TR className="hover:bg-transparent">
            {headers.map((h) => (
              <TH key={h}>{h}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {Array.from({ length: rows }, (_, r) => (
            <TR key={r} className="hover:bg-transparent">
              {headers.map((h, c) => (
                <TD key={h}>
                  {/* Vary the width a little so the block does not read as a grid. */}
                  <Skeleton className={cn('h-3.5', c === 0 ? 'w-40' : c % 3 === 0 ? 'w-16' : 'w-24')} />
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </SkeletonRegion>
  );
}

/** Stacked cards — the shape of the approvals queue and other card feeds. */
export function CardsSkeleton({
  cards = 3,
  label = 'Loading…',
  className,
}: {
  cards?: number;
  label?: string;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} className={className}>
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-3 w-12" />
            </div>
            <div className="space-y-2 rounded-lg bg-muted/50 p-3">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <div className="mt-4 flex gap-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * A responsive grid of media cards — the shape of the catalog and any other
 * image-led grid. The image block keeps the same `aspect-video` ratio as the
 * real card so the grid does not reflow when thumbnails load.
 */
export function GridSkeleton({
  cards = 8,
  label = 'Loading…',
  className,
}: {
  cards?: number;
  label?: string;
  className?: string;
}) {
  return (
    <SkeletonRegion label={label} className={className}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-lg border border-border bg-card">
            <Skeleton className="aspect-video w-full rounded-none" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <div className="flex items-center justify-between pt-1">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * Alternating inbound/outbound bubbles — the shape of a message thread. The
 * alternation matters: a column of identical blocks reads as a list, and the
 * thread is the one surface where the left/right rhythm *is* the layout.
 */
export function ThreadSkeleton({
  messages = 5,
  label = 'Loading messages…',
  className,
}: {
  messages?: number;
  label?: string;
  className?: string;
}) {
  const widths = ['w-48', 'w-64', 'w-40', 'w-56', 'w-36', 'w-60'];
  return (
    <SkeletonRegion label={label} className={cn('space-y-3 p-4', className)}>
      <div className="space-y-3">
        {Array.from({ length: messages }, (_, i) => {
          const outbound = i % 2 === 1;
          return (
            <div key={i} className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
              <Skeleton
                className={cn('h-12 rounded-2xl', widths[i % widths.length])}
              />
            </div>
          );
        })}
      </div>
    </SkeletonRegion>
  );
}
