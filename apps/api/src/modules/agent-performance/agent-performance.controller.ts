import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AgentPerformanceService } from './agent-performance.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { AgentPerformanceQueryDto } from './dto';

@ApiTags('agent-performance')
@Controller('agent-performance')
export class AgentPerformanceController {
  constructor(private readonly agentPerformanceService: AgentPerformanceService) {}

  @Get()
  @ApiOperation({ summary: 'Leaderboard of per-agent performance metrics for a date range' })
  @ApiResponse({ status: 200, description: 'Paginated agent performance list for this business' })
  async list(@TenantId() tenantId: string, @Query() query: AgentPerformanceQueryDto) {
    return this.agentPerformanceService.listAgentPerformance(tenantId, query.from, query.to);
  }

  @Get(':memberId')
  @ApiOperation({ summary: 'Performance metrics for a single agent' })
  @ApiResponse({ status: 200, description: 'The requested agent performance' })
  @ApiParam({ name: 'memberId', description: 'Team member UUID' })
  @ApiResponse({ status: 404, description: 'Team member not found' })
  async get(
    @TenantId() tenantId: string,
    @Param('memberId', UuidValidationPipe) memberId: string,
    @Query() query: AgentPerformanceQueryDto,
  ) {
    return this.agentPerformanceService.getAgentPerformance(tenantId, memberId, query.from, query.to);
  }
}
