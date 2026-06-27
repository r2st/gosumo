import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  // TODO: implement Catalog business logic
  getStatus(): Record<string, string> {
    return { module: 'Catalog', status: 'ready' };
  }
}
