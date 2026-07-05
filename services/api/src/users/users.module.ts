import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

// Service-level only in Phase 1: no controller until auth exists.
// UsersRepository is exported so other modules (access-control) can perform
// tenant-scoped user existence checks without duplicating the scoping logic.
@Module({
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
