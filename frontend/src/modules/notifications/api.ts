import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';

export interface NotificationRow {
  id: number; type: string; priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; title: string; message: string;
  titleAr: string | null; messageAr: string | null; employeeId: number | null; readAt: string | null; createdAt: string;
  /** D-69: set on an announcement; the item opens it. */
  announcementId: number | null;
  /** D-71: `roster-approval:<id>:…` on a roster approval notice; the item opens the roster page. */
  eventKey: string | null;
}
export interface NotificationPage { items: NotificationRow[]; total: number; unread: number; page: number; pageSize: number }

export const useNotifications = (unreadOnly: boolean, page: number) => useQuery({
  queryKey: ['notifications', unreadOnly, page],
  queryFn: () => http.get<NotificationPage>(`/notifications?page=${page}&pageSize=50${unreadOnly ? '&unread=true' : ''}`),
});
/** Unread count for the header bell; refreshed every minute. */
export const useUnreadCount = () => useQuery({
  queryKey: ['notifications', 'count'], refetchInterval: 60_000,
  queryFn: async () => (await http.get<NotificationPage>('/notifications?unread=true&pageSize=1')).unread,
});

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number | 'all') => (id === 'all' ? http.post('/notifications/read-all') : http.post(`/notifications/${id}/read`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
