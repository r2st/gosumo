/**
 * Tests for AI confidence threshold endpoints added to fix
 * "Something went wrong" on the AI settings page.
 */
describe('AiEngineService confidence thresholds', () => {
  let prisma: { businesses: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };

  beforeEach(() => {
    prisma = {
      businesses: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
    };
  });

  // ─── getConfidenceThresholds ──────────────────

  describe('getConfidenceThresholds', () => {
    async function getConfidenceThresholds(businessId: string) {
      try {
        const biz = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
        const s = (biz.ai_settings ?? {}) as Record<string, any>;
        return { autoExecute: s.autoExecuteThreshold ?? 90, draftReview: s.reviewThreshold ?? 70 };
      } catch {
        return { autoExecute: 90, draftReview: 70 };
      }
    }

    it('should return stored thresholds when they exist', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({
        ai_settings: { autoExecuteThreshold: 85, reviewThreshold: 60 },
      });

      const result = await getConfidenceThresholds('biz-1');

      expect(result.autoExecute).toBe(85);
      expect(result.draftReview).toBe(60);
    });

    it('should return defaults when ai_settings is empty', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({ ai_settings: {} });

      const result = await getConfidenceThresholds('biz-1');

      expect(result.autoExecute).toBe(90);
      expect(result.draftReview).toBe(70);
    });

    it('should return defaults when ai_settings is null', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({ ai_settings: null });

      const result = await getConfidenceThresholds('biz-1');

      expect(result.autoExecute).toBe(90);
      expect(result.draftReview).toBe(70);
    });

    it('should return defaults when business lookup fails', async () => {
      prisma.businesses.findUniqueOrThrow.mockRejectedValue(new Error('not found'));

      const result = await getConfidenceThresholds('missing-biz');

      expect(result.autoExecute).toBe(90);
      expect(result.draftReview).toBe(70);
    });
  });

  // ─── updateConfidenceThresholds ───────────────

  describe('updateConfidenceThresholds', () => {
    async function updateConfidenceThresholds(
      businessId: string,
      body: { autoExecute?: number; draftReview?: number },
    ) {
      const biz = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
      const s = { ...((biz.ai_settings ?? {}) as Record<string, any>) };
      if (body.autoExecute !== undefined) s.autoExecuteThreshold = body.autoExecute;
      if (body.draftReview !== undefined) s.reviewThreshold = body.draftReview;
      await prisma.businesses.update({ where: { id: businessId }, data: { ai_settings: s as any } });
      return { autoExecute: s.autoExecuteThreshold ?? 90, draftReview: s.reviewThreshold ?? 70 };
    }

    it('should update autoExecute threshold', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({ ai_settings: { autoExecuteThreshold: 90, reviewThreshold: 70 } });
      prisma.businesses.update.mockResolvedValue({});

      const result = await updateConfidenceThresholds('biz-1', { autoExecute: 95 });

      expect(result.autoExecute).toBe(95);
      expect(result.draftReview).toBe(70);
      expect(prisma.businesses.update).toHaveBeenCalledWith({
        where: { id: 'biz-1' },
        data: { ai_settings: expect.objectContaining({ autoExecuteThreshold: 95, reviewThreshold: 70 }) },
      });
    });

    it('should update draftReview threshold', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({ ai_settings: {} });
      prisma.businesses.update.mockResolvedValue({});

      const result = await updateConfidenceThresholds('biz-1', { draftReview: 50 });

      expect(result.draftReview).toBe(50);
      expect(result.autoExecute).toBe(90); // default preserved
    });

    it('should update both thresholds at once', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({ ai_settings: {} });
      prisma.businesses.update.mockResolvedValue({});

      const result = await updateConfidenceThresholds('biz-1', { autoExecute: 80, draftReview: 40 });

      expect(result.autoExecute).toBe(80);
      expect(result.draftReview).toBe(40);
    });

    it('should preserve existing ai_settings keys not related to thresholds', async () => {
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({
        ai_settings: { autoReplyEnabled: true, personalityPrompt: 'Be kind' },
      });
      prisma.businesses.update.mockResolvedValue({});

      await updateConfidenceThresholds('biz-1', { autoExecute: 85 });

      expect(prisma.businesses.update).toHaveBeenCalledWith({
        where: { id: 'biz-1' },
        data: {
          ai_settings: expect.objectContaining({
            autoReplyEnabled: true,
            personalityPrompt: 'Be kind',
            autoExecuteThreshold: 85,
          }),
        },
      });
    });
  });
});
