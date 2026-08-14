/**
 * VoiceMessageRouter unit tests — audio detection + transcribe → AI routing off
 * the `message.received` spine. Prisma, leads, and the processor are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import type { MessageReceivedEvent } from '@gosumo/shared';
import { VoiceMessageRouter } from './voice-message.router';
import { VoiceNoteProcessorService } from './voice-note-processor.service';
import { RealtyLeadsService } from '../../../realty-leads/realty-leads.service';
import { PrismaService } from '../../../../common/services/prisma.service';
import { TranscriptionUnavailableError } from './transcription.service';

const BIZ = '00000000-0000-4000-a000-000000000001';

function event(overrides: Partial<MessageReceivedEvent> = {}): MessageReceivedEvent {
  return {
    id: 'evt_1',
    type: 'message.received',
    timestamp: new Date().toISOString(),
    businessId: BIZ,
    correlationId: 'corr_1',
    messageId: 'msg_1',
    conversationId: 'conv_1',
    channelAccountId: 'acc_1',
    channel: 'WHATSAPP',
    senderExternalId: '919876543210',
    clientId: 'client_1',
    ...overrides,
  } as MessageReceivedEvent;
}

const audioMessage = {
  id: 'm1',
  type: 'AUDIO',
  content: { type: 'IMAGE', url: 'whatsapp-media://vid', mimeType: 'audio/ogg' },
  metadata: {},
};
const textMessage = {
  id: 'm2',
  type: 'TEXT',
  content: { type: 'TEXT', text: 'hi' },
  metadata: {},
};

describe('VoiceMessageRouter', () => {
  let router: VoiceMessageRouter;
  let prisma: { messages: { findFirst: jest.Mock; update: jest.Mock } };
  let leads: { findLeadByPhone: jest.Mock };
  let processor: { transcribeVoiceNote: jest.Mock; processBuyerVoiceNote: jest.Mock };

  beforeEach(async () => {
    prisma = {
      messages: {
        findFirst: jest.fn().mockResolvedValue(audioMessage),
        update: jest.fn().mockResolvedValue(audioMessage),
      },
    };
    leads = { findLeadByPhone: jest.fn().mockResolvedValue({ id: 'lead_1' }) };
    processor = {
      transcribeVoiceNote: jest.fn().mockResolvedValue('two bhk in whitefield'),
      processBuyerVoiceNote: jest.fn().mockResolvedValue({ routeMode: 'DRAFT' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceMessageRouter,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtyLeadsService, useValue: leads },
        { provide: VoiceNoteProcessorService, useValue: processor },
      ],
    }).compile();

    router = module.get(VoiceMessageRouter);
  });

  it('transcribes an audio message, stamps metadata, and routes to the AI', async () => {
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).toHaveBeenCalledWith('whatsapp-media://vid', 'audio/ogg');
    expect(prisma.messages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ transcription: 'two bhk in whitefield' }),
        }),
      }),
    );
    expect(processor.processBuyerVoiceNote).toHaveBeenCalledWith(
      BIZ,
      'lead_1',
      'two bhk in whitefield',
      expect.objectContaining({ conversationId: 'conv_1' }),
    );
  });

  it('ignores a non-audio message', async () => {
    prisma.messages.findFirst.mockResolvedValue(textMessage);
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).not.toHaveBeenCalled();
    expect(processor.processBuyerVoiceNote).not.toHaveBeenCalled();
  });

  it('detects audio by mime-type even when type is not AUDIO', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      ...audioMessage,
      type: 'IMAGE',
    });
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).toHaveBeenCalled();
  });

  it('skips a message already transcribed (idempotent)', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      ...audioMessage,
      metadata: { transcription: 'already done' },
    });
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).not.toHaveBeenCalled();
  });

  it('skips when there is no lead for the sender', async () => {
    leads.findLeadByPhone.mockResolvedValue(null);
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).not.toHaveBeenCalled();
  });

  it('swallows a transcription-unavailable error without routing to the AI', async () => {
    processor.transcribeVoiceNote.mockRejectedValue(new TranscriptionUnavailableError('no key'));
    await router.onMessageReceived(event());
    expect(prisma.messages.update).not.toHaveBeenCalled();
    expect(processor.processBuyerVoiceNote).not.toHaveBeenCalled();
  });

  it('returns early when the event has no conversation', async () => {
    await router.onMessageReceived(event({ conversationId: '' }));
    expect(prisma.messages.findFirst).not.toHaveBeenCalled();
  });

  it('returns early when the event has no business', async () => {
    await router.onMessageReceived(event({ businessId: '' }));
    expect(prisma.messages.findFirst).not.toHaveBeenCalled();
  });

  it('returns early when the event has no sender', async () => {
    // Without a sender there is no phone to resolve a lead by.
    await router.onMessageReceived(event({ senderExternalId: '' }));
    expect(prisma.messages.findFirst).not.toHaveBeenCalled();
  });

  it('returns early when the conversation has no stored inbound message', async () => {
    prisma.messages.findFirst.mockResolvedValue(null);
    await router.onMessageReceived(event());
    expect(leads.findLeadByPhone).not.toHaveBeenCalled();
  });

  it('scopes the message lookup to the tenant and the inbound direction', async () => {
    await router.onMessageReceived(event());
    expect(prisma.messages.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          business_id: BIZ,
          conversation_id: 'conv_1',
          direction: 'INBOUND',
        },
        orderBy: { created_at: 'desc' },
      }),
    );
  });

  it('scopes the metadata update to the tenant', async () => {
    await router.onMessageReceived(event());
    expect(prisma.messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1', business_id: BIZ } }),
    );
  });

  it('preserves pre-existing metadata when stamping the transcript', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      ...audioMessage,
      metadata: { waMessageId: 'wamid.1' },
    });

    await router.onMessageReceived(event());

    const data = prisma.messages.update.mock.calls[0][0].data.metadata;
    expect(data).toMatchObject({
      waMessageId: 'wamid.1',
      transcription: 'two bhk in whitefield',
    });
    expect(typeof data.transcribedAt).toBe('string');
  });

  it('treats a VOICE-typed message as audio', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      ...audioMessage,
      type: 'VOICE',
      content: { url: 'whatsapp-media://v2' },
    });

    await router.onMessageReceived(event());

    // No mimeType on the payload — the WhatsApp default is assumed.
    expect(processor.transcribeVoiceNote).toHaveBeenCalledWith(
      'whatsapp-media://v2',
      'audio/ogg',
    );
  });

  it('falls back to the content type when the row has no type column value', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      id: 'm4',
      type: null,
      content: { type: 'AUDIO', url: 'whatsapp-media://v3' },
      metadata: {},
    });

    await router.onMessageReceived(event());

    expect(processor.transcribeVoiceNote).toHaveBeenCalledWith(
      'whatsapp-media://v3',
      'audio/ogg',
    );
  });

  it('ignores an audio message that carries no media URL', async () => {
    prisma.messages.findFirst.mockResolvedValue({
      ...audioMessage,
      content: { mimeType: 'audio/ogg' },
    });

    await router.onMessageReceived(event());

    expect(processor.transcribeVoiceNote).not.toHaveBeenCalled();
  });

  it('ignores a message with no content at all', async () => {
    prisma.messages.findFirst.mockResolvedValue({ id: 'm3', type: 'TEXT', content: null });
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).not.toHaveBeenCalled();
  });

  it('treats null metadata as not-yet-transcribed', async () => {
    prisma.messages.findFirst.mockResolvedValue({ ...audioMessage, metadata: null });
    await router.onMessageReceived(event());
    expect(processor.transcribeVoiceNote).toHaveBeenCalled();
  });

  it('swallows an unexpected transcription failure instead of breaking the spine', async () => {
    // This runs inside an @OnEvent handler — an escaping rejection would surface
    // as an unhandled rejection and take down unrelated message.received work.
    processor.transcribeVoiceNote.mockRejectedValue(new Error('whisper 500'));

    await expect(router.onMessageReceived(event())).resolves.toBeUndefined();
    expect(prisma.messages.update).not.toHaveBeenCalled();
    expect(processor.processBuyerVoiceNote).not.toHaveBeenCalled();
  });

  it('swallows a database failure during lookup', async () => {
    prisma.messages.findFirst.mockRejectedValue(new Error('connection terminated'));

    await expect(router.onMessageReceived(event())).resolves.toBeUndefined();
  });

  it('swallows a non-Error rejection', async () => {
    prisma.messages.findFirst.mockRejectedValue('socket hang up');

    await expect(router.onMessageReceived(event())).resolves.toBeUndefined();
  });

  it('does not route to the AI when the metadata stamp fails', async () => {
    // The transcript is the record; routing without persisting it would make the
    // turn unreproducible and re-transcribe on the next inbound message.
    prisma.messages.update.mockRejectedValue(new Error('write conflict'));

    await expect(router.onMessageReceived(event())).resolves.toBeUndefined();
    expect(processor.processBuyerVoiceNote).not.toHaveBeenCalled();
  });
});
