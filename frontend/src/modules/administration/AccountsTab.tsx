import { useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useAuth } from '../../hooks/useAuth';
import { ApiError, http } from '../../services/http';
import { useAccounts, useCreateAccount, useUpdateAccount, type Account } from './api';
import type { TelegramLinkOffer as Offer } from '../../types/api';
import { TelegramLinkOffer } from '../auth/telegram/TelegramLinkOffer';
import { keyAfterError } from '../../lib/idempotency';

interface NewAccount { email: string; displayName: string; password: string; employeeId?: number }

export function AccountsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const me = useAuth((s) => s.user);
  const [q, setQ] = useState('');
  const accounts = useAccounts(q);
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const [open, setOpen] = useState(false);
  // One key per form opening: a retried submit is applied once by the server.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [form] = Form.useForm<NewAccount>();
  // D-66: a Telegram link HR shows the person as a QR code (15 minutes, single use).
  const [telegramOffer, setTelegramOffer] = useState<{ email: string; offer: Offer } | null>(null);
  // D-67: HR starts a sign-in e-mail change; it applies when the person opens the link in the new mailbox.
  const [emailFor, setEmailFor] = useState<Account | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailForm] = Form.useForm<{ newEmail: string }>();

  async function changeEmail(v: { newEmail: string }) {
    if (!emailFor) return;
    setEmailBusy(true);
    try {
      const out = await http.post<{ pendingEmail: string }>(`/users/${emailFor.id}/email`, { newEmail: v.newEmail.trim() });
      message.success(t('emailChangeSentFor', { email: out.pendingEmail }));
      setEmailFor(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'EMAIL_IN_USE' || code === 'EMAIL_UNCHANGED') emailForm.setFields([{ name: 'newEmail', errors: [(e as ApiError).message] }]);
      else message.error(describeApiError(e));
    } finally {
      setEmailBusy(false);
    }
  }

  async function telegramLink(a: Account) {
    try {
      setTelegramOffer({ email: a.email, offer: await http.post<Offer>(`/users/${a.id}/telegram/link`) });
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function submit(values: NewAccount) {
    try {
      await create.mutateAsync({ body: { ...values, employeeId: values.employeeId ?? null }, key });
      message.success(t('saved'));
      setOpen(false);
      form.resetFields();
    } catch (e) {
      setKey((k) => keyAfterError(k, e)); // a refusal is not replayed on the next submit
      message.error(describeApiError(e));
    }
  }

  async function toggle(a: Account) {
    try {
      await update.mutateAsync({ id: a.id, body: { isActive: !a.isActive } });
      message.success(t('saved'));
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  // D-50: the link goes to the account's own e-mail; HR confirms who is asking first.
  async function sendReset(a: Account) {
    try {
      const out = await http.post<{ email: string }>(`/users/${a.id}/password-reset`);
      message.success(t('resetLinkSent', { email: out.email }));
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  // Spec §3.5: a lost phone. The authenticator is removed and the account signed out; a new one is set up at the next sign-in.
  async function resetMfa(a: Account) {
    try {
      await http.post(`/users/${a.id}/mfa/reset`);
      message.success(t('mfaResetDone', { email: a.email }));
      await accounts.refetch();
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Space wrap>
          <Button type="primary" onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>{t('newAccount')}</Button>
          <Input.Search allowClear placeholder={t('searchEmailOrName')} style={{ width: 280 }} onSearch={(v) => setQ(v.trim())} />
        </Space>
      </div>
      <Table<Account>
        rowKey="id"
        loading={accounts.isLoading}
        dataSource={accounts.data?.items}
        pagination={{ pageSize: 20 }}
        scroll={{ x: true }}
        columns={[
          { title: t('email'), dataIndex: 'email' },
          { title: t('displayName'), dataIndex: 'displayName' },
          { title: t('linkedEmployee'), render: (_, a) => a.employee ? `${a.employee.jobNumber} — ${a.employee.fullName}` : '—' },
          { title: t('roleAssignments'), render: (_, a) => a.isBreakGlass ? <Tag color="red">BREAK-GLASS</Tag> : a.roleAssignments.map((r) => <Tag key={`${r.role}${r.scopeType}`}>{r.role} · {r.scopeType}</Tag>) },
          { title: t('status'), render: (_, a) => <Tag color={a.isActive ? 'green' : 'default'}>{a.isActive ? t('active') : t('inactive')}</Tag> },
          { title: t('mfaColumn'), render: (_, a) => a.isBreakGlass ? '—' : <Tag color={a.mfaEnabled ? 'green' : 'default'}>{a.mfaEnabled ? t('mfaOn') : t('mfaOff')}</Tag> },
          { title: t('telegram'), render: (_, a) => a.isBreakGlass ? '—' : <Tag color={a.telegramLinked ? 'green' : 'default'}>{a.telegramLinked ? t('telegramLinked') : t('telegramNotLinked')}</Tag> },
          { title: t('lastLogin'), render: (_, a) => a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : t('never') },
          {
            title: '', render: (_, a) => a.isBreakGlass || a.id === me?.id ? null : (
              <Space>
                {a.isActive && (
                  <Popconfirm title={t('sendResetLink')} description={a.email} onConfirm={() => sendReset(a)}>
                    <Button size="small">{t('sendResetLink')}</Button>
                  </Popconfirm>
                )}
                {a.isActive && <Button size="small" onClick={() => void telegramLink(a)}>{t('telegramLinkFor')}</Button>}
                {a.isActive && <Button size="small" onClick={() => { emailForm.resetFields(); setEmailFor(a); }}>{t('changeEmail')}</Button>}
                {a.mfaEnabled && (
                  <Popconfirm title={t('resetMfa')} description={<div style={{ maxWidth: 320 }}>{t('resetMfaConfirm')}</div>} onConfirm={() => resetMfa(a)}>
                    <Button size="small">{t('resetMfa')}</Button>
                  </Popconfirm>
                )}
                <Popconfirm title={a.isActive ? t('deactivate') : t('activate')} onConfirm={() => toggle(a)}>
                  <Button size="small" danger={a.isActive}>{a.isActive ? t('deactivate') : t('activate')}</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Drawer title={t('newAccount')} open={open} onClose={() => setOpen(false)} size={480} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="email" label={t('email')} rules={[{ required: true, type: 'email' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item name="displayName" label={t('displayName')} rules={[{ required: true, max: 120 }]}><Input /></Form.Item>
          <Form.Item name="password" label={t('initialPassword')} extra={t('passwordRule')} rules={[{ required: true, min: 12, max: 72 }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="employeeId" label={t('employeeIdOptional')}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>{t('create')}</Button>
        </Form>
      </Drawer>
      <Modal open={telegramOffer !== null} footer={null} title={`${t('telegramLinkFor')} — ${telegramOffer?.email ?? ''}`}
        onCancel={() => { setTelegramOffer(null); void accounts.refetch(); }} destroyOnHidden>
        {telegramOffer && <TelegramLinkOffer offer={telegramOffer.offer} />}
      </Modal>
      <Modal open={emailFor !== null} title={`${t('changeEmail')} — ${emailFor?.email ?? ''}`} onCancel={() => setEmailFor(null)}
        onOk={() => emailForm.submit()} okText={t('emailChangeSend')} cancelText={t('cancel')} confirmLoading={emailBusy} destroyOnHidden>
        <Alert type="info" showIcon title={t('emailChangeAssistedHow')} style={{ marginBottom: 12 }} />
        <Form form={emailForm} layout="vertical" requiredMark={false} onFinish={changeEmail}>
          <Form.Item name="newEmail" label={t('newEmail')} normalize={(v: string) => v.trim()}
            rules={[{ required: true, message: t('fieldRequired') }, { type: 'email', message: t('emailInvalid') }]}>
            <Input dir="ltr" autoComplete="off" inputMode="email" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
