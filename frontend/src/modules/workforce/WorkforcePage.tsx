// Organisation structure (spec §2.9, §3.1.1, §6.3). Every rule (scope, W1–W8)
// is enforced by the server; this page collects input and shows its answer.

import { useState } from 'react';
import { Alert, App, Button, Card, Drawer, Flex, Form, Input, InputNumber, Modal, Select, Space, Statistic, Switch, Table, Tabs, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError, isStaleRecord } from '../../lib/errors';
import { GuideHelp } from '../guidelines/GuideHelp';
import { RankGradesTab } from './RankGradesTab';
import { SpecialtiesTab } from './SpecialtiesTab';
import { LocationsTab } from './LocationsTab';
import { FacilitiesManager } from './FacilitiesManager';
import {
  SHIFTS, TIERS, useAllDepartments, useAllUnits, useBedHistory, useCoverage, usePositions, useSummary, useWorkforceAction,
  type DepartmentRow, type ImportResult, type PositionRow, type ShiftType, type UnitRow,
} from './api';

const activeTag = (active: boolean, t: (k: string) => string) => <Tag color={active ? 'green' : 'default'}>{active ? t('active') : t('inactive')}</Tag>;

function useRun() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const action = useWorkforceAction();
  // onStale: someone else saved the record first; the edit dialog closes so it reopens with their version.
  const run = async (a: Parameters<typeof action.mutateAsync>[0], ok = t('saved'), onStale?: () => void) => {
    try { const out = await action.mutateAsync(a); message.success(ok); return out; } catch (e) {
      if (isStaleRecord(e)) { message.warning(describeApiError(e), 8); onStale?.(); } else message.error(describeApiError(e));
      return undefined;
    }
  };
  return { run, pending: action.isPending };
}

function UnitsTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const units = useAllUnits();
  const depts = useAllDepartments();
  const summary = useSummary();
  const { run, pending } = useRun();
  const [beds, setBeds] = useState<UnitRow | null>(null);
  const [history, setHistory] = useState<UnitRow | null>(null);
  const [editing, setEditing] = useState<UnitRow | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [bedForm] = Form.useForm<{ bedCount: number; reason: string }>();
  const [unitForm] = Form.useForm();
  const deptName = new Map(depts.data?.items.map((d) => [d.id, d.code]));
  const log = useBedHistory(history?.id ?? null);

  return (
    <>
      <Flex gap={24} wrap style={{ marginBottom: 16 }}>
        <Statistic title={t('units')} value={summary.data?.unitCount ?? '—'} />
        <Statistic title={t('totalBeds')} value={summary.data?.totalBeds ?? '—'} />
        {summary.data?.byDepartment.map((d) => <Statistic key={d.id} title={d.code} value={d.beds} suffix={t('beds')} />)}
      </Flex>
      {canWrite && (
        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" onClick={() => { unitForm.resetFields(); setEditing('new'); }}>{t('addUnit')}</Button>
          <Button onClick={() => setImporting(true)}>{t('importCsv')}</Button>
        </Space>
      )}
      <Table<UnitRow>
        rowKey="id" size="middle" loading={units.isLoading} dataSource={units.data?.items} pagination={{ pageSize: 50 }} scroll={{ x: true }}
        columns={[
          { title: t('code'), dataIndex: 'code' },
          { title: t('name'), dataIndex: 'name' },
          { title: t('department'), render: (_, u) => deptName.get(u.departmentId) ?? u.departmentId },
          { title: t('beds'), dataIndex: 'bedCount', align: 'end' },
          { title: t('criticalArea'), render: (_, u) => u.criticalArea ?? '—' },
          {
            title: t('kpiBasis'), render: (_, u) => (
              <>{u.inpatientBeds && <Tag color="blue">{t('inpatientBeds')}</Tag>}{!u.patientCareArea && <Tag>{t('notPatientCare')}</Tag>}</>
            ),
          },
          { title: t('status'), render: (_, u) => activeTag(u.isActive, t) },
          {
            title: '', render: (_, u) => (
              <Space>
                {canWrite && <Button size="small" onClick={() => { bedForm.setFieldsValue({ bedCount: u.bedCount, reason: '' }); setBeds(u); }}>{t('changeBeds')}</Button>}
                <Button size="small" onClick={() => setHistory(u)}>{t('history')}</Button>
                {canWrite && <Button size="small" onClick={() => { unitForm.setFieldsValue(u); setEditing(u); }}>{t('edit')}</Button>}
              </Space>
            ),
          },
        ]}
      />

      <Modal title={beds ? `${t('changeBeds')}: ${beds.code}` : ''} open={beds !== null} onCancel={() => setBeds(null)} onOk={() => bedForm.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={pending} forceRender>
        <Form form={bedForm} layout="vertical" onFinish={async (v) => { if (beds && await run({ kind: 'beds', id: beds.id, version: beds.updatedAt, ...v }, undefined, () => setBeds(null)) !== undefined) setBeds(null); }}>
          <Form.Item name="bedCount" label={t('beds')} rules={[{ required: true }]}><InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 3, whitespace: true }]}><Input maxLength={200} /></Form.Item>
        </Form>
      </Modal>

      <Modal title={editing === 'new' ? t('addUnit') : editing ? `${t('edit')}: ${editing.code}` : ''} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => unitForm.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={pending} forceRender>
        <Form form={unitForm} layout="vertical" onFinish={async (v) => {
          const out = editing === 'new'
            ? await run({ kind: 'unit', body: v })
            : await run({ kind: 'unit', id: (editing as UnitRow).id, version: (editing as UnitRow).updatedAt, body: { name: v.name, description: v.description ?? null, departmentId: v.departmentId, isActive: v.isActive, criticalArea: v.criticalArea ?? null, patientCareArea: v.patientCareArea, inpatientBeds: v.inpatientBeds } }, undefined, () => setEditing(null));
          if (out !== undefined) setEditing(null);
        }}>
          {editing === 'new' && <Form.Item name="code" label={t('code')} rules={[{ required: true }]}><Input maxLength={20} /></Form.Item>}
          <Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="departmentId" label={t('department')} rules={[{ required: true }]}>
            <Select options={depts.data?.items.filter((d) => d.isActive).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` }))} />
          </Form.Item>
          <Form.Item name="description" label={t('description')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Form.Item name="criticalArea" label={t('criticalArea')} extra={t('criticalAreaHint')}>
            <Select allowClear options={(['ICU', 'ER', 'OR'] as const).map((a) => ({ value: a, label: a }))} />
          </Form.Item>
          <Form.Item name="patientCareArea" label={t('patientCareArea')} extra={t('patientCareAreaHint')} valuePropName="checked" initialValue={true}><Switch /></Form.Item>
          <Form.Item name="inpatientBeds" label={t('inpatientBeds')} extra={t('inpatientBedsHint')} valuePropName="checked" initialValue={false}><Switch /></Form.Item>
          {editing === 'new'
            ? <Form.Item name="bedCount" label={t('beds')} initialValue={0}><InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} /></Form.Item>
            : <Form.Item name="isActive" label={t('status')} valuePropName="checked"><Switch checkedChildren={t('active')} unCheckedChildren={t('inactive')} /></Form.Item>}
        </Form>
      </Modal>

      <Drawer title={history ? `${t('bedHistory')}: ${history.code}` : ''} open={history !== null} onClose={() => setHistory(null)} size={560} destroyOnHidden>
        <Table rowKey="id" size="small" pagination={false} loading={log.isLoading} dataSource={log.data?.items}
          columns={[
            { title: t('when'), render: (_, r) => new Date(r.changedAt).toLocaleString() },
            { title: t('beds'), render: (_, r) => `${r.previousCount} → ${r.newCount}` },
            { title: t('reason'), dataIndex: 'reason' },
            { title: t('by'), render: (_, r) => r.changedBy ?? t('system') },
          ]} />
      </Drawer>

      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { run, pending } = useRun();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const check = async (dryRun: boolean) => {
    const out = await run({ kind: 'import', csv, dryRun }, dryRun ? t('previewReady') : t('saved')) as ImportResult | undefined;
    if (!out) return;
    if (dryRun) setPreview(out); else { setPreview(null); setCsv(''); onClose(); }
  };
  return (
    <Modal title={t('importCsv')} open={open} onCancel={onClose} width={760} destroyOnHidden
      footer={[
        <Button key="c" onClick={onClose}>{t('cancel')}</Button>,
        <Button key="p" onClick={() => check(true)} loading={pending} disabled={!csv.trim()}>{t('preview')}</Button>,
        <Button key="a" type="primary" onClick={() => check(false)} loading={pending} disabled={!preview || preview.created + preview.updated === 0}>{t('apply')}</Button>,
      ]}>
      <Alert type="info" showIcon title={t('importHint')} style={{ marginBottom: 12 }} />
      <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setPreview(null); } }} />
      <Input.TextArea rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} style={{ marginTop: 8, fontFamily: 'monospace' }}
        placeholder="unit_code,name,department_code,beds,description" />
      {preview && (
        <>
          <Space style={{ margin: '12px 0' }}>
            <Tag color="green">{t('created')}: {preview.created}</Tag><Tag color="blue">{t('updated')}: {preview.updated}</Tag>
            <Tag>{t('unchanged')}: {preview.unchanged}</Tag><Tag color="red">{t('rejected')}: {preview.rejected}</Tag>
          </Space>
          <Table rowKey="line" size="small" pagination={{ pageSize: 10 }} dataSource={preview.results}
            columns={[{ title: '#', dataIndex: 'line', width: 56 }, { title: t('code'), dataIndex: 'unitCode' }, { title: t('status'), dataIndex: 'status' }, { title: t('reason'), dataIndex: 'reason' }]} />
        </>
      )}
    </Modal>
  );
}

function DepartmentsTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const depts = useAllDepartments();
  const { run, pending } = useRun();
  const [editing, setEditing] = useState<DepartmentRow | 'new' | null>(null);
  const [form] = Form.useForm();
  return (
    <>
      {canWrite && <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { form.resetFields(); setEditing('new'); }}>{t('addDepartment')}</Button>}
      <Table<DepartmentRow> rowKey="id" size="middle" loading={depts.isLoading} dataSource={depts.data?.items} pagination={false}
        columns={[
          { title: t('code'), dataIndex: 'code' }, { title: t('name'), dataIndex: 'name' }, { title: t('description'), dataIndex: 'description', ellipsis: true },
          { title: t('status'), render: (_, d) => activeTag(d.isActive, t) },
          ...(canWrite ? [{ title: '', render: (_: unknown, d: DepartmentRow) => <Button size="small" onClick={() => { form.setFieldsValue(d); setEditing(d); }}>{t('edit')}</Button> }] : []),
        ]} />
      <Modal title={editing === 'new' ? t('addDepartment') : editing ? `${t('edit')}: ${editing.code}` : ''} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={pending} forceRender>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          const out = editing === 'new' ? await run({ kind: 'department', body: v })
            : await run({ kind: 'department', id: (editing as DepartmentRow).id, version: (editing as DepartmentRow).updatedAt, body: { name: v.name, description: v.description ?? null, isActive: v.isActive } }, undefined, () => setEditing(null));
          if (out !== undefined) setEditing(null);
        }}>
          {editing === 'new' && <Form.Item name="code" label={t('code')} rules={[{ required: true }]}><Input maxLength={20} /></Form.Item>}
          <Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="description" label={t('description')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          {editing !== 'new' && <Form.Item name="isActive" label={t('status')} valuePropName="checked"><Switch checkedChildren={t('active')} unCheckedChildren={t('inactive')} /></Form.Item>}
        </Form>
      </Modal>
    </>
  );
}

function PositionsTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const positions = usePositions(true);
  const { run, pending } = useRun();
  const [editing, setEditing] = useState<PositionRow | 'new' | null>(null);
  const [form] = Form.useForm();
  return (
    <>
      {canWrite && <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { form.resetFields(); setEditing('new'); }}>{t('addPosition')}</Button>}
      <Table<PositionRow> rowKey="code" size="middle" loading={positions.isLoading} dataSource={positions.data?.items} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('code'), dataIndex: 'code' }, { title: t('title'), dataIndex: 'title' },
          { title: t('titleArabic'), dataIndex: 'titleAr', render: (v: string | null) => (v ? <span dir="rtl" lang="ar">{v}</span> : '—') }, { title: t('tier'), dataIndex: 'tier' },
          { title: t('schedulable'), render: (_, p) => (p.isSchedulable ? <Tag color="blue">{t('yes')}</Tag> : <Tag>{t('no')}</Tag>) },
          { title: t('countsAsNurse'), render: (_, p) => (p.countsAsNurse ? <Tag color="blue">{t('yes')}</Tag> : <Tag>{t('no')}</Tag>) },
          { title: t('status'), render: (_, p) => <>{activeTag(p.isActive, t)}{p.replacedBy && <Tag>→ {p.replacedBy}</Tag>}</> },
          ...(canWrite ? [{ title: '', render: (_: unknown, p: PositionRow) => <Button size="small" onClick={() => { form.setFieldsValue(p); setEditing(p); }}>{t('edit')}</Button> }] : []),
        ]} />
      <Modal title={editing === 'new' ? t('addPosition') : editing ? `${t('edit')}: ${editing.code}` : ''} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={pending} forceRender>
        <Alert type="warning" showIcon title={t('schedulableHint')} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" initialValues={{ isSchedulable: true, countsAsNurse: false }} onFinish={async (v) => {
          const { code, replacedBy: _r, ...rest } = v;
          const out = editing === 'new' ? await run({ kind: 'position', body: { code, ...rest, titleAr: rest.titleAr?.trim() || undefined, isActive: undefined } })
            : await run({ kind: 'position', code: (editing as PositionRow).code, version: (editing as PositionRow).updatedAt, body: { title: rest.title, titleAr: rest.titleAr?.trim() || null, tier: rest.tier, description: rest.description ?? null, isSchedulable: rest.isSchedulable, countsAsNurse: rest.countsAsNurse, isActive: rest.isActive, displayOrder: rest.displayOrder } }, undefined, () => setEditing(null));
          if (out !== undefined) setEditing(null);
        }}>
          {editing === 'new' && <Form.Item name="code" label={t('code')} rules={[{ required: true }]}><Input maxLength={20} /></Form.Item>}
          <Form.Item name="title" label={t('title')} rules={[{ required: true }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="titleAr" label={t('titleArabic')}><Input maxLength={120} dir="rtl" lang="ar" /></Form.Item>
          <Form.Item name="tier" label={t('tier')} rules={[{ required: true }]}><Select options={TIERS.map((x) => ({ value: x, label: x }))} /></Form.Item>
          <Form.Item name="description" label={t('description')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Form.Item name="displayOrder" label={t('displayOrder')} initialValue={0}><InputNumber min={0} precision={0} /></Form.Item>
          <Form.Item name="isSchedulable" label={t('schedulable')} valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="countsAsNurse" label={t('countsAsNurse')} extra={t('countsAsNurseHint')} valuePropName="checked"><Switch /></Form.Item>
          {editing !== 'new' && <Form.Item name="isActive" label={t('status')} valuePropName="checked"><Switch checkedChildren={t('active')} unCheckedChildren={t('inactive')} /></Form.Item>}
        </Form>
      </Modal>
    </>
  );
}

/** Unit × shift grid. An empty cell is "unspecified", never zero (W8). */
function CoverageTab({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const units = useAllUnits();
  const coverage = useCoverage();
  const { run } = useRun();
  const value = (unitId: number, s: ShiftType) => coverage.data?.items.find((c) => c.unitId === unitId && c.shiftType === s)?.minimumStaff ?? null;
  const save = (unitId: number, s: ShiftType, v: number | null) => {
    if (v === value(unitId, s)) return;
    void run({ kind: 'coverage', unitId, shiftType: s, minimumStaff: v });
  };
  return (
    <>
      <Alert type="info" showIcon title={t('coverageHint')} style={{ marginBottom: 12 }} />
      <Table<UnitRow> rowKey="id" size="small" loading={units.isLoading || coverage.isLoading} dataSource={units.data?.items.filter((u) => u.isActive)} pagination={{ pageSize: 50 }} scroll={{ x: true }}
        columns={[
          { title: t('unit'), render: (_, u) => `${u.code} — ${u.name}` },
          ...SHIFTS.map((s) => ({
            title: t(`shift_${s}`),
            render: (_: unknown, u: UnitRow) => canWrite
              ? <InputNumber key={`${u.id}-${s}-${value(u.id, s)}`} size="small" min={0} max={999} precision={0} placeholder={t('unspecified')} defaultValue={value(u.id, s) ?? undefined}
                  onBlur={(e) => save(u.id, s, e.target.value === '' ? null : Number(e.target.value))} />
              : value(u.id, s) ?? <Tag>{t('unspecified')}</Tag>,
          })),
        ]} />
    </>
  );
}

export default function WorkforcePage() {
  const { t } = useTranslation();
  const { hasRole } = usePermissions();
  const canWrite = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  return (
    <Card title={<>{t('workforce')} <GuideHelp section="workforce" /></>}>
      <Tabs destroyOnHidden items={[
        { key: 'units', label: t('units'), children: <UnitsTab canWrite={canWrite} /> },
        { key: 'departments', label: t('departments'), children: <DepartmentsTab canWrite={canWrite} /> },
        { key: 'positions', label: t('positions'), children: <PositionsTab canWrite={canWrite} /> },
        { key: 'rankGrades', label: t('rankGrades'), children: <RankGradesTab canWrite={canWrite} /> },
        { key: 'specialties', label: t('specialties'), children: <SpecialtiesTab canWrite={canWrite} /> },
        { key: 'locations', label: t('locations'), children: <LocationsTab canWrite={canWrite} /> },
        { key: 'facilities', label: t('facilities'), children: <><Alert type="info" showIcon title={t('facilitiesHint')} style={{ marginBottom: 12 }} /><FacilitiesManager canWrite={canWrite} /></> },
        { key: 'coverage', label: t('coverageTargets'), children: <CoverageTab canWrite={canWrite} /> },
      ]} />
    </Card>
  );
}
