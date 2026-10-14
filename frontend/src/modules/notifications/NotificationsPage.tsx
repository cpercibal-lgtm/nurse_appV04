// Own notifications (spec §7.1, N2). Email delivery waits for SMTP; these are
// the in-app records every recipient acknowledges for themselves.

import { useState } from 'react';
import { App, Button, Card, Empty, Flex, List, Segmented, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useMarkRead, useNotifications, type NotificationRow } from './api';

import { GuideHelp } from '../guidelines/GuideHelp';
const PRIORITY_COLOR: Record<NotificationRow['priority'], string> = { CRITICAL: 'red', HIGH: 'volcano', MEDIUM: 'blue', LOW: 'default' };

export default function NotificationsPage() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [page, setPage] = useState(1);
  const list = useNotifications(unreadOnly, page);
  const mark = useMarkRead();
  const ar = i18n.language === 'ar';
  const read = (id: number | 'all') => mark.mutateAsync(id).catch((e) => message.error(describeApiError(e)));

  return (
    <Card title={<>{t('notifications')} <GuideHelp section="notifications" /></>} extra={
      <Flex gap={8}>
        <Segmented value={unreadOnly ? 'unread' : 'all'} onChange={(v) => { setUnreadOnly(v === 'unread'); setPage(1); }}
          options={[{ value: 'unread', label: `${t('unread')} (${list.data?.unread ?? 0})` }, { value: 'all', label: t('all') }]} />
        <Button onClick={() => read('all')} disabled={!list.data?.unread} loading={mark.isPending}>{t('markAllRead')}</Button>
      </Flex>
    }>
      <List
        loading={list.isLoading} dataSource={list.data?.items} locale={{ emptyText: <Empty description={t('noNotifications')} /> }}
        pagination={list.data && list.data.total > 50 ? { current: page, pageSize: 50, total: list.data.total, onChange: setPage } : false}
        renderItem={(n) => (
          <List.Item actions={[
            ...(n.announcementId ? [<Link key="o" to={`/announcements?id=${n.announcementId}`} onClick={() => { if (!n.readAt) void read(n.id); }}>{t('annOpen')}</Link>] : []),
            ...(n.eventKey?.startsWith('roster-approval:') ? [<Link key="ro" to="/scheduling" onClick={() => { if (!n.readAt) void read(n.id); }}>{t('rosterOpen')}</Link>] : []),
            ...(n.readAt ? [] : [<Button key="r" size="small" onClick={() => read(n.id)}>{t('markRead')}</Button>]),
          ]}>
            <List.Item.Meta
              title={<Flex gap={6} align="center"><Tag color={PRIORITY_COLOR[n.priority]}>{t(`priority_${n.priority}`)}</Tag>
                <Typography.Text strong={!n.readAt}>{ar && n.titleAr ? n.titleAr : n.title}</Typography.Text></Flex>}
              description={<><span style={{ whiteSpace: 'pre-line' }}>{ar && n.messageAr ? n.messageAr : n.message}</span><div className="meta-text">{new Date(n.createdAt).toLocaleString()}</div></>}
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
