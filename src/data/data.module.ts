import { Global, Module } from "@nestjs/common";
import { InMemoryDatabaseService } from "./in-memory-database.service";
import { PrismaDatabaseService } from "./prisma-database.service";

@Global()
@Module({ providers: [InMemoryDatabaseService, PrismaDatabaseService, { provide: "DATABASE_REPOSITORY", inject: [InMemoryDatabaseService, PrismaDatabaseService], useFactory: (memory: InMemoryDatabaseService, prisma: PrismaDatabaseService) => process.env.DATABASE_URL ? prisma : memory }], exports: [InMemoryDatabaseService, PrismaDatabaseService, "DATABASE_REPOSITORY"] })
export class DataModule {}
