import { ShippingService } from './shipping.service';
import { ShippingModule } from './shipping.module';

/**
 * ShippingService is still a scaffold — the Shiprocket integration described in
 * the module README has not been written yet. These tests pin the only contract
 * it currently has (the health probe the module exports) so the placeholder
 * cannot silently rot before the real implementation lands.
 */
describe('ShippingService', () => {
  let service: ShippingService;

  beforeEach(() => {
    service = new ShippingService();
  });

  it('reports itself ready under the Shipping module name', () => {
    expect(service.getStatus()).toEqual({
      module: 'Shipping',
      status: 'ready',
    });
  });

  it('returns a fresh object per call, so a caller cannot mutate shared state', () => {
    const first = service.getStatus();
    first.status = 'tampered';
    expect(service.getStatus().status).toBe('ready');
  });

  it('is registered and exported by ShippingModule', () => {
    const providers = Reflect.getMetadata('providers', ShippingModule);
    const exported = Reflect.getMetadata('exports', ShippingModule);
    expect(providers).toContain(ShippingService);
    expect(exported).toContain(ShippingService);
  });
});
