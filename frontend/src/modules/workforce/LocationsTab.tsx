// Saudi Arabia location master (owner decision 2026-10-03): hospital-wide HR and System
// Admins maintain the regions and their cities — add, edit, deactivate, reactivate and
// delete. Delete confirms first; a region with cities or employees, or a city employees
// hold, is offered for deactivation instead. Every change is in the audit log.

import { useMemo, useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, InputNumber, Modal, Segmented, Select, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { ApiError } from '../../services/http';
import { useCities, useLocationAction, useRegions, type SaudiCity, type SaudiRegion } from './api';

type StatusFilter = 'all' | 'active' | 'inactive';
type RegionValues = { code: string; name: string; nameAr?: string; isActive: boolean; sortOrder: number };
type CityValues = { regionCode: string; name: string; nameAr?: string; isActive: boolean; sortOrder: number };
const optional = (v: string | undefined) => (v?.trim() ? v : undefined);
const matches = (s: string, ...fields: Array<string | null>) => !s || fields.some((f) => (f ?? '').toLowerCase().includes(s));
const byStatus = (status: StatusFilter, isActive: boolean) => status === 'all' || (status === 'active') === isActive;

export function LocationsTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const [part, setPart] = useState<'regions' | 'cities'>('regions');
  return (
    <>
      <Alert type="info" showIcon title={t('locationsHint')} style={{ marginBottom: 12 }} />
      <Segmented value={part} onChange={(v) => setPart(v as 'regions' | 'cities')} style={{ marginBottom: 12 }}
        options={[{ value: 'regions', label: t('regions') }, { value: 'cities', label: t('cities') }]} />
      {part === 'regions' ? <RegionsPart canWrite={canWrite} /> : <CitiesPart canWrite={canWrite} />}
    </>
  );
}

function useSafeDelete() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  /** Confirm, delete; if in use, offer to deactivate instead. */
  return (title: string, remove: () => Promise<unknown>, inUse: string, deactivate: () => Promise<unknown>) => modal.confirm({
    title, okText: t('delete'), cancelText: t('cancel'), okButtonProps: { danger: true },
    onOk: async () => {
      try { await remove(); message.success(t('locationDeleted')); } catch (e) {
        if (e instanceof ApiError && e.code === inUse) {
          modal.confirm({
            title: t('locationInUseTitle'), content: t(inUse === 'REGION_IN_USE' ? 'regionInUseText' : 'cityInUseText'), okText: t('deactivate'), cancelText: t('cancel'),
            okButtonProps: { danger: true }, onOk: async () => { try { await deactivate(); message.success(t('saved')); } catch (err) { message.error(describeApiError(err)); } },
          });
        } else message.error(describeApiError(e));
      }
    },
  });
}

function RegionsPart({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const list = useRegions(true);
  const action = useLocationAction();
  const safeDelete = useSafeDelete();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<SaudiRegion | 'new' | null>(null);
  const [form] = Form.useForm<RegionValues>();
  const rows = useMemo(() => (list.data?.items ?? []).filter((r) => byStatus(status, r.isActive) && matches(q.trim().toLowerCase(), r.code, r.name, r.nameAr)), [list.data, q, status]);

  const open = (r: SaudiRegion | 'new') => {
    form.resetFields();
    form.setFieldsValue(r === 'new' ? { isActive: true, sortOrder: Math.max(0, ...(list.data?.items ?? []).map((x) => x.sortOrder)) + 1 }
      : { code: r.code, name: r.name, nameAr: r.nameAr ?? undefined, isActive: r.isActive, sortOrder: r.sortOrder });
    setEditing(r);
  };
  // A stale edit (someone else saved first) also closes the dialog: the list has reloaded with their change.
  const run = async (a: Parameters<typeof action.mutateAsync>[0]) => {
    try { await action.mutateAsync(a); message.success(t('saved')); return true; } catch (e) {
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); return true; }
      message.error(describeApiError(e)); return false;
    }
  };

  return (
    <>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t('regionSearch')} style={{ width: 280 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select<StatusFilter> value={status} onChange={setStatus} style={{ width: 140 }} options={[{ value: 'all', label: t('all') }, { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]} />
        {canWrite && <Button type="primary" onClick={() => open('new')}>{t('addRegion')}</Button>}
      </Flex>
      <Table<SaudiRegion> rowKey="code" size="small" loading={list.isLoading} dataSource={rows} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('displayOrder'), dataIndex: 'sortOrder', width: 80 },
          { title: t('code'), dataIndex: 'code', width: 90 },
          { title: t('regionName'), dataIndex: 'name' },
          { title: t('nameArabic'), render: (_, r) => <span dir="rtl">{r.nameAr ?? '—'}</span> },
          { title: t('cities'), dataIndex: 'cityCount', width: 80 },
          { title: t('rankGradeEmployees'), dataIndex: 'employeeCount', width: 90 },
          { title: t('status'), render: (_, r) => <Tag color={r.isActive ? 'green' : 'default'}>{t(r.isActive ? 'active' : 'inactive')}</Tag> },
          ...(canWrite ? [{
            title: '', render: (_: unknown, r: SaudiRegion) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => open(r)}>{t('edit')}</Button>
                <Button size="small" onClick={() => run({ kind: 'updateRegion', code: r.code, body: { isActive: !r.isActive } })}>{t(r.isActive ? 'deactivate' : 'reactivate')}</Button>
                <Button size="small" danger onClick={() => safeDelete(t('locationDeleteConfirm', { label: `${r.code} - ${r.name}` }),
                  () => action.mutateAsync({ kind: 'removeRegion', code: r.code }), 'REGION_IN_USE',
                  () => action.mutateAsync({ kind: 'updateRegion', code: r.code, body: { isActive: false } }))}>{t('delete')}</Button>
              </Space>
            ),
          }] : []),
        ]} />
      <Modal title={editing === 'new' ? t('addRegion') : t('editRegion')} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('save')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          const ok = editing === 'new'
            ? await run({ kind: 'createRegion', body: { code: v.code, name: v.name, nameAr: optional(v.nameAr), isActive: v.isActive, sortOrder: v.sortOrder } })
            : editing && await run({ kind: 'updateRegion', code: editing.code, version: editing.updatedAt, body: { name: v.name, nameAr: optional(v.nameAr) ?? null, isActive: v.isActive, sortOrder: v.sortOrder } });
          if (ok) setEditing(null);
        }}>
          <Form.Item name="code" label={t('regionCode')} extra={editing === 'new' ? t('regionCodeHint') : t('locationCodeFixed')}
            rules={[{ required: true, whitespace: true }, { pattern: /^\s*[A-Za-z][A-Za-z0-9-]{0,9}\s*$/, message: t('regionCodeHint') }]}>
            <Input disabled={editing !== 'new'} maxLength={12} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="name" label={t('regionName')} rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
          <Form.Item name="nameAr" label={t('nameArabic')}><Input maxLength={80} dir="rtl" /></Form.Item>
          <Flex gap={8}>
            <Form.Item name="isActive" label={t('status')} style={{ flex: 1 }}><Select options={[{ value: true, label: t('active') }, { value: false, label: t('inactive') }]} /></Form.Item>
            <Form.Item name="sortOrder" label={t('displayOrder')} rules={[{ required: true }]} style={{ flex: 1 }}><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
          </Flex>
        </Form>
      </Modal>
    </>
  );
}

function CitiesPart({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const regions = useRegions(true);
  const [regionCode, setRegionCode] = useState<string | null>(null);
  const list = useCities(regionCode, true);
  const action = useLocationAction();
  const safeDelete = useSafeDelete();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<SaudiCity | 'new' | null>(null);
  const [form] = Form.useForm<CityValues>();
  const regionName = (code: string) => regions.data?.items.find((r) => r.code === code)?.name ?? code;
  const rows = useMemo(() => (list.data?.items ?? []).filter((c) => byStatus(status, c.isActive) && matches(q.trim().toLowerCase(), c.name, c.nameAr)), [list.data, q, status]);

  const open = (c: SaudiCity | 'new') => {
    form.resetFields();
    form.setFieldsValue(c === 'new' ? { regionCode: regionCode ?? undefined, isActive: true, sortOrder: Math.max(0, ...rows.map((x) => x.sortOrder)) + 1 }
      : { regionCode: c.regionCode, name: c.name, nameAr: c.nameAr ?? undefined, isActive: c.isActive, sortOrder: c.sortOrder });
    setEditing(c);
  };
  // A stale edit (someone else saved first) also closes the dialog: the list has reloaded with their change.
  const run = async (a: Parameters<typeof action.mutateAsync>[0]) => {
    try { await action.mutateAsync(a); message.success(t('saved')); return true; } catch (e) {
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); return true; }
      message.error(describeApiError(e)); return false;
    }
  };

  return (
    <>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Select<string> allowClear placeholder={t('allRegions')} style={{ width: 240 }} value={regionCode ?? undefined} onChange={(v) => setRegionCode(v ?? null)}
          options={(regions.data?.items ?? []).map((r) => ({ value: r.code, label: r.isActive ? r.name : `${r.name} (${t('inactive')})` }))} />
        <Input.Search allowClear placeholder={t('citySearch')} style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select<StatusFilter> value={status} onChange={setStatus} style={{ width: 140 }} options={[{ value: 'all', label: t('all') }, { value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]} />
        {canWrite && <Button type="primary" onClick={() => open('new')}>{t('addCity')}</Button>}
      </Flex>
      <Table<SaudiCity> rowKey="id" size="small" loading={list.isLoading} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: true }}
        columns={[
          { title: t('regionName'), render: (_, c) => regionName(c.regionCode) },
          { title: t('displayOrder'), dataIndex: 'sortOrder', width: 80 },
          { title: t('cityName'), dataIndex: 'name' },
          { title: t('nameArabic'), render: (_, c) => <span dir="rtl">{c.nameAr ?? '—'}</span> },
          { title: t('rankGradeEmployees'), dataIndex: 'employeeCount', width: 90 },
          { title: t('status'), render: (_, c) => <Tag color={c.isActive ? 'green' : 'default'}>{t(c.isActive ? 'active' : 'inactive')}</Tag> },
          ...(canWrite ? [{
            title: '', render: (_: unknown, c: SaudiCity) => (
              <Space size={4} wrap>
                <Button size="small" onClick={() => open(c)}>{t('edit')}</Button>
                <Button size="small" onClick={() => run({ kind: 'updateCity', id: c.id, body: { isActive: !c.isActive } })}>{t(c.isActive ? 'deactivate' : 'reactivate')}</Button>
                <Button size="small" danger onClick={() => safeDelete(t('locationDeleteConfirm', { label: `${regionName(c.regionCode)} - ${c.name}` }),
                  () => action.mutateAsync({ kind: 'removeCity', id: c.id }), 'CITY_IN_USE',
                  () => action.mutateAsync({ kind: 'updateCity', id: c.id, body: { isActive: false } }))}>{t('delete')}</Button>
              </Space>
            ),
          }] : []),
        ]} />
      <Modal title={editing === 'new' ? t('addCity') : t('editCity')} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('save')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          const ok = editing === 'new'
            ? await run({ kind: 'createCity', body: { regionCode: v.regionCode, name: v.name, nameAr: optional(v.nameAr), isActive: v.isActive, sortOrder: v.sortOrder } })
            : editing && await run({ kind: 'updateCity', id: editing.id, version: editing.updatedAt, body: { ...(v.regionCode !== editing.regionCode ? { regionCode: v.regionCode } : {}), name: v.name, nameAr: optional(v.nameAr) ?? null, isActive: v.isActive, sortOrder: v.sortOrder } });
          if (ok) setEditing(null);
        }}>
          <Form.Item name="regionCode" label={t('regionName')} rules={[{ required: true }]}
            extra={editing !== 'new' && editing && editing.employeeCount > 0 ? t('cityRegionFixed') : undefined}>
            <Select disabled={editing !== 'new' && !!editing && editing.employeeCount > 0} showSearch={{ optionFilterProp: 'label' }}
              options={(regions.data?.items ?? []).map((r) => ({ value: r.code, label: r.name }))} />
          </Form.Item>
          <Form.Item name="name" label={t('cityName')} rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
          <Form.Item name="nameAr" label={t('nameArabic')}><Input maxLength={80} dir="rtl" /></Form.Item>
          <Flex gap={8}>
            <Form.Item name="isActive" label={t('status')} style={{ flex: 1 }}><Select options={[{ value: true, label: t('active') }, { value: false, label: t('inactive') }]} /></Form.Item>
            <Form.Item name="sortOrder" label={t('displayOrder')} rules={[{ required: true }]} style={{ flex: 1 }}><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
          </Flex>
        </Form>
      </Modal>
    </>
  );
}
