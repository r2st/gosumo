import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelType, generateId, generateCorrelationId } from '@gosumo/shared';
import type {
  MessageReceivedEvent,
  PaymentSuccessEvent,
  ClientProfileUpdatedEvent,
} from '@gosumo/shared';
import {
  ClientIntelligenceRepository,
  ClientWithContacts,
} from './client-intelligence.repository';
import {
  FindOrCreateClientDto,
  UpdateClientProfileDto,
  ListClientsQueryDto,
  ClientProfileDto,
  ClientAISummaryDto,
  SentimentTrendDto,
  SentimentEntryDto,
  ChurnScoreDto,
  ChurnRiskLevel,
  LTVEstimateDto,
  ClientFactDto,
  PaginatedClients,
  ClientSegment,
  ClientSegmentDto,
  ClientTimelineDto,
  TimelineEventDto,
  TimelineEventType,
} from './dto';

// ─────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────

interface StoredFact {
  factType: string;
  value: string;
  confidence: number;
  messageId: string;
  extractedAt: string;
}

interface SentimentEntry {
  score: number;
  messageId: string;
  recordedAt: string;
}

/**
 * Churn risk level boundaries (score 0-100).
 * LOW: 0-30, MEDIUM: 31-60, HIGH: 61-80, CRITICAL: 81-100
 */
function getChurnRiskLevel(score: number): ChurnRiskLevel {
  if (score <= 30) return ChurnRiskLevel.LOW;
  if (score <= 60) return ChurnRiskLevel.MEDIUM;
  if (score <= 80) return ChurnRiskLevel.HIGH;
  return ChurnRiskLevel.CRITICAL;
}

/** Whole days between two dates (floored, never negative). */
function daysBetween(from: Date, to: Date): number {
  return Math.max(
    0,
    Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)),
  );
}

/**
 * ClientIntelligenceService — orchestrates client profile management,
 * fact extraction, sentiment tracking, churn risk assessment, and LTV estimation.
 *
 * All operations are scoped by businessId. Intelligence operations are best-effort
 * and never block message processing.
 */
@Injectable()
export class ClientIntelligenceService {
  private readonly logger = new Logger(ClientIntelligenceService.name);

  constructor(
    private readonly repository: ClientIntelligenceRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // Profile Management
  // ─────────────────────────────────────────────

  /**
   * Find or create a client by externalId + channelType.
   * Creates a channel_contact mapping. Returns the full profile.
   */
  async findOrCreateClient(
    businessId: string,
    dto: FindOrCreateClientDto,
  ): Promise<ClientProfileDto> {
    const client = await this.repository.findOrCreateClient(
      businessId,
      dto.externalId,
      dto.channelType,
      dto.channelAccountId,
      {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
      },
    );

    return this.toClientProfileDto(client);
  }

  /**
   * Get a client profile by ID.
   */
  async getClientProfile(
    businessId: string,
    clientId: string,
  ): Promise<ClientProfileDto> {
    const client = await this.repository.getClientById(businessId, clientId);

    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    return this.toClientProfileDto(client);
  }

  /**
   * Get a client by external ID and channel type.
   */
  async getClientByExternalId(
    businessId: string,
    externalId: string,
    channelType: ChannelType,
  ): Promise<ClientProfileDto | null> {
    const client = await this.repository.getClientByExternalId(
      businessId,
      externalId,
      channelType,
    );

    return client ? this.toClientProfileDto(client) : null;
  }

  /**
   * Update a client profile. Emits client.profile.updated event.
   */
  async updateClientProfile(
    businessId: string,
    clientId: string,
    dto: UpdateClientProfileDto,
  ): Promise<ClientProfileDto> {
    // Verify the client exists first
    const existing = await this.repository.getClientById(businessId, clientId);
    if (!existing) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const changedFields: string[] = [];
    if (dto.name !== undefined) changedFields.push('name');
    if (dto.email !== undefined) changedFields.push('email');
    if (dto.phone !== undefined) changedFields.push('phone');
    if (dto.avatarUrl !== undefined) changedFields.push('avatarUrl');
    if (dto.profile !== undefined) changedFields.push('profile');

    const updated = await this.repository.updateClientProfile(businessId, clientId, {
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      avatarUrl: dto.avatarUrl,
      profile: dto.profile,
    });

    // Emit profile updated event
    if (changedFields.length > 0) {
      const event: ClientProfileUpdatedEvent = {
        id: generateId(),
        type: 'client.profile.updated',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        clientId,
        changedFields,
        updatedBy: 'HUMAN',
      };
      this.eventEmitter.emit('client.profile.updated', event);
    }

    return this.toClientProfileDto(updated);
  }

  /**
   * List clients with optional search/filters, paginated.
   */
  async listClients(
    businessId: string,
    query: ListClientsQueryDto,
  ): Promise<PaginatedClients> {
    const result = await this.repository.listClients(businessId, {
      search: query.search || query.q,
      channelType: query.channelType,
      churnRisk: query.churnRisk,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: result.data.map((c) => this.toClientProfileDto(c)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Merge two clients: move conversations, orders, channel_contacts from
   * secondary to primary. Soft-delete the secondary client.
   */
  async mergeClients(
    businessId: string,
    primaryId: string,
    secondaryId: string,
  ): Promise<ClientProfileDto> {
    if (primaryId === secondaryId) {
      throw new BadRequestException('Cannot merge a client with itself');
    }

    const merged = await this.repository.mergeClients(
      businessId,
      primaryId,
      secondaryId,
    );

    // Emit profile updated event for the merged client
    const event: ClientProfileUpdatedEvent = {
      id: generateId(),
      type: 'client.profile.updated',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      clientId: primaryId,
      changedFields: ['merged'],
      updatedBy: 'SYSTEM',
    };
    this.eventEmitter.emit('client.profile.updated', event);

    return this.toClientProfileDto(merged);
  }

  // ─────────────────────────────────────────────
  // Intelligence: Fact Extraction
  // ─────────────────────────────────────────────

  /**
   * Extract facts from message text using regex-based extraction (MVP).
   * Stores extracted facts in the client profile metadata.
   * Returns extracted facts.
   */
  async extractAndStoreFacts(
    businessId: string,
    clientId: string,
    messageId: string,
    text: string,
  ): Promise<ClientFactDto[]> {
    const facts: ClientFactDto[] = [];

    try {
      // Extract name patterns: "my name is ...", "I'm ...", "I am ..."
      const namePatterns = [
        /my name is\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
        /i'?m\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i,
        /call me\s+([A-Z][a-zA-Z]+)/i,
      ];

      for (const pattern of namePatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
          facts.push({ factType: 'name', value: match[1].trim(), confidence: 0.8 });
          break;
        }
      }

      // Extract location patterns: "I'm in ...", "I live in ...", "from ..."
      const locationPatterns = [
        /(?:i'?m in|i live in|i'm from|i am from|based in|located in)\s+([A-Z][a-zA-Z\s]+?)(?:\.|,|$)/i,
      ];

      for (const pattern of locationPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
          facts.push({ factType: 'location', value: match[1].trim(), confidence: 0.75 });
          break;
        }
      }

      // Extract email
      const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      if (emailMatch) {
        facts.push({ factType: 'email', value: emailMatch[0], confidence: 0.95 });
      }

      // Extract phone (Indian format)
      const phoneMatch = text.match(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/);
      if (phoneMatch) {
        facts.push({ factType: 'phone', value: phoneMatch[0].replace(/[\s-]/g, ''), confidence: 0.9 });
      }

      // Extract preferences: "I prefer ...", "I like ...", "I want ..."
      const preferencePatterns = [
        /i (?:prefer|like|want|need|love)\s+(.+?)(?:\.|,|!|$)/i,
      ];

      for (const pattern of preferencePatterns) {
        const match = text.match(pattern);
        if (match?.[1] && match[1].length < 100) {
          facts.push({ factType: 'preference', value: match[1].trim(), confidence: 0.7 });
          break;
        }
      }

      // Store facts in client profile metadata
      if (facts.length > 0) {
        const client = await this.repository.getClientById(businessId, clientId);
        if (client) {
          const profile = (client.profile as Record<string, unknown>) ?? {};
          const existingFacts = (profile['facts'] as StoredFact[]) ?? [];

          const newFacts: StoredFact[] = facts.map((f) => ({
            factType: f.factType,
            value: f.value,
            confidence: f.confidence,
            messageId,
            extractedAt: new Date().toISOString(),
          }));

          // Append new facts (keep history)
          const updatedFacts = [...existingFacts, ...newFacts];

          // Update client name/email/phone if high confidence
          const updateData: Record<string, string | undefined> = {};
          const nameFact = facts.find((f) => f.factType === 'name' && f.confidence >= 0.8);
          if (nameFact && !client.name) {
            updateData['name'] = nameFact.value;
          }
          const emailFact = facts.find((f) => f.factType === 'email' && f.confidence >= 0.9);
          if (emailFact && !client.email) {
            updateData['email'] = emailFact.value;
          }
          const phoneFact = facts.find((f) => f.factType === 'phone' && f.confidence >= 0.9);
          if (phoneFact && !client.phone) {
            updateData['phone'] = phoneFact.value;
          }

          await this.repository.updateClientProfile(businessId, clientId, {
            profile: { ...profile, facts: updatedFacts },
            ...updateData,
          });

          // Emit fact extracted events
          for (const fact of facts) {
            this.eventEmitter.emit('client.fact.extracted', {
              id: generateId(),
              timestamp: new Date().toISOString(),
              businessId,
              correlationId: generateCorrelationId(),
              clientId,
              factType: fact.factType,
              value: fact.value,
            });
          }
        }
      }
    } catch (err) {
      // Intelligence is best-effort — log and continue
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Fact extraction failed for client ${clientId}: ${message}`,
      );
    }

    return facts;
  }

  // ─────────────────────────────────────────────
  // Intelligence: Sentiment
  // ─────────────────────────────────────────────

  /**
   * Record a sentiment score for a client message.
   * Clamps score to [-1.0, 1.0]. Stores in profile metadata.
   */
  async recordSentiment(
    businessId: string,
    clientId: string,
    messageId: string,
    score: number,
  ): Promise<void> {
    // Clamp to [-1.0, 1.0] — never throw
    const clampedScore = Math.max(-1.0, Math.min(1.0, score));

    try {
      const client = await this.repository.getClientById(businessId, clientId);
      if (!client) {
        this.logger.warn(`Cannot record sentiment: client ${clientId} not found`);
        return;
      }

      const profile = (client.profile as Record<string, unknown>) ?? {};
      const sentimentHistory = (profile['sentimentHistory'] as SentimentEntry[]) ?? [];

      sentimentHistory.push({
        score: clampedScore,
        messageId,
        recordedAt: new Date().toISOString(),
      });

      // Keep only the last 100 entries to prevent unbounded growth
      const trimmed = sentimentHistory.slice(-100);

      await this.repository.updateClientProfile(businessId, clientId, {
        profile: { ...profile, sentimentHistory: trimmed },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Sentiment recording failed for client ${clientId}: ${message}`,
      );
    }
  }

  /**
   * Get sentiment trend for a client over a time period.
   */
  async getClientSentimentTrend(
    businessId: string,
    clientId: string,
    days: number,
  ): Promise<SentimentTrendDto> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const profile = (client.profile as Record<string, unknown>) ?? {};
    const sentimentHistory = (profile['sentimentHistory'] as SentimentEntry[]) ?? [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const filtered = sentimentHistory.filter(
      (entry) => new Date(entry.recordedAt) >= cutoff,
    );

    const entries: SentimentEntryDto[] = filtered.map((entry) => ({
      date: entry.recordedAt,
      score: entry.score,
    }));

    const averageScore =
      entries.length > 0
        ? entries.reduce((sum, e) => sum + e.score, 0) / entries.length
        : undefined;

    return {
      clientId,
      days,
      entries,
      averageScore: averageScore !== undefined ? Math.round(averageScore * 100) / 100 : undefined,
    };
  }

  // ─────────────────────────────────────────────
  // Intelligence: Churn Risk
  // ─────────────────────────────────────────────

  /**
   * Calculate churn score based on RFM (Recency, Frequency, Monetary).
   * Score 0-100. Levels: LOW(0-30), MEDIUM(31-60), HIGH(61-80), CRITICAL(81-100).
   */
  async getChurnScore(
    businessId: string,
    clientId: string,
  ): Promise<ChurnScoreDto> {
    const rfmData = await this.repository.getClientRFMData(businessId, clientId);

    const score = this.calculateChurnScore(rfmData);
    const riskLevel = getChurnRiskLevel(score);

    return { score, riskLevel };
  }

  /**
   * RFM-based churn score calculation.
   *
   * Recency: days since last interaction (higher = worse = higher churn score)
   * Frequency: order count (higher = better = lower churn score)
   * Monetary: total spent (higher = better = lower churn score)
   */
  private calculateChurnScore(rfmData: {
    lastInteractionAt: Date | null;
    lastOrderAt: Date | null;
    orderCount: number;
    totalSpent: number;
    firstSeenAt: Date;
  }): number {
    const now = new Date();

    // Recency score (0-100, higher = more churn risk)
    const lastActivity = rfmData.lastInteractionAt ?? rfmData.lastOrderAt ?? rfmData.firstSeenAt;
    const daysSinceActivity = Math.floor(
      (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24),
    );

    let recencyScore: number;
    if (daysSinceActivity <= 7) recencyScore = 0;
    else if (daysSinceActivity <= 14) recencyScore = 15;
    else if (daysSinceActivity <= 30) recencyScore = 30;
    else if (daysSinceActivity <= 60) recencyScore = 50;
    else if (daysSinceActivity <= 90) recencyScore = 70;
    else recencyScore = 90;

    // Frequency score (0-100, higher orders = lower churn risk)
    let frequencyScore: number;
    if (rfmData.orderCount >= 10) frequencyScore = 0;
    else if (rfmData.orderCount >= 5) frequencyScore = 15;
    else if (rfmData.orderCount >= 3) frequencyScore = 30;
    else if (rfmData.orderCount >= 1) frequencyScore = 50;
    else frequencyScore = 80;

    // Monetary score (0-100, higher spend = lower churn risk)
    // Amounts in Decimal (rupees)
    let monetaryScore: number;
    if (rfmData.totalSpent >= 50000) monetaryScore = 0;
    else if (rfmData.totalSpent >= 10000) monetaryScore = 15;
    else if (rfmData.totalSpent >= 5000) monetaryScore = 30;
    else if (rfmData.totalSpent >= 1000) monetaryScore = 50;
    else monetaryScore = 70;

    // Weighted composite: Recency 50%, Frequency 30%, Monetary 20%
    const compositeScore = Math.round(
      recencyScore * 0.5 + frequencyScore * 0.3 + monetaryScore * 0.2,
    );

    // Clamp to 0-100
    return Math.max(0, Math.min(100, compositeScore));
  }

  // ─────────────────────────────────────────────
  // Intelligence: LTV
  // ─────────────────────────────────────────────

  /**
   * Get lifetime value estimate for a client.
   * Sum of all completed order values.
   */
  async getLTVEstimate(
    businessId: string,
    clientId: string,
  ): Promise<LTVEstimateDto> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const aggregates = await this.repository.getClientOrderAggregates(
      businessId,
      clientId,
    );

    // Convert from rupees (Decimal) to paise (integer)
    const totalRevenuePaise = Math.round(aggregates.totalRevenue * 100);
    const avgOrderValuePaise =
      aggregates.orderCount > 0
        ? Math.round(totalRevenuePaise / aggregates.orderCount)
        : 0;

    return {
      totalRevenuePaise,
      orderCount: aggregates.orderCount,
      avgOrderValuePaise,
    };
  }

  // ─────────────────────────────────────────────
  // Intelligence: Score Refresh
  // ─────────────────────────────────────────────

  /**
   * Recalculate churn + LTV + engagement scores.
   * Emits client.churn.risk ONLY on level boundary crossings.
   */
  async refreshIntelligenceScores(
    businessId: string,
    clientId: string,
  ): Promise<void> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      this.logger.warn(`Cannot refresh scores: client ${clientId} not found`);
      return;
    }

    // Get previous churn risk level
    const previousChurnRisk = client.churn_risk
      ? client.churn_risk.toNumber()
      : null;
    const previousLevel = previousChurnRisk !== null
      ? getChurnRiskLevel(Math.round(previousChurnRisk * 100))
      : null;

    // Calculate new churn score
    const rfmData = await this.repository.getClientRFMData(businessId, clientId);
    const newChurnScore = this.calculateChurnScore(rfmData);
    const newLevel = getChurnRiskLevel(newChurnScore);

    // Calculate LTV
    const aggregates = await this.repository.getClientOrderAggregates(
      businessId,
      clientId,
    );
    const ltvScore = aggregates.totalRevenue;

    // Calculate engagement score (based on recent activity)
    const engagementScore = this.calculateEngagementScore(rfmData);

    // Store as 0.0-1.0 scale for churn_risk and engagement_score
    await this.repository.updateIntelligenceScores(businessId, clientId, {
      churnRisk: newChurnScore / 100,
      ltvScore,
      engagementScore: engagementScore / 100,
    });

    // Emit churn risk event ONLY on level boundary crossings
    if (previousLevel !== null && previousLevel !== newLevel) {
      this.eventEmitter.emit('client.churn.risk', {
        id: generateId(),
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: generateCorrelationId(),
        clientId,
        churnScore: newChurnScore,
        riskLevel: newLevel,
        previousRiskLevel: previousLevel,
      });

      this.logger.log(
        `Churn risk boundary crossing for client ${clientId}: ${previousLevel} -> ${newLevel} (score: ${newChurnScore})`,
      );
    }
  }

  /**
   * Calculate engagement score (0-100) based on interaction patterns.
   */
  private calculateEngagementScore(rfmData: {
    lastInteractionAt: Date | null;
    orderCount: number;
    firstSeenAt: Date;
  }): number {
    const now = new Date();

    // Recency component (0-50)
    const lastActivity = rfmData.lastInteractionAt ?? rfmData.firstSeenAt;
    const daysSinceActivity = Math.floor(
      (now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24),
    );

    let recencyComponent: number;
    if (daysSinceActivity <= 1) recencyComponent = 50;
    else if (daysSinceActivity <= 7) recencyComponent = 40;
    else if (daysSinceActivity <= 14) recencyComponent = 30;
    else if (daysSinceActivity <= 30) recencyComponent = 20;
    else if (daysSinceActivity <= 60) recencyComponent = 10;
    else recencyComponent = 0;

    // Frequency component (0-50)
    let frequencyComponent: number;
    if (rfmData.orderCount >= 10) frequencyComponent = 50;
    else if (rfmData.orderCount >= 5) frequencyComponent = 40;
    else if (rfmData.orderCount >= 3) frequencyComponent = 30;
    else if (rfmData.orderCount >= 1) frequencyComponent = 20;
    else frequencyComponent = 5;

    return Math.min(100, recencyComponent + frequencyComponent);
  }

  // ─────────────────────────────────────────────
  // Intelligence: AI Summary
  // ─────────────────────────────────────────────

  /**
   * Generate a compact summary (<=300 chars) for AI prompt injection.
   * Includes name, sentiment, recent high-confidence facts, churn risk level.
   */
  async getClientSummaryForAI(
    businessId: string,
    clientId: string,
  ): Promise<ClientAISummaryDto> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const parts: string[] = [];

    // Name
    if (client.name) {
      parts.push(`Name: ${client.name}`);
    }

    // Churn risk level
    if (client.churn_risk !== null) {
      const score = Math.round(client.churn_risk.toNumber() * 100);
      const level = getChurnRiskLevel(score);
      parts.push(`Churn: ${level}`);
    }

    // Sentiment from recent history
    const profile = (client.profile as Record<string, unknown>) ?? {};
    const sentimentHistory = (profile['sentimentHistory'] as SentimentEntry[]) ?? [];
    if (sentimentHistory.length > 0) {
      const scores = sentimentHistory.slice(-5).map((e) => e.score).filter(Number.isFinite);
      if (scores.length > 0) {
        const avgSentiment = scores.reduce((sum, s) => sum + s, 0) / scores.length;
        const sentimentLabel =
          avgSentiment >= 0.3 ? 'positive' : avgSentiment <= -0.3 ? 'negative' : 'neutral';
        parts.push(`Mood: ${sentimentLabel}`);
      }
    }

    // Order stats
    if (client.total_orders > 0) {
      parts.push(`Orders: ${client.total_orders}`);
    }

    // High-confidence facts (confidence >= 0.7)
    const facts = (profile['facts'] as StoredFact[]) ?? [];
    const highConfFacts = facts.filter((f) => f.confidence >= 0.7);

    // Deduplicate by factType (keep most recent)
    const factMap = new Map<string, StoredFact>();
    for (const fact of highConfFacts) {
      const existing = factMap.get(fact.factType);
      if (!existing || fact.extractedAt > existing.extractedAt) {
        factMap.set(fact.factType, fact);
      }
    }

    for (const [factType, fact] of factMap) {
      if (factType !== 'name') {
        // Avoid duplicating name
        parts.push(`${factType}: ${fact.value}`);
      }
    }

    // Build summary, respecting 300 char limit
    let summary = parts.join('. ');
    if (summary.length > 300) {
      summary = summary.slice(0, 297) + '...';
    }

    return { clientId, summary };
  }

  // ─────────────────────────────────────────────
  // Intelligence: Segmentation
  // ─────────────────────────────────────────────

  /**
   * Classify a client into a behavioural segment (VIP, at-risk, new,
   * dormant, lost, active) derived from RFM signals + churn risk.
   */
  async getClientSegment(
    businessId: string,
    clientId: string,
  ): Promise<ClientSegmentDto> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const rfmData = await this.repository.getClientRFMData(businessId, clientId);
    const churnScore = this.calculateChurnScore(rfmData);
    const churnRiskLevel = getChurnRiskLevel(churnScore);

    const lastActivity =
      rfmData.lastInteractionAt ?? rfmData.lastOrderAt ?? rfmData.firstSeenAt;
    const daysSinceLastActivity = daysBetween(lastActivity, new Date());

    const { segment, reason } = this.computeSegment({
      orderCount: rfmData.orderCount,
      totalSpent: rfmData.totalSpent,
      daysSinceLastActivity,
      tenureDays: daysBetween(rfmData.firstSeenAt, new Date()),
      churnRiskLevel,
    });

    return {
      clientId,
      segment,
      reason,
      daysSinceLastActivity,
      orderCount: rfmData.orderCount,
      totalSpent: rfmData.totalSpent,
      churnRiskLevel,
    };
  }

  /**
   * Pure segment classifier. Precedence (highest first):
   * LOST → VIP → AT_RISK → DORMANT → NEW → ACTIVE.
   */
  private computeSegment(input: {
    orderCount: number;
    totalSpent: number;
    daysSinceLastActivity: number;
    tenureDays: number;
    churnRiskLevel: ChurnRiskLevel;
  }): { segment: ClientSegment; reason: string } {
    const VIP_ORDER_THRESHOLD = 10;
    const VIP_SPEND_THRESHOLD = 50000; // rupees
    const isHighChurn =
      input.churnRiskLevel === ChurnRiskLevel.HIGH ||
      input.churnRiskLevel === ChurnRiskLevel.CRITICAL;

    if (input.daysSinceLastActivity > 180) {
      return {
        segment: ClientSegment.LOST,
        reason: `No activity for ${input.daysSinceLastActivity} days (>180)`,
      };
    }

    if (
      (input.orderCount >= VIP_ORDER_THRESHOLD ||
        input.totalSpent >= VIP_SPEND_THRESHOLD) &&
      input.daysSinceLastActivity <= 60
    ) {
      return {
        segment: ClientSegment.VIP,
        reason: `High value (${input.orderCount} orders, ₹${input.totalSpent} spent) and active`,
      };
    }

    if (input.orderCount >= 1 && isHighChurn) {
      return {
        segment: ClientSegment.AT_RISK,
        reason: `Existing customer with ${input.churnRiskLevel} churn risk`,
      };
    }

    if (input.daysSinceLastActivity > 60) {
      return {
        segment: ClientSegment.DORMANT,
        reason: `No activity for ${input.daysSinceLastActivity} days (60–180)`,
      };
    }

    if (input.tenureDays <= 30 && input.orderCount <= 1) {
      return {
        segment: ClientSegment.NEW,
        reason: `Acquired ${input.tenureDays} days ago with ${input.orderCount} order(s)`,
      };
    }

    return {
      segment: ClientSegment.ACTIVE,
      reason: `Engaged customer with ${input.orderCount} order(s)`,
    };
  }

  // ─────────────────────────────────────────────
  // Intelligence: Timeline
  // ─────────────────────────────────────────────

  /**
   * Build a chronological (newest-first) timeline of all of a client's
   * interactions: conversations, orders, bookings, and payments.
   */
  async getClientTimeline(
    businessId: string,
    clientId: string,
    limit = 50,
  ): Promise<ClientTimelineDto> {
    const client = await this.repository.getClientById(businessId, clientId);
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }

    const data = await this.repository.getClientTimelineData(
      businessId,
      clientId,
      limit,
    );

    const events: TimelineEventDto[] = [];

    for (const c of data.conversations) {
      events.push({
        type: TimelineEventType.CONVERSATION,
        id: c.id,
        timestamp: (c.last_message_at ?? c.created_at).toISOString(),
        title: c.subject ?? `Conversation on ${c.channel}`,
        status: c.status,
        channel: c.channel as ChannelType,
      });
    }

    for (const o of data.orders) {
      events.push({
        type: TimelineEventType.ORDER,
        id: o.id,
        timestamp: o.placed_at.toISOString(),
        title: `Order ${o.order_number}`,
        status: o.status,
        amountPaise: Math.round(o.total.toNumber() * 100),
      });
    }

    for (const b of data.bookings) {
      events.push({
        type: TimelineEventType.BOOKING,
        id: b.id,
        timestamp: b.created_at.toISOString(),
        title: `Booking for ${b.start_at.toISOString()}`,
        status: b.status,
      });
    }

    for (const p of data.payments) {
      events.push({
        type: TimelineEventType.PAYMENT,
        id: p.id,
        timestamp: p.created_at.toISOString(),
        title: p.method ? `Payment via ${p.method}` : 'Payment',
        status: p.status,
        amountPaise: Math.round(p.amount.toNumber() * 100),
      });
    }

    // Newest first, then cap to the requested limit.
    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const limited = events.slice(0, limit);

    return { clientId, events: limited, total: limited.length };
  }

  // ─────────────────────────────────────────────
  // Event Listeners
  // ─────────────────────────────────────────────

  /**
   * On message.received: async fact extraction.
   * Intelligence is best-effort, never blocks message processing.
   */
  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    if (!event.clientId || !event.messageId) {
      return;
    }

    try {
      // We don't have the message text from the event — the fact extraction
      // must be called explicitly by the conversation/message module after
      // the message is stored. This listener updates last_interaction_at.
      await this.repository.updateClientProfile(event.businessId, event.clientId, {
        lastInteractionAt: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to handle message.received for client ${event.clientId}: ${message}`,
      );
    }
  }

  /**
   * On order.delivered: update LTV, reset churn risk.
   */
  @OnEvent('order.delivered')
  async handleOrderDelivered(event: {
    businessId: string;
    clientId: string;
    orderId: string;
  }): Promise<void> {
    try {
      await this.refreshIntelligenceScores(event.businessId, event.clientId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to handle order.delivered for client ${event.clientId}: ${message}`,
      );
    }
  }

  /**
   * On payment.success: update LTV.
   */
  @OnEvent('payment.success')
  async handlePaymentSuccess(event: PaymentSuccessEvent): Promise<void> {
    try {
      await this.refreshIntelligenceScores(event.businessId, event.clientId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to handle payment.success for client ${event.clientId}: ${message}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Mapping helpers
  // ─────────────────────────────────────────────

  private toClientProfileDto(client: ClientWithContacts): ClientProfileDto {
    const dto = new ClientProfileDto();
    dto.id = client.id;
    dto.businessId = client.business_id;
    dto.name = client.name;
    dto.email = client.email;
    dto.phone = client.phone;
    dto.avatarUrl = client.avatar_url;
    dto.profile = (client.profile as Record<string, unknown>) ?? {};
    dto.optOuts = (client.opt_outs as Record<string, unknown>) ?? {};
    dto.ltvScore = client.ltv_score ? client.ltv_score.toNumber() : null;
    dto.churnRisk = client.churn_risk ? client.churn_risk.toNumber() : null;
    dto.engagementScore = client.engagement_score
      ? client.engagement_score.toNumber()
      : null;
    dto.totalOrders = client.total_orders;
    dto.totalSpent = client.total_spent.toNumber();
    dto.lastInteractionAt = client.last_interaction_at;
    dto.firstSeenAt = client.first_seen_at;
    dto.createdAt = client.created_at;
    dto.updatedAt = client.updated_at;

    if (client.channel_contacts) {
      dto.channelContacts = client.channel_contacts.map((cc) => ({
        id: cc.id,
        channel: cc.channel as ChannelType,
        externalId: cc.external_id,
        displayName: cc.display_name,
        profilePicUrl: cc.profile_pic_url,
        isOptedIn: cc.is_opted_in,
        firstSeenAt: cc.first_seen_at,
        lastSeenAt: cc.last_seen_at,
      }));
    }

    return dto;
  }
}
