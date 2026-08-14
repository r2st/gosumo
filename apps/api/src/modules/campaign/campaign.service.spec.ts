import { CampaignService } from './campaign.service';

/**
 * CampaignService is still a scaffold. These tests pin the only contract it
 * currently has so the placeholder cannot silently rot before the real
 * implementation lands.
 */
describe('CampaignService', () => {
  let service: CampaignService;

  beforeEach(() => {
    service = new CampaignService();
  });

  it('reports itself ready under the Campaign module name', () => {
    expect(service.getStatus()).toEqual({
      module: 'Campaign',
      status: 'ready',
    });
  });

  it('returns a fresh object per call, so a caller cannot mutate shared state', () => {
    service.getStatus().status = 'tampered';
    expect(service.getStatus().status).toBe('ready');
  });
});
