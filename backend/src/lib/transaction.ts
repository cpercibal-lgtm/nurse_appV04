// Executes an operation inside a caller-owned transaction, or opens one for
// non-HTTP callers. The caller owns commit/rollback when a transaction is passed.
import type { Db, Prisma } from './prisma.js';
export type Transaction = Prisma.TransactionClient;
export function inTransaction<T>(db: Db, transaction: Transaction | undefined, work: (tx: Transaction) => Promise<T>, options?: { timeout?: number; maxWait?: number }) {
  return transaction ? work(transaction) : db.$transaction(work, options);
}
