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
});
