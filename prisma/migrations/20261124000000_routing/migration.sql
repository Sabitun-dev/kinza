-- CreateTable
CREATE TABLE "road_distances" (
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,
    "meters" INTEGER NOT NULL,
    "seconds" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "road_distances_pkey" PRIMARY KEY ("fromKey","toKey")
);

-- CreateTable
CREATE TABLE "gps_points" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "checklistId" INTEGER,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gps_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gps_points_userId_at_idx" ON "gps_points"("userId", "at");

