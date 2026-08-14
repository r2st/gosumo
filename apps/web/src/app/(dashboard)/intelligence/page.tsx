'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { LineChart, MapPin, Sparkles, TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { MeterBar, axisProps, tooltipStyle } from '@/components/analytics/chart-kit';
import {
  useCorridorPriors,
  useIntelligenceAggregates,
  useIntelligenceCorridors,
  useIntelligenceOptIn,
  useSetIntelligenceOptIn,
  useSourceQuality,
} from '@/hooks/use-realty';
import { useLanguage } from '@/providers/language-provider';
import { paiseToCompactRupees } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { IntelligenceAggregate } from '@/lib/intelligence-types';
import {
  bucketLabel,
  getCadence,
  getObjections,
  getPrice,
  getSeasonal,
  monthLabel,
  objectionLabel,
  ratioPct,
  sourceLabel,
} from '@/lib/intelligence-ui';

export default function IntelligencePage() {
  const { t } = useLanguage();
  const corridorsQuery = useIntelligenceCorridors();
  const aggregatesQuery = useIntelligenceAggregates();
  const [selected, setSelected] = useState<string | null>(null);

  const corridors = corridorsQuery.data?.corridors ?? [];
  // Default the detail view to the first corridor once the list arrives.
  const activeCorridor = selected ?? corridors[0] ?? null;

  // Group every aggregate by corridor so the overview cards can render each locality.
  const byCorridor = useMemo(() => {
    const map = new Map<string, IntelligenceAggregate[]>();
    for (const agg of aggregatesQuery.data ?? []) {
      const bucket = map.get(agg.corridor);
      if (bucket) bucket.push(agg);
      else map.set(agg.corridor, [agg]);
    }
    return map;
  }, [aggregatesQuery.data]);

  return (
    <div>
      <PageHeader title={t('intel.title')} description={t('intel.subtitle')} />

      <div className="space-y-5 p-4 lg:p-6">
        <OptInCard />

        {corridorsQuery.isLoading || aggregatesQuery.isLoading ? (
          <LoadingState label={t('common.loading')} />
        ) : corridorsQuery.isError ? (
          <ErrorState onRetry={() => void corridorsQuery.refetch()} />
        ) : corridors.length === 0 ? (
          <Card>
            <CardContent className="pt-5">
              <EmptyState
                icon={LineChart}
                title={t('intel.noData')}
                description={t('intel.noDataDesc')}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Micro-market cards / heatmap by locality */}
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <MapPin className="h-4 w-4 text-primary" /> {t('intel.microMarket')}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {corridors.map((corridor) => (
                  <CorridorCard
                    key={corridor}
                    corridor={corridor}
                    aggregates={byCorridor.get(corridor) ?? []}
                    active={corridor === activeCorridor}
                    onSelect={() => setSelected(corridor)}
                  />
                ))}
              </div>
            </section>

            {/* Corridor detail */}
            {activeCorridor && (
              <section className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <TrendingUp className="h-4 w-4 text-primary" /> {activeCorridor}
                  </h2>
                  <div className="w-full sm:w-64">
                    <Select
                      aria-label={t('intel.selectCorridor')}
                      value={activeCorridor}
                      onChange={(e) => setSelected(e.target.value)}
                      options={corridors.map((c) => ({ label: c, value: c }))}
                    />
                  </div>
                </div>
                <CorridorDetail corridor={activeCorridor} />
              </section>
            )}

            <SourceQualitySection />
          </>
        )}
      </div>
    </div>
  );
}

// ── Network contribution consent ─────────────────────────────────────────────────

function OptInCard() {
  const { t } = useLanguage();
  const { data, isLoading } = useIntelligenceOptIn();
  const setOptIn = useSetIntelligenceOptIn();
  // Opting the tenant in or out is an undecorated write — STAFF and above.
  const { canWrite } = usePermissions();
  const optIn = data?.optIn ?? false;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent">
            <Sparkles className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('intel.optInTitle')}</p>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{t('intel.optInDesc')}</p>
            <Badge tone={optIn ? 'success' : 'neutral'} className="mt-2">
              {optIn ? t('intel.optedIn') : t('intel.optedOut')}
            </Badge>
          </div>
        </div>
        {canWrite && (
          <Switch
            checked={optIn}
            disabled={isLoading || setOptIn.isPending}
            onChange={(next) => setOptIn.mutate(next)}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── One micro-market card (heatmap tile) ─────────────────────────────────────────

function CorridorCard({
  corridor,
  aggregates,
  active,
  onSelect,
}: {
  corridor: string;
  aggregates: IntelligenceAggregate[];
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useLanguage();
  const cadence = getCadence(aggregates);
  const price = getPrice(aggregates);
  const sampleSize = aggregates[0]?.sampleSize ?? 0;
  const rate = cadence?.conversionRate ?? 0;

  return (
    <button
      onClick={onSelect}
      className={cn(
        'group rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50',
        active ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-semibold text-foreground">{corridor}</p>
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: demandColor(rate) }}
          title={t('intel.demandTrend')}
        />
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{t('intel.conversionRate')}</p>
          <p className="text-lg font-bold tracking-tight text-foreground">{ratioPct(rate)}</p>
        </div>
        {price?.recommendedBandPaise && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{t('intel.priceBand')}</p>
            <p className="text-sm font-semibold text-foreground">
              {paiseToCompactRupees(price.recommendedBandPaise.low)}–
              {paiseToCompactRupees(price.recommendedBandPaise.high)}
            </p>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {sampleSize} {t('intel.leads')}
      </p>
    </button>
  );
}

/** Demand-intensity colour for a conversion rate (heatmap green → amber → red). */
function demandColor(rate: number): string {
  if (rate >= 0.25) return 'hsl(var(--success))';
  if (rate >= 0.1) return 'hsl(var(--warning))';
  return 'hsl(var(--danger))';
}

// ── Corridor detail (priors) ─────────────────────────────────────────────────────

function CorridorDetail({ corridor }: { corridor: string }) {
  const { t, lang } = useLanguage();
  const { data, isLoading, isError, refetch } = useCorridorPriors(corridor);

  if (isLoading) return <LoadingState label={t('common.loading')} />;
  if (isError) return <ErrorState onRetry={() => void refetch()} />;

  const priors = data?.priors ?? [];
  const cadence = getCadence(priors);
  const price = getPrice(priors);
  const objections = getObjections(priors);
  const seasonal = getSeasonal(priors);
  const sampleSize = priors[0]?.sampleSize ?? 0;

  const narrative = extractNarrative(data?.promptContext ?? null);

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('intel.conversionRate')} value={ratioPct(cadence?.conversionRate ?? 0)} />
        <Stat
          label={t('intel.medianDays')}
          value={cadence?.medianDaysToConvert != null ? String(cadence.medianDaysToConvert) : '—'}
        />
        <Stat
          label={t('intel.priceBand')}
          value={
            price?.recommendedBandPaise
              ? `${paiseToCompactRupees(price.recommendedBandPaise.low)}–${paiseToCompactRupees(
                  price.recommendedBandPaise.high,
                )}`
              : '—'
          }
        />
        <Stat label={t('intel.sampleSize')} value={`${sampleSize} ${t('intel.leads')}`} />
      </div>

      {narrative.length > 0 && (
        <Card>
          <CardContent className="flex gap-3 pt-5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('intel.narrative')}</p>
              <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                {narrative.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-primary">•</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Demand trend / supply-demand gap over time */}
        {seasonal && seasonal.months.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('intel.supplyDemandGap')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('intel.demandTrend')}</p>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart
                  data={seasonal.months.map((m) => ({
                    month: monthLabel(m.month, lang),
                    leads: m.leads,
                    converted: m.converted,
                  }))}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis dataKey="month" {...axisProps} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    dataKey="leads"
                    name={t('intel.leadsInflow')}
                    fill="hsl(var(--primary))"
                    radius={[4, 4, 0, 0]}
                    barSize={18}
                  />
                  <Line
                    type="monotone"
                    dataKey="converted"
                    name={t('intel.conversions')}
                    stroke="hsl(var(--success))"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Price band */}
        {price && (price.recommendedBandPaise || price.budgetMaxPaise) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('intel.priceBand')}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {price.withBudget} {t('intel.buyers')}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {price.recommendedBandPaise && (
                <div className="rounded-md bg-accent p-3">
                  <p className="text-xs font-medium text-accent-foreground">
                    {t('intel.recommendedBand')}
                  </p>
                  <p className="mt-0.5 text-lg font-bold tracking-tight text-foreground">
                    {paiseToCompactRupees(price.recommendedBandPaise.low)} –{' '}
                    {paiseToCompactRupees(price.recommendedBandPaise.high)}
                  </p>
                </div>
              )}
              {price.budgetMaxPaise && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Quantile label="P25" paise={price.budgetMaxPaise.p25} />
                  <Quantile label="P50" paise={price.budgetMaxPaise.p50} />
                  <Quantile label="P75" paise={price.budgetMaxPaise.p75} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Common objections */}
        {objections && objections.topObjections.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('intel.topObjections')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {objections.topObjections.map((o) => (
                <MeterBar
                  key={o.label}
                  label={objectionLabel(o.label, lang)}
                  valueLabel={`${ratioPct(o.share)} · ${o.count}`}
                  fraction={o.share}
                  color="hsl(var(--warning))"
                />
              ))}
            </CardContent>
          </Card>
        )}

        {/* Popular configurations (BHK) */}
        {objections && objections.byConfig.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('intel.popularConfigs')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {objections.byConfig.map((c) => (
                <div
                  key={c.config}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm font-semibold text-foreground">{c.config}</span>
                  <span className="text-xs text-muted-foreground">
                    {objectionLabel(c.topObjection, lang)} · {c.count}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Cadence timing buckets */}
      {cadence && cadence.converted > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('intel.conversionRate')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cadence.buckets.map((b) => (
              <MeterBar
                key={b.label}
                label={bucketLabel(b.label, lang)}
                valueLabel={`${ratioPct(b.share)} · ${b.converted}`}
                fraction={b.share}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SourceQualitySection() {
  const { t, lang } = useLanguage();
  const { data, isLoading } = useSourceQuality();
  if (isLoading || !data || data.sources.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('intel.sourceQuality')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {data.totalLeads} {t('intel.leads')}
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 font-medium">{t('privacy.source')}</th>
              <th className="pb-2 text-right font-medium">{t('intel.leads')}</th>
              <th className="pb-2 text-right font-medium">{t('intel.qualifiedRate')}</th>
              <th className="pb-2 text-right font-medium">{t('intel.visitRate')}</th>
              <th className="pb-2 text-right font-medium">{t('intel.avgScore')}</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.source} className="border-b border-border/60 last:border-0">
                <td className="py-2 font-medium text-foreground">{sourceLabel(s.source, lang)}</td>
                <td className="py-2 text-right text-muted-foreground">{s.leads}</td>
                <td className="py-2 text-right text-muted-foreground">
                  {ratioPct(s.qualifiedRate)}
                </td>
                <td className="py-2 text-right text-muted-foreground">{ratioPct(s.visitRate)}</td>
                <td className="py-2 text-right text-muted-foreground">{s.avgQualScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-lg font-bold tracking-tight text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

function Quantile({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="rounded-md border border-border py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold text-foreground">{paiseToCompactRupees(paise)}</p>
    </div>
  );
}

/**
 * The backend prompt-context is an XML-ish `<micro_market_intelligence>` block whose
 * body is a set of "- …" guidance bullets. Pull those bullets out for display.
 */
function extractNarrative(context: string | null): string[] {
  if (!context) return [];
  return context
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}
