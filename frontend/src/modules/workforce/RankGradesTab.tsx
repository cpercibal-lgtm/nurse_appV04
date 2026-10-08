// Rank/Grade master (owner decision 2026-10-03): system-wide HR and System Admins add,
// edit, deactivate and reactivate the SCFHS nursing classifications. Delete removes a
// record nobody uses; one in use is offered for deactivation instead. Every change is
// in the audit log. Everyone else only views the list.

import { useMemo, useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { ApiError } from '../../services/http';
import { useRankGradeAction, useRankGrades, type RankGrade } from './api';

type Values = { code: string; name: string; meaning?: string; isActive: boolean; sortOrder: number };
type StatusFilter = 'all' | 'active' | 'inactive';

export function RankGradesTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const list = useRankGrades(true);
  const action = useRankGradeAction();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<RankGrade | 'new' | null>(null);
  const [form] = Form.useForm<Values>();

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list.data?.items ?? [])
      .filter((r) => status === 'all' || (status === 'active') === r.isActive)
      .filter((r) => !s || [r.code, r.name, r.meaning ?? ''].some((f) => f.toLowerCase().includes(s)));
  }, [list.data, q, status]);

  function openForm(row: RankGrade | 'new') {
    form.resetFields();
    if (row === 'new') form.setFieldsValue({ isActive: true, sortOrder: Math.max(0, ...(list.data?.items ?? []).map((r) => r.sortOrder)) + 1 });
    else form.setFieldsValue({ code: row.code, name: row.name, meaning: row.meaning ?? undefined, isActive: row.isActive, sortOrder: row.sortOrder });
    setEditing(row);
  }

  async function save(v: Values) {
    try {
      if (editing === 'new') {
        await action.mutateAsync({ kind: 'create', body: { code: v.code, name: v.name, ...(v.meaning?.trim() ? { meaning: v.meaning } : {}), isActive: v.isActive, sortOrder: v.sortOrder } });
      } else if (editing) {
        await action.mutateAsync({ kind: 'update', code: editing.code, version: editing.updatedAt, body: { name: v.name, meaning: v.meaning?.trim() ? v.meaning : null, isActive: v.isActive, sortOrder: v.sortOrder } });
      }
      message.success(t('saved'));
      setEditing(null);
    } catch (e) {
      // Someone else saved this record first: the list has reloaded; the dialog closes so it reopens with their change.
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); setEditing(null); } else message.error(describeApiError(e));
    }
  }

  const setActive = async (r: RankGrade, isActive: boolean) => {
    try { await action.mutateAsync({ kind: 'update', code: r.code, body: { isActive } }); message.success(t('saved')); } catch (e) { message.error(describeApiError(e)); }
  };

  async function remove(r: RankGrade) {
    try {
      await action.mutateAsync({ kind: 'remove', code: r.code });
      message.success(t('rankGradeDeleted'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RANK_GRADE_IN_USE') {
        modal.confirm({
          title: t('rankGradeInUseTitle'), content: t('rankGradeInUseText'), okText: t('deactivate'), cancelText: t('cancel'), okButtonProps: { danger: true },
          onOk: () => setActive(r, false),
        });
      } else message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Alert type="info" showIcon title={t('rankGradeHint')} style={{ marginBottom: 12 }} />
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t('rankGradeSearch')} style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select<StatusFilter> value={status} onChange={setStatus} style={{ width: 160 }}
          options={[{ value: 'all', label: t('all') }, { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]} />
        {canWrite && <Button type="primary" onClick={() => openForm('new')}>{t('addRankGrade')}</Button>}
      </Flex>
      <Table<RankGrade> rowKey="code" size="small" loading={list.isLoading} dataSource={rows} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('displayOrder'), dataIndex: 'sortOrder', width: 80 },
          { title: t('code'), dataIndex: 'code', width: 90 },
          { title: t('rankGradeClassification'), dataIndex: 'name' },
          { title: t('rankGradeMeaning'), dataIndex: 'meaning', render: (m: string | null) => m ?? '—' },
          { title: t('rankGradeEmployees'), dataIndex: 'employeeCount', width: 90 },
          { title: t('status'), render: (_, r) => <Tag color={r.isActive ? 'green' : 'default'}>{t(r.isActive ? 'active' : 'inactive')}</Tag> },
          ...(canWrite ? [{
            title: '', render: (_: unknown, r: RankGrade) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => openForm(r)}>{t('edit')}</Button>
                {r.isActive
                  ? <Popconfirm title={t('rankGradeDeleteConfirm')} onConfirm={() => remove(r)} okButtonProps={{ danger: true }}><Button size="small" danger>{t('delete')}</Button></Popconfirm>
                  : <Button size="small" onClick={() => setActive(r, true)}>{t('reactivate')}</Button>}
              </Space>
            ),
          }] : []),
        ]} />

      <Modal title={editing === 'new' ? t('addRankGrade') : t('editRankGrade')} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('save')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="code" label={t('code')} extra={editing === 'new' ? t('rankGradeCodeHint') : t('rankGradeCodeFixed')}
            rules={[{ required: true, whitespace: true }, { pattern: /^\s*[A-Za-z][A-Za-z0-9_]{0,19}\s*$/, message: t('rankGradeCodeHint') }]}>
            <Input disabled={editing !== 'new'} maxLength={22} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="name" label={t('rankGradeClassification')} rules={[{ required: true, whitespace: true, message: t('rankGradeNameRequired') }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="meaning" label={t('rankGradeMeaning')}><Input maxLength={300} /></Form.Item>
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
