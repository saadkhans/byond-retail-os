import { User, UserStatus, UserType } from '@prisma/client';

/** User shape safe for API responses — passwordHash can never leak. */
export interface SafeUser {
  id: string;
  tenantId: string | null;
  userType: UserType;
  email: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(user: Omit<User, 'passwordHash'>): SafeUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    userType: user.userType,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
