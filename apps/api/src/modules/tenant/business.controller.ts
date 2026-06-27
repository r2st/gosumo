import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TenantService } from './tenant.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';

/**
 * Alias controller — maps /business/me to tenant profile for frontend compat.
 */
@ApiTags('business')
@Controller('business')
export class BusinessController {
  constructor(private readonly tenantService: TenantService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current business profile' })
  @ApiResponse({ status: 200, description: 'Business profile' })
  @ApiResponse({ status: 404, description: 'Business not found' })
  async getMe(@TenantId() businessId: string) {
    return this.tenantService.getBusinessById(businessId);
  }
}
