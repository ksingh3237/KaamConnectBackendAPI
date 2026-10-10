import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { Language } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';
import type {
  AddressInputDto,
  UpdateAddressDto,
  UpdateCustomerDto,
  UpsertCustomerDto,
} from './dto/customer.dto.js';

export const MAX_ADDRESSES = 5;

export interface AddressView {
  id: string;
  area: { id: number; name: string };
  city: { id: number; name: string };
  line: string;
  lat: number | null;
  lng: number | null;
  isPrimary: boolean;
}

export interface CustomerView {
  userId: string;
  fullName: string;
  photoUrl: string | null;
  commLanguage: Language;
  allowDirectCalls: boolean;
  addresses: AddressView[];
}

const addressInclude = { area: { include: { city: true } } } as const;

export function toAddressView(a: {
  id: string;
  line: string;
  lat: number | null;
  lng: number | null;
  isPrimary: boolean;
  area: { id: number; name: string; city: { id: number; name: string } };
}): AddressView {
  return {
    id: a.id,
    area: { id: a.area.id, name: a.area.name },
    city: { id: a.area.city.id, name: a.area.city.name },
    line: a.line,
    lat: a.lat,
    lng: a.lng,
    isPrimary: a.isPrimary,
  };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly media: MediaService,
  ) {}

  async get(userId: string): Promise<CustomerView> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: {
        addresses: {
          include: addressInclude,
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!profile) throw profileNotFound();
    return this.toView(profile);
  }

  /**
   * Customer onboarding "Save": creates the profile and its primary address, or updates both.
   * Optional fields that are omitted keep their current value (defaults on first save).
   */
  async upsert(userId: string, dto: UpsertCustomerDto): Promise<CustomerView> {
    await this.catalog.assertAreaExists(dto.address.areaId, 'address.areaId');
    if (dto.photoKey) {
      await this.media.assertOwnedUpload(
        userId,
        MediaPurpose.PROFILE_PHOTO,
        dto.photoKey,
        'photoKey',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.customerProfile.upsert({
        where: { userId },
        create: {
          userId,
          fullName: dto.fullName,
          photoKey: dto.photoKey,
          commLanguage: dto.commLanguage,
          allowDirectCalls: dto.allowDirectCalls,
        },
        update: {
          fullName: dto.fullName,
          photoKey: dto.photoKey,
          commLanguage: dto.commLanguage,
          allowDirectCalls: dto.allowDirectCalls,
        },
      });

      const data = addressData(dto.address);
      const primary = await tx.address.findFirst({
        where: { customerId: userId, isPrimary: true },
        select: { id: true },
      });
      if (primary) {
        await tx.address.update({ where: { id: primary.id }, data });
      } else {
        await tx.address.create({
          data: { ...data, customerId: userId, isPrimary: true },
        });
      }
    });
    return this.get(userId);
  }

  async patch(userId: string, dto: UpdateCustomerDto): Promise<CustomerView> {
    if (dto.photoKey) {
      await this.media.assertOwnedUpload(
        userId,
        MediaPurpose.PROFILE_PHOTO,
        dto.photoKey,
        'photoKey',
      );
    }
    const updated = await this.prisma.customerProfile.updateMany({
      where: { userId },
      data: {
        fullName: dto.fullName,
        photoKey: dto.photoKey, // undefined = unchanged, null = remove
        commLanguage: dto.commLanguage,
        allowDirectCalls: dto.allowDirectCalls,
      },
    });
    if (updated.count === 0) throw profileNotFound();
    return this.get(userId);
  }

  private async toView(profile: {
    userId: string;
    fullName: string;
    photoKey: string | null;
    commLanguage: Language;
    allowDirectCalls: boolean;
    addresses: Parameters<typeof toAddressView>[0][];
  }): Promise<CustomerView> {
    return {
      userId: profile.userId,
      fullName: profile.fullName,
      photoUrl: await this.media.readUrl(
        MediaPurpose.PROFILE_PHOTO,
        profile.photoKey,
      ),
      commLanguage: profile.commLanguage,
      allowDirectCalls: profile.allowDirectCalls,
      addresses: profile.addresses.map(toAddressView),
    };
  }
}

export function addressData(
  input: Pick<AddressInputDto, 'areaId' | 'line' | 'lat' | 'lng'>,
) {
  return {
    areaId: input.areaId,
    line: input.line,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
  };
}

export function profileNotFound(): AppException {
  return new AppException(
    'PROFILE_NOT_FOUND',
    404,
    'Customer profile not found',
  );
}

export type { UpdateAddressDto };
