// Announcements (D-69): memos, meeting schedules and seminar notices. The server
// decides scope and approval; these hooks only read and send.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';

export type AnnouncementKind = 'MEMO' | 'MEETING' | 'SEMINAR';
export type AnnouncementStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'REJECTED' | 'CANCELLED';
export type AudienceType = 'HOSPITAL' | 'DEPARTMENT' | 'UNIT' | 'PEOPLE';
export type AnnouncementPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export const KINDS: AnnouncementKind[] = ['MEMO', 'MEETING', 'SEMINAR'];

export interface Announcement {
  id: number; kind: AnnouncementKind; status: AnnouncementStatus; priority: AnnouncementPriority | 'CRITICAL';
  title: string; body: string; titleAr: string | null; bodyAr: string | null; referenceNo: string | null;
  startsAt: string | null; endsAt: string | null; location: string | null; onlineUrl: string | null;
  speaker: string | null; ceHours: number | null;
  audienceType: AudienceType; audienceIds: number[]; roleFilter: string[]; positionFilter: string[]; specialtyFilter: string[];
  recipientCount: number | null; emailOnlyCount: number | null; expiresAt: string;
  createdById: number; createdByName: string | null; publishedAt: string | null;
  cancelledAt: string | null; cancelReason: string | null; createdAt: string; updatedAt: string;
  /** GET /announcements/:id only. */
  canCancel?: boolean;
  /** Create / update only: whether sending will wait for a second administrator. */
  needsApproval?: boolean;
}

/** What the compose form sends (create and update). */
export interface AnnouncementInput {
  kind: AnnouncementKind; title: string; body: string; titleAr?: string | null; bodyAr?: string | null; referenceNo?: string | null;
  startsAt?: string | null; endsAt?: string | null; location?: string | null; onlineUrl?: string | null; speaker?: string | null; ceHours?: number | null;
  priority?: AnnouncementPriority; audienceType: AudienceType; audienceIds: number[];
  roleFilter: string[]; positionFilter: string[]; specialtyFilter: string[]; expiresAt?: string | null;
}

export interface Preview {
  recipients: number; telegramLinked: number; emailOnly: number; needsApproval: boolean;
  emailsQueued: number; emailEtaMinutes: number; emailHourlyLimit: number;
}
export interface Person { id: number; displayName: string; jobNumber: string | null; unitName: string | null }
export interface Page<T> { items: T[]; total: number; page?: number; pageSize?: number }

const KEY = ['announcements'] as const;

export const useBoard = (state: 'active' | 'archived', kind: AnnouncementKind | undefined, page: number) => useQuery({
  queryKey: [...KEY, 'board', state, kind ?? 'all', page],
  queryFn: () => http.get<Page<Announcement>>(`/announcements?state=${state}&page=${page}&pageSize=20${kind ? `&kind=${kind}` : ''}`),
});
export const useSent = (enabled: boolean) => useQuery({ queryKey: [...KEY, 'sent'], enabled, queryFn: () => http.get<Page<Announcement>>('/announcements/sent') });
export const useManaged = (enabled: boolean) => useQuery({ queryKey: [...KEY, 'managed'], enabled, queryFn: () => http.get<Page<Announcement>>('/announcements/managed') });
export const useAnnouncement = (id: number | null) => useQuery({
  queryKey: [...KEY, 'one', id], enabled: id !== null, retry: false,
  queryFn: () => http.get<Announcement>(`/announcements/${id}`),
});
export const usePeople = (q: string) => useQuery({
  queryKey: [...KEY, 'people', q], enabled: q.trim().length >= 2,
  queryFn: () => http.get<Page<Person>>(`/announcements/people?q=${encodeURIComponent(q.trim())}`),
});

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: AnnouncementInput }) =>
      (id === null ? http.post<Announcement>('/announcements', input) : http.patch<Announcement>(`/announcements/${id}`, input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
export const usePreview = () => useMutation({ mutationFn: (id: number) => http.post<Preview>(`/announcements/${id}/preview`) });

export function useSubmit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, key }: { id: number; key: string }) =>
      http.post<{ id: number; status: 'PUBLISHED' | 'PENDING_APPROVAL'; approvalRequestId?: number }>(`/announcements/${id}/submit`, undefined, { idempotencyKey: key }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ['notifications'] }); },
  });
}
export function useCancel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      http.post<{ id: number; emailsStopped: number; telegramStopped: number }>(`/announcements/${id}/cancel`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: number) => http.delete(`/announcements/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) });
}
