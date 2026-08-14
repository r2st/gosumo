'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Languages, Send, UserCog, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import {
  useAssignLead,
  useEnrollCadence,
  useTransitionStage,
  useUpdateLead,
} from '@/hooks/use-realty';
import { useTeam } from '@/hooks/use-settings';
import { useToast } from '@/providers/toast-provider';
import {
  CADENCE_TRIGGER_LABELS,
  LANGUAGE_LABELS,
  LEAD_LANGUAGES,
  LEAD_STAGES,
  STAGE_LABELS,
  normalizeLeadLanguage,
  type CadenceTrigger,
  type Lead,
  type LeadLanguage,
  type LeadStage,
} from '@/lib/realty-types';
import { usePermissions } from '@/hooks/use-permissions';

type ActiveModal = 'assign' | 'stage' | 'cadence' | null;

const CADENCE_TRIGGERS: CadenceTrigger[] = ['NO_RESPONSE', 'POST_VISIT', 'DORMANT'];

/** Primary action bar for the lead detail page: assign, change stage, book visit, start cadence. */
export function LeadActions({ lead }: { lead: Lead }) {
  const router = useRouter();
  // Assigning, restaging and enrolling in a cadence are undecorated writes —
  // STAFF and above. "Book visit" only navigates, but it leads to a page whose
  // booking control is gated the same way, so it goes with the rest.
  const { canWrite } = usePermissions();
  const [active, setActive] = useState<ActiveModal>(null);
  const close = () => setActive(null);

  if (!canWrite) return null;

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button variant="outline" size="sm" onClick={() => setActive('assign')}>
          <UserCog className="h-4 w-4" />
          Assign agent
        </Button>
        <Button variant="outline" size="sm" onClick={() => setActive('stage')}>
          <Send className="h-4 w-4" />
          Change stage
        </Button>
        <Button variant="primary" size="sm" onClick={() => router.push('/sitevisits')}>
          <CalendarPlus className="h-4 w-4" />
          Book visit
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setActive('cadence')}>
          <Workflow className="h-4 w-4" />
          Start cadence
        </Button>
      </div>

      <LanguageSelector lead={lead} />

      {active === 'assign' && <AssignAgentModal lead={lead} onClose={close} />}
      {active === 'stage' && <ChangeStageModal lead={lead} onClose={close} />}
      {active === 'cadence' && <StartCadenceModal lead={lead} onClose={close} />}
    </>
  );
}

/**
 * Inline follow-up language switcher. Saves on change to the lead's `languagePref`,
 * which selects the English vs. Hindi cadence templates and the AI's reply language.
 */
function LanguageSelector({ lead }: { lead: Lead }) {
  const toast = useToast();
  const update = useUpdateLead();
  const current = normalizeLeadLanguage(lead.languagePref);

  const options = LEAD_LANGUAGES.map((code) => ({ label: LANGUAGE_LABELS[code], value: code }));

  const onChange = (next: LeadLanguage) => {
    if (next === current) return;
    update.mutate(
      { id: lead.id, patch: { languagePref: next } },
      {
        onSuccess: () =>
          toast.success(`Follow-ups will use ${LANGUAGE_LABELS[next]}.`, {
            title: 'Language updated',
          }),
        onError: () => toast.error('Could not update the language. Please try again.'),
      },
    );
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Languages className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">Follow-up language</p>
          <p className="text-xs text-muted-foreground">
            Sets which cadence templates are sent and the language the AI replies in.
          </p>
        </div>
      </div>
      <div className="sm:w-44">
        <Select
          value={current}
          onChange={(e) => onChange(e.target.value as LeadLanguage)}
          options={options}
          disabled={update.isPending}
          aria-label="Follow-up language"
        />
      </div>
    </div>
  );
}

function AssignAgentModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const toast = useToast();
  const teamQ = useTeam();
  const assign = useAssignLead();
  const members = teamQ.data?.data ?? [];
  const [agentId, setAgentId] = useState(lead.assignedAgentId ?? '');

  const options = [
    { label: members.length ? 'Select a team member…' : 'No team members found', value: '' },
    ...members.map((m) => ({ label: `${m.name} · ${m.role}`, value: m.id })),
  ];

  const submit = () => {
    if (!agentId) return;
    const agentName = members.find((m) => m.id === agentId)?.name;
    assign.mutate(
      { id: lead.id, agentId },
      {
        onSuccess: () => {
          toast.success(agentName ? `Lead assigned to ${agentName}.` : 'Lead assigned.', {
            title: 'Agent assigned',
          });
          onClose();
        },
        onError: () => toast.error('Could not assign the lead. Please try again.'),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Assign agent"
      description="Hand this lead to a team member to own the follow-up."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={assign.isPending} disabled={!agentId}>
            Assign
          </Button>
        </>
      }
    >
      <Select
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        options={options}
        disabled={teamQ.isLoading}
        aria-label="Team member"
      />
      {assign.isError && (
        <p className="mt-2 text-xs text-danger">Could not assign the lead. Please try again.</p>
      )}
    </Modal>
  );
}

function ChangeStageModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const toast = useToast();
  const transition = useTransitionStage();
  const [stage, setStage] = useState<LeadStage>(lead.stage);

  const options = LEAD_STAGES.map((s) => ({ label: STAGE_LABELS[s], value: s }));

  const submit = () => {
    if (stage === lead.stage) {
      onClose();
      return;
    }
    transition.mutate(
      { id: lead.id, stage },
      {
        onSuccess: () => {
          toast.success(`Moved to “${STAGE_LABELS[stage]}”.`, { title: 'Stage updated' });
          onClose();
        },
        onError: () => toast.error('Could not update the stage. Please try again.'),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Change stage"
      description={`Currently at "${STAGE_LABELS[lead.stage]}".`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={transition.isPending}>
            Update stage
          </Button>
        </>
      }
    >
      <Select
        value={stage}
        onChange={(e) => setStage(e.target.value as LeadStage)}
        options={options}
        aria-label="Stage"
      />
      {transition.isError && (
        <p className="mt-2 text-xs text-danger">Could not update the stage. Please try again.</p>
      )}
    </Modal>
  );
}

function StartCadenceModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const toast = useToast();
  const enroll = useEnrollCadence();
  const [trigger, setTrigger] = useState<CadenceTrigger>('NO_RESPONSE');
  const [noCadence, setNoCadence] = useState(false);

  const options = CADENCE_TRIGGERS.map((t) => ({ label: CADENCE_TRIGGER_LABELS[t], value: t }));

  const submit = () => {
    setNoCadence(false);
    enroll.mutate(
      { leadId: lead.id, trigger },
      {
        onSuccess: (data) => {
          // The API returns null when no active cadence matches the trigger.
          if (data) {
            toast.success(`Enrolled in the ${CADENCE_TRIGGER_LABELS[trigger]} sequence.`, {
              title: 'Cadence started',
            });
            onClose();
          } else {
            setNoCadence(true);
            toast.warning('No active cadence is configured for this trigger yet.');
          }
        },
        onError: () => toast.error('Could not enrol the lead. Please try again.'),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Start cadence"
      description="Enrol this lead into an automated follow-up sequence."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={enroll.isPending}>
            Enrol
          </Button>
        </>
      }
    >
      <Select
        value={trigger}
        onChange={(e) => setTrigger(e.target.value as CadenceTrigger)}
        options={options}
        aria-label="Cadence trigger"
      />
      {noCadence && (
        <p className="mt-2 text-xs text-warning">
          No active cadence is configured for this trigger yet.
        </p>
      )}
      {enroll.isError && (
        <p className="mt-2 text-xs text-danger">Could not enrol the lead. Please try again.</p>
      )}
    </Modal>
  );
}
