'use client';

import { useMemo, useState } from 'react';
import { CalendarCheck, Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SegmentedTabs } from '@/components/ui/tabs';
import { LoadingState, EmptyState, ErrorState } from '@/components/ui/states';
import { formatDateTimeIST } from '@/lib/format';
import { usePermissions } from '@/hooks/use-permissions';
import {
  useSiteVisits,
  useProjects,
  useLeads,
  useBookVisit,
  useConfirmVisit,
  useCancelVisit,
  useCompleteVisit,
  useMarkNoShow,
  useRescheduleVisit,
} from '@/hooks/use-realty';
import {
  SITE_VISIT_STATUS_LABELS,
  SITE_VISIT_OUTCOMES,
  SITE_VISIT_OUTCOME_LABELS,
  type SiteVisit,
  type SiteVisitStatus,
  type SiteVisitOutcome,
} from '@/lib/realty-types';

const STATUS_TONE: Record<SiteVisitStatus, BadgeTone> = {
  BOOKED: 'info',
  CONFIRMED: 'success',
  COMPLETED: 'success',
  NO_SHOW: 'danger',
  RESCHEDULED: 'warning',
  CANCELLED: 'neutral',
};

const TERMINAL: SiteVisitStatus[] = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];

/** datetime-local value (local time) → ISO-8601 UTC. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

export default function SiteVisitsPage() {
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [booking, setBooking] = useState(false);
  // Booking, confirming, rescheduling and cancelling visits are all
  // undecorated writes — STAFF and above.
  const { canWrite } = usePermissions();
  const visitsQ = useSiteVisits({ limit: 100 });
  const visits = visitsQ.data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Site Visits"
        description="Book, confirm and follow up on property visits — reminders fire at T-24h and T-2h."
        actions={
          canWrite ? (
            <Button onClick={() => setBooking(true)}>
              <Plus className="h-4 w-4" /> Book visit
            </Button>
          ) : null
        }
      />

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        <div className="mb-4">
          <SegmentedTabs
            items={[
              { key: 'list', label: 'List' },
              { key: 'calendar', label: 'Calendar' },
            ]}
            activeKey={view}
            onChange={(k) => setView(k as 'list' | 'calendar')}
          />
        </div>

        {visitsQ.isLoading ? (
          <LoadingState label="Loading visits…" />
        ) : visitsQ.isError ? (
          <ErrorState message="Could not load site visits." error={visitsQ.error} onRetry={() => visitsQ.refetch()} />
        ) : visits.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="No site visits yet"
            description="Book a visit for a qualified lead and it will sync to Google Calendar with automatic reminders."
          />
        ) : view === 'list' ? (
          <VisitList visits={visits} />
        ) : (
          <VisitCalendar visits={visits} />
        )}
      </div>

      {booking && <BookVisitModal onClose={() => setBooking(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────

function VisitList({ visits }: { visits: SiteVisit[] }) {
  const now = Date.now();
  const upcoming = visits.filter(
    (v) => new Date(v.scheduledAt).getTime() >= now && !TERMINAL.includes(v.status),
  );
  const past = visits.filter(
    (v) => !(new Date(v.scheduledAt).getTime() >= now && !TERMINAL.includes(v.status)),
  );

  return (
    <div className="flex flex-col gap-6">
      <Section title="Upcoming" visits={upcoming} emptyLabel="No upcoming visits." />
      <Section title="Past & closed" visits={past} emptyLabel="No past visits." />
    </div>
  );
}

function Section({
  title,
  visits,
  emptyLabel,
}: {
  title: string;
  visits: SiteVisit[];
  emptyLabel: string;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{title}</h3>
      {visits.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visits.map((v) => (
            <VisitRow key={v.id} visit={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function VisitRow({ visit }: { visit: SiteVisit }) {
  const confirm = useConfirmVisit();
  const cancel = useCancelVisit();
  const noShow = useMarkNoShow();
  const { canWrite } = usePermissions();
  const [reschedule, setReschedule] = useState(false);
  const [complete, setComplete] = useState(false);
  const isTerminal = TERMINAL.includes(visit.status);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{formatDateTimeIST(visit.scheduledAt)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Lead {visit.leadId.slice(0, 8)} · {visit.durationMinutes} min
            {visit.outcome !== 'PENDING' && ` · ${SITE_VISIT_OUTCOME_LABELS[visit.outcome]}`}
          </p>
        </div>
        <Badge tone={STATUS_TONE[visit.status]}>{SITE_VISIT_STATUS_LABELS[visit.status]}</Badge>
      </div>

      {visit.feedback && <p className="mt-2 text-xs text-muted-foreground">“{visit.feedback}”</p>}

      {!isTerminal && canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          {visit.status !== 'CONFIRMED' && (
            <Button
              size="sm"
              variant="secondary"
              loading={confirm.isPending}
              onClick={() => confirm.mutate(visit.id)}
            >
              Confirm
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setComplete(true)}>
            Complete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReschedule(true)}>
            Reschedule
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={noShow.isPending}
            onClick={() => noShow.mutate(visit.id)}
          >
            No-show
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={cancel.isPending}
            onClick={() => cancel.mutate({ id: visit.id })}
          >
            Cancel
          </Button>
        </div>
      )}

      {reschedule && <RescheduleModal visit={visit} onClose={() => setReschedule(false)} />}
      {complete && <CompleteModal visit={visit} onClose={() => setComplete(false)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// Calendar view (lightweight month grid)
// ─────────────────────────────────────────────

function VisitCalendar({ visits }: { visits: SiteVisit[] }) {
  const { days, monthLabel } = useMemo(() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ date: Date | null }> = [];
    for (let i = 0; i < startDay; i++) cells.push({ date: null });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: new Date(year, month, d) });
    return {
      days: cells,
      monthLabel: first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    };
  }, []);

  const byDay = useMemo(() => {
    const map = new Map<string, SiteVisit[]>();
    for (const v of visits) {
      const key = new Date(v.scheduledAt).toDateString();
      const list = map.get(key) ?? [];
      list.push(v);
      map.set(key, list);
    }
    return map;
  }, [visits]);

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="mb-3 text-sm font-semibold">{monthLabel}</p>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((cell, i) => {
          const dayVisits = cell.date ? (byDay.get(cell.date.toDateString()) ?? []) : [];
          return (
            <div
              key={i}
              className={`min-h-[74px] rounded-md border p-1 text-left ${
                cell.date ? 'border-border' : 'border-transparent'
              }`}
            >
              {cell.date && (
                <>
                  <span className="text-[11px] text-muted-foreground">{cell.date.getDate()}</span>
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {dayVisits.slice(0, 3).map((v) => (
                      <span
                        key={v.id}
                        title={`${formatDateTimeIST(v.scheduledAt)} · ${SITE_VISIT_STATUS_LABELS[v.status]}`}
                        className="truncate rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary"
                      >
                        {new Date(v.scheduledAt).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: 'Asia/Kolkata',
                        })}{' '}
                        · {v.leadId.slice(0, 4)}
                      </span>
                    ))}
                    {dayVisits.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">
                        +{dayVisits.length - 3} more
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────

function BookVisitModal({ onClose }: { onClose: () => void }) {
  const leadsQ = useLeads({ limit: 100 });
  const projectsQ = useProjects();
  const book = useBookVisit();
  const [leadId, setLeadId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [duration, setDuration] = useState('45');
  const [notes, setNotes] = useState('');

  const leads = leadsQ.data?.data ?? [];
  const projects = projectsQ.data ?? [];
  const canSubmit = leadId && projectId && scheduledAt && !book.isPending;

  const submit = () => {
    if (!canSubmit) return;
    book.mutate(
      {
        leadId,
        projectId,
        scheduledAt: toIso(scheduledAt),
        durationMinutes: Number(duration) || undefined,
        notes: notes || undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Book a site visit"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={book.isPending} disabled={!canSubmit} onClick={submit}>
            Book visit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Lead">
          <Select
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            options={[
              { value: '', label: 'Select a lead…' },
              ...leads.map((l) => ({
                value: l.id,
                label: `${l.name ?? 'Unknown'} · ${l.whatsappPhone}`,
              })),
            ]}
          />
        </Field>
        <Field label="Project">
          <Select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            options={[
              { value: '', label: 'Select a project…' },
              ...projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.locality}` })),
            ]}
          />
        </Field>
        <Field label="Date & time">
          <Input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        </Field>
        <Field label="Duration (minutes)">
          <Input
            type="number"
            min={5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </Field>
        <Field label="Notes (address, meeting point)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {book.isError && (
          <p className="text-xs text-danger">
            Could not book the visit. Check the details and try again.
          </p>
        )}
      </div>
    </Modal>
  );
}

function RescheduleModal({ visit, onClose }: { visit: SiteVisit; onClose: () => void }) {
  const reschedule = useRescheduleVisit();
  const [when, setWhen] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Reschedule visit"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={reschedule.isPending}
            disabled={!when || reschedule.isPending}
            onClick={() =>
              reschedule.mutate(
                { id: visit.id, newScheduledAt: toIso(when) },
                { onSuccess: onClose },
              )
            }
          >
            Reschedule
          </Button>
        </>
      }
    >
      <Field label="New date & time">
        <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
    </Modal>
  );
}

function CompleteModal({ visit, onClose }: { visit: SiteVisit; onClose: () => void }) {
  const complete = useCompleteVisit();
  const [outcome, setOutcome] = useState<SiteVisitOutcome>('INTERESTED');
  const [feedback, setFeedback] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title="Complete visit"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={complete.isPending}
            onClick={() =>
              complete.mutate(
                { id: visit.id, outcome, feedback: feedback || undefined },
                { onSuccess: onClose },
              )
            }
          >
            Save outcome
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Outcome">
          <Select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as SiteVisitOutcome)}
            options={SITE_VISIT_OUTCOMES.filter((o) => o !== 'PENDING').map((o) => ({
              value: o,
              label: SITE_VISIT_OUTCOME_LABELS[o],
            }))}
          />
        </Field>
        <Field label="Feedback">
          <Textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
