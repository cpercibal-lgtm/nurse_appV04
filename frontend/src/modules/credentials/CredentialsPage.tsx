// Credentials for HR / System Admin (full, scoped) and Supervisors (compliance
// view only — spec §8.1, §5.2). Every rule is enforced by the server; this page
// shows data and sends the user's decisions.

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Flex, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { useUnits } from '../administration/api';
import { usePositions } from '../workforce/api';
import { FIELD_TYPES, NATIONALITY_RULES, PDPL_CATEGORIES, useCategories, useCredentialAction, useCredentials, useRequirements, useTemplates, type Category, type CredentialRow, type Requirement, type Template } from './api';
import { CredentialStatusTag, DocumentsDrawer, LifecycleTag, normaliseTracking, TrackingFields } from './components';
import { useEmployees } from '../nurses/api';
import { ScfhsDrawer } from './ScfhsDrawer';
import { NationalityRuleTag, useNationalityRuleText } from './NationalityRuleTag';
import { NationalitySelect } from '../../components/NationalitySelect';
import { changeBody, createBody, fieldProblems, isDateType, toFormValues, type FieldRowValue, type TemplateFormValues } from './catalogForm';
import { useTypeLabels } from './labels';

import { GuideHelp } from '../guidelines/GuideHelp';
type Decision = { kind: 'suspend' | 'revoke' | 'reject'; row: CredentialRow };

function RecordsTable({ queue }: { queue?: 'review' }) {
  const { t } = useTranslation();
  const { typeLabel } = useTypeLabels();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const [identifier, setIdentifier] = useState('');
  const rows = useCredentials(queue, identifier || undefined);
  const action = useCredentialAction();
  const [docsFor, setDocsFor] = useState<number | null>(null);
  const [scfhsFor, setScfhsFor] = useState<{ id: number; title: string } | null>(null);
  // Spec §5.4 (D-64): the types whose holders' licences are checked with SCFHS.
  const templates = useTemplates();
  const scfhsTypes = new Set(templates.data?.items.filter((x) => x.scfhsEnabled).map((x) => x.id));
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');

  async function run(p: Promise<unknown>) {
    try { await p; message.success(t('saved')); } catch (e) { message.error(describeApiError(e)); }
  }

  // HR records a credential on a nurse's behalf (POST /credentials, scoped on the server).
  const [recording, setRecording] = useState(false);
  const [nurseQuery, setNurseQuery] = useState('');
  const nurses = useEmployees({ q: nurseQuery || undefined, page: 1 }, recording);
  const [recordForm] = Form.useForm();
  const recordTemplateId = Form.useWatch('templateId', recordForm) as number | undefined;
  const recordTemplate = templates.data?.items.find((x) => x.id === recordTemplateId);
  const ruleText = useNationalityRuleText();
  async function submitRecord(v: { employeeId: number; templateId: number; trackingData?: Record<string, unknown> }) {
    try {
      const created = await action.mutateAsync({ kind: 'record', self: false, body: { employeeId: v.employeeId, templateId: v.templateId, trackingData: normaliseTracking(v) } }) as { id: number };
      message.success(t('recordedUploadEvidence'));
      setRecording(false); recordForm.resetFields();
      setDocsFor(created.id);
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <>
      {hr && !queue && (
        <Flex gap={8} wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder={t('searchIdentifier')} style={{ width: 320 }} maxLength={40}
            onSearch={(v) => setIdentifier(v.trim().length >= 3 ? v.trim() : '')} />
          <Button type="primary" onClick={() => { recordForm.resetFields(); setNurseQuery(''); setRecording(true); }}>{t('recordForNurse')}</Button>
        </Flex>
      )}
      <Modal title={t('recordForNurse')} open={recording} onCancel={() => setRecording(false)} onOk={() => recordForm.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden>
        <Alert type="info" showIcon title={t('recordForNurseHint')} style={{ marginBottom: 12 }} />
        <Form form={recordForm} layout="vertical" onFinish={submitRecord}>
          <Form.Item name="employeeId" label={t('employee')} rules={[{ required: true }]}>
            <Select showSearch={{ filterOption: false, onSearch: setNurseQuery }} loading={nurses.isFetching} placeholder={t('searchJobOrName')}
              options={nurses.data?.items.map((e) => ({ value: e.id, label: `${e.jobNumber} — ${e.fullName}${e.unit ? ` (${e.unit.code})` : ''}` }))} />
          </Form.Item>
          <Form.Item name="templateId" label={t('credential')} rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={templates.data?.items.filter((x) => x.isActive).map((x) => {
              const rule = ruleText(x.nationalityRule, x.nationalityCodes);
              return { value: x.id, label: `${typeLabel(x)}${rule ? ` · ${rule}` : ''}` };
            })} />
          </Form.Item>
          {recordTemplate && <TrackingFields defs={recordTemplate.fieldDefs} />}
        </Form>
      </Modal>
      <Table<CredentialRow>
        rowKey="id" size="middle" loading={rows.isLoading} dataSource={rows.data?.items} pagination={{ pageSize: 20 }} scroll={{ x: true }}
        columns={[
          { title: t('employee'), render: (_, r) => `${r.employee.jobNumber} — ${r.employee.fullName}` },
          { title: t('credential'), render: (_, r) => typeLabel(r.template) },
          { title: t('status'), render: (_, r) => <Space size={4} wrap><CredentialStatusTag status={r.status} /><LifecycleTag label={r.lifecycle} />{r.personalDataErased && <Tag color="purple">{t('personalDataErased')}</Tag>}{r.graceExpiryDate && <Tag color="gold">{t('graceUntil', { date: r.graceExpiryDate })}</Tag>}</Space> },
          { title: t('issueDate'), dataIndex: 'issueDate' },
          { title: t('expiryDate'), render: (_, r) => r.expiryDate ? `${r.expiryDate}${r.expiryDateHijri ? ` (${r.expiryDateHijri} هـ)` : ''}` : '—' },
          ...(hr ? [{
            title: '', render: (_: unknown, r: CredentialRow) => (
              <Flex gap={4} wrap>
                <Button size="small" onClick={() => setDocsFor(r.id)}>{t('evidence')}</Button>
                {scfhsTypes.has(r.templateId) && <Button size="small" onClick={() => setScfhsFor({ id: r.id, title: `${r.template.code} · ${r.employee.fullName}` })}>{t('scfhsButton')}</Button>}
                {r.status === 'PendingVerification' && <Button size="small" type="primary" onClick={() => run(action.mutateAsync({ kind: 'verify', id: r.id }))}>{t('verify')}</Button>}
                {(r.pendingData || (r.documentsPendingReview ?? 0) > 0) && r.status !== 'PendingVerification' && (
                  <>
                    <Popconfirm title={t('approveRenewal')} onConfirm={() => run(action.mutateAsync({ kind: 'approve', id: r.id }))}><Button size="small" type="primary">{t('approveRenewal')}</Button></Popconfirm>
                    <Button size="small" onClick={() => setDecision({ kind: 'reject', row: r })}>{t('rejectRenewal')}</Button>
                  </>
                )}
                {r.status !== 'Revoked' && r.status !== 'Suspended' && <Button size="small" danger onClick={() => setDecision({ kind: 'suspend', row: r })}>{t('suspend')}</Button>}
                {r.status !== 'Revoked' && <Button size="small" danger onClick={() => setDecision({ kind: 'revoke', row: r })}>{t('revoke')}</Button>}
              </Flex>
            ),
          }] : []),
        ]}
      />
      <DocumentsDrawer credentialId={docsFor} onClose={() => setDocsFor(null)} canUpload={hr} />
      <ScfhsDrawer credential={scfhsFor} onClose={() => setScfhsFor(null)} />
      <Modal
        title={decision ? `${t(decision.kind === 'reject' ? 'rejectRenewal' : decision.kind)} — ${decision.row.template.code} · ${decision.row.employee.fullName}` : ''}
        open={decision !== null} onCancel={() => setDecision(null)} cancelText={t('cancel')} okText={t('submit')}
        okButtonProps={{ danger: true, disabled: reason.trim().length === 0, loading: action.isPending }}
        onOk={async () => {
          if (!decision) return;
          await run(action.mutateAsync({ kind: decision.kind, id: decision.row.id, reason }));
          setDecision(null); setReason('');
        }}
        destroyOnHidden
      >
        <Input.TextArea rows={3} placeholder={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Modal>
    </>
  );
}

function RequirementsTab() {
  const positions = usePositions();
  const { t } = useTranslation();
  const { typeLabel } = useTypeLabels();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const reqs = useRequirements();
  const templates = useTemplates();
  const units = useUnits();
  const action = useCredentialAction();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const policy = Form.useWatch('policyStatus', form);

  async function add(v: { templateId: number; unitId: number; positionCode?: string; policyStatus: string; transitionDeadline?: { format: (f: string) => string } }) {
    try {
      const res = await action.mutateAsync({ kind: 'requirement', body: {
        templateId: v.templateId, unitId: v.unitId, positionCode: v.positionCode?.trim() || null, policyStatus: v.policyStatus,
        transitionDeadline: v.policyStatus === 'TRANSITION' && v.transitionDeadline ? v.transitionDeadline.format('YYYY-MM-DD') : null,
      } }) as { affectedEmployees: number };
      message.success(t('requirementSaved', { count: res.affectedEmployees }));
      setOpen(false); form.resetFields();
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <>
      {hr && <Button type="primary" style={{ marginBottom: 12 }} onClick={() => setOpen(true)}>{t('addRequirement')}</Button>}
      <Table<Requirement>
        rowKey="id" size="middle" loading={reqs.isLoading} dataSource={reqs.data?.items} pagination={{ pageSize: 25 }} scroll={{ x: true }}
        columns={[
          { title: t('unit'), render: (_, r) => `${r.unit.code} — ${r.unit.name}` },
          { title: t('position'), render: (_, r) => r.positionCode ?? <Tag>{t('allPositions')}</Tag> },
          { title: t('credential'), render: (_, r) => typeLabel(r.template) },
          { title: t('policy'), render: (_, r) => <Tag color={r.policyStatus === 'MANDATORY' ? 'red' : r.policyStatus === 'TRANSITION' ? 'orange' : 'default'}>{r.policyStatus}{r.transitionDeadline ? ` · ${r.transitionDeadline.slice(0, 10)}` : ''}</Tag> },
          ...(hr ? [{
            title: '', render: (_: unknown, r: Requirement) => (
              <Popconfirm title={t('deleteRequirement')} onConfirm={async () => { try { await action.mutateAsync({ kind: 'requirementDelete', id: r.id }); message.success(t('saved')); } catch (e) { message.error(describeApiError(e)); } }}>
                <Button size="small" danger>{t('delete')}</Button>
              </Popconfirm>
            ),
          }] : []),
        ]}
      />
      <Modal title={t('addRequirement')} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} okText={t('create')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={add} initialValues={{ policyStatus: 'MANDATORY' }}>
          <Form.Item name="unitId" label={t('unit')} rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={units.data?.items.map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))} />
          </Form.Item>
          <Form.Item name="positionCode" label={t('position')} extra={t('positionBlankHint')}>
            <Select allowClear showSearch optionFilterProp="label" options={positions.data?.items.map((p) => ({ value: p.code, label: `${p.code} — ${p.title}` }))} />
          </Form.Item>
          <Form.Item name="templateId" label={t('credential')} rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={templates.data?.items.filter((x) => x.isActive).map((x) => ({ value: x.id, label: typeLabel(x) }))} />
          </Form.Item>
          <Form.Item name="policyStatus" label={t('policy')}>
            <Select options={['MANDATORY', 'TRANSITION', 'OPTIONAL'].map((p) => ({ value: p, label: p }))} />
          </Form.Item>
          {policy === 'TRANSITION' && (
            <Form.Item name="transitionDeadline" label={t('transitionDeadline')} rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}

/** Categories group credential types; every change goes to a second system-wide administrator (P8). */
function CategoriesTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const categories = useCategories();
  const action = useCredentialAction();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [form] = Form.useForm<{ code?: string; name: string; description?: string | null; displayOrder: number; reason: string }>();

  async function submit(v: { code?: string; name: string; description?: string | null; displayOrder: number; reason: string }) {
    try {
      const out = editing === 'new'
        ? await action.mutateAsync({ kind: 'categoryCreate', body: { ...v, description: v.description || undefined } })
        : await action.mutateAsync({ kind: 'categoryUpdate', code: (editing as Category).code, body: { name: v.name, description: v.description || null, displayOrder: v.displayOrder, reason: v.reason } });
      const o = out as { status: string; requestId?: number };
      if (o.status === 'PENDING_APPROVAL') message.info(t('submittedForApproval', { id: o.requestId }), 6);
      else message.success(t('saved'));
      setEditing(null);
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <>
      <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 12 }}>
        <Alert type="info" showIcon title={t('categoriesFourEyes')} style={{ flex: 1 }} />
        {hr && <Button type="primary" onClick={() => { form.resetFields(); setEditing('new'); }}>{t('addCategory')}</Button>}
      </Flex>
      <Table<Category>
        rowKey="code" size="middle" loading={categories.isLoading} dataSource={categories.data?.items} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('displayOrder'), dataIndex: 'displayOrder', width: 90 },
          { title: t('code'), dataIndex: 'code' },
          { title: t('name'), dataIndex: 'name' },
          { title: t('description'), dataIndex: 'description', ellipsis: true },
          ...(hr ? [{ title: '', render: (_: unknown, c: Category) => <Button size="small" onClick={() => { form.setFieldsValue({ name: c.name, description: c.description, displayOrder: c.displayOrder, reason: '' }); setEditing(c); }}>{t('edit')}</Button> }] : []),
        ]}
      />
      <Modal title={editing === 'new' ? t('addCategory') : editing ? `${t('edit')}: ${editing.code}` : ''} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} forceRender>
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ displayOrder: 0 }}>
          {editing === 'new' && <Form.Item name="code" label={t('code')} rules={[{ required: true, pattern: /^[A-Z][A-Z0-9_]{1,39}$/ }]}><Input maxLength={40} /></Form.Item>}
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
          <Form.Item name="description" label={t('description')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Form.Item name="displayOrder" label={t('displayOrder')}><InputNumber min={0} precision={0} /></Form.Item>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 10, whitespace: true }]}><Input.TextArea rows={3} maxLength={1000} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

/**
 * Catalog changes — new credential types included — go to a second
 * system-wide administrator before they apply (D-24). An edit sends only what
 * changed, so the approver sees exactly the change.
 */
function CatalogTab() {
  const { t } = useTranslation();
  const { typeName, fieldLabel } = useTypeLabels();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const templates = useTemplates();
  const categories = useCategories();
  const action = useCredentialAction();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [form] = Form.useForm<TemplateFormValues>();
  const rows = Form.useWatch('fields', form);
  const scfhsOn = Form.useWatch('scfhsEnabled', form) === true;
  const nationalityRule = Form.useWatch('nationalityRule', form) ?? 'ALL';

  function open(x: Template | 'new') {
    form.resetFields();
    if (x !== 'new') form.setFieldsValue(toFormValues(x));
    setEditing(x);
  }

  async function submit(v: TemplateFormValues) {
    if (!editing) return;
    const body = editing === 'new' ? createBody(v) : changeBody(editing, v);
    try {
      const out = editing === 'new'
        ? await action.mutateAsync({ kind: 'templateCreate', body })
        : await action.mutateAsync({ kind: 'template', id: editing.id, body });
      const o = out as { status: string; requestId?: number };
      if (o.status === 'PENDING_APPROVAL') message.info(t('submittedForApproval', { id: o.requestId }), 6);
      else message.success(t('saved'));
      setEditing(null);
    } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <>
      <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 12 }}>
        <Alert type="info" showIcon title={t('catalogFourEyes')} style={{ flex: 1 }} />
        {hr && <Button type="primary" onClick={() => open('new')}>{t('addCredentialType')}</Button>}
      </Flex>
      <Table<Template>
        rowKey="id" size="middle" loading={templates.isLoading} dataSource={templates.data?.items} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('code'), dataIndex: 'code' },
          { title: t('credential'), render: (_, x) => typeName(x) },
          { title: t('category'), dataIndex: 'categoryCode' },
          { title: t('fields'), render: (_, x) => x.fieldDefs.map(fieldLabel).join(', ') || '—', ellipsis: true },
          { title: t('graceDays'), dataIndex: 'gracePeriodDays' },
          { title: t('status'), render: (_, x) => <Space size={4} wrap><Tag color={x.isActive ? 'green' : 'default'}>{x.isActive ? t('active') : t('inactive')}</Tag>{x.scfhsEnabled && <Tag color="blue">{x.scfhsAutoSuspend ? t('scfhsCheckedAutoTag') : t('scfhsCheckedTag')}</Tag>}<NationalityRuleTag rule={x.nationalityRule} codes={x.nationalityCodes} /></Space> },
          ...(hr ? [{ title: '', render: (_: unknown, x: Template) => <Button size="small" onClick={() => open(x)}>{t('edit')}</Button> }] : []),
        ]}
      />
      <Modal title={editing === 'new' ? t('addCredentialType') : editing ? `${t('edit')}: ${editing.code}` : ''} open={editing !== null} onCancel={() => setEditing(null)}
        onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} width={900} forceRender>
        <Form form={form} layout="vertical" onFinish={submit}
          initialValues={{ hasExpiry: true, requiresUpload: true, gracePeriodDays: 0, displayOrder: 0, isActive: true, fields: [], scfhsEnabled: false, scfhsAutoSuspend: false, nationalityRule: 'ALL', nationalityCodes: [] }}>
          <Flex gap={12} wrap>
            {editing === 'new' && <Form.Item name="code" label={t('code')} style={{ minWidth: 180 }} rules={[{ required: true, pattern: /^[A-Z][A-Z0-9_]{1,39}$/ }]}><Input maxLength={40} /></Form.Item>}
            <Form.Item name="name" label={t('name')} style={{ flex: 1, minWidth: 220 }} rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>
            <Form.Item name="nameAr" label={t('nameArabic')} style={{ flex: 1, minWidth: 220 }}><Input maxLength={120} dir="rtl" /></Form.Item>
            <Form.Item name="categoryCode" label={t('category')} style={{ minWidth: 220 }} rules={[{ required: true }]}>
              <Select showSearch optionFilterProp="label" options={categories.data?.items.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} />
            </Form.Item>
          </Flex>
          <Form.Item name="description" label={t('description')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="hasExpiry" label={t('hasExpiry')} valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="requiresUpload" label={t('requiresUpload')} valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="gracePeriodDays" label={t('graceDays')} rules={[{ required: true }]}><InputNumber min={0} max={90} precision={0} /></Form.Item>
            <Form.Item name="displayOrder" label={t('displayOrder')}><InputNumber min={0} precision={0} /></Form.Item>
            {editing !== 'new' && <Form.Item name="isActive" label={t('status')} valuePropName="checked"><Switch checkedChildren={t('active')} unCheckedChildren={t('inactive')} /></Form.Item>}
          </Flex>
          <Flex gap={16} wrap>
            <Form.Item name="scfhsEnabled" label={t('scfhsEnabled')} valuePropName="checked" tooltip={t('scfhsEnabledHint')}><Switch /></Form.Item>
            <Form.Item name="scfhsAutoSuspend" label={t('scfhsAutoSuspend')} valuePropName="checked" tooltip={t('scfhsAutoSuspendHint')}><Switch disabled={!scfhsOn} /></Form.Item>
          </Flex>
          <Flex gap={16} wrap>
            <Form.Item name="nationalityRule" label={t('nationalityRule')} tooltip={t('nationalityRuleHint')} style={{ minWidth: 280 }}>
              <Select options={NATIONALITY_RULES.map((r) => ({ value: r, label: t(`nationalityRule_${r}`) }))} />
            </Form.Item>
            {nationalityRule !== 'ALL' && (
              <Form.Item name="nationalityCodes" label={t('nationalityCodes')} style={{ flex: 1, minWidth: 260 }}
                rules={[{ required: true, type: 'array', min: 1, message: t('nationalityCodesRequired') }]}>
                <NationalitySelect<string[]> mode="multiple" allowClear />
              </Form.Item>
            )}
          </Flex>
          <Form.List
            name="fields"
            rules={[{
              validator: async (_, list?: FieldRowValue[]) => {
                const problems = fieldProblems(list);
                if (problems.length) throw new Error(problems.map((p) => t(p)).join(' '));
              },
            }]}
          >
            {(items, { add, remove, move }, { errors }) => (
              <Card size="small" title={t('fields')} style={{ marginBottom: 16 }}
                extra={<Button size="small" disabled={items.length >= 30} onClick={() => add({ key: '', label: '', labelAr: '', type: 'text', required: false })}>{t('addField')}</Button>}>
                <Alert type="info" showIcon title={t('fieldsChangeHint')} style={{ marginBottom: 8 }} />
                {items.map((item, i) => {
                  const dateField = isDateType(rows?.[item.name]?.type);
                  return (
                    <Flex key={item.key} gap={8} wrap align="start">
                      <Form.Item name={[item.name, 'key']} label={i === 0 ? t('fieldKey') : undefined} style={{ width: 150 }}
                        rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{0,49}$/, message: t('fieldKeyInvalid') }]}><Input maxLength={50} /></Form.Item>
                      <Form.Item name={[item.name, 'label']} label={i === 0 ? t('fieldLabel') : undefined} style={{ flex: 1, minWidth: 160 }}
                        rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item>
                      <Form.Item name={[item.name, 'labelAr']} label={i === 0 ? t('fieldLabelArabic') : undefined} style={{ flex: 1, minWidth: 160 }}><Input maxLength={100} dir="rtl" /></Form.Item>
                      <Form.Item name={[item.name, 'type']} label={i === 0 ? t('fieldType') : undefined} style={{ width: 170 }}>
                        <Select options={FIELD_TYPES.map((x) => ({ value: x, label: t(`fieldType_${x}`) }))} />
                      </Form.Item>
                      <Form.Item name={[item.name, 'required']} label={i === 0 ? t('fieldRequired') : undefined} valuePropName="checked"><Switch size="small" /></Form.Item>
                      <Form.Item name={[item.name, 'isIssueDate']} label={i === 0 ? t('fieldIssueDate') : undefined} valuePropName="checked"><Switch size="small" disabled={!dateField} /></Form.Item>
                      <Form.Item name={[item.name, 'isExpiryDate']} label={i === 0 ? t('fieldExpiryDate') : undefined} valuePropName="checked"><Switch size="small" disabled={!dateField} /></Form.Item>
                      <Form.Item name={[item.name, 'pdplCategory']} label={i === 0 ? t('fieldSensitive') : undefined} tooltip={i === 0 ? t('fieldSensitiveHint') : undefined} style={{ width: 160 }}>
                        <Select allowClear disabled={rows?.[item.name]?.type !== 'text'} placeholder="—" options={PDPL_CATEGORIES.map((c) => ({ value: c, label: t(`pdpl_${c}`) }))} />
                      </Form.Item>
                      <Space size={4} style={{ marginTop: i === 0 ? 30 : 0 }}>
                        <Button size="small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('moveUp')}>↑</Button>
                        <Button size="small" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={t('moveDown')}>↓</Button>
                        <Button size="small" danger onClick={() => remove(item.name)}>{t('removeField')}</Button>
                      </Space>
                    </Flex>
                  );
                })}
                <Form.ErrorList errors={errors} />
              </Card>
            )}
          </Form.List>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 10, whitespace: true }]}><Input.TextArea rows={3} maxLength={1000} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default function CredentialsPage() {
  const { t } = useTranslation();
  const { hasRole } = usePermissions();
  const hr = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  return (
    <Card title={<>{t('credentials')} <GuideHelp section="credentials" /></>}>
      <Tabs
        destroyOnHidden
        items={[
          { key: 'records', label: t('records'), children: <RecordsTable /> },
          ...(hr ? [{ key: 'queue', label: t('reviewQueue'), children: <RecordsTable queue="review" /> }] : []),
          { key: 'requirements', label: t('requirements'), children: <RequirementsTab /> },
          { key: 'catalog', label: t('catalog'), children: <CatalogTab /> },
          { key: 'categories', label: t('categories'), children: <CategoriesTab /> },
        ]}
      />
    </Card>
  );
}
