/**
 * OperatorAlertController route wiring.
 *
 * The controller holds no logic, so what is asserted is the wiring that
 * misbehaves quietly rather than throwing: the literal `unread` route being
 * shadowed by `:id` (which answers a perfectly good URL with a 400 about a
 * malformed UUID), the tenant being threaded from the decorator rather than a
 * body, and the row → DTO mapping, which is the boundary that decides what
 * leaves the API.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { OperatorAlertStatus } from '@gosumo/database';

import { OperatorAlertController } from './operator-alert.controller';
import { OperatorAlertService } from './operator-alert.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';
const USER = '00000000-0000-4000-c000-000000000001';

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  business_id: BIZ,
  kind: 'ESCALATION',
  severity: 'CRITICAL',
  title: 'SLA escalation',
  body: 'Body',
  source_channel: 'WHATSAPP',
  conversation_id: '00000000-0000-4000-e000-000000000001',
  entity_type: 'sla_policy',
  entity_id: '00000000-0000-4000-f000-000000000001',
  context: { policyId: 'p1' },
  status: OperatorAlertStatus.DELIVERED,
  reason: null,
  deferred_until: null,
  delivered_at: new Date('2026-08-21T10:05:00.000Z'),
  delivered_to: ['ops@example.com'],
  read_at: null,
  read_by: null,
  dedupe_key: 'k',
  created_at: new Date('2026-08-21T10:00:00.000Z'),
  updated_at: new Date('2026-08-21T10:00:00.000Z'),
});

describe('OperatorAlertController', () => {
  let controller: OperatorAlertController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      list: jest
        .fn()
        .mockResolvedValue({ data: [row()], total: 1, page: 1, limit: 20, totalPages: 1 }),
      get: jest.fn().mockResolvedValue(row()),
      markRead: jest.fn().mockResolvedValue(row({ read_at: new Date() })),
      markAllRead: jest.fn().mockResolvedValue(3),
      unreadCounts: jest.fn().mockResolvedValue({ total: 3, bySeverity: [] }),
    };

    const module = await Test.createTestingModule({
      controllers: [OperatorAlertController],
      providers: [{ provide: OperatorAlertService, useValue: service }],
    }).compile();

    controller = module.get(OperatorAlertController);
  });

  describe('route order', () => {
    const getPaths = (): string[] =>
      Object.getOwnPropertyNames(OperatorAlertController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const handler = Object.getOwnPropertyDescriptor(
            OperatorAlertController.prototype,
            name,
          )?.value as unknown;
          return {
            path: Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined,
            method: Reflect.getMetadata(METHOD_METADATA, handler as object) as
              | RequestMethod
              | undefined,
          };
        })
        .filter((r) => r.method === RequestMethod.GET && r.path !== undefined)
        .map((r) => r.path as string);

    it('declares the literal unread route before the :id catch-all', () => {
      const paths = getPaths();
      expect(paths.indexOf('unread')).toBeGreaterThanOrEqual(0);
      expect(paths.indexOf('unread')).toBeLessThan(paths.indexOf(':id'));
    });
  });

  describe('list', () => {
    it('threads the tenant and every filter through to the service', async () => {
      await controller.list(BIZ, {
        kind: 'ESCALATION',
        severity: 'CRITICAL',
        status: OperatorAlertStatus.DELIVERED,
        unread: true,
        conversationId: '00000000-0000-4000-e000-000000000001',
        page: 2,
        limit: 10,
      } as never);

      expect(service.list).toHaveBeenCalledWith(BIZ, {
        kind: 'ESCALATION',
        severity: 'CRITICAL',
        status: OperatorAlertStatus.DELIVERED,
        unreadOnly: true,
        conversationId: '00000000-0000-4000-e000-000000000001',
        page: 2,
        limit: 10,
      });
    });

    it('maps rows to the camelCase DTO and keeps the page envelope', async () => {
      const result = await controller.list(BIZ, {} as never);

      expect(result.total).toBe(1);
      expect(result.data[0]).toEqual(
        expect.objectContaining({
          id: ID,
          kind: 'ESCALATION',
          sourceChannel: 'WHATSAPP',
          deliveredTo: ['ops@example.com'],
          readAt: null,
        }),
      );
      // The storage column names must not leak into the API surface.
      const dto = result.data[0] as unknown as Record<string, unknown>;
      expect(dto).not.toHaveProperty('business_id');
      expect(dto).not.toHaveProperty('source_channel');
      expect(dto).not.toHaveProperty('dedupe_key');
    });
  });

  describe('reads', () => {
    it('passes the acting member so the first reader is recorded', async () => {
      await controller.markRead(BIZ, USER, ID);
      expect(service.markRead).toHaveBeenCalledWith(BIZ, ID, USER);
    });

    it('records a null reader when the token carries no subject', async () => {
      await controller.markRead(BIZ, undefined as unknown as string, ID);
      expect(service.markRead).toHaveBeenCalledWith(BIZ, ID, null);
    });

    it('reports how many alerts read-all actually changed', async () => {
      await expect(controller.markAllRead(BIZ, USER)).resolves.toEqual({ marked: 3 });
    });

    it('returns the unread counts unchanged', async () => {
      await expect(controller.unread(BIZ)).resolves.toEqual({ total: 3, bySeverity: [] });
    });

    it('scopes a single fetch to the tenant', async () => {
      await controller.get(BIZ, ID);
      expect(service.get).toHaveBeenCalledWith(BIZ, ID);
    });
  });
});
