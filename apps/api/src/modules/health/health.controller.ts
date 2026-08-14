import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { HealthService, ReadinessReport } from './health.service';

/**
 * Health probes. Both routes are `@Public()` — a load balancer has no JWT, and
 * gating the probe behind auth means an auth outage reads as a total outage.
 *
 * Neither route is tenant-scoped: they report on this process, not on any
 * business's data, and return nothing derived from the database's contents.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness probe — is the process up',
    description:
      'Touches no dependency, so a database or Redis blip never gets a healthy process restarted.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Process is alive' })
  liveness() {
    return this.health.liveness();
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe — should this instance receive traffic',
    description:
      'Probes Postgres and Redis concurrently under a 2s budget and reports each one separately.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'All dependencies reachable' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'At least one dependency is unreachable — stop routing traffic here',
  })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    // 503 is what makes this useful: a balancer reads the status code, not the
    // body, so a degraded instance answering 200 keeps taking traffic it
    // cannot serve.
    res.status(
      report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return report;
  }
}
