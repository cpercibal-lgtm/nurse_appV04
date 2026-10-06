// Announcements (D-69): the board everyone reads, and — for senders — their own
// announcements and the compose form; managers also see every announcement in
// their scope. `?id=` opens one (the e-mail button and the bell link here).

import { useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Flex, Input, List, Modal, Popconfirm, Result, Segmented, Select, Table, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { GuideHelp } from '../guidelines/GuideHelp';
import { ComposeDrawer } from './ComposeDrawer';
import {
  KINDS, useAnnouncement, useBoard, useCancel, useDeleteDraft, useManaged, useSent,
  type Announcement, type AnnouncementKind, type AnnouncementStatus,
} from './api';

const KIND_COLOR: Record<AnnouncementKind, string> = { MEMO: 'geekblue', MEETING: 'green', SEMINAR: 'purple' };
const STATUS_COLOR: Record<AnnouncementStatus, string> = { DRAFT: 'default', PENDING_APPROVAL: 'gold', PUBLISHED: 'green', REJECTED: 'red', CANCELLED: 'volcano' };

/** Riyadh time, Gregorian, in the interface language. */
export function useDateFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.language === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB';
  return {
    dateTime: (iso: string) => new Date(iso).toLocaleString(locale, { timeZone: 'Asia/Riyadh', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
    date: (iso: string) => new Date(iso).toLocaleDateString(locale, { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', year: 'numeric' }),
    time: (iso: string) => new Date(iso).toLocaleTimeString(locale, { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hour12: false }),
    /** Same Riyadh day as `other`. */
    sameDay: (iso: string, other: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }) === new Date(other).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }),
  };
}

/** The Arabic text when the interface is Arabic and the sender wrote one. */
function useText(a: Announcement | undefined) {
  const { i18n } = useTranslation();
  if (!a) return null;
  const ar = i18n.language === 'ar';
  return { title: ar && a.titleAr ? a.titleAr : a.title, body: ar && a.bodyAr ? a.bodyAr : a.body, rtl: ar && Boolean(a.bodyAr) };
}

function BoardItem({ a, onOpen }: { a: Announcement; onOpen: () => void }) {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const text = useText(a)!;
  return (
    <List.Item onClick={onOpen} style={{ cursor: 'pointer' }}>
      <List.Item.Meta
        title={<Flex gap={6} align="center" wrap><Tag color={KIND_COLOR[a.kind]}>{t(`annKind_${a.kind}`)}</Tag>
          {a.priority === 'HIGH' && <Tag color="volcano">{t('priority_HIGH')}</Tag>}<Typography.Text strong>{text.title}</Typography.Text></Flex>}
        description={<>
          {a.startsAt && <div>{t('annWhen')}: {fmt.dateTime(a.startsAt)}{a.location ? ` · ${a.location}` : ''}</div>}
          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{text.body}</Typography.Paragraph>
          <div style={{ fontSize: 12, opacity: 0.65 }}>{t('annFrom', { name: a.createdByName ?? '—' })} · {a.publishedAt ? fmt.dateTime(a.publishedAt) : ''}</div>
        </>}
      />
    </List.Item>
  );
}

function Board({ onOpen }: { onOpen: (id: number) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'active' | 'archived'>('active');
  const [kind, setKind] = useState<AnnouncementKind | undefined>();
  const [page, setPage] = useState(1);
  const board = useBoard(state, kind, page);
  return (
    <>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Segmented value={state} onChange={(v) => { setState(v as 'active' | 'archived'); setPage(1); }} options={[{ value: 'active', label: t('annActive') }, { value: 'archived', label: t('annArchived') }]} />
        <Select allowClear placeholder={t('annAllKinds')} value={kind} onChange={(v) => { setKind(v); setPage(1); }} style={{ minWidth: 160 }}
          options={KINDS.map((k) => ({ value: k, label: t(`annKind_${k}`) }))} />
      </Flex>
      <List loading={board.isLoading} dataSource={board.data?.items} locale={{ emptyText: <Empty description={t('annEmpty')} /> }}
        pagination={board.data && board.data.total > 20 ? { current: page, pageSize: 20, total: board.data.total, onChange: setPage } : false}
        renderItem={(a) => <BoardItem key={a.id} a={a} onOpen={() => onOpen(a.id)} />} />
    </>
  );
}

function SentTable({ rows, loading, onOpen, showSender }: { rows: Announcement[] | undefined; loading: boolean; onOpen: (a: Announcement) => void; showSender?: boolean }) {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  return (
    <Table<Announcement> rowKey="id" size="middle" loading={loading} dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }}
      locale={{ emptyText: <Empty description={t('annEmpty')} /> }} onRow={(a) => ({ onClick: () => onOpen(a), style: { cursor: 'pointer' } })}
      columns={[
        { title: t('annTitle'), dataIndex: 'title', render: (v: string, a) => <Flex gap={6} align="center"><Tag color={KIND_COLOR[a.kind]}>{t(`annKind_${a.kind}`)}</Tag>{v}</Flex> },
        { title: t('status'), dataIndex: 'status', width: 170, render: (s: AnnouncementStatus) => <Tag color={STATUS_COLOR[s]}>{t(`annStatus_${s}`)}</Tag> },
        { title: t('annAudience'), dataIndex: 'audienceType', width: 150, render: (v: Announcement['audienceType'], a) => `${t(`annAudience_${v}`)}${a.audienceIds.length ? ` (${a.audienceIds.length})` : ''}` },
        { title: t('annRecipients'), width: 120, render: (_, a) => (a.recipientCount === null ? '—' : `${a.recipientCount}${a.emailOnlyCount ? ` + ${a.emailOnlyCount}` : ''}`) },
        ...(showSender ? [{ title: t('annSender'), dataIndex: 'createdByName', width: 160 }] : []),
        { title: t('annUpdated'), dataIndex: 'updatedAt', width: 180, render: (v: string) => fmt.dateTime(v) },
      ]} />
  );
}

function Detail({ id, onClose, onEdit, onCopy }: { id: number; onClose: () => void; onEdit: (a: Announcement) => void; onCopy: (a: Announcement) => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const fmt = useDateFormat();
  const one = useAnnouncement(id);
  const cancel = useCancel();
  const remove = useDeleteDraft();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const a = one.data;
  const shown = useText(a);

  async function confirmCancel() {
    if (!a) return;
    try {
      const r = await cancel.mutateAsync({ id: a.id, reason: reason.trim() });
      message.success(t('annCancelled', { emails: r.emailsStopped, telegram: r.telegramStopped }));
      setCancelOpen(false);
      void one.refetch();
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <Drawer open onClose={onClose} size={640} title={shown?.title ?? t('announcements')}>
      {one.isError && <Result status="404" subTitle={t('annNotFound')} />}
      {a && shown && (
        <Flex vertical gap={16}>
          {/* In the body, not the header: on a phone the buttons wrap instead of running off the screen. */}
          <Flex gap={8} wrap>
            {a.status === 'DRAFT' && <Button onClick={() => onEdit(a)}>{t('annEdit')}</Button>}
            {a.status === 'DRAFT' && <Popconfirm title={t('annDeleteConfirm')} onConfirm={() => remove.mutateAsync(a.id).then(onClose).catch((e) => message.error(describeApiError(e)))}>
              <Button danger loading={remove.isPending}>{t('annDeleteDraft')}</Button></Popconfirm>}
            {a.status !== 'DRAFT' && a.status !== 'PENDING_APPROVAL' && <CopyButton a={a} onCopy={onCopy} />}
            {a.canCancel && <Button danger onClick={() => { setReason(''); setCancelOpen(true); }}>{t('annCancel')}</Button>}
          </Flex>
          <Flex gap={6} wrap>
            <Tag color={KIND_COLOR[a.kind]}>{t(`annKind_${a.kind}`)}</Tag>
            <Tag color={STATUS_COLOR[a.status]}>{t(`annStatus_${a.status}`)}</Tag>
            {a.priority !== 'LOW' && <Tag>{t(`priority_${a.priority}`)}</Tag>}
          </Flex>
          {a.status === 'CANCELLED' && a.cancelledAt && <Alert type="warning" showIcon title={t('annCancelledBanner', { date: fmt.dateTime(a.cancelledAt), reason: a.cancelReason ?? '' })} />}
          {a.status === 'PENDING_APPROVAL' && <Alert type="info" showIcon title={t('annPendingOk')} />}
          {a.status === 'REJECTED' && <Alert type="error" showIcon title={t('annRejectedHint')} />}
          <Descriptions column={1} size="small" items={[
            ...(a.startsAt ? [{ key: 'w', label: t('annWhen'), children: `${fmt.dateTime(a.startsAt)}${a.endsAt ? ` – ${fmt.sameDay(a.endsAt, a.startsAt) ? fmt.time(a.endsAt) : fmt.dateTime(a.endsAt)}` : ''}` }] : []),
            ...(a.location ? [{ key: 'l', label: t('annLocation'), children: a.location }] : []),
            ...(a.onlineUrl ? [{ key: 'o', label: t('annOnline'), children: <Button type="link" href={a.onlineUrl} target="_blank" rel="noopener noreferrer" style={{ padding: 0 }}>{t('annJoin')}</Button> }] : []),
            ...(a.speaker ? [{ key: 's', label: t('annSpeaker'), children: a.speaker }] : []),
            ...(a.ceHours !== null ? [{ key: 'c', label: t('annCeHours'), children: a.ceHours }] : []),
            ...(a.referenceNo ? [{ key: 'r', label: t('annReferenceNo'), children: a.referenceNo }] : []),
            { key: 'f', label: t('annSender'), children: a.createdByName ?? '—' },
            ...(a.publishedAt ? [{ key: 'p', label: t('annPublished'), children: fmt.dateTime(a.publishedAt) }] : []),
            { key: 'e', label: t('annOnBoardUntil'), children: fmt.date(a.expiresAt) },
            ...(a.recipientCount !== null ? [{ key: 'n', label: t('annRecipients'), children: `${a.recipientCount}${a.emailOnlyCount ? ` + ${a.emailOnlyCount} ${t('annByEmailOnly')}` : ''}` }] : []),
          ]} />
          <Typography.Paragraph dir={shown.rtl ? 'rtl' : undefined} style={{ whiteSpace: 'pre-line', fontSize: 15 }}>{shown.body}</Typography.Paragraph>
        </Flex>
      )}
      <Modal open={cancelOpen} title={t('annCancel')} onCancel={() => setCancelOpen(false)} onOk={confirmCancel} okButtonProps={{ danger: true, disabled: reason.trim().length < 10, loading: cancel.isPending }} okText={t('annCancel')} cancelText={t('back')}>
        <Typography.Paragraph>{t('annCancelHint')}</Typography.Paragraph>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('annCancelReason')} maxLength={1000} />
      </Modal>
    </Drawer>
  );
}

function CopyButton({ a, onCopy }: { a: Announcement; onCopy: (a: Announcement) => void }) {
  const { t } = useTranslation();
  const { hasRole } = usePermissions();
  if (!hasRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR')) return null;
  return <Button onClick={() => onCopy(a)}>{t('annCopy')}</Button>;
}

export default function AnnouncementsPage() {
  const { t } = useTranslation();
  const { hasRole, holdsAssignment } = usePermissions();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('id')) || null;
  const sender = hasRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR');
  const manager = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const [tab, setTab] = useState('board');
  const [compose, setCompose] = useState<{ draft: Announcement | null; copyOf: Announcement | null } | null>(null);
  const sent = useSent(sender && tab === 'sent');
  const managed = useManaged(manager && tab === 'managed');

  const open = (id: number) => setParams({ id: String(id) });
  const close = () => setParams({});
  const edit = (a: Announcement) => { close(); setCompose({ draft: a, copyOf: null }); };
  const copy = (a: Announcement) => { close(); setCompose({ draft: null, copyOf: a }); };

  return (
    <Card title={<>{t('announcements')} <GuideHelp section="announcements" /></>} extra={sender
      ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCompose({ draft: null, copyOf: null })}>{t('annNew')}</Button>
      : null}>
      {!sender && holdsAssignment('SYSTEM_ADMIN') && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('annElevateToSend')} />}
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'board', label: t('annBoard'), children: <Board onOpen={open} /> },
        ...(sender ? [{ key: 'sent', label: t('annSent'), children: <SentTable rows={sent.data?.items} loading={sent.isLoading} onOpen={(a) => (a.status === 'DRAFT' ? setCompose({ draft: a, copyOf: null }) : open(a.id))} /> }] : []),
        ...(manager ? [{ key: 'managed', label: t('annManaged'), children: <SentTable rows={managed.data?.items} loading={managed.isLoading} onOpen={(a) => open(a.id)} showSender /> }] : []),
      ]} />
      {openId !== null && <Detail key={openId} id={openId} onClose={close} onEdit={edit} onCopy={copy} />}
      {compose && <ComposeDrawer open draft={compose.draft} copyOf={compose.copyOf} onClose={() => setCompose(null)} />}
    </Card>
  );
}
