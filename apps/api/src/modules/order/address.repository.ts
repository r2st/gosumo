import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { shipping_addresses } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface CreateAddressData {
  businessId: string;
  clientId: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  phone?: string;
  label?: string;
  isDefault: boolean;
}

export interface UpdateAddressData {
  recipientName?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  label?: string;
  isDefault?: boolean;
}

/**
 * AddressRepository — Prisma queries for customer shipping addresses.
 * Every query is scoped by businessId.
 */
@Injectable()
export class AddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateAddressData): Promise<shipping_addresses> {
    return this.prisma.shipping_addresses.create({
      data: {
        business_id: data.businessId,
        client_id: data.clientId,
        recipient_name: data.recipientName,
        line1: data.line1,
        line2: data.line2 ?? null,
        city: data.city,
        state: data.state,
        pincode: data.pincode,
        country: data.country,
        phone: data.phone ?? null,
        label: data.label ?? null,
        is_default: data.isDefault,
      },
    });
  }

  async findById(
    businessId: string,
    addressId: string,
  ): Promise<shipping_addresses | null> {
    return this.prisma.shipping_addresses.findFirst({
      where: { id: addressId, business_id: businessId, deleted_at: null },
    });
  }

  async listByClient(
    businessId: string,
    clientId: string,
  ): Promise<shipping_addresses[]> {
    return this.prisma.shipping_addresses.findMany({
      where: { business_id: businessId, client_id: clientId, deleted_at: null },
      orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
    });
  }

  async update(
    addressId: string,
    data: UpdateAddressData,
  ): Promise<shipping_addresses> {
    const updateData: Prisma.shipping_addressesUpdateInput = {};
    if (data.recipientName !== undefined) updateData.recipient_name = data.recipientName;
    if (data.line1 !== undefined) updateData.line1 = data.line1;
    if (data.line2 !== undefined) updateData.line2 = data.line2;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.pincode !== undefined) updateData.pincode = data.pincode;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.label !== undefined) updateData.label = data.label;
    if (data.isDefault !== undefined) updateData.is_default = data.isDefault;

    return this.prisma.shipping_addresses.update({
      where: { id: addressId },
      data: updateData,
    });
  }

  async softDelete(addressId: string): Promise<shipping_addresses> {
    return this.prisma.shipping_addresses.update({
      where: { id: addressId },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * Clear the default flag on all of a client's addresses (before setting a
   * new default). Scoped by businessId + clientId.
   */
  async unsetDefaults(businessId: string, clientId: string): Promise<void> {
    await this.prisma.shipping_addresses.updateMany({
      where: { business_id: businessId, client_id: clientId, is_default: true },
      data: { is_default: false },
    });
  }
}
