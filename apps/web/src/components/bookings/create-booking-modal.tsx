'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { CalendarClock, Check } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Avatar } from '@/components/ui/avatar';
import { useClients } from '@/hooks/use-queries';
import { useCatalogItems } from '@/hooks/use-catalog';
import { useCreateBooking, useSlots, useStaff } from '@/hooks/use-bookings';
import { formatTimeIST, formatDateIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CreateBookingRequest } from '@/lib/commerce-types';

export function CreateBookingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateBooking();

  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [startTime, setStartTime] = useState('');
  const [notes, setNotes] = useState('');
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [createOrder, setCreateOrder] = useState(true);

  const clientsQ = useClients({ q: clientQuery || undefined, limit: 6 });
  const servicesQ = useCatalogItems({ type: 'SERVICE', limit: 100 });
  const staffQ = useStaff();

  // Suggested slots for the chosen service, next 14 days.
  const slotRange = useMemo(() => {
    const today = new Date();
    const to = new Date(today.getTime() + 14 * 86_400_000);
    return { from: format(today, 'yyyy-MM-dd'), to: format(to, 'yyyy-MM-dd') };
  }, []);
  const slotsQ = useSlots(
    { catalogItemId: serviceId, staffMemberId: staffId || undefined, from: slotRange.from, to: slotRange.to },
    open && !!serviceId,
  );
  const slots = (slotsQ.data?.slots ?? []).filter((s) => s.available).slice(0, 12);

  const reset = () => {
    setClientId('');
    setClientName('');
    setClientQuery('');
    setServiceId('');
    setStaffId('');
    setStartTime('');
    setNotes('');
    setSendConfirmation(true);
    setCreateOrder(true);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clientId || !serviceId || !startTime) return;
    const body: CreateBookingRequest = {
      clientId,
      catalogItemId: serviceId,
      staffMemberId: staffId || undefined,
      startTime: new Date(startTime).toISOString(),
      notes: notes.trim() || undefined,
      sendConfirmation,
      createOrder,
    };
    create.mutate(body, {
      onSuccess: () => {
        reset();
        onClose();
      },
    });
  };

  const close = () => {
    reset();
    onClose();
  };

  const clients = clientsQ.data?.data ?? [];

  return (
    <Modal
      open={open}
      onClose={close}
      title="New booking"
      description="Schedule an appointment for a client."
      footer={
        <>
          <Button variant="outline" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="booking-form" loading={create.isPending} disabled={!clientId || !serviceId || !startTime}>
            Create booking
          </Button>
        </>
      }
    >
      <form id="booking-form" onSubmit={submit} className="space-y-4">
        {/* Client */}
        <Field label="Client">
          {clientId ? (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-success" /> {clientName}
              </span>
              <button
                type="button"
                onClick={() => {
                  setClientId('');
                  setClientName('');
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Input value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Search client by name, phone…" />
              {clientQuery && (
                <div className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {clients.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No matching clients.</p>
                  ) : (
                    clients.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setClientId(c.id);
                          setClientName(c.name);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <Avatar name={c.name} src={c.avatarUrl} size="sm" />
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto truncate text-xs text-muted-foreground">{c.phone ?? c.email}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Service">
            <Select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              options={[
                { label: 'Select a service…', value: '' },
                ...(servicesQ.data?.data ?? []).map((s) => ({ label: s.name, value: s.id })),
              ]}
            />
          </Field>
          <Field label="Staff" hint="Optional">
            <Select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              options={[
                { label: 'Any available', value: '' },
                ...(staffQ.data?.staff ?? []).map((s) => ({ label: s.name, value: s.id })),
              ]}
            />
          </Field>
        </div>

        <Field label="Date & time">
          <Input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        </Field>

        {/* Suggested slots */}
        {serviceId && (
          <Field label="Suggested slots" hint={slotsQ.isLoading ? 'Finding availability…' : undefined}>
            {slots.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {slotsQ.isLoading ? 'Loading…' : 'No open slots in the next 14 days — pick a time manually.'}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {slots.map((slot) => {
                  const dt = new Date(slot.startTime);
                  const localValue = format(dt, "yyyy-MM-dd'T'HH:mm");
                  const active = startTime === localValue;
                  return (
                    <button
                      key={slot.startTime}
                      type="button"
                      onClick={() => setStartTime(localValue)}
                      className={cn(
                        'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted',
                      )}
                    >
                      {formatDateIST(slot.startTime).replace(/ \d{4}$/, '')}, {formatTimeIST(slot.startTime)}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        )}

        <Field label="Notes" hint="Optional">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything the team should know" />
        </Field>

        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <Switch checked={sendConfirmation} onChange={setSendConfirmation} label="Send confirmation" description="Notify the client via their preferred channel." />
          <Switch checked={createOrder} onChange={setCreateOrder} label="Create order & payment" description="Generate a linked order and payment link." />
        </div>

        {!serviceId && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" /> Choose a service to see suggested slots.
          </p>
        )}
        {create.isError && <p className="text-sm text-danger">Couldn’t create the booking. The slot may no longer be available.</p>}
      </form>
    </Modal>
  );
}
