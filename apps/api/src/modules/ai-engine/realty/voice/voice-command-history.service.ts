import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@gosumo/database';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/services/prisma.service';
import type { BrokerCommand } from './broker-command.parser';

/** Terminal outcome of a broker voice command. */
export type VoiceCommandStatus =
  | 'executed' // routed and applied
  | 'not_understood' // transcript matched no command grammar
  | 'unresolved' // command understood but a lead/project/agent couldn't be found
  | 'failed'; // downstream service threw

export interface VoiceCommandRecordInput {
  businessId: string;
  userId?: string | null;
  transcription: string;
  command: BrokerCommand | null;
  status: VoiceCommandStatus;
  /** Human-readable outcome, shown in the console history. */
  detail: string;
  correlationId?: string;
}

/** One row in the broker voice-command history feed. */
export interface VoiceCommandHistoryItem {
  id: string;
  transcription: string;
  kind: string;
  status: VoiceCommandStatus;
  detail: string;
  createdAt: Date;
}

const RESOURCE_TYPE = 'realty_voice_command';

/**
 * VoiceCommandHistoryService — the append-only history of broker voice commands,
 * persisted on the shared `audit_logs` table (no new table needed; `audit_logs`
 * is INSERT-only at the DB level). Powers the "voice command history" panel in
 * the broker console.
 */
@Injectable()
export class VoiceCommandHistoryService {
  private readonly logger = new Logger(VoiceCommandHistoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append a voice-command record. Best-effort — never throws to the caller. */
  async record(input: VoiceCommandRecordInput): Promise<void> {
    try {
      await this.prisma.audit_logs.create({
        data: {
          business_id: input.businessId,
          actor_type: 'TEAM_MEMBER',
          actor_id: input.userId ?? null,
          action: AuditAction.UPDATE,
          resource_type: RESOURCE_TYPE,
          resource_after: {
            transcription: input.transcription,
            kind: input.command?.kind ?? 'UNKNOWN',
            command: (input.command as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            status: input.status,
            detail: input.detail,
          } as Prisma.InputJsonValue,
          request_id: input.correlationId ?? null,
          description: `Broker voice command · ${input.command?.kind ?? 'UNKNOWN'} · ${input.status}: ${input.detail}`,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to record broker voice command: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** List recent broker voice commands (newest first) for the console. */
  async list(businessId: string, limit = 50): Promise<VoiceCommandHistoryItem[]> {
    const rows = await this.prisma.audit_logs.findMany({
      where: { business_id: businessId, resource_type: RESOURCE_TYPE },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => {
      const after = (r.resource_after ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        transcription: typeof after['transcription'] === 'string' ? after['transcription'] : '',
        kind: typeof after['kind'] === 'string' ? after['kind'] : 'UNKNOWN',
        status: (typeof after['status'] === 'string'
          ? after['status']
          : 'not_understood') as VoiceCommandStatus,
        detail: typeof after['detail'] === 'string' ? after['detail'] : (r.description ?? ''),
        createdAt: r.created_at,
      };
    });
  }
}
