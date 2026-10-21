// Dev Console — simulated SCFHS registry (D-64, System Admin). Until the hospital
// has access to the SCFHS verification service, licence checks are answered from
// these entries: set what "SCFHS" says for a registration number to demonstrate
// each outcome. ERROR simulates SCFHS being unreachable. Synthetic entries only.

import { useState } from 'react';
import { Alert, App, Button, DatePicker, Flex, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useScfhsRegistry, useScfhsRegistryChange, type RegistryEntry, type RegistryStatus } from './api';

const STATUSES: RegistryStatus[] = ['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'ERROR'];
const COLOR: Record<RegistryStatus, string> = { VERIFIED: 'green', EXPIRED: 'orange', SUSPENDED: 'red', REVOKED: 'red', ERROR: 'default' };
type Values = { registrationNumber: string; status: RegistryStatus; expiryDate?: dayjs.Dayjs | null; specialty?: string; note?: string };

export function ScfhsRegistryTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const registry = useScfhsRegistry();
  const change = useScfhsRegistryChange();
  const [editing, setEditing] = useState<RegistryEntry | 'new' | null>(null);
  const [form] = Form.useForm<Values>();
  const driver = registry.data?.driver ?? 'mock';

  function open(e: RegistryEntry | 'new') {
    form.resetFields();
    if (e !== 'new') form.setFieldsValue({ ...e, expiryDate: e.expiryDate ? dayjs(e.expiryDate) : null, specialty: e.specialty ?? undefined, note: e.note ?? undefined });
    setEditing(e);
  }

  async function save(v: Values) {
    try {
      await change.mutateAsync({
        kind: 'set', reg: v.registrationNumber.trim().toUpperCase(),
        body: { status: v.status, expiryDate: v.expiryDate ? v.expiryDate.format('YYYY-MM-DD') : null, specialty: v.specialty?.trim() || null, note: v.note?.trim() || null },
      });
      message.success(t('saved'));
      setEditing(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Alert type={driver === 'mock' ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }} title={t(driver === 'mock' ? 'scfhsRegistryMock' : driver === 'off' ? 'scfhsRegistryOff' : 'scfhsRegistryLive')} />
      <Flex justify="end" style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => open('new')}>{t('scfhsRegistryAdd')}</Button>
      </Flex>
      <Table<RegistryEntry>
        rowKey="registrationNumber" size="small" loading={registry.isLoading} dataSource={registry.data?.items} scroll={{ x: 820 }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: t('scfhsRegistrationNumber'), width: 180, render: (_, r) => <Typography.Text code dir="ltr" style={{ whiteSpace: 'nowrap' }}>{r.registrationNumber}</Typography.Text> },
          { title: t('scfhsAnswer'), width: 150, render: (_, r) => <Tag color={COLOR[r.status]}>{t(`scfhsStatus_${r.status}`)}</Tag> },
          { title: t('expiryDate'), width: 120, render: (_, r) => r.expiryDate ?? '—' },
          { title: t('scfhsSpecialty'), width: 160, render: (_, r) => r.specialty ?? '—' },
          { title: t('note'), width: 200, render: (_, r) => r.note ?? '—' },
          {
            title: '', width: 150, render: (_, r) => (
              <Space size={4}>
                <Button size="small" onClick={() => open(r)}>{t('edit')}</Button>
                <Popconfirm title={t('scfhsRegistryRemoveConfirm')} onConfirm={async () => { try { await change.mutateAsync({ kind: 'remove', reg: r.registrationNumber }); } catch (e) { message.error(describeApiError(e)); } }}>
                  <Button size="small" danger>{t('delete')}</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? t('scfhsRegistryAdd') : t('edit')} onCancel={() => setEditing(null)} onOk={() => form.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={change.isPending} destroyOnHidden forceRender>
        <Form form={form} layout="vertical" onFinish={save} initialValues={{ status: 'VERIFIED' }}>
          <Form.Item name="registrationNumber" label={t('scfhsRegistrationNumber')} rules={[{ required: true, pattern: /^[A-Za-z0-9-]{3,40}$/, message: t('scfhsRegistrationInvalid') }]}>
            <Input dir="ltr" maxLength={40} disabled={editing !== 'new'} placeholder="12-RN-0001" />
          </Form.Item>
          <Form.Item name="status" label={t('scfhsAnswer')} extra={t('scfhsRegistryErrorHint')}>
            <Select options={STATUSES.map((s) => ({ value: s, label: t(`scfhsStatus_${s}`) }))} />
          </Form.Item>
          <Form.Item name="expiryDate" label={t('expiryDate')}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="specialty" label={t('scfhsSpecialty')}><Input maxLength={200} /></Form.Item>
          <Form.Item name="note" label={t('note')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
