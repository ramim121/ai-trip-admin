/*
  Warnings:

  - Added the required column `familyExpiresAt` to the `admin_refresh_tokens` table without a default value. This is not possible if the table is not empty.
  - Added the required column `familyExpiresAt` to the `user_refresh_tokens` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "admin_refresh_tokens" ADD COLUMN     "familyExpiresAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "user_refresh_tokens" ADD COLUMN     "familyExpiresAt" TIMESTAMP(3) NOT NULL;
