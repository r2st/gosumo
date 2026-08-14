/**
 * AddressRepository unit tests.
 *
 * `update()` builds its Prisma payload field by field, so a field the caller
 * left out must not appear in the update at all — sending `undefined` through
 * would be harmless, but sending `null` (or a stale value) would silently wipe a
 * column the caller never mentioned. Each `!== undefined` guard is a branch, and
 * this file pins down both sides of every one of them.
 *
 * The tenant scoping on the read paths is covered here too: every query must
 * carry `business_id`, and the soft-delete convention means reads filter on
 * `deleted_at: null` rather than expecting rows to be gone.
 */
import { Test } from '@nestjs/testing';
import { AddressRepository, type UpdateAddressData } from './address.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const CLIENT = '00000000-0000-4000-a000-0000000000c1';
const ADDRESS = '00000000-0000-4000-a000-0000000000a1';

describe('AddressRepository', () => {
  let repository: AddressRepository;
  let prisma: {
    shipping_addresses: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      shipping_addresses: {
        create: jest.fn().mockResolvedValue({ id: ADDRESS }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: ADDRESS }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [AddressRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(AddressRepository);
  });

  /** The `data` object handed to the single `update` call. */
  function updatePayload(): Record<string, unknown> {
    return prisma.shipping_addresses.update.mock.calls[0][0].data as Record<string, unknown>;
  }

  describe('create', () => {
    it('maps the optional fields to null rather than leaving them absent', async () => {
      await repository.create({
        businessId: BIZ,
        clientId: CLIENT,
        recipientName: 'Asha',
        line1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        country: 'IN',
        isDefault: false,
      });

      expect(prisma.shipping_addresses.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BIZ,
          client_id: CLIENT,
          line2: null,
          phone: null,
          label: null,
          is_default: false,
        }),
      });
    });

    it('passes the optional fields through when they are supplied', async () => {
      await repository.create({
        businessId: BIZ,
        clientId: CLIENT,
        recipientName: 'Asha',
        line1: '12 MG Road',
        line2: 'Near the metro',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        country: 'IN',
        phone: '+919876543210',
        label: 'Home',
        isDefault: true,
      });

      expect(prisma.shipping_addresses.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          line2: 'Near the metro',
          phone: '+919876543210',
          label: 'Home',
          is_default: true,
        }),
      });
    });
  });

  describe('reads', () => {
    it('scopes findById by tenant and skips soft-deleted rows', async () => {
      await repository.findById(BIZ, ADDRESS);

      expect(prisma.shipping_addresses.findFirst).toHaveBeenCalledWith({
        where: { id: ADDRESS, business_id: BIZ, deleted_at: null },
      });
    });

    it('lists a client’s live addresses with the default first', async () => {
      await repository.listByClient(BIZ, CLIENT);

      expect(prisma.shipping_addresses.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, client_id: CLIENT, deleted_at: null },
        orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
      });
    });
  });

  describe('update', () => {
    it('sends an empty payload when no field was supplied', async () => {
      await repository.update(BIZ, ADDRESS, {});

      expect(updatePayload()).toEqual({});
      expect(prisma.shipping_addresses.update).toHaveBeenCalledWith({
        where: { id: ADDRESS, business_id: BIZ },
        data: {},
      });
    });

    // One case per `!== undefined` guard: the field is written under its
    // snake_case column name, and nothing else is.
    it.each<[keyof UpdateAddressData, string, string | boolean]>([
      ['recipientName', 'recipient_name', 'Asha Rao'],
      ['line1', 'line1', '14 MG Road'],
      ['line2', 'line2', 'Flat 3B'],
      ['city', 'city', 'Mysuru'],
      ['state', 'state', 'Karnataka'],
      ['pincode', 'pincode', '570001'],
      ['phone', 'phone', '+919876543210'],
      ['label', 'label', 'Office'],
      ['isDefault', 'is_default', true],
    ])('writes only %s when it alone is supplied', async (field, column, value) => {
      await repository.update(BIZ, ADDRESS, { [field]: value } as UpdateAddressData);

      expect(updatePayload()).toEqual({ [column]: value });
    });

    it('writes every column when the whole address is supplied', async () => {
      await repository.update(BIZ, ADDRESS, {
        recipientName: 'Asha Rao',
        line1: '14 MG Road',
        line2: 'Flat 3B',
        city: 'Mysuru',
        state: 'Karnataka',
        pincode: '570001',
        phone: '+919876543210',
        label: 'Office',
        isDefault: false,
      });

      expect(updatePayload()).toEqual({
        recipient_name: 'Asha Rao',
        line1: '14 MG Road',
        line2: 'Flat 3B',
        city: 'Mysuru',
        state: 'Karnataka',
        pincode: '570001',
        phone: '+919876543210',
        label: 'Office',
        is_default: false,
      });
    });

    it('clears the default flag when isDefault is explicitly false', async () => {
      // `false` is falsy — a truthiness check here would drop the update and
      // leave the address wrongly marked as the client's default.
      await repository.update(BIZ, ADDRESS, { isDefault: false });

      expect(updatePayload()).toEqual({ is_default: false });
    });

    it('writes an empty-string label rather than treating it as absent', async () => {
      await repository.update(BIZ, ADDRESS, { label: '' });

      expect(updatePayload()).toEqual({ label: '' });
    });

    it('scopes the update by tenant', async () => {
      await repository.update(BIZ, ADDRESS, { city: 'Mysuru' });

      expect(prisma.shipping_addresses.update.mock.calls[0][0].where).toEqual({
        id: ADDRESS,
        business_id: BIZ,
      });
    });
  });

  describe('softDelete', () => {
    it('stamps deleted_at instead of removing the row', async () => {
      await repository.softDelete(BIZ, ADDRESS);

      const call = prisma.shipping_addresses.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: ADDRESS, business_id: BIZ });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('unsetDefaults', () => {
    it('clears only the rows that are currently the default, within the tenant', async () => {
      await repository.unsetDefaults(BIZ, CLIENT);

      expect(prisma.shipping_addresses.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, client_id: CLIENT, is_default: true },
        data: { is_default: false },
      });
    });
  });
});
