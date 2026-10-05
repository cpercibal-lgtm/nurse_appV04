// Eligibility states and emergency waivers (spec §6.1, §6.1.2). The stored
// state is the engine's result; every reason is shown as the engine gave it.

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Form, Input, Modal, Segmented, Select, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useTypeLabels } from '../credentials/labels';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { useCredentialAction, useEligibility, useTemplates, useWaivers, type EligibilityStatus, type StateRow, type Waiver } from '../credentials/api';
import { EligibilityTag, ReasonList } from '../credentials/components';

import { GuideHelp } from '../guidelines/GuideHelp';
const STATUSES: Array<EligibilityStatus | 'ALL'> = ['ALL', 'INELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'ELIGIBLE_WITH_POLICY_WARNING', 'ELIGIBLE'];

export default function EligibilityPage() {
  const { t } = useTranslation();
  const { typeLabel } = useTypeLabels();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  // Spec §6.1.2: only Supervisors and HR Admins issue waivers.
  const canWaive = hasRole('SUPERVISOR', 'HR_ADMIN');
  const ownEmployeeId = useAuth((s) => s.user?.employeeId ?? null);
  const states = useEligibility();
  const waivers = useWaivers();
  const templates = useTemplates();
  const action = useCredentialAction();
  const [filter, setFilter] = useState<EligibilityStatus | 'ALL'>('ALL');
  const [waiving, setWaiving] = useState<StateRow | null>(null);
  const [form] = Form.useForm<{ templateId: number; reason: string; expiresAt: Dayjs }>();

  const rows = states.data?.items.filter((s) => filter === 'ALL' || s.status === filter);
  const blockingTemplates = (s: StateRow) => s.reasons.filter((r) => r.severity === 'BLOCK' && r.templateCode).map((r) => r.templateCode!);

  async function waive(v: { templateId: number; reason: string; expiresAt: Dayjs }) {
    if (!waiving) return;
    try {
      const res = await action.mutateAsync({ kind: 'waiver', body: { employeeId: waiving.employeeId, templateId: v.templateId, reason: v.reason, expiresAt: v.expiresAt.toISOString() } }) as { eligibility: string };
      message.success(t('waiverGranted', { status: res.eligibility }));
      setWaiving(null); form.resetFields();
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <Card title={<>{t('eligibility')} <GuideHelp section="eligibility" /></>}>
      <Segmented style={{ marginBottom: 12 }} value={filter} onChange={(v) => setFilter(v as typeof filter)}
        options={STATUSES.map((s) => ({ value: s, label: s === 'ALL' ? t('all') : t(`elig_${s}`) }))} />
      <Table<StateRow>
        rowKey="employeeId" loading={states.isLoading} dataSource={rows} pagination={{ pageSize: 25 }} scroll={{ x: true }}
        columns={[
          { title: t('employee'), render: (_, s) => `${s.employee.jobNumber} — ${s.employee.fullName}` },
          { title: t('position'), render: (_, s) => s.employee.positionCode },
          { title: t('status'), render: (_, s) => <EligibilityTag status={s.status} /> },
          { title: t('reasons'), render: (_, s) => <ReasonList reasons={s.reasons} /> },
          { title: t('calculated'), render: (_, s) => `${new Date(s.calculatedAt).toLocaleString()} · ${s.updatedByEvent ?? ''}` },
          ...(canWaive ? [{
            title: '', render: (_: unknown, s: StateRow) => blockingTemplates(s).length > 0 && s.employeeId !== ownEmployeeId // nobody waives their own credential
              ? <Button size="small" onClick={() => { form.resetFields(); setWaiving(s); }}>{t('grantWaiver')}</Button> : null,
          }] : []),
        ]}
      />

      <Card size="small" title={t('waivers')} style={{ marginTop: 16 }}>
        <Table<Waiver>
          rowKey="id" size="small" loading={waivers.isLoading} dataSource={waivers.data?.items} pagination={{ pageSize: 10 }} scroll={{ x: true }}
          columns={[
            { title: t('employee'), render: (_, w) => `${w.employee.jobNumber} — ${w.employee.fullName}` },
            { title: t('credential'), render: (_, w) => typeLabel(w.template) },
            { title: t('reason'), dataIndex: 'reason', ellipsis: true },
            { title: t('expires'), render: (_, w) => new Date(w.expiresAt).toLocaleString() },
            { title: t('status'), render: (_, w) => <Tag color={w.active ? 'gold' : 'default'}>{w.active ? t('active') : t('expired')}</Tag> },
          ]}
        />
      </Card>

      <Modal title={waiving ? `${t('grantWaiver')}: ${waiving.employee.fullName}` : ''} open={waiving !== null} onCancel={() => setWaiving(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden>
        <Alert type="warning" showIcon title={t('waiverHint')} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" onFinish={waive} initialValues={{ expiresAt: dayjs().add(24, 'hour') }}>
          <Form.Item name="templateId" label={t('credential')} rules={[{ required: true }]}>
            <Select options={waiving ? templates.data?.items.filter((x) => blockingTemplates(waiving).includes(x.code)).map((x) => ({ value: x.id, label: typeLabel(x) })) : []} />
          </Form.Item>
          <Form.Item name="reason" label={t('clinicalJustification')} rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
          <Form.Item name="expiresAt" label={t('expires')} rules={[{ required: true }]}>
            <DatePicker showTime style={{ width: '100%' }} disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(dayjs().add(72, 'hour'), 'day')} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
