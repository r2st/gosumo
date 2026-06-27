import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AddressService } from './address.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateAddressDto,
  UpdateAddressDto,
  ValidateAddressDto,
} from './dto/address.dto';

/**
 * AddressController — REST endpoints for customer shipping addresses.
 *
 * Routes:
 *   POST   /addresses                 — create an address
 *   POST   /addresses/validate        — validate an address payload
 *   GET    /addresses?clientId=...    — list a client's addresses
 *   GET    /addresses/:id             — get an address
 *   PATCH  /addresses/:id             — update an address
 *   DELETE /addresses/:id             — soft-delete an address
 */
@ApiTags('addresses')
@Controller('addresses')
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a shipping address' })
  @ApiResponse({ status: 201, description: 'Address created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async create(@TenantId() tenantId: string, @Body() dto: CreateAddressDto) {
    return this.addressService.createAddress(tenantId, dto);
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate an address payload without saving' })
  @ApiResponse({ status: 200, description: 'Validation result' })
  validate(@Body() dto: ValidateAddressDto) {
    return this.addressService.validate({
      pincode: dto.pincode,
      phone: dto.phone,
    });
  }

  @Get()
  @ApiOperation({ summary: "List a client's shipping addresses" })
  @ApiQuery({ name: 'clientId', description: 'Client UUID', required: true })
  @ApiResponse({ status: 200, description: 'List of addresses' })
  async list(
    @TenantId() tenantId: string,
    @Query('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.addressService.listAddresses(tenantId, clientId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a shipping address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address details' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.addressService.getAddress(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a shipping address' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address updated' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addressService.updateAddress(tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a shipping address' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 204, description: 'Address deleted' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  async remove(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.addressService.deleteAddress(tenantId, id);
  }
}
