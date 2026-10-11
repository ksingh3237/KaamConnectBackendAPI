import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { SkipUserThrottle } from '../../common/throttle/user-throttle.decorator.js';
import { SosDto } from '../fulfilment/dto/fulfilment.dto.js';
import {
  SosService,
  type SosRaised,
  type SosStatusView,
} from './sos.service.js';

/** Open to the customer and the assigned worker of the job; ownership is checked in the service. */
@Controller('jobs/:id/sos')
export class SafetyController {
  constructor(private readonly sos: SosService) {}

  // An emergency call is the last thing to refuse: exempt from the per-user limit (the per-IP one still applies).
  @SkipUserThrottle()
  @Post()
  @HttpCode(201)
  raise(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SosDto,
  ): Promise<SosRaised> {
    return this.sos.raise(user.id, id, dto);
  }

  /** Where the caller's own alerts on this job stand: sent, received by the desk, acknowledged, resolved. */
  @Get()
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SosStatusView[]> {
    return this.sos.statusFor(user.id, id);
  }
}
