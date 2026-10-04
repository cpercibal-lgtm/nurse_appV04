// Grant / revoke roles (ported from V03 GrantRoleDrawer + RevokeRoleModal).
// V03 granted roles to employee records and read everything from the browser
// store; V04 grants to login accounts and every rule is enforced by the server
// (R2–R10) — the form only collects input and shows the server's answer.

import { useState } from 'react';
import { Alert, App, Button, DatePicker, Drawer, Form, Input, Modal, Select, Table, Tag } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import type { AppRole, ScopeType } from '../../types/api';
import { useAccounts, useAssignments, useDepartments, useGrant, useRevoke, useUnits, type Assignment } from './api';
import { keyAfterError } from '../../lib/idempotency';

interface GrantForm { userId: number; role: AppRole; scopeType: ScopeType; scopeIds?: number[]; reason: string; expiresAt?: Dayjs }

export function RoleAssignmentsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const assignments = useAssignments();
  const accounts = useAccounts();
  const departments = useDepartments();
  const units = useUnits();
  const grant = useGrant();
  const revoke = useRevoke();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [form] = Form.useForm<GrantForm>();
  const role = Form.useWatch('role', form);
  const scopeType = Form.useWatch('scopeType', form);
  const [revoking, setRevoking] = useState<Assignment | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  const unitName = new Map(units.data?.items.map((u) => [u.id, u.code]));
  const deptName = new Map(departments.data?.items.map((d) => [d.id, d.code]));
  const scopeLabel = (a: Pick<Assignment, 'scopeType' | 'scopeIds'>) =>
    a.scopeType === 'SYSTEM' ? t('systemWide') : a.scopeIds.map((id) => (a.scopeType === 'UNIT' ? unitName : deptName).get(id) ?? `#${id}`).join(', ');

  async function submit(v: GrantForm) {
    try {
      const out = await grant.mutateAsync({
        key,
        body: { userId: v.userId, role: v.role, scopeType: v.scopeType, scopeIds: v.scopeType === 'SYSTEM' ? [] : v.scopeIds ?? [], reason: v.reason, expiresAt: v.expiresAt?.toISOString() },
      });
      if (out.status === 'PENDING_APPROVAL') message.info(t('submittedForApproval', { id: out.requestId }), 6);
      else message.success(t('granted'));
      setOpen(false);
      form.resetFields();
    } catch (e) {
      setKey((k) => keyAfterError(k, e)); // a refusal is not replayed on the next submit
      message.error(describeApiError(e));
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    try {
      await revoke.mutateAsync({ id: revoking.id, reason: revokeReason });
      message.success(t('saved'));
      setRevoking(null);
      setRevokeReason('');
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  const fourEyes = role === 'SYSTEM_ADMIN' || (role === 'HR_ADMIN' && scopeType === 'SYSTEM');

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>{t('grantRole')}</Button>
      </div>
      <Table<Assignment>
        rowKey="id"
        loading={assignments.isLoading}
        dataSource={assignments.data?.items}
        pagination={{ pageSize: 20 }}
        scroll={{ x: true }}
        columns={[
          { title: t('account'), render: (_, a) => `${a.user.displayName} (${a.user.email})` },
          { title: t('role'), render: (_, a) => <Tag color={a.role === 'SYSTEM_ADMIN' ? 'red' : a.role === 'HR_ADMIN' ? 'blue' : 'green'}>{a.role}</Tag> },
          { title: t('scope'), render: (_, a) => scopeLabel(a) },
          { title: t('reason'), dataIndex: 'reason', ellipsis: true },
          { title: t('grantedBy'), render: (_, a) => `${a.grantedBy.displayName} · ${new Date(a.grantedAt).toLocaleDateString()}` },
          { title: t('status'), render: (_, a) => a.revokedAt ? <Tag>{t('revoked')}</Tag> : a.active ? <Tag color="green">{t('active')}</Tag> : <Tag>{t('expired')}</Tag> },
          { title: '', render: (_, a) => a.active ? <Button size="small" danger onClick={() => setRevoking(a)}>{t('revoke')}</Button> : null },
        ]}
      />

      <Drawer title={t('grantRole')} open={open} onClose={() => setOpen(false)} size={520} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ role: 'SUPERVISOR', scopeType: 'UNIT' }}>
          <Form.Item name="userId" label={t('account')} rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={accounts.data?.items.filter((a) => a.isActive && !a.isBreakGlass).map((a) => ({ value: a.id, label: `${a.displayName} — ${a.email}` }))}
            />
          </Form.Item>
          <Form.Item name="role" label={t('role')} rules={[{ required: true }]}>
            <Select options={['SUPERVISOR', 'HR_ADMIN', 'SYSTEM_ADMIN'].map((r) => ({ value: r, label: r }))} />
          </Form.Item>
          <Form.Item name="scopeType" label={t('scopeType')} rules={[{ required: true }]}>
            <Select options={[{ value: 'UNIT', label: t('units') }, { value: 'DEPARTMENT', label: t('departments') }, { value: 'SYSTEM', label: t('systemWide') }]} />
          </Form.Item>
          {scopeType !== 'SYSTEM' && (
            <Form.Item name="scopeIds" label={t('scope')} rules={[{ required: true }]}>
              <Select
                mode="multiple"
                optionFilterProp="label"
                options={scopeType === 'DEPARTMENT'
                  ? departments.data?.items.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))
                  : units.data?.items.map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))}
              />
            </Form.Item>
          )}
          {fourEyes && <Alert type="warning" showIcon title={t('fourEyesWarning')} style={{ marginBottom: 16 }} />}
          <Form.Item name="reason" label={t('reason')} extra={t('reasonGrantHint')} rules={[{ required: true, min: 20, whitespace: true }]}>
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
          <Form.Item name="expiresAt" label={t('expiresAtOptional')}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={grant.isPending}>{t('submit')}</Button>
        </Form>
      </Drawer>

      <Modal
        title={revoking ? `${t('revoke')}: ${revoking.role} — ${revoking.user.displayName}` : ''}
        open={revoking !== null}
        onCancel={() => setRevoking(null)}
        onOk={confirmRevoke}
        okButtonProps={{ danger: true, disabled: revokeReason.trim().length < 10, loading: revoke.isPending }}
        okText={t('revoke')}
        cancelText={t('cancel')}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label={t('reason')} extra={t('revokeReasonHint')}>
            <Input.TextArea rows={3} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
