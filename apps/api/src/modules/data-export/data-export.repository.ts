import { Injectable } from '@nestjs/common';
import type {
  bookings,
  channel_contacts,
  clients,
  consent_logs,
  conversations,
  messages,
  notifications,
  orders,
  payments,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import {
  MAX_EXPORT_CONVERSATIONS,
  MAX_EXPORT_MESSAGES,
  MAX_EXPORT_RECORDS_PER_SECTION,
} from './data-export.constants';

/** Every collection an export gathers, plus the true counts behind the caps. */
export interface ClientDataRows {
  client: clients;
  channelContacts: channel_contacts[];
  conversations: conversations[];
  messages: messages[];
  orders: orders[];
  payments: payments[];
  bookings: bookings[];
  notifications: notifications[];
  consents: consent_logs[];
  counts: ClientDataCounts;
}

/** True row counts, independent of the caps applied to the returned rows. */
export interface ClientDataCounts {
  conversations: number;
  messages: number;
  orders: number;
  payments: number;
  bookings: number;
  notifications: number;
  consents: number;
  channelContacts: number;
  /** Counted but never returned — see WITHHELD_FIELDS' note on AI decisions. */
  aiDecisions: number;
}

/**
 * DataExportRepository — every read the export performs.
 *
 * Three rules hold across all of them:
 *
 *  - **`business_id` is in every WHERE clause**, including the ones that could
 *    be reached by a client id alone. The client id comes from the URL, and a
 *    valid UUID belonging to another tenant is trivially guessable at scale;
 *    this endpoint returns a person's entire history, so it is the worst
 *    possible place for the tenant scope to be implied rather than stated.
 *  - **Soft-deleted rows are excluded.** A deleted order is a row the business
 *    has already decided is not part of the record.
 *  - **Counts are read separately from rows.** The cap is what keeps the
 *    response deliverable; the count is what makes the truncation *visible*.
 *    Returning capped rows without the real total is how a partial export gets
 *    handed to a regulator as a complete one.
 */
@Injectable()
export class DataExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The client itself, or null when it does not belong to this tenant. */
  async findClient(businessId: string, clientId: string): Promise<clients | null> {
    return this.prisma.clients.findFirst({
      where: { id: clientId, business_id: businessId, deleted_at: null },
    });
  }

  /**
   * Resolve a client by phone or email — the identifiers a data subject
   * actually has. Nobody making an access request knows their UUID.
   */
  async findClientByIdentifier(
    businessId: string,
    identifier: { phone?: string; email?: string },
  ): Promise<clients | null> {
    const or: Array<Record<string, string>> = [];
    if (identifier.phone) or.push({ phone: identifier.phone });
    if (identifier.email) or.push({ email: identifier.email.toLowerCase() });
    if (or.length === 0) return null;

    return this.prisma.clients.findFirst({
      where: { business_id: businessId, deleted_at: null, OR: or },
    });
  }

  /** Gather every collection for one client. */
  async collect(businessId: string, client: clients): Promise<ClientDataRows> {
    const scope = { business_id: businessId, client_id: client.id };

    const [
      channelContacts,
      conversationRows,
      orderRows,
      paymentRows,
      bookingRows,
      notificationRows,
      counts,
    ] = await Promise.all([
      this.prisma.channel_contacts.findMany({
        where: scope,
        orderBy: { first_seen_at: 'asc' },
        take: MAX_EXPORT_RECORDS_PER_SECTION,
      }),
      this.prisma.conversations.findMany({
        where: { ...scope, deleted_at: null },
        orderBy: { last_message_at: 'desc' },
        take: MAX_EXPORT_CONVERSATIONS,
      }),
      this.prisma.orders.findMany({
        where: { ...scope, deleted_at: null },
        orderBy: { placed_at: 'desc' },
        take: MAX_EXPORT_RECORDS_PER_SECTION,
      }),
      this.prisma.payments.findMany({
        where: scope,
        orderBy: { created_at: 'desc' },
        take: MAX_EXPORT_RECORDS_PER_SECTION,
      }),
      this.prisma.bookings.findMany({
        where: { ...scope, deleted_at: null },
        orderBy: { start_at: 'desc' },
        take: MAX_EXPORT_RECORDS_PER_SECTION,
      }),
      this.prisma.notifications.findMany({
        where: { ...scope, deleted_at: null },
        orderBy: { created_at: 'desc' },
        take: MAX_EXPORT_RECORDS_PER_SECTION,
      }),
      this.countAll(businessId, client),
    ]);

    // Messages are fetched after the conversations, not alongside them: they
    // are scoped by conversation id, and the conversation list is already
    // capped. Reading them by `business_id + client_id` instead is not
    // possible — `messages` has no client column, which is exactly why the
    // conversation ids are the join.
    const messageRows = await this.findMessages(
      businessId,
      conversationRows.map((c) => c.id),
    );

    return {
      client,
      channelContacts,
      conversations: conversationRows,
      messages: messageRows,
      orders: orderRows,
      payments: paymentRows,
      bookings: bookingRows,
      notifications: notificationRows,
      consents: await this.findConsents(businessId, client.phone),
      counts,
    };
  }

  /**
   * The customer's messages, newest first, across the conversations given.
   *
   * Every message in a conversation is part of the customer's record, not just
   * the ones they sent: what the business replied is as much a part of the
   * exchange as what was asked, and an export containing only one side of a
   * conversation is unreadable.
   */
  private async findMessages(
    businessId: string,
    conversationIds: string[],
  ): Promise<messages[]> {
    if (conversationIds.length === 0) return [];
    return this.prisma.messages.findMany({
      where: { business_id: businessId, conversation_id: { in: conversationIds } },
      orderBy: { created_at: 'desc' },
      take: MAX_EXPORT_MESSAGES,
    });
  }

  /**
   * Consent records, keyed by phone rather than client id.
   *
   * `consent_logs` predates this module and identifies the data principal by
   * E.164 phone (it is shared with the realty lead ledger). A client with no
   * phone on file therefore has no consent trail to find — which is correct,
   * not a gap: consent in this system is captured on a phone channel.
   */
  private async findConsents(
    businessId: string,
    phone: string | null,
  ): Promise<consent_logs[]> {
    if (!phone) return [];
    return this.prisma.consent_logs.findMany({
      where: { business_id: businessId, phone },
      orderBy: { granted_at: 'desc' },
      take: MAX_EXPORT_RECORDS_PER_SECTION,
    });
  }

  /**
   * True counts for every collection.
   *
   * Read even when nothing is truncated, because the caller cannot tell the
   * two cases apart without them: a section holding exactly its cap is either
   * complete or the visible tip of something much larger.
   */
  async countAll(businessId: string, client: clients): Promise<ClientDataCounts> {
    const scope = { business_id: businessId, client_id: client.id };

    const [
      conversationCount,
      orderCount,
      paymentCount,
      bookingCount,
      notificationCount,
      channelContactCount,
      consentCount,
    ] = await Promise.all([
      this.prisma.conversations.count({ where: { ...scope, deleted_at: null } }),
      this.prisma.orders.count({ where: { ...scope, deleted_at: null } }),
      this.prisma.payments.count({ where: scope }),
      this.prisma.bookings.count({ where: { ...scope, deleted_at: null } }),
      this.prisma.notifications.count({ where: { ...scope, deleted_at: null } }),
      this.prisma.channel_contacts.count({ where: scope }),
      client.phone
        ? this.prisma.consent_logs.count({
            where: { business_id: businessId, phone: client.phone },
          })
        : Promise.resolve(0),
    ]);

    // Both of these need the conversation ids, so they run after the count
    // above rather than in the same batch. The id list is uncapped on purpose:
    // it is a projection of one indexed column, and using the capped list
    // would make the "true count" as truncated as the thing it describes.
    const conversationIds = (
      await this.prisma.conversations.findMany({
        where: { ...scope, deleted_at: null },
        select: { id: true },
      })
    ).map((c) => c.id);

    const [messageCount, aiDecisionCount] =
      conversationIds.length === 0
        ? [0, 0]
        : await Promise.all([
            this.prisma.messages.count({
              where: { business_id: businessId, conversation_id: { in: conversationIds } },
            }),
            this.prisma.ai_decisions.count({
              where: { business_id: businessId, conversation_id: { in: conversationIds } },
            }),
          ]);

    return {
      conversations: conversationCount,
      messages: messageCount,
      orders: orderCount,
      payments: paymentCount,
      bookings: bookingCount,
      notifications: notificationCount,
      consents: consentCount,
      channelContacts: channelContactCount,
      aiDecisions: aiDecisionCount,
    };
  }
}
