import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { shipping_addresses } from '@prisma/client';
import { AddressRepository } from './address.repository';
import {
  CreateAddressDto,
  UpdateAddressDto,
  AddressDto,
  AddressValidationResult,
  INDIAN_PINCODE_REGEX,
} from './dto/address.dto';

const INDIAN_PHONE_REGEX = /^(\+91)?[6-9][0-9]{9}$/;

function toAddressDto(a: shipping_addresses): AddressDto {
  return {
    id: a.id,
    businessId: a.business_id,
    clientId: a.client_id,
    label: a.label,
    isDefault: a.is_default,
    recipientName: a.recipient_name,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    country: a.country,
    phone: a.phone,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
  };
}

/**
 * AddressService — CRUD and validation for customer shipping addresses.
 *
 * Address validation enforces Indian PIN-code and phone formats and the
 * presence of all required delivery fields. The `validate()` method is exposed
 * so callers (e.g. checkout flows or the AI) can pre-check an address.
 */
@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);

  constructor(private readonly repository: AddressRepository) {}

  async createAddress(
    businessId: string,
    dto: CreateAddressDto,
  ): Promise<AddressDto> {
    const validation = this.validate({
      recipientName: dto.recipientName,
      line1: dto.line1,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      phone: dto.phone,
    });
    if (!validation.valid) {
      throw new BadRequestException(
        `Invalid address: ${validation.errors.join('; ')}`,
      );
    }

    const isDefault = dto.isDefault ?? false;
    if (isDefault) {
      await this.repository.unsetDefaults(businessId, dto.clientId);
    }

    const address = await this.repository.create({
      businessId,
      clientId: dto.clientId,
      recipientName: dto.recipientName,
      line1: dto.line1,
      line2: dto.line2,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      country: dto.country ?? 'IN',
      phone: dto.phone,
      label: dto.label,
      isDefault,
    });

    this.logger.log(
      `Address created for client ${dto.clientId} (pincode ${dto.pincode})`,
    );
    return toAddressDto(address);
  }

  async listAddresses(
    businessId: string,
    clientId: string,
  ): Promise<AddressDto[]> {
    const addresses = await this.repository.listByClient(businessId, clientId);
    return addresses.map(toAddressDto);
  }

  async getAddress(businessId: string, addressId: string): Promise<AddressDto> {
    const address = await this.repository.findById(businessId, addressId);
    if (!address) {
      throw new NotFoundException(`Address not found: ${addressId}`);
    }
    return toAddressDto(address);
  }

  async updateAddress(
    businessId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<AddressDto> {
    const address = await this.repository.findById(businessId, addressId);
    if (!address) {
      throw new NotFoundException(`Address not found: ${addressId}`);
    }

    const validation = this.validate({
      recipientName: dto.recipientName ?? address.recipient_name,
      line1: dto.line1 ?? address.line1,
      city: dto.city ?? address.city,
      state: dto.state ?? address.state,
      pincode: dto.pincode ?? address.pincode,
      phone: dto.phone ?? address.phone ?? undefined,
    });
    if (!validation.valid) {
      throw new BadRequestException(
        `Invalid address: ${validation.errors.join('; ')}`,
      );
    }

    if (dto.isDefault) {
      await this.repository.unsetDefaults(businessId, address.client_id);
    }

    const updated = await this.repository.update(businessId, addressId, {
      recipientName: dto.recipientName,
      line1: dto.line1,
      line2: dto.line2,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      phone: dto.phone,
      label: dto.label,
      isDefault: dto.isDefault,
    });
    return toAddressDto(updated);
  }

  async deleteAddress(businessId: string, addressId: string): Promise<void> {
    const address = await this.repository.findById(businessId, addressId);
    if (!address) {
      throw new NotFoundException(`Address not found: ${addressId}`);
    }
    await this.repository.softDelete(businessId, addressId);
    this.logger.log(`Address ${addressId} soft-deleted`);
  }

  /**
   * Validate the shape of an address without persisting it. Returns a list of
   * human-readable errors (empty when valid).
   */
  validate(input: {
    recipientName?: string;
    line1?: string;
    city?: string;
    state?: string;
    pincode: string;
    phone?: string;
  }): AddressValidationResult {
    const errors: string[] = [];

    if (input.recipientName !== undefined && input.recipientName.trim() === '') {
      errors.push('recipientName is required');
    }
    if (input.line1 !== undefined && input.line1.trim() === '') {
      errors.push('line1 is required');
    }
    if (input.city !== undefined && input.city.trim() === '') {
      errors.push('city is required');
    }
    if (input.state !== undefined && input.state.trim() === '') {
      errors.push('state is required');
    }
    if (!INDIAN_PINCODE_REGEX.test(input.pincode)) {
      errors.push('pincode must be a valid 6-digit Indian PIN code');
    }
    if (input.phone && !INDIAN_PHONE_REGEX.test(input.phone)) {
      errors.push('phone must be a valid Indian mobile number');
    }

    return { valid: errors.length === 0, errors };
  }
}
