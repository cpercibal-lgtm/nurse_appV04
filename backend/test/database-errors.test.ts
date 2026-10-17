import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/lib/prisma.js';
import { fromPrismaError } from '../src/middleware/errors.js';

describe('database failure classification', () => {
  it.each(['P1001', 'P1002', 'P2024', 'P2034', 'ECONNREFUSED'])('does not blame the request for %s', (code) => {
    const error = new Prisma.PrismaClientKnownRequestError('private database details', { code, clientVersion: '7' });
    const mapped = fromPrismaError(error);
    expect(mapped.status).toBe(503);
    expect(JSON.stringify(mapped.toBody())).not.toContain('private database details');
  });
  it('keeps an unrecognized database failure server-side', () => {
    const error = new Prisma.PrismaClientKnownRequestError('private', { code: 'P9999', clientVersion: '7' });
    expect(fromPrismaError(error).status).toBe(500);
  });
  it.each(['40001', '40P01', '08006', '57P01', '53300'])('recognizes driver SQLSTATE %s', (sqlState) => {
    const error = new Prisma.PrismaClientKnownRequestError('private', {
      code: 'P2010', clientVersion: '7', meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
    });
    expect(fromPrismaError(error).status).toBe(503);
  });
});
