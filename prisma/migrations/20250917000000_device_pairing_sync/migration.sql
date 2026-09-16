-- CreateEnum
CREATE TYPE "PairingAttemptKind" AS ENUM ('CREATE', 'CLAIM');

-- CreateTable
CREATE TABLE "SyncSpace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "SyncSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingCode" (
    "id" TEXT NOT NULL,
    "syncSpaceId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairedDevice" (
    "id" TEXT NOT NULL,
    "syncSpaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingAttempt" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "kind" "PairingAttemptKind" NOT NULL,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncSpace_userId_key" ON "SyncSpace"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PairingCode_codeHash_key" ON "PairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "PairingCode_expiresAt_idx" ON "PairingCode"("expiresAt");

-- CreateIndex
CREATE INDEX "PairingCode_syncSpaceId_idx" ON "PairingCode"("syncSpaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PairedDevice_tokenHash_key" ON "PairedDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "PairedDevice_syncSpaceId_idx" ON "PairedDevice"("syncSpaceId");

-- CreateIndex
CREATE INDEX "PairingAttempt_ipHash_createdAt_idx" ON "PairingAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "PairingAttempt_createdAt_idx" ON "PairingAttempt"("createdAt");

-- AddForeignKey
ALTER TABLE "SyncSpace" ADD CONSTRAINT "SyncSpace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_syncSpaceId_fkey" FOREIGN KEY ("syncSpaceId") REFERENCES "SyncSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairedDevice" ADD CONSTRAINT "PairedDevice_syncSpaceId_fkey" FOREIGN KEY ("syncSpaceId") REFERENCES "SyncSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

