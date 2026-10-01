'use client';

import { AlertTriangle, Boxes } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/states';
import { paiseToRupees } from '@/lib/format';
import { freshness, UNIT_AVAILABILITY_LABEL, UNIT_AVAILABILITY_TONE } from '@/lib/realty-ui';
import { cn } from '@/lib/utils';
import type { RealtyUnit } from '@/lib/realty-types';

/** Small dash for empty numeric cells. */
const DASH = <span className="text-muted-foreground">—</span>;

function sqft(carpet: number | null, builtup: number | null) {
  if (carpet == null && builtup == null) return DASH;
  return (
    <span className="whitespace-nowrap">
      {carpet != null ? `${carpet}` : '—'}
      <span className="text-muted-foreground"> / {builtup != null ? builtup : '—'}</span>
    </span>
  );
}

/** Verified-at cell with a freshness pill; anything past the 24h window is flagged stale. */
function VerifiedCell({ unit }: { unit: RealtyUnit }) {
  const fresh = freshness(unit.verifiedAt);
  if (!fresh) return <span className="text-xs text-muted-foreground">Never verified</span>;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium',
        fresh.stale ? 'text-rose-400' : 'text-sky-400',
      )}
      title={new Date(unit.verifiedAt as string).toLocaleString('en-IN')}
    >
      {fresh.stale && <AlertTriangle className="h-3 w-3" />}
      {fresh.label}
    </span>
  );
}

/**
 * Availability + freshness grid for a project's units — the operational heart of
 * the broker console. Colour-codes availability and warns when a unit's
 * verified-at falls outside the 24-hour freshness window the AI relies on.
 */
export function InventoryUnitsTable({ units }: { units: RealtyUnit[] }) {
  if (units.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No units yet"
        description="Add units with their configuration, pricing, and availability so the AI can match buyers to real inventory."
      />
    );
  }

  // AVAILABLE first, then held/unverified, then sold — the broker's working order.
  const order: Record<RealtyUnit['availability'], number> = {
    AVAILABLE: 0,
    HELD: 1,
    UNVERIFIED: 2,
    SOLD: 3,
  };
  const rows = [...units].sort(
    (a, b) => order[a.availability] - order[b.availability] || a.allInPricePaise - b.allInPricePaise,
  );

  return (
    <Table>
      <THead>
        <TR>
          <TH>Config</TH>
          <TH className="text-right">Carpet / Built-up</TH>
          <TH className="text-right">Floor</TH>
          <TH>Facing</TH>
          <TH className="text-right">Base</TH>
          <TH className="text-right">All-in</TH>
          <TH>Status</TH>
          <TH>Verified</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((u) => (
          <TR key={u.id}>
            <TD className="font-medium">{u.config}</TD>
            <TD className="text-right tabular-nums">{sqft(u.carpetSqft, u.builtupSqft)}</TD>
            <TD className="text-right tabular-nums">{u.floor != null ? u.floor : DASH}</TD>
            <TD>{u.facing ?? DASH}</TD>
            <TD className="text-right tabular-nums">
              {u.basePricePaise != null ? paiseToRupees(u.basePricePaise) : DASH}
            </TD>
            <TD className="text-right font-semibold tabular-nums">
              {paiseToRupees(u.allInPricePaise)}
            </TD>
            <TD>
              <Badge tone={UNIT_AVAILABILITY_TONE[u.availability]}>
                {UNIT_AVAILABILITY_LABEL[u.availability]}
              </Badge>
            </TD>
            <TD>
              <VerifiedCell unit={u} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
