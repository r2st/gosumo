'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { LoadingState, ErrorState } from '@/components/ui/states';
import { BusinessHoursEditor } from '@/components/settings/business-hours-editor';
import { useBusinessSettings, useUpdateBusinessSettings } from '@/hooks/use-bookings';
import type { OfficeHours } from '@/lib/feature-types';

export function AvailabilitySettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useBusinessSettings();
  const update = useUpdateBusinessSettings();

  const [bookingEnabled, setBookingEnabled] = useState(true);
  const [slotDuration, setSlotDuration] = useState('30');
  const [hours, setHours] = useState<OfficeHours>({});

  useEffect(() => {
    if (data) {
      setBookingEnabled(data.bookingEnabled);
      setSlotDuration(String(data.defaultSlotDurationMinutes ?? 30));
      setHours(data.officeHours ?? {});
    }
  }, [data]);

  const save = () => {
    update.mutate(
      {
        bookingEnabled,
        defaultSlotDurationMinutes: Number(slotDuration) || 30,
        officeHours: hours,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Availability settings"
      description="Control when clients can book and how long each slot is."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={update.isPending} disabled={isLoading || isError}>
            Save settings
          </Button>
        </>
      }
    >
      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : (
        <div className="space-y-5">
          <div className="rounded-lg border border-border p-4">
            <Switch
              checked={bookingEnabled}
              onChange={setBookingEnabled}
              label="Accept bookings"
              description="Turn off to pause all new bookings."
            />
          </div>

          <Field label="Default slot duration (minutes)" hint="Used when a service doesn’t specify its own length.">
            <Input
              type="number"
              min="5"
              step="5"
              value={slotDuration}
              onChange={(e) => setSlotDuration(e.target.value)}
              className="w-40"
            />
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium">Working hours</p>
            <BusinessHoursEditor value={hours} onChange={setHours} />
          </div>

          {update.isError && <p className="text-sm text-danger">Couldn’t save settings. Please try again.</p>}
        </div>
      )}
    </Modal>
  );
}
