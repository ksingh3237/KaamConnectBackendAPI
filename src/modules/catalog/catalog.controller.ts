import { Controller, Get, Header } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import type { LocationDto, ServiceCategoryDto } from './dto/catalog.dto.js';

// `private`: these require login (global JWT guard), so shared caches must not store them. Express adds an ETag, so unchanged data answers 304.
const CACHE = 'private, max-age=300';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('locations')
  @Header('Cache-Control', CACHE)
  locations(): Promise<LocationDto[]> {
    return this.catalog.listLocations();
  }

  @Get('service-categories')
  @Header('Cache-Control', CACHE)
  serviceCategories(): Promise<ServiceCategoryDto[]> {
    return this.catalog.listServiceCategories();
  }
}
