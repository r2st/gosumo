import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { BaseEvent } from '@gosumo/shared';
import { NotificationService } from './notification.service';
import { SUPPORTED_TRIGGER_EVENTS } from './notification.constants';

/**
 * NotificationEventListener — bridges the domain event bus to the notification
 * pipeline. It subscribes to every event in {@link SUPPORTED_TRIGGER_EVENTS}
 * (booking.*, order.*, payment.*) and hands the payload to the service, which
 * resolves the business's configured triggers (or a built-in default) and
 * dispatches the matching notifications.
 *
 * The handler is intentionally generic: each domain event carries its own
 * `type` discriminant, so one method covers all subscribed events.
 */
@Injectable()
export class NotificationEventListener {
  private readonly logger = new Logger(NotificationEventListener.name);

  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent(SUPPORTED_TRIGGER_EVENTS, { async: true, promisify: true })
  async handleTriggerEvent(
    event: BaseEvent & { type: string; clientId?: string },
  ): Promise<void> {
    if (!event?.type) {
      this.logger.warn('Received an event without a type discriminant; ignoring');
      return;
    }
    this.logger.debug(`Notification trigger event: ${event.type}`);
    try {
      await this.notificationService.handleEventTrigger(
        event.type,
        event as unknown as Record<string, unknown>,
      );
    } catch (err) {
      // Never let a notification failure break the emitting flow.
      this.logger.error(
        `Failed handling ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
