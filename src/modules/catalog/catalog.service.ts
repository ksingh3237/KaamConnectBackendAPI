import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { LocationDto, ServiceCategoryDto } from './dto/catalog.dto.js';

/** Read-only reference data. Rarely changes, so it is a safe candidate for a cache later (D-6). */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listLocations(): Promise<LocationDto[]> {
    const cities = await this.prisma.city.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        areas: { orderBy: { id: 'asc' }, select: { id: true, name: true } },
      },
    });
    return cities;
  }

  /** 422 if the client sent an area id that does not exist. */
  async assertAreaExists(areaId: number, field: string): Promise<void> {
    const area = await this.prisma.area.findUnique({
      where: { id: areaId },
      select: { id: true },
    });
    if (!area) {
      throw new AppException(
        'VALIDATION_FAILED',
        422,
        'Request validation failed',
        [{ field, issue: 'unknown area' }],
      );
    }
  }

  /** 422 unless every id is an existing, active service category. */
  async assertCategoriesActive(
    categoryIds: string[],
    field: string,
  ): Promise<void> {
    const found = await this.prisma.serviceCategory.count({
      where: { id: { in: categoryIds }, isActive: true },
    });
    if (found !== new Set(categoryIds).size) {
      throw new AppException(
        'VALIDATION_FAILED',
        422,
        'Request validation failed',
        [{ field, issue: 'contains an unknown or inactive service category' }],
      );
    }
  }

  async listServiceCategories(): Promise<ServiceCategoryDto[]> {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return categories.map((c) => ({
      id: c.id,
      title: { en: c.titleEn, hi: c.titleHi, pa: c.titlePa },
      iconKey: c.iconKey,
      color: c.color,
      bgColor: c.bgColor,
      baseVisitFee: c.baseVisitFee,
      examples: c.examples,
    }));
  }
}
