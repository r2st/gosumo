import { IsOptional, IsISO8601 } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AgentPerformanceQueryDto {
  @ApiPropertyOptional({ description: 'Range start (ISO-8601). Defaults to 30 days ago.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO-8601). Defaults to now.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export interface ResolvedRangeDto {
  from: string;
  to: string;
}

export interface AgentPerformanceDto {
  memberId: string;
  name: string;
  email: string;
  role: string;
  range: ResolvedRangeDto;
  assignedConversations: number;
  resolvedConversations: number;
  avgFirstResponseSeconds: number;
  avgResolutionSeconds: number;
  csatAverage: number | null;
  csatResponseCount: number;
  tasksResolved: number;
  avgTaskResolutionSeconds: number;
  slaTargetsTotal: number;
  slaBreachedCount: number;
  slaComplianceRate: number;
}

export interface AgentLeaderboardDto {
  range: ResolvedRangeDto;
  agents: AgentPerformanceDto[];
}
