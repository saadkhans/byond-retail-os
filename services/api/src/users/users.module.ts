import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

import { UsersController } from './users.controller';

// UsersRepository is exported so other modules (access-control) can perform
// tenant-scoped user existence checks without duplicating the scoping logic.
@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
