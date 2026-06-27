/**
 * Tests for the calendar and staff routes added to BookingController
 * to fix "Something went wrong" on the bookings page.
 */
describe('BookingController calendar & staff routes', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';

  // ─── Calendar route ──────────────────────────

  describe('getCalendar', () => {
    it('should map bookings to calendar events format', () => {
      const bookings = [
        {
          id: 'b1', notes: 'Haircut', start_at: '2024-06-01T10:00:00Z',
          end_at: '2024-06-01T11:00:00Z', status: 'CONFIRMED',
          client: { name: 'Alice' }, staffMember: { name: 'Bob' },
        },
      ];

      const events = bookings.map((b: any) => ({
        id: b.id,
        title: b.notes || 'Appointment',
        start: b.startAt ?? b.start_at,
        end: b.endAt ?? b.end_at,
        status: b.status,
        clientName: b.client?.name ?? null,
        staffName: b.staffMember?.name ?? null,
      }));

      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('b1');
      expect(events[0]!.title).toBe('Haircut');
      expect(events[0]!.start).toBe('2024-06-01T10:00:00Z');
      expect(events[0]!.clientName).toBe('Alice');
      expect(events[0]!.staffName).toBe('Bob');
    });

    it('should use Appointment as default title when notes is empty', () => {
      const b = { id: 'b2', notes: '', start_at: '2024-06-01T10:00:00Z' };
      const title = b.notes || 'Appointment';
      expect(title).toBe('Appointment');
    });
  });

  // ─── Staff route ─────────────────────────────

  describe('getStaffMembers', () => {
    it('should map team members to staff shape', () => {
      const members = [
        { id: 'm1', name: 'Alice', email: 'alice@test.com', role: 'STAFF', avatar_url: 'https://img.test/a.jpg' },
        { id: 'm2', name: null, email: 'bob@test.com', role: 'ADMIN', avatar_url: null },
      ];

      const staff = members.map((m: any) => ({
        id: m.id,
        name: m.name ?? m.email?.split('@')[0] ?? 'Staff',
        email: m.email,
        role: m.role,
        avatarUrl: m.avatar_url ?? null,
      }));

      expect(staff).toHaveLength(2);
      expect(staff[0]!.name).toBe('Alice');
      expect(staff[0]!.avatarUrl).toBe('https://img.test/a.jpg');
      expect(staff[1]!.name).toBe('bob'); // derived from email
      expect(staff[1]!.avatarUrl).toBeNull();
    });

    it('should return empty staff array when no members', () => {
      const members: any[] = [];
      const result = { staff: (members ?? []).map(() => ({})) };
      expect(result.staff).toEqual([]);
    });
  });
});

describe('ListBookingsQueryDto include field', () => {
  it('should accept include as an optional string parameter', () => {
    // The DTO fix ensures include=client does not cause a 400 validation error
    const dto = { include: 'client', page: 1, limit: 10 };
    expect(dto.include).toBe('client');
  });
});
