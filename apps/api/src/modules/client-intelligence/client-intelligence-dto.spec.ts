/**
 * Tests for the ListClientsQueryDto fix that resolved 400 errors
 * on the clients page when frontend sends extra query params.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ListClientsQueryDto } from './dto';

describe('ListClientsQueryDto validation', () => {
  async function validateDto(plain: Record<string, unknown>) {
    const dto = plainToInstance(ListClientsQueryDto, plain);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('should accept standard pagination params', async () => {
    const errors = await validateDto({ page: '1', limit: '20' });
    expect(errors.length).toBe(0);
  });

  it('should accept the include param', async () => {
    const errors = await validateDto({ include: 'tags,orders' });
    expect(errors.length).toBe(0);
  });

  it('should accept the tags param', async () => {
    const errors = await validateDto({ tags: 'vip,returning' });
    expect(errors.length).toBe(0);
  });

  it('should accept the churnRiskLevel param', async () => {
    const errors = await validateDto({ churnRiskLevel: 'HIGH' });
    expect(errors.length).toBe(0);
  });

  it('should accept the q (search) param', async () => {
    const errors = await validateDto({ q: 'john' });
    expect(errors.length).toBe(0);
  });

  it('should accept hasOrders as boolean-like string', async () => {
    const dto = plainToInstance(ListClientsQueryDto, { hasOrders: 'true' });
    expect(dto.hasOrders).toBe(true);
  });

  it('should accept all params together without validation errors', async () => {
    const errors = await validateDto({
      page: '1', limit: '10', include: 'tags',
      tags: 'vip', churnRiskLevel: 'LOW', hasOrders: 'true', q: 'alice',
    });
    expect(errors.length).toBe(0);
  });
});
