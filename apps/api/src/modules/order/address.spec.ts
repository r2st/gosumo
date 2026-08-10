import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AddressService } from './address.service';
import { AddressRepository } from './address.repository';

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

describe('AddressService', () => {
  let service: AddressService;
  let repository: jest.Mocked<AddressRepository>;

  beforeEach(async () => {
    const mockRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      listByClient: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      unsetDefaults: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressService,
        { provide: AddressRepository, useValue: mockRepository },
      ],
    }).compile();

    service = module.get<AddressService>(AddressService);
    repository = module.get(AddressRepository) as jest.Mocked<AddressRepository>;
  });

  describe('validate', () => {
    it('accepts a valid Indian address', () => {
      const result = service.validate({
        recipientName: 'Asha',
        line1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        phone: '9876543210',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects a malformed pincode', () => {
      const result = service.validate({ pincode: '12345' });
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toContain('pincode');
    });

    it('rejects a pincode starting with 0', () => {
      const result = service.validate({ pincode: '012345' });
      expect(result.valid).toBe(false);
    });

    it('rejects an invalid phone number', () => {
      const result = service.validate({ pincode: '560001', phone: '12345' });
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toContain('phone');
    });

    it('flags blank required fields', () => {
      const result = service.validate({
        recipientName: '   ',
        line1: '',
        pincode: '560001',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('recipientName is required');
      expect(result.errors).toContain('line1 is required');
    });
  });

  describe('createAddress', () => {
    it('creates a valid address', async () => {
      repository.create.mockResolvedValue(mockAddress() as never);

      const result = await service.createAddress(BUSINESS_ID, VALID_CREATE);

      expect(result.pincode).toBe('560001');
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, country: 'IN' }),
      );
    });

    it('rejects an address with an invalid pincode', async () => {
      await expect(
        service.createAddress(BUSINESS_ID, { ...VALID_CREATE, pincode: '99' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('unsets existing defaults when creating a default address', async () => {
      repository.create.mockResolvedValue(
        mockAddress({ is_default: true }) as never,
      );

      await service.createAddress(BUSINESS_ID, {
        ...VALID_CREATE,
        isDefault: true,
      });

      expect(repository.unsetDefaults).toHaveBeenCalledWith(BUSINESS_ID, CLIENT_ID);
    });
  });

  describe('getAddress', () => {
    it('throws NotFound for an unknown address', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.getAddress(BUSINESS_ID, ADDRESS_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateAddress', () => {
    it('updates an existing address', async () => {
      repository.findById.mockResolvedValue(mockAddress() as never);
      repository.update.mockResolvedValue(
        mockAddress({ city: 'Mysuru' }) as never,
      );

      const result = await service.updateAddress(BUSINESS_ID, ADDRESS_ID, {
        city: 'Mysuru',
      });

      expect(result.city).toBe('Mysuru');
    });

    it('rejects an update with a bad pincode', async () => {
      repository.findById.mockResolvedValue(mockAddress() as never);
      await expect(
        service.updateAddress(BUSINESS_ID, ADDRESS_ID, { pincode: 'abc' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteAddress', () => {
    it('soft-deletes an existing address', async () => {
      repository.findById.mockResolvedValue(mockAddress() as never);
      repository.softDelete.mockResolvedValue(mockAddress() as never);

      await service.deleteAddress(BUSINESS_ID, ADDRESS_ID);

      expect(repository.softDelete).toHaveBeenCalledWith(BUSINESS_ID, ADDRESS_ID);
    });

    it('throws NotFound when deleting a missing address', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(
        service.deleteAddress(BUSINESS_ID, ADDRESS_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
