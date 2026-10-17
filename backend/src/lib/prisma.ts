import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';

export { Prisma };
export type Db = PrismaClient;
/** Either the root client or an interactive-transaction client. Services accept this. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Pins the PostgreSQL session time zone to UTC.
 *
 * Prisma 7.10's pg adapter sends JavaScript Dates as UTC wall-clock text
 * without an offset, which PostgreSQL interprets in the session time zone. On
 * a server set to Asia/Riyadh every timestamp Prisma wrote was stored three
 * hours early, while database-side now() (defaults, the audit function) was
 * right — so comparisons between the two were off by three hours. Prisma's own
 * reads hide it (the offset is stripped again), and CI's UTC container never
 * shows it. Found in commit 5 by the break-glass expiry test.
 *
 * The flag is appended to any startup options already in the URL; PostgreSQL
 * applies the last -c for a setting, so an operator's TimeZone cannot win.
 */
export function withUtcSession(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get('options');
  url.searchParams.set('options', `${existing ? `${existing} ` : ''}-c TimeZone=UTC`);
  return url.toString();
}

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new SerialTransactionPrismaPg({ connectionString: withUtcSession(databaseUrl) }) });
}

// Prisma can issue parallel relation queries within one operation, even when
// application calls are awaited. A transaction has one pg connection: queue at
// the adapter boundary rather than relying on pg's deprecated implicit queue.
// Ordinary pool queries and separate transactions remain independent.
class SerialTransactionPrismaPg extends PrismaPg {
  override async connect() {
    const adapter = await super.connect();
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const tx = await startTransaction(...args);
      let tail: Promise<unknown> = Promise.resolve();
      const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
        const result = tail.then(work);
        // A failed statement must not prevent rollback/savepoint recovery.
        tail = result.catch(() => undefined);
        return result;
      };
      const query = tx.queryRaw.bind(tx);
      const execute = tx.executeRaw.bind(tx);
      const commit = tx.commit.bind(tx);
      const rollback = tx.rollback.bind(tx);
      tx.queryRaw = (sql) => enqueue(() => query(sql));
      tx.executeRaw = (sql) => enqueue(() => execute(sql));
      tx.commit = () => enqueue(commit);
      tx.rollback = () => enqueue(rollback);
      return tx;
    };
    return adapter;
  }
}
