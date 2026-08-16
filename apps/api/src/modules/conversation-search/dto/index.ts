import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  IsUUID,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType, ConversationStatus } from '@gosumo/shared';
import { MAX_PAGE_NUMBER } from '../../../common/validators/pagination.constants';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

/** Largest page a search may return. Deliberately below the list endpoints'
 * 100: every hit costs a rank computation and a snippet build. */
export const SEARCH_MAX_LIMIT = 50;

export class SearchMessagesQueryDto {
  @ApiProperty({
    description:
      'Full-text query. Supports quoted phrases, OR, and -exclusion — parsed by Postgres ' +
      '`websearch_to_tsquery`, which never rejects a syntax it does not understand.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  q!: string;

  @ApiPropertyOptional({ description: 'Restrict to one customer' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Restrict to one conversation' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ description: 'Messages sent at or after this instant (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Messages sent before this instant (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  dateTo?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: SEARCH_MAX_LIMIT, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit?: number;
}

/** One matching message, with enough conversation context to render a row. */
export interface MessageSearchHitDto {
  messageId: string;
  conversationId: string;
  sequence: number;
  direction: string;
  senderType: string;
  sentAt: string;
  /** Relevance, higher is better. Comparable within one response only. */
  rank: number;
  /** Plain text — never markup. See `search-snippet.util.ts`. */
  snippet: string;
  /** `[start, end)` offsets into `snippet` where the query matched. */
  highlights: { start: number; end: number }[];
  conversation: {
    subject: string | null;
    channel: ChannelType;
    status: ConversationStatus;
    clientId: string;
    clientName: string | null;
  };
}

export interface MessageSearchResultDto {
  data: MessageSearchHitDto[];
  pagination: {
    /**
     * Matching messages, capped — see `SEARCH_COUNT_CEILING`. `totalIsExact`
     * says whether this is the real count or the ceiling.
     */
    total: number;
    totalIsExact: boolean;
    page: number;
    limit: number;
  };
  /** Echoed so a client can highlight consistently with the server. */
  query: string;
}

/** A conversation with at least one matching message, collapsed to one row. */
export interface ConversationSearchHitDto {
  conversationId: string;
  subject: string | null;
  channel: ChannelType;
  status: ConversationStatus;
  clientId: string;
  clientName: string | null;
  lastMessageAt: string | null;
  /** How many messages in this conversation matched. */
  matchCount: number;
  /** Best rank among the matching messages. */
  rank: number;
  /** Snippet from the best-ranked matching message. */
  snippet: string;
  highlights: { start: number; end: number }[];
}

export interface ConversationSearchResultDto {
  data: ConversationSearchHitDto[];
  pagination: {
    total: number;
    totalIsExact: boolean;
    page: number;
    limit: number;
  };
  query: string;
}
