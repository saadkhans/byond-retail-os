import { Module } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsRepository } from './brands.repository';
import { BrandsService } from './brands.service';
import { CategoriesController } from './categories.controller';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

@Module({
  controllers: [CategoriesController, BrandsController, ProductsController],
  providers: [
    CategoriesService,
    CategoriesRepository,
    BrandsService,
    BrandsRepository,
    ProductsService,
    ProductsRepository,
  ],
  exports: [ProductsRepository],
})
export class CatalogModule {}
