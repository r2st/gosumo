import { Controller, Get, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ParserHealthService } from './parser-health.service';

/**
 * ParserHealthController — the ops surface for portal-parser monitoring. Lets an
 * operator trigger an on-demand health check and read the latest per-portal
 * report. JWT-guarded (platform-ops); no tenant scoping (parsers are global).
 */
@ApiTags('realty-ingestion')
@Controller('realty/ingestion/parser-health')
export class ParserHealthController {
  constructor(private readonly health: ParserHealthService) {}

  @Get()
  @ApiOperation({ summary: 'Latest health report per portal parser' })
  @ApiResponse({ status: 200, description: 'Paginated parser health list for this business' })
  async latest() {
    return this.health.getLatestReports();
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the portal-parser health check now' })
  @ApiResponse({ status: 200, description: 'Per-portal parser health, freshly sampled' })
  async runNow() {
    return this.health.runCheck();
  }
}
