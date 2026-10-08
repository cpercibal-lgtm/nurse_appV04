// Facility master (owner decision 2026-10-03): the list with Add, Edit, Deactivate /
// Reactivate and Delete, used inside Manage Facilities (beside the onboarding field) and
// on Workforce -> Facilities. Delete confirms with the name; a facility employees use
// cannot be deleted, so Deactivate is offered instead. The server checks the
// permissions and the duplicate names; this screen reports what it says.

import { useMemo, useState } from 'react';
import { App, Button, Flex, Form, Input, Modal, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { ApiError } from '../../services/http';
import { useFacilities, useFacilityAction, type Facility } from './api';

/** Trimmed, repeated spaces collapsed — the same rule as the server, for the duplicate check. */
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

export interface FacilityEvents {
  onCreated?: (f: Facility) => void;
  /** A facility was deleted or deactivated: a form holding it unsaved must choose another. */
  onWithdrawn?: (id: number) => void;
}

export function FacilitiesManager({ canWrite, onCreated, onWithdrawn }: { canWrite: boolean } & FacilityEvents) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const list = useFacilities(true);
  const action = useFacilityAction();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Facility | 'new' | null>(null);
  const [form] = Form.useForm<{ name: string; nameAr?: string }>();
  const all = list.data?.items ?? [];
  const rows = useMemo(() => {
    const s = tidy(q).toLowerCase();
    return all.filter((f) => !s || f.name.toLowerCase().includes(s) || (f.nameAr ?? '').includes(s));
  }, [all, q]);

  const open = (f: Facility | 'new') => {
    form.resetFields();
    if (f !== 'new') form.setFieldsValue({ name: f.name, nameAr: f.nameAr ?? undefined });
    setEditing(f);
  };

  async function save(v: { name: string; nameAr?: string }) {
    try {
      if (editing === 'new') {
        const created = await action.mutateAsync({ kind: 'create', body: { name: tidy(v.name), ...(v.nameAr?.trim() ? { nameAr: v.nameAr } : {}) } }) as Facility;
        message.success(t('facilityAdded', { name: created.name }));
        onCreated?.(created);
      } else if (editing) {
        await action.mutateAsync({ kind: 'update', id: editing.id, version: editing.updatedAt, body: { name: tidy(v.name), nameAr: v.nameAr?.trim() ? v.nameAr : null } });
        message.success(t('saved'));
      }
      setEditing(null);
    } catch (e) {
      // Someone else saved this record first: the list has reloaded; the dialog closes so it reopens with their change.
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); setEditing(null); } else message.error(describeApiError(e));
    }
  }

  const setActive = async (f: Facility, isActive: boolean) => {
    try {
      await action.mutateAsync({ kind: 'update', id: f.id, body: { isActive } });
      message.success(t('saved'));
      if (!isActive) onWithdrawn?.(f.id);
    } catch (e) { message.error(describeApiError(e)); }
  };

  const confirmDelete = (f: Facility) => modal.confirm({
    title: t('facilityDeleteConfirm', { name: f.name }), okText: t('delete'), cancelText: t('cancel'), okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await action.mutateAsync({ kind: 'remove', id: f.id });
        message.success(t('facilityDeleted', { name: f.name }));
        onWithdrawn?.(f.id);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'FACILITY_IN_USE') {
          modal.confirm({
            title: t('facilityInUseTitle', { name: f.name }), content: t('facilityInUseText'), okText: t('deactivate'), cancelText: t('cancel'),
            okButtonProps: { danger: true }, onOk: () => setActive(f, false),
          });
        } else message.error(describeApiError(e));
      }
    },
  });

  // Same rule as the server, so a duplicate is reported before saving.
  const duplicate = (_: unknown, value: string) => {
    const name = tidy(value ?? '').toLowerCase();
    const clash = all.find((f) => f.name.toLowerCase() === name && (editing === 'new' || f.id !== editing?.id));
    return clash ? Promise.reject(new Error(t('facilityDuplicate', { name: clash.name }))) : Promise.resolve();
  };

  return (
    <>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t('facilitySearch')} style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
        {canWrite && <Button type="primary" onClick={() => open('new')}>{t('addFacility')}</Button>}
      </Flex>
      <Table<Facility> rowKey="id" size="small" loading={list.isLoading} dataSource={rows} pagination={false} scroll={{ x: true, y: 420 }}
        columns={[
          { title: t('facilityName'), dataIndex: 'name' },
          { title: t('nameArabic'), render: (_, f) => <span dir="rtl">{f.nameAr ?? '—'}</span> },
          { title: t('rankGradeEmployees'), dataIndex: 'employeeCount', width: 90 },
          { title: t('status'), width: 100, render: (_, f) => <Tag color={f.isActive ? 'green' : 'default'}>{t(f.isActive ? 'active' : 'inactive')}</Tag> },
          ...(canWrite ? [{
            title: '', render: (_: unknown, f: Facility) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => open(f)}>{t('edit')}</Button>
                {!f.isActive && <Button size="small" onClick={() => setActive(f, true)}>{t('reactivate')}</Button>}
                <Button size="small" danger onClick={() => confirmDelete(f)}>{t('delete')}</Button>
              </Space>
            ),
          }] : []),
        ]} />
      <Modal title={editing === 'new' ? t('addFacility') : t('editFacility')} open={editing !== null} onCancel={() => setEditing(null)} width={460}
        onOk={() => form.submit()} okText={t('save')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label={t('facilityName')}
            rules={[{ required: true, whitespace: true, message: t('facilityNameRequired') }, { validator: duplicate }]}>
            <Input maxLength={150} autoFocus />
          </Form.Item>
          <Form.Item name="nameAr" label={t('nameArabic')}><Input maxLength={150} dir="rtl" /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
