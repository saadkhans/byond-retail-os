import { Injectable } from '@nestjs/common';
import { User, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

@Injectable()
export class UsersRepository extends TenantScopedRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  create(
    tenantId: string,
    data: { email: string; firstName: string; lastName: string },
  ): Promise<User> {
    return this.prisma.user.create({
      data: {
        ...data,
        tenantId: this.requireTenantId(tenantId),
        userType: UserType.TENANT,
      },
    });
  }

  findById(tenantId: string, id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: this.scope(tenantId, { id }) });
  }

  findByEmail(tenantId: string, email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: this.scope(tenantId, { email }),
    });
  }

  findMany(tenantId: string): Promise<User[]> {
    return this.prisma.user.findMany({ where: this.scope(tenantId) });
  }
}
