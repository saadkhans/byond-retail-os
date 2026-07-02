import { Global, Module } from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, AuditLogService],
  exports: [PrismaService, AuditLogService],
})
export class PrismaModule {}
