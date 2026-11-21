-- CreateEnum
CREATE TYPE "StockPlace" AS ENUM ('WAREHOUSE', 'CAR');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'TRANSFER';

-- DropIndex
DROP INDEX "stock_batches_productId_remainingCans_idx";

-- AlterTable
ALTER TABLE "stock_batches" ADD COLUMN     "carUserId" INTEGER,
ADD COLUMN     "place" "StockPlace" NOT NULL DEFAULT 'WAREHOUSE';

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "carUserId" INTEGER,
ADD COLUMN     "place" "StockPlace" NOT NULL DEFAULT 'WAREHOUSE',
ADD COLUMN     "transferId" INTEGER;

-- AlterTable
ALTER TABLE "stock_counts" ADD COLUMN     "carUserId" INTEGER,
ADD COLUMN     "place" "StockPlace" NOT NULL DEFAULT 'WAREHOUSE';

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" SERIAL NOT NULL,
    "toCar" BOOLEAN NOT NULL,
    "carUserId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "note" TEXT,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_batches_productId_place_carUserId_remainingCans_idx" ON "stock_batches"("productId", "place", "carUserId", "remainingCans");

