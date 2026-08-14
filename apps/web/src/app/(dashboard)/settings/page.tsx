'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { Building2 } from 'lucide-react';
import {
  useBusinessProfile,
  useBusinessSettings,
  useUpdateBusinessProfile,
  useUpdateBusinessSettings,
} from '@/hooks/use-settings';
import {
  SettingsCard,
  SaveButton,
  FormRow,
  ReadOnlyFieldset,
  ReadOnlyNotice,
} from '@/components/settings/settings-kit';
import { usePermissions } from '@/hooks/use-permissions';
import { useToast } from '@/providers/toast-provider';
import { BusinessHoursEditor } from '@/components/settings/business-hours-editor';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { LoadingState, ErrorState } from '@/components/ui/states';
import type { OfficeHours } from '@/lib/feature-types';
import type { BusinessProfile } from '@/lib/types';

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Colombo',
  'UTC',
];
const TZ_OPTIONS = TIMEZONES.map((tz) => ({ label: tz, value: tz }));

export default function BusinessProfilePage() {
  return (
    <>
      <ProfileForm />
      <HoursForm />
    </>
  );
}

function ProfileForm() {
  const { data: business, isLoading, isError, refetch } = useBusinessProfile();
  const update = useUpdateBusinessProfile();

  if (isLoading) return <LoadingState />;
  if (isError || !business) return <ErrorState onRetry={() => void refetch()} />;

  return <ProfileFormInner key={business.updatedAt} business={business} update={update} />;
}

function ProfileFormInner({
  business,
  update,
}: {
  business: BusinessProfile;
  update: ReturnType<typeof useUpdateBusinessProfile>;
}) {
  const initial = {
    name: business.name,
    description: business.description ?? '',
    logo: business.logo ?? '',
    phone: business.phone ?? '',
    email: business.email ?? '',
    website: business.website ?? '',
    timezone: business.timezone,
  };
  const [form, setForm] = useState(initial);
  const set =
    (k: keyof typeof form) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const toast = useToast();
  // PATCH /business/me is @Roles(MANAGER).
  const { canManage } = usePermissions();
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(form as Partial<BusinessProfile>, {
          onSuccess: () => toast.success('Business profile saved.', { title: 'Settings saved' }),
          onError: () => toast.error('Could not save your changes. Please try again.'),
        });
      }}
    >
      <ReadOnlyFieldset readOnly={!canManage}>
        <SettingsCard
          title="Business profile"
          description="This information appears on customer-facing messages and invoices."
          footer={
            canManage ? (
              <SaveButton
                isPending={update.isPending}
                isSuccess={update.isSuccess}
                isError={update.isError}
                dirty={dirty}
              />
            ) : (
              <ReadOnlyNotice>
                Only a manager or owner can edit the business profile.
              </ReadOnlyNotice>
            )
          }
        >
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
              {form.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.logo} alt="Logo" className="h-full w-full object-cover" />
              ) : (
                <Building2 className="h-6 w-6 text-muted-foreground" />
              )}
            </div>
            <Field
              label="Logo URL"
              className="flex-1"
              hint="Paste a hosted image URL (square works best)."
            >
              <Input value={form.logo} onChange={set('logo')} placeholder="https://…/logo.png" />
            </Field>
          </div>

          <FormRow>
            <Field label="Business name">
              <Input value={form.name} onChange={set('name')} required />
            </Field>
            <Field label="Industry">
              <Input value={business.industry} disabled />
            </Field>
          </FormRow>

          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={set('description')}
              rows={3}
              placeholder="What your business does…"
            />
          </Field>

          <FormRow>
            <Field label="Contact phone">
              <Input value={form.phone} onChange={set('phone')} placeholder="+91…" />
            </Field>
            <Field label="Contact email">
              <Input
                type="email"
                value={form.email}
                onChange={set('email')}
                placeholder="hello@business.in"
              />
            </Field>
          </FormRow>

          <FormRow>
            <Field label="Website">
              <Input value={form.website} onChange={set('website')} placeholder="https://…" />
            </Field>
            <Field label="Timezone">
              <Select options={TZ_OPTIONS} value={form.timezone} onChange={set('timezone')} />
            </Field>
          </FormRow>
        </SettingsCard>
      </ReadOnlyFieldset>
    </form>
  );
}

function HoursForm() {
  const toast = useToast();
  // PATCH /business/settings is @Roles(MANAGER).
  const { canManage } = usePermissions();
  const { data: settings, isLoading, isError, refetch } = useBusinessSettings();
  const update = useUpdateBusinessSettings();
  const [hours, setHours] = useState<OfficeHours | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [outsideMsg, setOutsideMsg] = useState('');

  useEffect(() => {
    if (settings) {
      setHours(settings.officeHours ?? {});
      setEnabled(settings.officeHoursEnabled);
      setOutsideMsg(settings.outsideHoursMessage ?? '');
    }
  }, [settings]);

  if (isLoading) return <LoadingState />;
  if (isError || !settings || hours === null) return <ErrorState onRetry={() => void refetch()} />;

  const dirty =
    enabled !== settings.officeHoursEnabled ||
    outsideMsg !== (settings.outsideHoursMessage ?? '') ||
    JSON.stringify(hours) !== JSON.stringify(settings.officeHours ?? {});

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          { officeHoursEnabled: enabled, officeHours: hours, outsideHoursMessage: outsideMsg },
          {
            onSuccess: () => toast.success('Business hours saved.', { title: 'Settings saved' }),
            onError: () => toast.error('Could not save your changes. Please try again.'),
          },
        );
      }}
    >
      <ReadOnlyFieldset readOnly={!canManage}>
        <SettingsCard
          title="Business hours"
          description="When closed, the AI sends your away message instead of replying live."
          footer={
            canManage ? (
              <SaveButton
                isPending={update.isPending}
                isSuccess={update.isSuccess}
                isError={update.isError}
                dirty={dirty}
              />
            ) : (
              <ReadOnlyNotice>Only a manager or owner can change business hours.</ReadOnlyNotice>
            )
          }
        >
          <Switch
            checked={enabled}
            onChange={setEnabled}
            label="Enforce business hours"
            description="Outside these hours, customers receive your away message."
          />
          {enabled && (
            <>
              <BusinessHoursEditor value={hours} onChange={setHours} />
              <Field label="Away message" hint="Sent automatically outside business hours.">
                <Textarea
                  value={outsideMsg}
                  onChange={(e) => setOutsideMsg(e.target.value)}
                  rows={2}
                  placeholder="Thanks for reaching out! We’re currently closed and will reply when we reopen."
                />
              </Field>
            </>
          )}
        </SettingsCard>
      </ReadOnlyFieldset>
    </form>
  );
}
