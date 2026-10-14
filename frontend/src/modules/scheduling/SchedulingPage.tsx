// Roster board (spec §6.2, §6.3). Supervisors and Nursing Admins draft, ask the
// Nursing Director for approval and publish (D-14, D-71); the Nursing Director
// approves; HR and System Admins read. Every eligibility tag is the server's
// live engine result for the shift date; publication re-checks all of them.
// Employees see their own and their home unit's published shifts (S2).

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Empty, Flex, Input, List, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { useUnits } from '../administration/api';
import { EligibilityTag, ReasonList } from '../credentials/components';
import { SHIFTS, type ShiftType } from '../workforce/api';
import { useApprovals, useBoard, useOwnRoster, usePool, useRosterAction, type Assignment, type GenerateResult, type OwnShift, type PublishResult, type RosterApproval } from './api';

import { GuideHelp } from '../guidelines/GuideHelp';
const ELIG_COLOR = { ELIGIBLE: 'green', ELIGIBLE_WITH_POLICY_WARNING: 'orange', ELIGIBLE_WITH_GRACE: 'gold', INELIGIBLE: 'red' } as const;

function OwnSchedule() {
  const { t } = useTranslation();
  const from = dayjs().format('YYYY-MM-DD');
  const to = dayjs().add(27, 'day').format('YYYY-MM-DD');
  const roster = useOwnRoster(from, to, true);
  const cols: ColumnsType<OwnShift> = [
    { title: t('date'), dataIndex: 'shiftDate' }, { title: t('shift'), render: (_, r) => t(`shift_${r.shiftType}`) },
    { title: t('unit'), dataIndex: 'unitCode' }, { title: t('notes'), dataIndex: 'notes' },
  ];
  return (
    <Card title={<>{t('scheduling')} <GuideHelp section="scheduling" task="own-roster" /></>}>
      <Typography.Title level={5}>{t('myShifts')}</Typography.Title>
      <Table rowKey="id" size="small" loading={roster.isLoading} dataSource={roster.data?.own} pagination={false} columns={cols} />
      <Typography.Title level={5} style={{ marginTop: 16 }}>{t('homeUnitSchedule')}</Typography.Title>
      <Table rowKey="id" size="small" loading={roster.isLoading} dataSource={roster.data?.homeUnit} pagination={{ pageSize: 30 }}
        columns={[{ title: t('employee'), render: (_, r) => `${r.jobNumber} — ${r.fullName}` }, ...cols]} />
    </Card>
  );
}

export default function SchedulingPage() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const { hasRole } = usePermissions();
  const staff = hasRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR');
  const canWrite = hasRole('SUPERVISOR', 'NURSING_ADMIN'); // D-14, D-71: prepare, ask for approval, publish
  const canApprove = hasRole('NURSING_DIRECTOR'); // D-71
  const units = useUnits();
  const [unitId, setUnitId] = useState<number>();
  const [weekStart, setWeekStart] = useState(dayjs().startOf('day'));
  const from = weekStart.format('YYYY-MM-DD');
  const to = weekStart.add(6, 'day').format('YYYY-MM-DD');
  const board = useBoard(unitId, from, to);
  const approvals = useApprovals(unitId);
  const action = useRosterAction();
  const [slot, setSlot] = useState<{ unitId: number; date: string; shiftType: ShiftType } | null>(null);
  const pool = usePool(slot);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);

  if (!staff) return <OwnSchedule />;

  const days = Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day').format('YYYY-MM-DD'));
  const cell = (date: string, s: ShiftType) => board.data?.assignments.filter((a) => a.shiftDate === date && a.shiftType === s) ?? [];
  const cov = (date: string, s: ShiftType) => board.data?.coverage.find((c) => c.date === date && c.shiftType === s);
  // D-71: what the Nursing Director has said about the dates on screen.
  const items = approvals.data?.items ?? [];
  const covering = items.find((a) => a.status === 'Approved' && a.from <= from && a.to >= to);
  const pending = items.find((a) => a.status === 'Pending' && a.from <= to && a.to >= from);
  const rejected = !covering && !pending ? items.find((a) => a.status === 'Rejected' && a.from <= to && a.to >= from) : undefined;
  const draftCount = board.data?.assignments.filter((a) => a.status === 'Draft').length ?? 0;

  async function run<T>(a: Parameters<typeof action.mutateAsync>[0]): Promise<T | undefined> {
    try { return (await action.mutateAsync(a)) as T; } catch (e) { message.error(describeApiError(e)); return undefined; }
  }

  async function assign(employeeId: number) {
    if (!slot) return;
    const out = await run<{ eligibility: { status: string } }>({ kind: 'assign', body: { employeeId, unitId: slot.unitId, shiftDate: slot.date, shiftType: slot.shiftType } });
    if (out) { message.success(t('draftAdded', { status: t(`elig_${out.eligibility.status}`) })); setSlot(null); }
  }

  function remove(a: Assignment) {
    let reason = '';
    modal.confirm({
      title: a.status === 'Draft' ? t('removeDraft') : t('cancelShift'),
      content: a.status === 'Published' ? <Input.TextArea rows={2} placeholder={t('decisionReasonHint')} onChange={(e) => { reason = e.target.value; }} /> : `${a.fullName} · ${a.shiftDate} · ${t(`shift_${a.shiftType}`)}`,
      okButtonProps: { danger: true }, okText: t('submit'), cancelText: t('cancel'),
      onOk: async () => { if (await run({ kind: 'remove', id: a.id, reason: reason || undefined }) !== undefined) message.success(t('saved')); },
    });
  }

  async function publish() {
    if (!unitId) return;
    const out = await run<PublishResult>({ kind: 'publish', body: { unitId, from, to }, key: crypto.randomUUID() });
    if (!out) return;
    modal[out.blocked.length ? 'warning' : 'success']({
      title: t('publishResult', { published: out.published, blocked: out.blocked.length }), width: 640,
      content: (
        <>
          {out.reliedOnGraceOrWaiver.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} title={t('reliedOnGraceOrWaiver', { count: out.reliedOnGraceOrWaiver.length })} />}
          <List size="small" dataSource={out.blocked} renderItem={(b) => (
            <List.Item>{b.shiftDate} · {t(`shift_${b.shiftType}`)} · {b.jobNumber} {b.fullName}: {b.reasons.map((r) => r.code).join(', ')}</List.Item>
          )} />
        </>
      ),
    });
  }

  async function ask() {
    if (!unitId) return;
    if (await run({ kind: 'ask', body: { unitId, from, to } }) !== undefined) message.success(t('approvalAsked'));
  }

  async function approve(a: RosterApproval) {
    if (await run({ kind: 'decide', id: a.id, decision: 'approve' }) !== undefined) message.success(t('saved'));
  }

  function rejectRequest(a: RosterApproval) {
    let note = '';
    modal.confirm({
      title: t('reject'), content: <Input.TextArea rows={2} placeholder={t('decisionReasonHint')} onChange={(e) => { note = e.target.value; }} />,
      okButtonProps: { danger: true }, okText: t('reject'), cancelText: t('cancel'),
      onOk: async () => { if (await run({ kind: 'decide', id: a.id, decision: 'reject', note }) !== undefined) message.success(t('saved')); },
    });
  }

  async function generate(dryRun: boolean) {
    if (!unitId) return;
    const out = await run<GenerateResult>({ kind: 'generate', body: { unitId, from, to, dryRun } });
    if (!out) return;
    if (dryRun) setGenerated(out); else { setGenerated(null); message.success(t('draftsCreated', { count: out.proposed.length })); }
  }

  return (
    <Card title={<>{t('scheduling')} <GuideHelp section="scheduling" /></>}>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Select aria-label={t('unit')} placeholder={t('unit')} style={{ width: 280 }} showSearch optionFilterProp="label" value={unitId} onChange={setUnitId}
          options={(units.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))} />
        <Button onClick={() => setWeekStart(weekStart.subtract(7, 'day'))}>‹</Button>
        <DatePicker value={weekStart} allowClear={false} onChange={(d) => d && setWeekStart(d.startOf('day'))} />
        <Button onClick={() => setWeekStart(weekStart.add(7, 'day'))}>›</Button>
        {canWrite && unitId && (
          <Space>
            <Button onClick={() => generate(true)} loading={action.isPending}>{t('autoFill')}</Button>
            <Tooltip title={covering ? undefined : t('approvalNeeded')}>
              <Button onClick={ask} loading={action.isPending} disabled={draftCount === 0 || pending !== undefined || covering !== undefined}>{t('askApproval')}</Button>
            </Tooltip>
            <Tooltip title={covering ? undefined : t('approvalNeeded')}>
              <Button type="primary" onClick={publish} loading={action.isPending} disabled={!covering}>{t('publishWeek')}</Button>
            </Tooltip>
          </Space>
        )}
      </Flex>
      {!canWrite && !canApprove && <Alert type="info" showIcon title={t('rosterReadOnly')} style={{ marginBottom: 12 }} />}
      {unitId && covering && <Alert type="success" showIcon style={{ marginBottom: 12 }} title={t('approvalApprovedMsg', { name: covering.decidedBy?.name ?? '—', from: covering.from, to: covering.to })} />}
      {unitId && pending && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={t('approvalPendingMsg', { name: pending.requestedBy.name ?? '—', from: pending.from, to: pending.to })}
          action={canApprove ? (
            <Space>
              <Button size="small" type="primary" onClick={() => approve(pending)} loading={action.isPending}>{t('approve')}</Button>
              <Button size="small" danger onClick={() => rejectRequest(pending)}>{t('reject')}</Button>
            </Space>
          ) : undefined} />
      )}
      {unitId && rejected && <Alert type="error" showIcon style={{ marginBottom: 12 }} title={t('approvalRejectedMsg', { name: rejected.decidedBy?.name ?? '—', note: rejected.note ?? '' })} />}
      {board.error && <Alert type="error" showIcon title={describeApiError(board.error)} style={{ marginBottom: 12 }} />}
      {!unitId ? <Empty description={t('chooseUnit')} /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ padding: 6 }} />
                {days.map((d) => <th key={d} style={{ padding: 6, textAlign: 'start' }}>{dayjs(d).format('ddd DD MMM')}</th>)}
              </tr>
            </thead>
            <tbody>
              {SHIFTS.map((s) => (
                <tr key={s}>
                  <th style={{ padding: 6, textAlign: 'start', verticalAlign: 'top' }}>{t(`shift_${s}`)}</th>
                  {days.map((d) => {
                    const c = cov(d, s);
                    return (
                      <td key={d} style={{ border: '1px solid var(--ant-color-border-secondary, #eee)', padding: 6, verticalAlign: 'top', minWidth: 130 }}>
                        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>
                          {c?.target === null || c?.target === undefined ? t('targetNotSet') : `${c.published.eligible}/${c.target}`}
                          {c && c.draft.total > 0 && ` · ${t('draftCount', { count: c.draft.total })}`}
                          {c?.publishedShortage ? <Tag color="orange" style={{ marginInlineStart: 4 }}>−{c.publishedShortage}</Tag> : null}
                        </div>
                        <Flex vertical gap={2}>
                          {cell(d, s).map((a) => (
                            <Tooltip key={a.id} title={<ReasonList reasons={a.eligibility.reasons} />}>
                              <Tag color={ELIG_COLOR[a.eligibility.status]} style={{ cursor: canWrite ? 'pointer' : 'default', borderStyle: a.status === 'Draft' ? 'dashed' : 'solid', marginInlineEnd: 0 }}
                                onClick={() => canWrite && remove(a)}>
                                {a.fullName}{a.status === 'Draft' ? ` · ${t('draft')}` : ''}
                              </Tag>
                            </Tooltip>
                          ))}
                          {canWrite && d >= dayjs().format('YYYY-MM-DD') && <Button size="small" type="dashed" onClick={() => setSlot({ unitId, date: d, shiftType: s })}>+</Button>}
                        </Flex>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title={slot ? `${t('assignNurse')} · ${slot.date} · ${t(`shift_${slot.shiftType}`)}` : ''} open={slot !== null} onCancel={() => setSlot(null)} footer={null} width={720} destroyOnHidden>
        <Table rowKey="id" size="small" loading={pool.isLoading} dataSource={pool.data?.items} pagination={{ pageSize: 10 }}
          columns={[
            { title: t('employee'), render: (_, r) => `${r.jobNumber} — ${r.fullName}` },
            { title: t('position'), dataIndex: 'positionCode' },
            { title: t('eligibility'), render: (_, r) => <><EligibilityTag status={r.eligibility.status} /><ReasonList reasons={r.eligibility.reasons} /></> },
            { title: t('sameDay'), render: (_, r) => r.shiftsThatDay.map((x) => t(`shift_${x}`)).join(', ') || '—' },
            { title: '', render: (_, r) => <Button size="small" onClick={() => assign(r.id)} loading={action.isPending}>{t('assign')}</Button> },
          ]} />
      </Modal>

      <Modal title={t('autoFill')} open={generated !== null} onCancel={() => setGenerated(null)} width={680} destroyOnHidden
        okText={t('createDrafts', { count: generated?.proposed.length ?? 0 })} cancelText={t('cancel')} onOk={() => generate(false)}
        okButtonProps={{ disabled: !generated?.proposed.length, loading: action.isPending }}>
        <Alert type="info" showIcon title={t('autoFillHint')} style={{ marginBottom: 8 }} />
        {generated && generated.targetsMissing.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} title={t('targetsMissing', { shifts: generated.targetsMissing.map((s) => t(`shift_${s}`)).join(', ') })} />}
        <List size="small" header={t('proposed')} dataSource={generated?.proposed ?? []} style={{ maxHeight: 240, overflow: 'auto' }}
          renderItem={(p) => <List.Item>{p.date} · {t(`shift_${p.shiftType}`)} · {p.jobNumber} {p.fullName}</List.Item>} />
        {generated && generated.unfilled.length > 0 && (
          <List size="small" header={t('unfilled')} dataSource={generated.unfilled} style={{ maxHeight: 160, overflow: 'auto' }}
            renderItem={(u) => <List.Item>{u.date} · {t(`shift_${u.shiftType}`)} · {u.have}/{u.target}</List.Item>} />
        )}
      </Modal>
    </Card>
  );
}
