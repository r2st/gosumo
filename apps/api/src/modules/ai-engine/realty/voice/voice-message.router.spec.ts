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
});
