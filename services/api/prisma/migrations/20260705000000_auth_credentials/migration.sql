-- Phase 2: authentication support.

-- New audit actions for auth-sensitive events.
-- (PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value is not used within the same transaction.)
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN';
ALTER TYPE "AuditAction" ADD VALUE 'LOGOUT';
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_CHANGE';

-- Local credential hash. Nullable: users may authenticate via future
-- providers (SSO/OIDC/OTP) and never hold a local credential.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
