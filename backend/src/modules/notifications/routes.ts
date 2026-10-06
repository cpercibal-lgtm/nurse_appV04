// Own notifications (spec §7.1, N2): a recipient reads and acknowledges only
// their own rows; one user can never acknowledge another user's notification.

import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { authOf } from '../../middleware/authorize.js';

const ListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createNotificationsRouter(db: Db) {
  const r = Router();
  const fields = { id: true, type: true, priority: true, title: true, message: true, titleAr: true, messageAr: true, employeeId: true, announcementId: true, readAt: true, createdAt: true } as const;

  r.get('/notifications', async (req, res) => {
    const q = ListQuery.parse(req.query);
    const me = authOf(res).user.id;
    const where = { recipientId: me, ...(q.unread === 'true' ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      db.notification.findMany({ where, select: fields, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.notification.count({ where }),
      db.notification.count({ where: { recipientId: me, readAt: null } }),
    ]);
    res.json({ items, total, unread, page: q.page, pageSize: q.pageSize });
  });

  r.post('/notifications/:id/read', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    // Scoped to the caller: another user's id is simply "not found".
    const done = await db.notification.updateMany({ where: { id, recipientId: authOf(res).user.id }, data: { readAt: new Date() } });
    if (done.count === 0) throw notFound('Notification not found');
    res.json({ id, read: true });
  });

  r.post('/notifications/read-all', async (_req, res) => {
    const done = await db.notification.updateMany({ where: { recipientId: authOf(res).user.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ updated: done.count });
  });

  return r;
}
