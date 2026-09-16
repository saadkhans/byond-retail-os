import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PriceBook, PriceBookVersion } from '@prisma/client';
import {
  RequireModule,
  RequirePermissions,
  TenantOnly,
} from '../auth/decorators/access-policy.decorators';
import {
  CurrentTenantId,
  CurrentUser,
} from '../auth/decorators/request-context.decorators';
import { RequestContext } from '../auth/request-context';
import { ActivateVersionDto } from './dto/activate-version.dto';
import { CreatePriceBookDto } from './dto/create-price-book.dto';
import { CreateVersionDto } from './dto/create-version.dto';
import { QueryPriceBooksDto, ResolvePriceDto } from './dto/query-pricing.dto';
import { RollbackVersionDto } from './dto/rollback-version.dto';
import { SetEntriesDto } from './dto/set-entries.dto';
import { UpdatePriceBookDto } from './dto/update-price-book.dto';
import { ResolvedPrice } from './pricing.logic';
import { PRICING_MODULE_CODE } from './pricing.constants';
import {
  PriceBookDetail,
  PriceBookEntryWithProduct,
  PriceBookVersionSummary,
} from './pricing.repository';
import { PricingService } from './pricing.service';

// Tenant context comes exclusively from the authenticated user via
// @CurrentTenantId(); a tenantId in the body is rejected by the global
// whitelist ValidationPipe.
@ApiTags('pricing')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PRICING_MODULE_CODE)
@Controller('price-books')
export class PriceBooksController {
  constructor(private readonly pricingService: PricingService) {}

  @Get()
  @RequirePermissions('price-book:read')
  @ApiOperation({
    summary: 'List price books in the caller’s tenant',
    description:
      'Each book carries its version history, newest first. A book scoped ' +
      'to a location overrides the tenant-wide book at that location.',
  })
  list(
    @CurrentTenantId() tenantId: string,
    @Query() query: QueryPriceBooksDto,
  ): Promise<{ items: PriceBookDetail[]; total: number }> {
    return this.pricingService.findBooks(tenantId, query);
  }

  @Post()
  @RequirePermissions('price-book:manage')
  @ApiOperation({ summary: 'Create a price book' })
  @ApiCreatedResponse({ description: 'Price book created' })
  @ApiConflictResponse({ description: 'The code is already used' })
  create(
    @CurrentTenantId() tenantId: string,
    @Body() dto: CreatePriceBookDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBook> {
    return this.pricingService.createBook(tenantId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id')
  @RequirePermissions('price-book:read')
  @ApiOperation({ summary: 'Read one price book and its versions' })
  @ApiNotFoundResponse({ description: 'No such price book in this tenant' })
  findOne(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PriceBookDetail> {
    return this.pricingService.findBookById(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('price-book:manage')
  @ApiOperation({
    summary: 'Rename or archive a price book',
    description:
      'Code, currency and location scope are identity and cannot change — ' +
      'they would silently reinterpret every historical version.',
  })
  update(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePriceBookDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBook> {
    return this.pricingService.updateBook(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id/versions/:versionId')
  @RequirePermissions('price-book:read')
  @ApiOperation({ summary: 'Read one version of a price book' })
  findVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<PriceBookVersionSummary> {
    return this.pricingService.findVersion(tenantId, id, versionId);
  }

  @Post(':id/versions')
  @RequirePermissions('price-book:manage')
  @ApiOperation({
    summary: 'Create a DRAFT version',
    description:
      'A draft is the only mutable thing in pricing. Optionally seed it ' +
      'with a copy of an earlier version’s entries.',
  })
  @ApiCreatedResponse({ description: 'Draft version created' })
  createVersion(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: CreateVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBookVersion> {
    return this.pricingService.createVersion(tenantId, id, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Get(':id/versions/:versionId/entries')
  @RequirePermissions('price-book:read')
  @ApiOperation({ summary: 'List the prices in one version' })
  listEntries(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<PriceBookEntryWithProduct[]> {
    return this.pricingService.findEntries(tenantId, id, versionId);
  }

  @Put(':id/versions/:versionId/entries')
  @RequirePermissions('price-book:manage')
  @ApiOperation({
    summary: 'Replace the prices in a DRAFT version',
    description:
      'Whole-set semantics: a version is a complete snapshot of the book’s ' +
      'prices. Entries of an activated version are immutable — changing a ' +
      'price means creating a new version.',
  })
  @ApiConflictResponse({ description: 'The version is not a DRAFT' })
  setEntries(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: SetEntriesDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBookVersion> {
    return this.pricingService.setEntries(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/versions/:versionId/activate')
  @RequirePermissions('price-book:manage')
  @ApiOperation({
    summary: 'Activate a DRAFT version',
    description:
      'The moment prices change for shoppers. Supersedes the previously ' +
      'active version by closing its effective window — no history is ' +
      'rewritten or deleted.',
  })
  @ApiConflictResponse({
    description: 'Not a draft, empty, or the effective window would invert',
  })
  activate(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: ActivateVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBookVersion> {
    return this.pricingService.activateVersion(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }

  @Post(':id/versions/:versionId/rollback')
  @RequirePermissions('price-book:manage')
  @ApiOperation({
    summary: 'Roll back to an earlier version',
    description:
      'Copies that version’s prices into a NEW version and activates it. ' +
      'The old version is never resurrected or edited, so the audit trail ' +
      'reads forward.',
  })
  @ApiConflictResponse({
    description: 'The source version was never active',
  })
  rollback(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: RollbackVersionDto,
    @CurrentUser() actor: RequestContext,
  ): Promise<PriceBookVersion> {
    return this.pricingService.rollbackToVersion(tenantId, id, versionId, dto, {
      id: actor.userId,
      email: actor.email,
    });
  }
}

@ApiTags('pricing')
@ApiBearerAuth()
@TenantOnly()
@RequireModule(PRICING_MODULE_CODE)
@Controller('prices')
export class PricesController {
  constructor(private readonly pricingService: PricingService) {}

  @Get('resolve')
  @RequirePermissions('price:read')
  @ApiOperation({
    summary: 'Resolve the effective price of a product',
    description:
      'Answers at an instant (default now). Because superseded versions ' +
      'keep their closed effective windows, a past `at` returns what the ' +
      'product actually cost then. Returns null when nothing applies — ' +
      'never a zero price.',
  })
  resolve(
    @CurrentTenantId() tenantId: string,
    @Query() query: ResolvePriceDto,
  ): Promise<ResolvedPrice | null> {
    return this.pricingService.resolve(tenantId, query);
  }
}
