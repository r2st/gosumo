import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaService only binds the Prisma client's connection lifecycle to Nest's.
 * The tests stub $connect/$disconnect on the instance so nothing reaches a real
 * database, and pin that a connection failure propagates — bootstrapping with a
 * dead database must abort rather than serve traffic that will fail per-request.
 */
describe('PrismaService', () => {
  let service: PrismaService;
  let connect: jest.Mock;
  let disconnect: jest.Mock;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new PrismaService();
    connect = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, { $connect: connect, $disconnect: disconnect });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('onModuleInit', () => {
    it('opens the connection', async () => {
      await service.onModuleInit();
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('logs only after the connection is actually open', async () => {
      let connected = false;
      connect.mockImplementation(async () => {
        connected = true;
      });
      log.mockImplementation(() => {
        expect(connected).toBe(true);
      });
      await service.onModuleInit();
      expect(log).toHaveBeenCalledWith('Prisma connected to database');
    });

    it('propagates a connection failure so bootstrap aborts', async () => {
      connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('closes the connection', async () => {
      await service.onModuleDestroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('Prisma disconnected from database');
    });

    it('propagates a disconnect failure rather than hiding a leaked pool', async () => {
      disconnect.mockRejectedValueOnce(new Error('pool busy'));
      await expect(service.onModuleDestroy()).rejects.toThrow('pool busy');
    });
  });

  it('implements both Nest lifecycle hooks', () => {
    expect(typeof service.onModuleInit).toBe('function');
    expect(typeof service.onModuleDestroy).toBe('function');
  });
});
