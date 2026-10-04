// Contracts (spec §4). HR: create, renew, upload the copy, and move a contract
// along the map of decision D-29 — the creator or submitter cannot approve
// (D-30). Supervisors get the reduced read view, employees their own.

import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Drawer, Flex, Form, Input, Modal, Select, Space, Table, Tag, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { toHijriShort } from '../../lib/hijri';
import { http } from '../../services/http';
import { GuideHelp } from '../guidelines/GuideHelp';
import {
  CONTRACT_STATUSES, NEEDS_REASON, TRANSITIONS, useContractAction, useContractDocs, useContracts, useContractTypes, useCreatable, useRenewable,
  type ContractAction, type ContractRow, type ContractStatus, type Renewable,
} from './api';
import { ContractTypesDrawer } from './ContractTypesDrawer';
import { keyAfterError } from '../../lib/idempotency';

const COLOR: Record<ContractStatus, string> = {
  Draft: 'default', PendingApproval: 'orange', Approved: 'blue', Active: 'green', Expired: 'red', Suspended: 'volcano', Terminated: 'magenta', Superseded: 'purple',
};
const covers = (s: ContractStatus) => s === 'Approved' || s === 'Active'; // C1, C3

export default function ContractsPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const staff = hasRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR');
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const [filter, setFilter] = useState<{ status?: ContractStatus; contractTypeCode?: string; page: number }>({ page: 1 });
  const contracts = useContracts(filter, staff);
  // Every type for the filter (old contracts may carry an inactive one). New contracts and renewals carry the
  // employee's previous type on the server (owner decision 2026-10-04: the type is chosen at Onboard employee).
  const allTypes = useContractTypes(true, staff);
  const typeLabel = (x: { name: string; nameAr: string | null }) => (ar && x.nameAr ? x.nameAr : x.name);
  const [managingTypes, setManagingTypes] = useState(false);
  const action = useContractAction();
  const [creating, setCreating] = useState<{ mode: 'new' | 'renew'; key: string } | null>(null);
  const [pending, setPending] = useState<{ row: ContractRow; action: ContractAction } | null>(null);
  const [reason, setReason] = useState('');
  const [docsFor, setDocsFor] = useState<ContractRow | null>(null);
  // Picker search runs on the server (all employees in scope, not just a first page); typing is debounced.
  const [pickerInput, setPickerInput] = useState('');
  const [pickerQ, setPickerQ] = useState('');
  useEffect(() => { const h = setTimeout(() => setPickerQ(pickerInput.trim()), 300); return () => clearTimeout(h); }, [pickerInput]);
  const creatable = useCreatable(creating?.mode === 'new', pickerQ);
  const renewable = useRenewable(creating?.mode === 'renew', pickerQ);
  const picker = creating?.mode === 'renew' ? renewable : creatable;
  // Kept apart from the search results, which change as the user types.
  const [chosenRenewal, setChosenRenewal] = useState<Renewable | null>(null);
  const [chosenOption, setChosenOption] = useState<{ value: number; label: string } | null>(null);
  const pickerOptions = (creating?.mode === 'renew'
    ? renewable.data?.items.map((r) => ({ value: r.employeeId, label: `${r.jobNumber} — ${r.fullName}` }))
    : creatable.data?.items.map((e) => ({ value: e.id, label: `${e.jobNumber} — ${e.fullName}` }))) ?? [];
  // The chosen employee stays selectable (and labelled) even when a later search no longer returns them.
  const options = chosenOption && !pickerOptions.some((o) => o.value === chosenOption.value) ? [chosenOption, ...pickerOptions] : pickerOptions;
  const docs = useContractDocs(docsFor?.id ?? null);
  const [form] = Form.useForm<{ employeeId: number; start: Dayjs; end: Dayjs }>();
  const start = Form.useWatch('start', form);
  const end = Form.useWatch('end', form);

  function openPicker(mode: 'new' | 'renew') {
    form.resetFields();
    setPickerInput(''); setPickerQ(''); setChosenRenewal(null); setChosenOption(null);
    setCreating({ mode, key: crypto.randomUUID() });
  }

  async function run(a: Parameters<typeof action.mutateAsync>[0], ok: string) {
    try { const out = await action.mutateAsync(a); message.success(ok); return out; } catch (e) {
      // A refused New contract / Renew must not replay that refusal on the next submit.
      if (a.kind === 'create' || a.kind === 'renew') setCreating((c) => (c ? { ...c, key: keyAfterError(c.key, e) } : c));
      message.error(describeApiError(e)); return undefined;
    }
  }

  async function transition(row: ContractRow, act: ContractAction, why?: string) {
    const out = await run({ kind: 'transition', id: row.id, action: act, reason: why }, t('saved')) as { status: ContractStatus; eligibility: string | null } | undefined;
    if (out) { message.info(t('contractNowStatus', { status: t(`contract_${out.status}`), eligibility: out.eligibility ?? '—' })); setPending(null); setReason(''); }
  }

  const actionsFor = (r: ContractRow) => (Object.keys(TRANSITIONS) as ContractAction[]).filter((a) => TRANSITIONS[a].includes(r.status));

  return (
    <Card title={<>{t('contracts')} <GuideHelp section="contracts" /></>} styles={{ title: { minWidth: 110 }, extra: { flexShrink: 1, minWidth: 0, paddingBlock: 8 } }} extra={hr && (
      <Space wrap>
        <Button type="primary" onClick={() => openPicker('new')}>{t('newContract')}</Button>
        <Button onClick={() => openPicker('renew')}>{t('renewContract')}</Button>
        <Button onClick={() => setManagingTypes(true)}>{t('contractTypes')}</Button>
      </Space>
    )}>
      {staff && (
        <Flex gap={8} wrap style={{ marginBottom: 12 }}>
          <Select allowClear placeholder={t('status')} style={{ width: 220 }} onChange={(v) => setFilter({ ...filter, status: v ?? undefined, page: 1 })}
            options={CONTRACT_STATUSES.map((s) => ({ value: s, label: t(`contract_${s}`) }))} />
          <Select allowClear placeholder={t('contractType')} style={{ width: 280 }} onChange={(v) => setFilter({ ...filter, contractTypeCode: v ?? undefined, page: 1 })}
            options={(allTypes.data?.items ?? []).map((x) => ({ value: x.code, label: x.isActive ? typeLabel(x) : `${typeLabel(x)} (${t('inactive')})` }))} />
        </Flex>
      )}
      <Table<ContractRow>
        rowKey="id" loading={contracts.isLoading} dataSource={contracts.data?.items} scroll={{ x: true }}
        pagination={staff ? { current: filter.page, pageSize: 50, total: contracts.data?.total, onChange: (page) => setFilter({ ...filter, page }) } : false}
        columns={[
          { title: '#', dataIndex: 'id', width: 64 },
          { title: t('employee'), render: (_, r) => `${r.jobNumber} — ${r.employeeName}` },
          { title: t('unit'), render: (_, r) => r.unitCode ?? t('unassigned') },
          { title: t('contractType'), render: (_, r) => (r.contractTypeName ? typeLabel({ name: r.contractTypeName, nameAr: r.contractTypeNameAr }) : <Tag>{t('contractTypeNone')}</Tag>) },
          { title: t('period'), render: (_, r) => <>{r.startDate} → {r.endDate}<div style={{ opacity: 0.65, fontSize: 12 }}>{r.startDateHijri} → {r.endDateHijri} AH</div></> },
          { title: t('status'), render: (_, r) => <><Tag color={COLOR[r.status]}>{t(`contract_${r.status}`)}</Tag>{!covers(r.status) && <Tag>{t('noCoverage')}</Tag>}</> },
          {
            title: '', render: (_, r) => (
              <Flex gap={4} wrap>
                {r.view === 'FULL' && <Button size="small" onClick={() => setDocsFor(r)}>{t('contractCopy')}</Button>}
                {!staff && <Button size="small" onClick={() => setDocsFor(r)}>{t('contractCopy')}</Button>}
                {hr && r.view === 'FULL' && actionsFor(r).map((a) => (
                  <Button key={a} size="small" danger={a === 'terminate' || a === 'suspend'} type={a === 'approve' ? 'primary' : 'default'}
                    onClick={() => (NEEDS_REASON.includes(a) ? setPending({ row: r, action: a }) : void transition(r, a))}>{t(`contractAction_${a}`)}</Button>
                ))}
              </Flex>
            ),
          },
        ]}
      />

      <Modal title={creating?.mode === 'renew' ? t('renewContract') : t('newContract')} open={creating !== null} onCancel={() => setCreating(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Alert type="info" showIcon title={t('contractDraftHint')} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" onFinish={async (v) => {
          if (!creating) return;
          const body = { startDate: v.start.format('YYYY-MM-DD'), endDate: v.end.format('YYYY-MM-DD') };
          const out = creating.mode === 'new'
            ? await run({ kind: 'create', body: { employeeId: v.employeeId, ...body }, key: creating.key }, t('saved'))
            : await run({ kind: 'renew', priorId: chosenRenewal!.prior.id, body, key: creating.key }, t('saved'));
          if (out !== undefined) setCreating(null);
        }}>
          <Form.Item name="employeeId" label={t('employee')} rules={[{ required: true }]}
            extra={picker.data && picker.data.total > picker.data.items.length
              ? t('pickerShowing', { shown: picker.data.items.length, total: picker.data.total }) : undefined}>
            <Select showSearch={{ filterOption: false, onSearch: setPickerInput }} loading={picker.isFetching} placeholder={t('searchJobOrName')}
              options={options}
              onChange={(id: number) => {
                setChosenOption(options.find((o) => o.value === id) ?? null);
                const r = renewable.data?.items.find((x) => x.employeeId === id) ?? (chosenRenewal?.employeeId === id ? chosenRenewal : undefined);
                setChosenRenewal(creating?.mode === 'renew' ? r ?? null : null);
                if (creating?.mode === 'renew' && r) form.setFieldsValue({ start: dayjs(r.prefill.start), end: dayjs(r.prefill.end) }); // C8
              }} />
          </Form.Item>
          {creating?.mode === 'renew' && chosenRenewal && (
            <Alert type="success" style={{ marginBottom: 12 }} title={t('priorContract', {
              start: chosenRenewal.prior.startDate, end: chosenRenewal.prior.endDate, status: t(`contract_${chosenRenewal.prior.status}`),
              hstart: chosenRenewal.prior.startDateHijri ?? '', hend: chosenRenewal.prior.endDateHijri ?? '',
            })} />
          )}
          <Flex gap={8}>
            <Form.Item name="start" label={t('contractStart')} extra={start ? toHijriShort(start) : undefined} rules={[{ required: true }]} style={{ flex: 1 }}><DatePicker style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="end" label={t('contractEnd')} extra={end ? toHijriShort(end) : undefined} rules={[{ required: true }]} style={{ flex: 1 }}><DatePicker style={{ width: '100%' }} /></Form.Item>
          </Flex>
        </Form>
      </Modal>

      <Modal title={pending ? `${t(`contractAction_${pending.action}`)} #${pending.row.id}` : ''} open={pending !== null} onCancel={() => setPending(null)}
        onOk={() => pending && transition(pending.row, pending.action, reason)} okText={t('submit')} cancelText={t('cancel')}
        okButtonProps={{ disabled: reason.trim().length < 5, loading: action.isPending, danger: pending?.action !== 'reinstate' }} destroyOnHidden>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('decisionReasonHint')} maxLength={500} />
      </Modal>

      <Drawer title={docsFor ? `${t('contractCopy')} #${docsFor.id}` : ''} open={docsFor !== null} onClose={() => setDocsFor(null)} size={560} destroyOnHidden>
        {hr && docsFor && (
          <Upload accept="application/pdf,.pdf" showUploadList={false} beforeUpload={(f) => { void run({ kind: 'upload', id: docsFor.id, file: f }, t('saved')); return false; }}>
            <Button icon={<UploadOutlined />} loading={action.isPending} style={{ marginBottom: 12 }}>{t('uploadContractCopy')}</Button>
          </Upload>
        )}
        <Table rowKey="id" size="small" pagination={false} loading={docs.isLoading} dataSource={docs.data?.items}
          columns={[
            { title: 'v', dataIndex: 'version', width: 48 },
            { title: t('fileName'), dataIndex: 'fileName', ellipsis: true },
            { title: t('status'), render: (_, d) => <Tag color={d.scanStatus === 'CLEAN' ? 'default' : 'red'}>{d.scanStatus}</Tag> },
            { title: t('uploaded'), render: (_, d) => new Date(d.uploadedAt).toLocaleString() },
            {
              title: '', render: (_, d) => d.scanStatus === 'CLEAN' && docsFor
                ? <Space size={4}><Button size="small" onClick={() => http.openDocument(`/contracts/${docsFor.id}/documents/${d.id}`).catch((e) => message.error(describeApiError(e)))}>{t('view')}</Button><Button size="small" onClick={() => http.download(`/contracts/${docsFor.id}/documents/${d.id}`, d.fileName).catch((e) => message.error(describeApiError(e)))}>{t('download')}</Button></Space>
                : null,
            },
          ]} />
      </Drawer>
      {hr && <ContractTypesDrawer open={managingTypes} onClose={() => setManagingTypes(false)} />}
    </Card>
  );
}
