import { NotificationEventListener } from './notification.event-listener';
import { NotificationService } from './notification.service';

describe('NotificationEventListener', () => {
  let service: { handleEventTrigger: jest.Mock };
  let listener: NotificationEventListener;

  beforeEach(() => {
    service = { handleEventTrigger: jest.fn().mockResolvedValue(undefined) };
    listener = new NotificationEventListener(service as unknown as NotificationService);
  });

  it('forwards the event type and payload to the service', async () => {
    const event = {
      id: 'e1',
      type: 'booking.created',
      timestamp: '2026-06-27T00:00:00Z',
      businessId: 'biz-1',
      correlationId: 'corr-1',
      clientId: 'client-1',
    };
    await listener.handleTriggerEvent(event as never);
    expect(service.handleEventTrigger).toHaveBeenCalledWith('booking.created', event);
  });

  it('ignores an event with no type discriminant', async () => {
    await listener.handleTriggerEvent({} as never);
    expect(service.handleEventTrigger).not.toHaveBeenCalled();
  });

  it('swallows service errors so the emitter flow is never broken', async () => {
    service.handleEventTrigger.mockRejectedValueOnce(new Error('boom'));
    await expect(
      listener.handleTriggerEvent({ type: 'order.confirmed' } as never),
    ).resolves.toBeUndefined();
  });

  it('swallows a rejection that is not an Error too', async () => {
    // The handler stringifies the rejection rather than reading `.message`
    // off it. Reading it blind would throw inside the catch, which is the one
    // place a throw is not caught — and would take the emitting flow down
    // with it, which is exactly what this listener exists to prevent.
    service.handleEventTrigger.mockRejectedValueOnce('socket hang up');
    await expect(
      listener.handleTriggerEvent({ type: 'order.confirmed' } as never),
    ).resolves.toBeUndefined();
  });
});
