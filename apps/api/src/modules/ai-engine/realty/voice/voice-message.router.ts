import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { MessageReceivedEvent } from '@gosumo/shared';
import { PrismaService } from '../../../../common/services/prisma.service';
import { RealtyLeadsService } from '../../../realty-leads/realty-leads.service';
import { VoiceNoteProcessorService } from './voice-note-processor.service';
import { TranscriptionUnavailableError } from './transcription.service';

/** An audio payload lifted from a stored message. */
interface AudioRef {
  mediaUrl: string;
  mimeType: string;
}

/**
 * VoiceMessageRouter — bridges the messaging spine to the voice pipeline.
 *
 * On every inbound `message.received`, it checks whether the latest inbound
 * message on that conversation is a voice note. If so it transcribes it,
 * stamps the transcript onto the message's `metadata` (so the thread can show
 * it — the append-only `content` is never touched), and feeds the text into the
 * realty AI turn as if the buyer had typed it (blueprint §5.3).
 *
 * Broker voice commands do NOT flow through here — they arrive on the
 * authenticated `/realty/voice/broker-command` endpoint from the console.
 */
@Injectable()
export class VoiceMessageRouter {
  private readonly logger = new Logger(VoiceMessageRouter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: RealtyLeadsService,
    private readonly processor: VoiceNoteProcessorService,
  ) {}

  @OnEvent('message.received')
  async onMessageReceived(event: MessageReceivedEvent): Promise<void> {
    if (!event.conversationId || !event.businessId || !event.senderExternalId) return;
    try {
      await this.handle(event);
    } catch (err) {
      this.logger.error(
        `Voice routing failed for message ${event.messageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async handle(event: MessageReceivedEvent): Promise<void> {
    // The inbound message was just stored; it is the latest inbound on the convo.
    const message = await this.prisma.messages.findFirst({
      where: {
        business_id: event.businessId,
        conversation_id: event.conversationId,
        direction: 'INBOUND',
      },
      orderBy: { created_at: 'desc' },
    });
    if (!message) return;

    const audio = extractAudio(message);
    if (!audio) return;

    // Idempotency: don't re-transcribe a message we've already handled.
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta['transcription'] === 'string') return;

    const lead = await this.leads.findLeadByPhone(event.businessId, event.senderExternalId);
    if (!lead) {
      this.logger.debug(`Voice note from ${event.senderExternalId} has no lead yet — skipping`);
      return;
    }

    let transcript: string;
    try {
      transcript = await this.processor.transcribeVoiceNote(audio.mediaUrl, audio.mimeType);
    } catch (err) {
      if (err instanceof TranscriptionUnavailableError) {
        this.logger.warn(`Voice note transcription unavailable: ${err.message}`);
        return;
      }
      throw err;
    }

    // Stamp the transcript on metadata (content stays append-only) so the
    // conversation thread can render it beneath the audio player.
    await this.prisma.messages.update({
      where: { id: message.id },
      data: {
        metadata: {
          ...meta,
          transcription: transcript,
          transcribedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await this.processor.processBuyerVoiceNote(event.businessId, lead.id, transcript, {
      conversationId: event.conversationId,
      correlationId: event.correlationId,
    });
    this.logger.log(`Transcribed + processed voice note for lead ${lead.id}`);
  }
}

/**
 * Detect a voice/audio payload on a stored message. Voice notes come through the
 * WhatsApp adapter as `audio/*` content (the DB `type` may be AUDIO or, for the
 * current adapter mapping, IMAGE with an audio mime-type).
 */
function extractAudio(message: {
  type: string;
  content: unknown;
}): AudioRef | null {
  const content = (message.content ?? {}) as Record<string, unknown>;
  const mime = typeof content['mimeType'] === 'string' ? content['mimeType'] : '';
  const url = typeof content['url'] === 'string' ? content['url'] : '';
  const type = String(message.type ?? content['type'] ?? '').toUpperCase();
  const isAudio = type === 'AUDIO' || type === 'VOICE' || mime.startsWith('audio/');
  if (!isAudio || !url) return null;
  return { mediaUrl: url, mimeType: mime || 'audio/ogg' };
}
