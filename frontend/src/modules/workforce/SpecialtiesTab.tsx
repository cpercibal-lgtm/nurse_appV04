// Nursing Specialty master (owner decision 2026-10-03): hospital-wide HR and System
// Admins add, edit, deactivate, reactivate and delete specialties. Delete removes a
// specialty nobody holds after confirmation; one held by employees is offered for
// deactivation instead. Every change is in the audit log. Everyone else only views.

import { useMemo, useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { ApiError } from '../../services/http';
import { useSpecialtyAction, useSpecialties, type NursingSpecialty } from './api';

type Values = { code: string; name: string; nameAr?: string; description?: string; isActive: boolean; sortOrder: number };
type StatusFilter = 'all' | 'active' | 'inactive';
const optional = (v: string | undefined) => (v?.trim() ? v : undefined);

export function SpecialtiesTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const list = useSpecialties(true);
  const action = useSpecialtyAction();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<NursingSpecialty | 'new' | null>(null);
  const [form] = Form.useForm<Values>();

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list.data?.items ?? [])
      .filter((r) => status === 'all' || (status === 'active') === r.isActive)
      .filter((r) => !s || [r.code, r.name, r.nameAr ?? '', r.description ?? ''].some((f) => f.toLowerCase().includes(s)));
  }, [list.data, q, status]);

  function openForm(row: NursingSpecialty | 'new') {
    form.resetFields();
    if (row === 'new') form.setFieldsValue({ isActive: true, sortOrder: Math.max(0, ...(list.data?.items ?? []).map((r) => r.sortOrder)) + 1 });
    else form.setFieldsValue({ code: row.code, name: row.name, nameAr: row.nameAr ?? undefined, description: row.description ?? undefined, isActive: row.isActive, sortOrder: row.sortOrder });
    setEditing(row);
  }

  async function save(v: Values) {
    try {
      if (editing === 'new') {
        await action.mutateAsync({ kind: 'create', body: { code: v.code, name: v.name, nameAr: optional(v.nameAr), description: optional(v.description), isActive: v.isActive, sortOrder: v.sortOrder } });
      } else if (editing) {
        await action.mutateAsync({ kind: 'update', code: editing.code, version: editing.updatedAt, body: { name: v.name, nameAr: optional(v.nameAr) ?? null, description: optional(v.description) ?? null, isActive: v.isActive, sortOrder: v.sortOrder } });
      }
      message.success(t('saved'));
      setEditing(null);
    } catch (e) {
      // Someone else saved this record first: the list has reloaded; the dialog closes so it reopens with their change.
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); setEditing(null); } else message.error(describeApiError(e));
    }
  }

  const setActive = async (r: NursingSpecialty, isActive: boolean) => {
    try { await action.mutateAsync({ kind: 'update', code: r.code, body: { isActive } }); message.success(t('saved')); } catch (e) { message.error(describeApiError(e)); }
  };

  function confirmDelete(r: NursingSpecialty) {
    modal.confirm({
      title: t('specialtyDeleteConfirm', { code: r.code, name: r.name }), okText: t('delete'), cancelText: t('cancel'), okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await action.mutateAsync({ kind: 'remove', code: r.code });
          message.success(t('specialtyDeleted'));
        } catch (e) {
          if (e instanceof ApiError && e.code === 'SPECIALTY_IN_USE') {
            modal.confirm({
              title: t('specialtyInUseTitle'), content: t('specialtyInUseText'), okText: t('deactivate'), cancelText: t('cancel'), okButtonProps: { danger: true },
              onOk: () => setActive(r, false),
            });
          } else message.error(describeApiError(e));
        }
      },
    });
  }

  return (
    <>
      <Alert type="info" showIcon title={t('specialtyHint')} style={{ marginBottom: 12 }} />
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t('specialtySearch')} style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select<StatusFilter> value={status} onChange={setStatus} style={{ width: 160 }}
          options={[{ value: 'all', label: t('all') }, { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]} />
        {canWrite && <Button type="primary" onClick={() => openForm('new')}>{t('addSpecialty')}</Button>}
      </Flex>
      <Table<NursingSpecialty> rowKey="code" size="small" loading={list.isLoading} dataSource={rows} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('displayOrder'), dataIndex: 'sortOrder', width: 80 },
          { title: t('code'), dataIndex: 'code', width: 90 },
          { title: t('specialtyName'), dataIndex: 'name' },
          { title: t('nameArabic'), render: (_, r) => <span dir="rtl">{r.nameAr ?? '—'}</span> },
          { title: t('description'), dataIndex: 'description', render: (d: string | null) => d ?? '—' },
          { title: t('rankGradeEmployees'), dataIndex: 'employeeCount', width: 90 },
          { title: t('status'), render: (_, r) => <Tag color={r.isActive ? 'green' : 'default'}>{t(r.isActive ? 'active' : 'inactive')}</Tag> },
          ...(canWrite ? [{
            title: '', render: (_: unknown, r: NursingSpecialty) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => openForm(r)}>{t('edit')}</Button>
                {r.isActive
                  ? <Button size="small" onClick={() => setActive(r, false)}>{t('deactivate')}</Button>
                  : <Button size="small" onClick={() => setActive(r, true)}>{t('reactivate')}</Button>}
                <Button size="small" danger onClick={() => confirmDelete(r)}>{t('delete')}</Button>
              </Space>
            ),
          }] : []),
        ]} />

      <Modal title={editing === 'new' ? t('addSpecialty') : t('editSpecialty')} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('save')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="code" label={t('specialtyCode')} extra={editing === 'new' ? t('specialtyCodeHint') : t('specialtyCodeFixed')}
            rules={[{ required: true, whitespace: true }, { pattern: /^\s*[A-Za-z][A-Za-z0-9_]{0,19}\s*$/, message: t('specialtyCodeHint') }]}>
            <Input disabled={editing !== 'new'} maxLength={22} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="name" label={t('specialtyName')} rules={[{ required: true, whitespace: true, message: t('specialtyNameRequired') }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="nameAr" label={t('nameArabic')}><Input maxLength={120} dir="rtl" /></Form.Item>
          <Form.Item name="description" label={t('description')}><Input maxLength={300} /></Form.Item>
          <Flex gap={8}>
            <Form.Item name="isActive" label={t('status')} style={{ flex: 1 }}>
              <Select options={[{ value: true, label: t('active') }, { value: false, label: t('inactive') }]} />
            </Form.Item>
            <Form.Item name="sortOrder" label={t('displayOrder')} rules={[{ required: true }]} style={{ flex: 1 }}><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
          </Flex>
        </Form>
      </Modal>
    </>
  );
}
