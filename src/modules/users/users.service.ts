import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import type {
  Language,
  VerificationStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface MeDto {
  id: string;
  phone: string;
  language: Language;
  customer: {
    fullName: string;
    commLanguage: Language;
    allowDirectCalls: boolean;
  } | null;
  worker: { fullName: string; verificationStatus: VerificationStatus } | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<MeDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        language: true,
        isActive: true,
        customer: {
          select: {
            fullName: true,
            commLanguage: true,
            allowDirectCalls: true,
          },
        },
        worker: { select: { fullName: true, verificationStatus: true } },
      },
    });
    // A valid token for a user that no longer exists or was disabled is treated as logged out.
    if (!user || !user.isActive) {
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');
    }
    const { isActive: _isActive, ...me } = user;
    return me;
  }

  async updateLanguage(userId: string, language: Language): Promise<MeDto> {
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, isActive: true },
      data: { language },
    });
    if (updated.count === 0) {
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');
    }
    return this.getMe(userId);
  }
}
