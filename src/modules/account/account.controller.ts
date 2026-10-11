import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Equals, Matches } from 'class-validator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { AdminOnly } from '../../common/decorators/require-profile.decorator.js';
import { IsIndianMobile } from '../../common/validators/indian-mobile.js';
import {
  AccountDeletionService,
  type DeletionRequestItem,
} from './account-deletion.service.js';

const HOUR = 60 * 60 * 1000;

export class DeleteAccountDto {
  /** A fresh code from `POST /auth/otp/request` for the account's own number. */
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;

  /** The app sends true only after the person confirmed on a screen that explains what is lost. */
  @Equals(true, { message: 'confirm must be true' })
  confirm!: true;
}

export class DeletionRequestDto {
  @IsIndianMobile()
  phone!: string;

  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}

/** Account deletion by anonymisation (docs/08 section 1). */
@Controller()
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /** Door A. Needs the session AND a fresh code for the phone number; answers 204 when done. */
  @Delete('me')
  @HttpCode(204)
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    await this.deletion.deleteOwn(user.id, dto.code);
  }

  /**
   * Door B: a disabled person cannot hold a session, so they prove the number with a code and ask. Records a request
   * for an admin; deletes nothing. The reply is the same for every number, so it cannot reveal who has an account.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  @Post('auth/deletion-requests')
  @HttpCode(202)
  async request(@Body() dto: DeletionRequestDto): Promise<{ message: string }> {
    await this.deletion.requestAsDisabled(dto.phone, dto.code);
    return {
      message:
        'If this number belongs to an account, your request has been received and will be reviewed.',
    };
  }
}

/** The back-office queue for Door B. Admin only (404 to everyone else). */
@AdminOnly()
@Controller('admin/deletion-requests')
export class AccountAdminController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Get()
  list(): Promise<{ items: DeletionRequestItem[] }> {
    return this.deletion.listRequests();
  }

  @Post(':userId/approve')
  @HttpCode(204)
  async approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.deletion.approveRequest(admin.id, userId);
  }

  @Post(':userId/decline')
  @HttpCode(204)
  async decline(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.deletion.declineRequest(admin.id, userId);
  }
}
