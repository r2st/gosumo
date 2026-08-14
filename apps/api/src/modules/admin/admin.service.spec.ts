import { AdminService } from './admin.service';

/**
 * AdminService is still a scaffold. These tests pin the only contract it
 * currently has so the placeholder cannot silently rot before the real
 * implementation lands.
 */
describe('AdminService', () => {
  let service: AdminService;

  beforeEach(() => {
    service = new AdminService();
  });

  it('reports itself ready under the Admin module name', () => {
    expect(service.getStatus()).toEqual({ module: 'Admin', status: 'ready' });
  });

  it('returns a fresh object per call, so a caller cannot mutate shared state', () => {
    service.getStatus().status = 'tampered';
    expect(service.getStatus().status).toBe('ready');
  });
});
