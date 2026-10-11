import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { AddressesService } from './addresses.service.js';
import {
  CustomersService,
  type AddressView,
  type CustomerView,
} from './customers.service.js';
import {
  AddressInputDto,
  UpdateAddressDto,
  UpdateCustomerDto,
  UpsertCustomerDto,
} from './dto/customer.dto.js';

@Controller('customers/me')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
  ) {}

  // --- Profile (open to any signed-in user; PUT is how the customer profile gets created) ---

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<CustomerView> {
    return this.customers.get(user.id);
  }

  @Put()
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpsertCustomerDto,
  ): Promise<CustomerView> {
    return this.customers.upsert(user.id, dto);
  }

  @Patch()
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerView> {
    return this.customers.patch(user.id, dto);
  }

  // --- Address book (needs a customer profile) ---

  @RequireProfile('customer')
  @Get('addresses')
  listAddresses(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AddressView[]> {
    return this.addresses.list(user.id);
  }

  @RequireProfile('customer')
  @Post('addresses')
  createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddressInputDto,
  ): Promise<AddressView> {
    return this.addresses.create(user.id, dto);
  }

  @RequireProfile('customer')
  @Patch('addresses/:id')
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressView> {
    return this.addresses.update(user.id, id, dto);
  }

  @RequireProfile('customer')
  @Post('addresses/:id/primary')
  @HttpCode(200)
  setPrimary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressView> {
    return this.addresses.setPrimary(user.id, id);
  }

  @RequireProfile('customer')
  @Delete('addresses/:id')
  @HttpCode(204)
  async removeAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.addresses.remove(user.id, id);
  }
}
