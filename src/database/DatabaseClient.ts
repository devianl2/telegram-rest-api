import { PrismaClient } from '@prisma/client';
import { DatabaseClientInterface } from './interface/DatabaseClientInterface';

export class DatabaseClient implements DatabaseClientInterface {
  private static instance: DatabaseClient;

  private constructor() {}

  static getInstance(): DatabaseClient {
    if (!DatabaseClient.instance) {
      DatabaseClient.instance = new DatabaseClient();
    }
    return DatabaseClient.instance;
  }

  async execute<T>(operation: (prisma: PrismaClient) => Promise<T>): Promise<T> {
    const prisma = new PrismaClient();
    try {
      return await operation(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }
}
