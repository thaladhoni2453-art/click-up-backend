/*
  Warnings:

  - Added the required column `workspaceId` to the `Channel` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ChatInvite" DROP CONSTRAINT "ChatInvite_senderId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_authorId_fkey";

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "workspaceId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "estimated_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "story_points" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Channel_workspaceId_idx" ON "Channel"("workspaceId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatInvite" ADD CONSTRAINT "ChatInvite_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
