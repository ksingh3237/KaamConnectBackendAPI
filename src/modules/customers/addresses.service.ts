import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { AddressInputDto, UpdateAddressDto } from './dto/customer.dto.js';
import {
  MAX_ADDRESSES,
  addressData,
  toAddressView,
  type AddressView,
} from './customers.service.js';

const include = { area: { include: { city: true } } } as const;
const notFound = () => new AppException('NOT_FOUND', 404, 'Address not found');

/** The customer's address book. Every query is scoped by customerId, so a foreign id is a 404. */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async list(userId: string): Promise<AddressView[]> {
    const rows = await this.prisma.address.findMany({
      where: { customerId: userId },
      include,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toAddressView);
  }

  /** The first address becomes the primary one automatically. */
  async create(userId: string, dto: AddressInputDto): Promise<AddressView> {
    await this.catalog.assertAreaExists(dto.areaId, 'areaId');

    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.address.count({
        where: { customerId: userId },
      });
      if (existing >= MAX_ADDRESSES) {
        throw new AppException(
          'ADDRESS_LIMIT',
          409,
          `You can save at most ${MAX_ADDRESSES} addresses`,
        );
      }
      return tx.address.create({
        data: {
          ...addressData(dto),
          customerId: userId,
          isPrimary: existing === 0,
        },
        include,
      });
    });
    return toAddressView(created);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<AddressView> {
    if (dto.areaId !== undefined)
      await this.catalog.assertAreaExists(dto.areaId, 'areaId');

    const result = await this.prisma.address.updateMany({
      where: { id, customerId: userId },
      data: {
        areaId: dto.areaId,
        line: dto.line,
        lat: dto.lat,
        lng: dto.lng,
        localityName:
          dto.localityName === undefined ? undefined : dto.localityName || null,
      },
    });
    if (result.count === 0) throw notFound();
    return this.getOwned(userId, id);
  }

  async setPrimary(userId: string, id: string): Promise<AddressView> {
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.address.findFirst({
        where: { id, customerId: userId },
        select: { id: true },
      });
      if (!target) throw notFound();
      // Two statements on purpose: the "one primary" unique index is checked per statement.
      await tx.address.updateMany({
        where: { customerId: userId, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.address.update({ where: { id }, data: { isPrimary: true } });
    });
    return this.getOwned(userId, id);
  }

  /** Deleting the primary address promotes the oldest remaining one. */
  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.address.findFirst({
        where: { id, customerId: userId },
      });
      if (!target) throw notFound();
      await tx.address.delete({ where: { id } });
      if (target.isPrimary) {
        const next = await tx.address.findFirst({
          where: { customerId: userId },
          orderBy: { createdAt: 'asc' },
        });
        if (next)
          await tx.address.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
      }
    });
  }

  private async getOwned(userId: string, id: string): Promise<AddressView> {
    const row = await this.prisma.address.findFirst({
      where: { id, customerId: userId },
      include,
    });
    if (!row) throw notFound();
    return toAddressView(row);
  }
}
