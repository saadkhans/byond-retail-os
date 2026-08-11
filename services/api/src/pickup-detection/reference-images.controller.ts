import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
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
import {
  ImportPreview,
  ImportReport,
  ReferenceImportService,
} from './reference-import.service';
import {
  ReferenceImageView,
  ReferenceImagesService,
  ReferenceLibraryStatus,
} from './reference-images.service';

const MAX_REFERENCE_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Multer memory-storage file shape (same idiom as UploadedVideoFile). */
interface UploadedReferenceFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
}

const MAX_IMPORT_ZIP_BYTES = 256 * 1024 * 1024;

/**
 * API-managed per-product reference images — the ONLY way the library is
 * populated (no operator-managed directory exists). Rows are metadata +
 * internal keys; bytes are served exclusively through the image endpoint.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@TenantOnly()
// Catalog surfaces live under the 'inventory' platform module (same gate
// as ProductsController — there is no separate 'catalog' module code).
@RequireModule('inventory')
@Controller('catalog/products')
export class ReferenceImagesController {
  constructor(
    private readonly service: ReferenceImagesService,
    private readonly importService: ReferenceImportService,
  ) {}

  @Post('reference-imports/preview')
  @RequirePermissions('catalog:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_ZIP_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'VALIDATION PREVIEW of a `<SKU>/<image>` reference ZIP — matched ' +
      'active SKUs, unknown folders, duplicates, invalid formats, and ' +
      'below-minimum projections. Reads nothing into storage.',
  })
  previewImport(
    @CurrentTenantId() tenantId: string,
    @UploadedFile() file: UploadedReferenceFile | undefined,
  ): Promise<ImportPreview> {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'Attach the ZIP archive as the multipart "file" field',
      );
    }
    return this.importService.preview(tenantId, file.buffer);
  }

  @Post('reference-imports')
  @RequirePermissions('catalog:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_ZIP_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'COMMIT a `<SKU>/<image>` reference ZIP import: images land through ' +
      'the same managed-storage/dedup/decode gates as single uploads; ' +
      'unknown folders are reported, never created. Returns the import ' +
      'report (accepted, rejected + reasons, now-inference-ready SKUs).',
  })
  commitImport(
    @CurrentTenantId() tenantId: string,
    @UploadedFile() file: UploadedReferenceFile | undefined,
    @CurrentUser() actor: RequestContext,
  ): Promise<ImportReport> {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'Attach the ZIP archive as the multipart "file" field',
      );
    }
    return this.importService.commit(tenantId, file.buffer, actor.userId);
  }

  @Post(':productId/reference-images')
  @RequirePermissions('catalog:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_REFERENCE_UPLOAD_BYTES, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload one PNG/JPEG reference image for a product (multipart ' +
      '"file"). Idempotent per byte-identical image. A product becomes ' +
      'INFERENCE-READY at 5 images.',
  })
  upload(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
    @UploadedFile() file: UploadedReferenceFile | undefined,
    @CurrentUser() actor: RequestContext,
  ): Promise<ReferenceImageView> {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'Attach the reference image as the multipart "file" field',
      );
    }
    return this.service.upload(
      tenantId,
      productId,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname ?? 'reference-image',
      },
      actor.userId,
    );
  }

  @Get('reference-images/overview')
  @RequirePermissions('catalog:read')
  @ApiOperation({
    summary:
      'Per-product reference counts + inference-ready verdicts (products ' +
      'carrying at least one image)',
  })
  overview(@CurrentTenantId() tenantId: string) {
    return this.service.overview(tenantId);
  }

  @Get(':productId/reference-images')
  @RequirePermissions('catalog:read')
  @ApiOperation({
    summary:
      'Reference-library status for one product: images, count, SKU, ' +
      'barcodes, and the inference-ready verdict (>= 5 images).',
  })
  @ApiNotFoundResponse({ description: 'Product not found in this tenant' })
  status(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<ReferenceLibraryStatus> {
    return this.service.status(tenantId, productId);
  }

  @Get(':productId/reference-images/:imageId/image')
  @RequirePermissions('catalog:read')
  @ApiOperation({ summary: 'Serve one reference image (bytes)' })
  async image(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const image = await this.service.imageBytes(tenantId, productId, imageId);
    response
      .status(200)
      .setHeader('Content-Type', image.mimeType)
      .setHeader('Cache-Control', 'private, max-age=3600')
      .send(image.data);
  }

  @Delete(':productId/reference-images/:imageId')
  @RequirePermissions('catalog:manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one reference image (row + stored bytes)' })
  async remove(
    @CurrentTenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('imageId') imageId: string,
  ): Promise<void> {
    await this.service.remove(tenantId, productId, imageId);
  }
}
