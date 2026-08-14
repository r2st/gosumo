import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { AddressService } from './address.service';
import { AddressRepository } from './address.repository';

/**
 * Branch coverage for AddressService: listing, the default-address handling on
 * both create and update, and the partial-update merge — an update validates
 * the *merged* address, so patching one field must not be allowed to invalidate
 * the rest of a stored address.
 *
 * `address.spec.ts` covers validation and the happy paths.
 */

const BUSINESS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const ADDRESS_ID = '00000000-0000-4000-8000-000000000030';

function mockAddress(overrides: Record<string, unknown> = {}) {
  return {
    id: ADDRESS_ID,
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    label: 'Home',
    is_default: false,
    recipient_name: 'Asha Rao',
    line1: '12 MG Road',
    line2: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    country: 'IN',
    phone: '9876543210',
    latitude: null,
    longitude: null,
    created_at: new Date('2026-06-27T10:00:00Z'),
    updated_at: new Date('2026-06-27T10:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

const VALID_CREATE = {
  clientId: CLIENT_ID,
  recipientName: 'Asha Rao',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  phone: '9876543210',
};

interface RepositoryMock {
  create: jest.Mock;
  findById: jest.Mock;
  listByClient: jest.Mock;
  update: jest.Mock;
  softDelete: jest.Mock;
  unsetDefaults: jest.Mock;
}

describe('AddressService (branches)', () => {
  let service: AddressService;
  let repository: RepositoryMock;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    repository = {
      create: jest.fn().mockResolvedValue(mockAddress()),
      findById: jest.fn().mockResolvedValue(mockAddress()),
      listByClient: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(mockAddress()),
      softDelete: jest.fn().mockResolvedValue(undefined),
      unsetDefaults: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressService,
        { provide: AddressRepository, useValue: repository },
      ],
    }).compile();

    service = module.get(AddressService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('listAddresses', () => {
    it('returns an empty list for a client with no addresses', async () => {
      await expect(service.listAddresses(BUSINESS_ID, CLIENT_ID)).resolves.toEqual([]);
      expect(repository.listByClient).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
    });

    it('maps every row to the DTO shape, with ISO timestamps', async () => {
      repository.listByClient.mockResolvedValueOnce([
        mockAddress(),
        mockAddress({ id: 'addr-2', label: 'Office', is_default: true }),
      ]);
      const list = await service.listAddresses(BUSINESS_ID, CLIENT_ID);
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        id: ADDRESS_ID,
        recipientName: 'Asha Rao',
        isDefault: false,
        createdAt: '2026-06-27T10:00:00.000Z',
        updatedAt: '2026-06-27T10:00:00.000Z',
      });
      expect(list[1]).toMatchObject({ label: 'Office', isDefault: true });
    });

    it('scopes the query to the tenant, never to the client alone', async () => {
      await service.listAddresses('other-business', CLIENT_ID);
      expect(repository.listByClient).toHaveBeenCalledWith('other-business', CLIENT_ID);
    });
  });

  describe('createAddress defaults', () => {
    it('does not disturb existing defaults for a non-default address', async () => {
      await service.createAddress(BUSINESS_ID, VALID_CREATE);
      expect(repository.unsetDefaults).not.toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false }),
      );
    });

    it('clears the client’s other defaults before creating a new default', async () => {
      await service.createAddress(BUSINESS_ID, { ...VALID_CREATE, isDefault: true });
      expect(repository.unsetDefaults).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true }),
      );
    });

    it('defaults the country to India when unspecified', async () => {
      await service.createAddress(BUSINESS_ID, VALID_CREATE);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'IN' }),
      );
    });

    it('honours an explicit country', async () => {
      await service.createAddress(BUSINESS_ID, { ...VALID_CREATE, country: 'AE' });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ country: 'AE' }),
      );
    });

    it('validates before touching the repository at all', async () => {
      await expect(
        service.createAddress(BUSINESS_ID, {
          ...VALID_CREATE,
          isDefault: true,
          pincode: '00123',
        }),
      ).rejects.toThrow(BadRequestException);
      // A failed create must not have already cleared the existing default.
      expect(repository.unsetDefaults).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('updateAddress merge', () => {
    it('rejects an update to a missing address', async () => {
      repository.findById.mockResolvedValueOnce(null);
      await expect(
        service.updateAddress(BUSINESS_ID, ADDRESS_ID, { city: 'Mysuru' }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('validates the merged address, not just the patch', async () => {
      // The patch alone carries no pincode; the stored one must be used.
      await service.updateAddress(BUSINESS_ID, ADDRESS_ID, { city: 'Mysuru' });
      expect(repository.update).toHaveBeenCalled();
    });

    it('rejects a patch that would invalidate the stored address', async () => {
      await expect(
        service.updateAddress(BUSINESS_ID, ADDRESS_ID, { pincode: '12' }),
      ).rejects.toThrow(/pincode must be a valid 6-digit Indian PIN code/);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects blanking a required field', async () => {
      await expect(
        service.updateAddress(BUSINESS_ID, ADDRESS_ID, { recipientName: '  ' }),
      ).rejects.toThrow(/recipientName is required/);
    });

    it('treats a stored null phone as absent rather than as an invalid phone', async () => {
      repository.findById.mockResolvedValueOnce(mockAddress({ phone: null }));
      await service.updateAddress(BUSINESS_ID, ADDRESS_ID, { city: 'Mysuru' });
      expect(repository.update).toHaveBeenCalled();
    });

    it('rejects a patch that sets an invalid phone', async () => {
      await expect(
        service.updateAddress(BUSINESS_ID, ADDRESS_ID, { phone: '1234567890' }),
      ).rejects.toThrow(/phone must be a valid Indian mobile number/);
    });

    it('clears other defaults when promoting an address to default', async () => {
      await service.updateAddress(BUSINESS_ID, ADDRESS_ID, { isDefault: true });
      expect(repository.unsetDefaults).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
    });

    it('leaves other defaults alone when demoting an address', async () => {
      await service.updateAddress(BUSINESS_ID, ADDRESS_ID, { isDefault: false });
      expect(repository.unsetDefaults).not.toHaveBeenCalled();
    });

    it('passes the patch through undefined-for-untouched, so unset fields are not cleared', async () => {
      await service.updateAddress(BUSINESS_ID, ADDRESS_ID, { city: 'Mysuru' });
      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, ADDRESS_ID, {
        recipientName: undefined,
        line1: undefined,
        line2: undefined,
        city: 'Mysuru',
        state: undefined,
        pincode: undefined,
        phone: undefined,
        label: undefined,
        isDefault: undefined,
      });
    });
  });

  describe('deleteAddress', () => {
    it('soft-deletes rather than removing the row', async () => {
      await service.deleteAddress(BUSINESS_ID, ADDRESS_ID);
      expect(repository.softDelete).toHaveBeenCalledWith(BUSINESS_ID, ADDRESS_ID);
    });

    it('rejects deleting an address that is not in this tenant', async () => {
      repository.findById.mockResolvedValueOnce(null);
      await expect(service.deleteAddress(BUSINESS_ID, ADDRESS_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.softDelete).not.toHaveBeenCalled();
    });
  });

  describe('validate phone formats', () => {
    const pin = { pincode: '560001' };

    it.each([
      ['9876543210', true],
      ['+919876543210', true],
      ['6000000000', true],
      ['5876543210', false],
      ['987654321', false],
      ['98765432100', false],
      ['+9198765432', false],
    ])('treats %s as valid=%s', (phone, valid) => {
      expect(service.validate({ ...pin, phone }).valid).toBe(valid);
    });

    it('accepts an address with no phone at all', () => {
      expect(service.validate(pin).valid).toBe(true);
    });

    it('accepts an empty-string phone as "not supplied"', () => {
      expect(service.validate({ ...pin, phone: '' }).valid).toBe(true);
    });

    it('collects every failure rather than stopping at the first', () => {
      const result = service.validate({
        recipientName: '',
        line1: '',
        city: '',
        state: '',
        pincode: 'nope',
        phone: '123',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(6);
    });
  });
});
