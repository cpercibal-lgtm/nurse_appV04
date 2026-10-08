// Employment contract types (owner decision 2026-10-03): system-wide HR and
// System Admins add, edit and delete them. Delete removes an unused type and
// deactivates a used one (the server decides and says which); an inactive type
// can be switched back on by editing it.

import { useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Space, Switch, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { useContractTypeAction, useContractTypes, type ContractType } from './api';

type Values = { code: string; name: string; nameAr?: string; displayOrder: number; isActive: boolean };

export function ContractTypesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const types = useContractTypes(true, open);
  const action = useContractTypeAction();
  const [editing, setEditing] = useState<ContractType | 'new' | null>(null);
  const [form] = Form.useForm<Values>();

  function openForm(row: ContractType | 'new') {
    form.resetFields();
    if (row !== 'new') form.setFieldsValue({ code: row.code, name: row.name, nameAr: row.nameAr ?? undefined, displayOrder: row.displayOrder, isActive: row.isActive });
    else form.setFieldsValue({ displayOrder: (types.data?.items.length ?? 0) + 1, isActive: true });
    setEditing(row);
  }

  async function save(v: Values) {
    try {
      if (editing === 'new') {
        await action.mutateAsync({ kind: 'create', body: { code: v.code, name: v.name, ...(v.nameAr ? { nameAr: v.nameAr } : {}), displayOrder: v.displayOrder } });
      } else if (editing) {
        await action.mutateAsync({ kind: 'update', code: editing.code, version: editing.updatedAt, body: { name: v.name, nameAr: v.nameAr || null, displayOrder: v.displayOrder, isActive: v.isActive } });
      }
      message.success(t('saved'));
      setEditing(null);
    } catch (e) {
      // Someone else saved this record first: the list has reloaded; the dialog closes so it reopens with their change.
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); setEditing(null); } else message.error(describeApiError(e));
    }
  }

  async function remove(row: ContractType) {
    try {
      const out = await action.mutateAsync({ kind: 'remove', code: row.code }) as { outcome: 'DELETED' | 'DEACTIVATED'; contractCount: number };
      if (out.outcome === 'DELETED') message.success(t('contractTypeDeleted'));
      else message.info(t('contractTypeDeactivated', { count: out.contractCount }));
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <Drawer title={t('contractTypes')} open={open} onClose={onClose} size={720} destroyOnHidden
      extra={<Button type="primary" onClick={() => openForm('new')}>{t('addContractType')}</Button>}>
      <Alert type="info" showIcon title={t('contractTypesHint')} style={{ marginBottom: 12 }} />
      <Table<ContractType> rowKey="code" size="small" pagination={false} loading={types.isLoading} dataSource={types.data?.items} scroll={{ x: true }}
        columns={[
          { title: t('displayOrder'), dataIndex: 'displayOrder', width: 70 },
          { title: t('code'), dataIndex: 'code' },
          { title: t('name'), dataIndex: 'name' },
          { title: t('nameArabic'), render: (_, r) => <span dir="rtl">{r.nameAr ?? '—'}</span> },
          { title: t('contractsUsing'), dataIndex: 'contractCount', width: 80 },
          { title: t('status'), render: (_, r) => <Tag color={r.isActive ? 'green' : 'default'}>{t(r.isActive ? 'active' : 'inactive')}</Tag> },
          {
            title: '', render: (_, r) => (
              <Space size={4}>
                <Button size="small" onClick={() => openForm(r)}>{t('edit')}</Button>
                {(r.isActive || r.contractCount === 0) && (
                  <Popconfirm title={t('contractTypeDeleteConfirm')} onConfirm={() => remove(r)} okButtonProps={{ danger: true }}>
                    <Button size="small" danger>{t('delete')}</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]} />

      <Modal title={editing === 'new' ? t('addContractType') : t('editContractType')} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="code" label={t('code')} extra={editing === 'new' ? t('contractTypeCodeHint') : undefined}
            rules={[{ required: true }, { pattern: /^[A-Za-z][A-Za-z0-9_]{0,19}$/, message: t('contractTypeCodeHint') }]}>
            <Input disabled={editing !== 'new'} maxLength={20} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="nameAr" label={t('nameArabic')}><Input maxLength={120} dir="rtl" /></Form.Item>
          <Form.Item name="displayOrder" label={t('displayOrder')} rules={[{ required: true }]}><InputNumber min={0} precision={0} style={{ width: 120 }} /></Form.Item>
          {editing !== 'new' && <Form.Item name="isActive" label={t('active')} valuePropName="checked"><Switch /></Form.Item>}
        </Form>
      </Modal>
    </Drawer>
  );
}
