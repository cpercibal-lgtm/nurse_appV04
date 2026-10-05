import { useState } from 'react';
import { App, Button, Empty, Flex, Input, Modal, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { describeApiError } from '../../lib/errors';
import { useApprovals, useDecide, useWithdraw, type ApprovalRequest } from './api';

const show = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function describe(r: ApprovalRequest): string {
  const p = r.payload;
  if (p.kind === 'TEMPLATE_CREATE') return `New credential type ${p.template.code} — ${p.template.name} — “${p.reason}”`;
  if (p.kind === 'TEMPLATE_UPDATE') {
    const diff = Object.keys(p.change).map((k) => `${k}: ${show(p.before[k])} → ${show(p.change[k])}`).join('; ');
    return `Change credential type ${p.code}: ${diff} — “${p.reason}”`;
  }
  if (p.kind === 'BASELINE_IMPORT') return `Hospital baseline import — ${p.totals.CREATE} new records (${p.totals.beds} beds, ${p.totals.fields} credential fields), ${p.totals.UNCHANGED} unchanged; file ${p.fileHash.slice(0, 12)} — “${p.reason}”`;
  if (p.kind === 'CATEGORY_CREATE') return `New credential category ${p.category.code} — ${p.category.name} — “${p.reason}”`;
  if (p.kind === 'CATEGORY_UPDATE') {
    const diff = Object.keys(p.change).map((k) => `${k}: ${show(p.before[k])} → ${show(p.change[k])}`).join('; ');
    return `Change credential category ${p.code}: ${diff} — “${p.reason}”`;
  }
  if (p.kind === 'ANNOUNCEMENT') {
    const kind = { MEMO: 'Memo', MEETING: 'Meeting', SEMINAR: 'Seminar' }[p.announcementKind];
    const n = p.audienceIds.length;
    const noun = { DEPARTMENT: ['department', 'departments'], UNIT: ['unit', 'units'], PEOPLE: ['person', 'people'] } as const;
    const audience = p.audienceType === 'HOSPITAL' ? 'the whole hospital' : `${n} ${noun[p.audienceType][n === 1 ? 0 : 1]}`;
    return `${kind} “${p.title}” to ${audience} — ${p.recipients} account(s)${p.emailOnly ? ` + ${p.emailOnly} by e-mail only` : ''} (announcement #${p.announcementId})`;
  }
  if (p.kind === 'GRANT') {
    const g = p.grant;
    return `Grant ${g.role} (${g.scopeType}${g.scopeIds.length ? ` ${g.scopeIds.join(', ')}` : ''}) to account #${g.userId} — “${g.reason}”`;
  }
  return `Change assignment #${p.assignmentId} to ${p.update.scopeType ?? 'same scope'} — “${p.update.reason}”`;
}

export function ApprovalsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const approvals = useApprovals();
  const decide = useDecide();
  const withdraw = useWithdraw();
  const myId = useAuth((s) => s.user?.id);
  const [pending, setPending] = useState<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const [withdrawTarget, setWithdrawTarget] = useState<ApprovalRequest | null>(null);

  async function confirm() {
    if (!pending) return;
    try {
      await decide.mutateAsync({ id: pending.request.id, decision: pending.decision, reason });
      message.success(t('saved'));
      setPending(null);
      setReason('');
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function confirmWithdraw() {
    if (!withdrawTarget) return;
    try {
      await withdraw.mutateAsync({ id: withdrawTarget.id, reason });
      message.success(t('withdrawn'));
      setWithdrawTarget(null);
      setReason('');
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Table<ApprovalRequest>
        rowKey="id"
        loading={approvals.isLoading}
        dataSource={approvals.data?.items}
        locale={{ emptyText: <Empty description={t('noPending')} /> }}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: '#', dataIndex: 'id', width: 60 },
          { title: t('status'), render: (_, r) => <Tag color={r.status === 'PENDING' ? 'orange' : r.status === 'WITHDRAWN' ? 'default' : 'green'}>{t(`approvalStatus_${r.status}`, r.status)}</Tag> },
          { title: t('reason'), render: (_, r) => describe(r) },
          { title: t('initiator'), render: (_, r) => r.initiator.displayName },
          { title: t('requested'), render: (_, r) => new Date(r.createdAt).toLocaleString() },
          {
            // R11: nobody approves or rejects their own request; initiators may withdraw it while pending.
            title: '', render: (_, r) => r.initiatorId === myId ? (
              <Flex gap={8} align="center">
                <Tag>{t('awaitingOtherAdmin')}</Tag>
                {r.status === 'PENDING' && <Button size="small" onClick={() => setWithdrawTarget(r)}>{t('withdraw')}</Button>}
              </Flex>
            ) : (
              <Flex gap={8}>
                <Button size="small" type="primary" onClick={() => setPending({ request: r, decision: 'approve' })}>{t('approve')}</Button>
                <Button size="small" danger onClick={() => setPending({ request: r, decision: 'reject' })}>{t('reject')}</Button>
              </Flex>
            ),
          },
        ]}
      />
      <Modal
        title={pending ? `${t(pending.decision)} #${pending.request.id}` : ''}
        open={pending !== null}
        onCancel={() => setPending(null)}
        onOk={confirm}
        okText={pending ? t(pending.decision) : ''}
        cancelText={t('cancel')}
        okButtonProps={{ danger: pending?.decision === 'reject', disabled: reason.trim().length < 5, loading: decide.isPending }}
        destroyOnHidden
      >
        {pending && <p>{describe(pending.request)}</p>}
        <Input.TextArea rows={3} placeholder={t('decisionReasonHint')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Modal>
      <Modal
        title={withdrawTarget ? `${t('withdraw')} #${withdrawTarget.id}` : ''}
        open={withdrawTarget !== null}
        onCancel={() => setWithdrawTarget(null)}
        onOk={confirmWithdraw}
        okText={t('withdraw')}
        cancelText={t('cancel')}
        okButtonProps={{ danger: true, disabled: reason.trim().length < 5, loading: withdraw.isPending }}
        destroyOnHidden
      >
        {withdrawTarget && <p>{t('withdrawHint')}</p>}
        <Input.TextArea rows={3} placeholder={t('decisionReasonHint')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Modal>
    </>
  );
}
