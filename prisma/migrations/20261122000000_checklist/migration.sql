-- CreateEnum
CREATE TYPE "VisitFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY');

-- CreateEnum
CREATE TYPE "WeekParity" AS ENUM ('ODD', 'EVEN');

-- CreateEnum
CREATE TYPE "ChecklistSource" AS ENUM ('ROUTE', 'CARRY', 'MOVED', 'PREORDER', 'NEW');

-- CreateEnum
CREATE TYPE "ChecklistStatus" AS ENUM ('PENDING', 'SOLD', 'DELIVERED', 'NO_ORDER', 'CLOSED', 'MOVED');

-- AlterEnum
ALTER TYPE "DocKind" ADD VALUE 'CHECKLIST';

-- AlterEnum
ALTER TYPE "VisitResult" ADD VALUE 'NO_ORDER';

-- AlterTable
ALTER TABLE "districts" ADD COLUMN     "weekParity" "WeekParity";

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "frequency" "VisitFrequency" NOT NULL DEFAULT 'WEEKLY',
ADD COLUMN     "notBefore" TEXT,
ADD COLUMN     "openFrom" TEXT,
ADD COLUMN     "openTo" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "weekParity" "WeekParity";

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "holidays" (
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "checklists" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "areaIds" INTEGER[],
    "closedAt" TIMESTAMP(3),
    "route" JSONB,
    "plannedKm" DOUBLE PRECISION,
    "plannedMin" INTEGER,
    "drivenKm" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" SERIAL NOT NULL,
    "checklistId" INTEGER NOT NULL,
    "shopId" INTEGER NOT NULL,
    "source" "ChecklistSource" NOT NULL,
    "status" "ChecklistStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "movedTo" DATE,
    "autoCarried" BOOLEAN NOT NULL DEFAULT false,
    "carriedOn" BOOLEAN NOT NULL DEFAULT false,
    "carryCount" INTEGER NOT NULL DEFAULT 0,
    "orderId" INTEGER,
    "visitId" INTEGER,
    "position" INTEGER,
    "etaMin" INTEGER,
    "legKm" DOUBLE PRECISION,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checklists_userId_date_key" ON "checklists"("userId", "date");

-- CreateIndex
CREATE INDEX "checklist_items_status_movedTo_idx" ON "checklist_items"("status", "movedTo");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_items_checklistId_shopId_key" ON "checklist_items"("checklistId", "shopId");

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "checklists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

