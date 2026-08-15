import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ChannelAdapterService } from './channel-adapter.service';
import type { ChannelHealthSnapshot } from './channel-health.service';

/**
 * Per-channel health, for an operator.
 *
 * A separate controller rather than a route on `ChannelAdapterController`,
 * because that class is `@Public()` for the whole of it — every webhook
 * endpoint authenticates by HMAC rather than by JWT — and the snapshot carries
 * the last failure message from each channel, which can quote a provider's own
 * error text. Here the global `JwtAuthGuard` applies, which is the correct
 * audience for a line that says why Instagram is refusing deliveries.
 *
 * Deliberately **not** tenant-scoped and deliberately not on `/health/ready`.
 * A channel's health is a property of the process and its providers, not of a
 * business: WhatsApp being down is the same fact for every tenant on this
 * instance. It stays off the readiness probe for the reason every other
 * non-gating signal there does — an unhealthy channel must not pull a working
 * instance out of rotation, since the replacement instance would reach exactly
 * the same provider.
 */
@ApiTags('channels')
@Controller('channels/health')
export class ChannelHealthController {
  constructor(private readonly channelAdapter: ChannelAdapterService) {}

  @Get()
  @ApiOperation({
    summary: 'Per-channel adapter health',
    description:
      'Inbound and outbound success/failure tallies per channel, with the consecutive-failure ' +
      'run that grades each one healthy, degraded or failing. Empty tallies mean no traffic, ' +
      'not a fault.',
  })
  @ApiResponse({ status: 200, description: 'One entry per registered channel type' })
  channels(): { channels: ChannelHealthSnapshot[] } {
    return { channels: this.channelAdapter.getChannelHealth() };
  }
}
