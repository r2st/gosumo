'use client';

import { useState, type FormEvent } from 'react';
import { Shield, Trash2, UserPlus } from 'lucide-react';
import {
  useInviteMember,
  useRemoveMember,
  useTeam,
  useUpdateMemberRole,
} from '@/hooks/use-settings';
import { usePermissions } from '@/hooks/use-permissions';
import { SettingsCard } from '@/components/settings/settings-kit';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';
import { timeAgo } from '@/lib/format';
import type { AssignableRole, Role, TeamMember } from '@/lib/feature-types';

const ROLE_TONE: Record<Role, BadgeTone> = {
  OWNER: 'primary',
  MANAGER: 'info',
  STAFF: 'neutral',
  VIEWER: 'warning',
};

/** Shown in place of the role dropdown when the viewer cannot change roles. */
const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  STAFF: 'Staff',
  VIEWER: 'Viewer',
};

const ROLE_DESC: Record<AssignableRole, string> = {
  MANAGER: 'Manage conversations, catalog, settings and AI config.',
  STAFF: 'Handle conversations and review HITL tasks.',
  VIEWER: 'Read-only access to dashboards and reports.',
};

const ROLE_OPTIONS = [
  { label: 'Manager', value: 'MANAGER' },
  { label: 'Staff', value: 'STAFF' },
  { label: 'Viewer', value: 'VIEWER' },
];

export default function TeamPage() {
  const { data, isLoading, isError, refetch } = useTeam();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toRemove, setToRemove] = useState<TeamMember | null>(null);

  // Mirrors what the API enforces: OWNER and MANAGER may invite and remove
  // (@Roles(MANAGER)), only OWNER may change a role (@Roles(OWNER)). The
  // server is the authority — this only keeps the page from offering buttons
  // that come back 403.
  const { canManage, canOwn: canChangeRoles } = usePermissions();

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState onRetry={() => void refetch()} />;

  const members = data.data;

  return (
    <>
      <SettingsCard
        title="Team members"
        description="Invite teammates and control what they can access."
      >
        {canManage && (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" /> Invite member
            </Button>
          </div>
        )}

        {members.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No team members yet"
            description="Invite your first teammate to collaborate."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Member</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Last active</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {members.map((m) => {
                  const isOwner = m.role === 'OWNER';
                  return (
                    <TR key={m.id}>
                      <TD>
                        <div className="flex items-center gap-3">
                          <Avatar name={m.name} src={m.avatarUrl} size="md" />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{m.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                          </div>
                        </div>
                      </TD>
                      <TD>
                        {isOwner || !canChangeRoles ? (
                          <Badge tone={ROLE_TONE[m.role]}>
                            {isOwner && <Shield className="h-3 w-3" />}
                            {ROLE_LABEL[m.role]}
                          </Badge>
                        ) : (
                          <Select
                            options={ROLE_OPTIONS}
                            value={m.role}
                            disabled={updateRole.isPending}
                            onChange={(e) =>
                              updateRole.mutate({ memberId: m.id, role: e.target.value as Role })
                            }
                            className="h-8 w-32"
                          />
                        )}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            m.status === 'ACTIVE'
                              ? 'success'
                              : m.status === 'INVITED'
                                ? 'warning'
                                : 'danger'
                          }
                        >
                          {m.status === 'ACTIVE'
                            ? 'Active'
                            : m.status === 'INVITED'
                              ? 'Invited'
                              : 'Suspended'}
                        </Badge>
                      </TD>
                      <TD className="text-muted-foreground">
                        {m.lastActiveAt ? timeAgo(m.lastActiveAt) : '—'}
                      </TD>
                      <TD className="text-right">
                        {!isOwner && canManage && (
                          <button
                            onClick={() => setToRemove(m)}
                            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-danger"
                            aria-label={`Remove ${m.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(ROLE_DESC) as AssignableRole[]).map((role) => (
            <div key={role} className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium capitalize text-foreground">{role.toLowerCase()}</p>
              <p className="text-xs text-muted-foreground">{ROLE_DESC[role]}</p>
            </div>
          ))}
        </div>
      </SettingsCard>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />

      <Modal
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        title="Remove team member"
        description={toRemove ? `${toRemove.name} will lose access immediately.` : ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setToRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeMember.isPending}
              onClick={() =>
                toRemove && removeMember.mutate(toRemove.id, { onSuccess: () => setToRemove(null) })
              }
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          This revokes their login and unassigns their open tasks. This action cannot be undone.
        </p>
      </Modal>
    </>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const invite = useInviteMember();
  const [form, setForm] = useState<{ name: string; email: string; role: AssignableRole }>({
    name: '',
    email: '',
    role: 'STAFF',
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(form, {
      onSuccess: () => {
        setForm({ name: '', email: '', role: 'STAFF' });
        onClose();
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite team member"
      description="They’ll receive an email with a link to set their password."
      footer={
        <>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" loading={invite.isPending}>
            Send invite
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="space-y-4">
        <Field label="Full name">
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
          />
        </Field>
        <Field label="Role">
          <Select
            options={ROLE_OPTIONS}
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as AssignableRole }))}
          />
        </Field>
        {invite.isError && (
          <p className="text-sm text-danger">Couldn’t send the invite. Please try again.</p>
        )}
      </form>
    </Modal>
  );
}
