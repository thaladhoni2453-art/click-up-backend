// backend/packages/db/index.js
const { PrismaClient } = require("@prisma/client");

const prisma =
  global.prismaShared ||
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaShared = prisma;
}

module.exports = { prisma };
