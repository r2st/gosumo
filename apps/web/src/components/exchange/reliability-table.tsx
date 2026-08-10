'use client';

import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import type { ReliabilityScore } from '@/lib/realty-types';
import { scoreTone, shortBusinessId } from '@/lib/exchange-ui';

function ScoreCell({ value }: { value: number }) {
  return <Badge tone={scoreTone(value)}>{Math.round(value)}</Badge>;
}

/**
 * Reliability leaderboard — the composite trust score that gates and ranks who a
 * broker syndicates to, broken out into its four behavioural sub-scores.
 */
export function ReliabilityTable({ scores }: { scores: ReliabilityScore[] }) {
  const ranked = [...scores].sort((a, b) => b.compositeScore - a.compositeScore);
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>Member</TH>
            <TH>Composite</TH>
            <TH>Response</TH>
            <TH>Show-up</TH>
            <TH>Split honoring</TH>
            <TH>Docs</TH>
          </TR>
        </THead>
        <TBody>
          {ranked.map((s) => (
            <TR key={s.id}>
              <TD className="font-mono text-xs">{shortBusinessId(s.targetBusinessId)}</TD>
              <TD>
                <ScoreCell value={s.compositeScore} />
              </TD>
              <TD>
                <ScoreCell value={s.responseSpeedScore} />
              </TD>
              <TD>
                <ScoreCell value={s.showupIntegrityScore} />
              </TD>
              <TD>
                <ScoreCell value={s.splitHonoringScore} />
              </TD>
              <TD>
                <ScoreCell value={s.documentationHygieneScore} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
