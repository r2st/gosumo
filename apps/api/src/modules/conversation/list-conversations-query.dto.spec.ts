/**
 * Validation tests for ListConversationsQueryDto.
 *
 * Regression coverage for the dashboard bug "property channelType should not
 * exist": the conversations channel filter sends `?channelType=WHATSAPP`
 * (per API_DESIGN.md), but the DTO previously named the field `channel`. Under
 * the global ValidationPipe (`whitelist: true, forbidNonWhitelisted: true`),
 * the unexpected `channelType` key was rejected, so selecting ANY channel
 * (WhatsApp, Instagram, SMS, Web Chat, Email) in the filter failed.
 *
 * These tests run the DTO through a ValidationPipe configured identically to
 * the one in main.ts, so they fail if the field name regresses.
 */

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';

import { ListConversationsQueryDto } from './dto';

// Mirror the global pipe configured in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const metadata: ArgumentMetadata = {
  type: 'query',
  metatype: ListConversationsQueryDto,
  data: '',
};

describe('ListConversationsQueryDto validation', () => {
  it('accepts channelType (the param the dashboard sends)', async () => {
    const result = await pipe.transform({ channelType: 'WHATSAPP' }, metadata);

    expect(result).toBeInstanceOf(ListConversationsQueryDto);
    expect(result.channelType).toBe(ChannelType.WHATSAPP);
  });

  it.each([
    ChannelType.WHATSAPP,
    ChannelType.INSTAGRAM,
    ChannelType.SMS,
    ChannelType.WEB_CHAT,
    ChannelType.EMAIL,
  ])('accepts every channel type the filter offers: %s', async (channelType) => {
    const result = await pipe.transform({ channelType }, metadata);

    expect(result.channelType).toBe(channelType);
  });

  it('rejects an invalid channelType value', async () => {
    await expect(
      pipe.transform({ channelType: 'CARRIER_PIGEON' }, metadata),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects the old `channel` key (now a non-whitelisted property)', async () => {
    // Guards against re-introducing the legacy field name.
    await expect(
      pipe.transform({ channel: 'WHATSAPP' }, metadata),
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([
          expect.stringContaining('property channel should not exist'),
        ]),
      },
    });
  });

  it('allows an empty query (no filters selected)', async () => {
    const result = await pipe.transform({}, metadata);

    expect(result).toBeInstanceOf(ListConversationsQueryDto);
    expect(result.channelType).toBeUndefined();
  });

  // ── `q` free-text search (frontend sends `q`, not `search`) ──
  describe('q (free-text search)', () => {
    it('accepts the `q` param the dashboard sends', async () => {
      const result = await pipe.transform({ q: 'refund request' }, metadata);

      expect(result.q).toBe('refund request');
    });

    it('rejects the old `search` key (now a non-whitelisted property)', async () => {
      await expect(
        pipe.transform({ search: 'refund request' }, metadata),
      ).rejects.toMatchObject({
        response: {
          message: expect.arrayContaining([
            expect.stringContaining('property search should not exist'),
          ]),
        },
      });
    });
  });

  // ── `assignedTo` (frontend sends `assignedTo`, not `assigneeId`) ──
  describe('assignedTo', () => {
    it('accepts a team-member UUID', async () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const result = await pipe.transform({ assignedTo: uuid }, metadata);

      expect(result.assignedTo).toBe(uuid);
    });

    it.each(['me', 'unassigned'])(
      'accepts the magic value "%s"',
      async (value) => {
        const result = await pipe.transform({ assignedTo: value }, metadata);

        expect(result.assignedTo).toBe(value);
      },
    );

    it('rejects an arbitrary non-UUID, non-magic value', async () => {
      await expect(
        pipe.transform({ assignedTo: 'someone-else' }, metadata),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects the old `assigneeId` key (now a non-whitelisted property)', async () => {
      await expect(
        pipe.transform(
          { assigneeId: '550e8400-e29b-41d4-a716-446655440000' },
          metadata,
        ),
      ).rejects.toMatchObject({
        response: {
          message: expect.arrayContaining([
            expect.stringContaining('property assigneeId should not exist'),
          ]),
        },
      });
    });
  });
});
