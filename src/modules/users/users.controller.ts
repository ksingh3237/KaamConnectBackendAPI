import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { UsersService, type MeDto } from './users.service.js';

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return this.users.getMe(user.id);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
  ): Promise<MeDto> {
    return this.users.updateLanguage(user.id, dto.language);
  }
}
