import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MediaModule } from '../media/media.module.js';
import { AddressesService } from './addresses.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [CatalogModule, MediaModule],
  controllers: [CustomersController],
  providers: [CustomersService, AddressesService],
  exports: [CustomersService],
})
export class CustomersModule {}
