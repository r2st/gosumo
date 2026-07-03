import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { RealtyAiService } from './realty-ai.service';
import { RealtyTurnDto, RealtyClassifyDto } from './dto';

/**
 * RealtyAiController — drives the realty AI loop for a lead. Thin: validates
 * input, delegates to the service, returns the decision DTO. No business logic.
 */
@ApiTags('realty-ai')
@Controller('realty-ai')
export class RealtyAiController {
  constructor(private readonly service: RealtyAiService) {}

  @Post('turn')
  @ApiOperation({ summary: 'Run one grounded realty AI turn for a lead' })
  async turn(@TenantId() businessId: string, @Body() dto: RealtyTurnDto) {
    return this.service.processTurn(businessId, dto);
  }

  @Post('classify')
  @ApiOperation({ summary: 'Classify a single realty message into one of the 14 intents' })
  async classify(@Body() dto: RealtyClassifyDto) {
    return this.service.classify(dto.text);
  }
}
