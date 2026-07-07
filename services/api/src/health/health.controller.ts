import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/access-policy.decorators';
import { PrismaService } from '../prisma/prisma.service';

// Deliberately minimal payload: no versions, dependency lists, env names, or
// error details — health endpoints are unauthenticated and must not disclose.
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and database reachability' })
  @ApiOkResponse({ description: 'Service is running' })
  async check(): Promise<{ status: 'ok'; db: 'up' | 'down' }> {
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    return { status: 'ok', db };
  }
}
