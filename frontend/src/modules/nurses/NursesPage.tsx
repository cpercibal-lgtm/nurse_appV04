// Employee master (spec §3.1, §8.1). HR sees and maintains every field within
// scope; a Supervisor sees the baseline (the server leaves private fields out;
// owner list D-36).
// Onboarding creates the employee and a Draft contract together (D-3): the
// nurse has no coverage until another HR person approves the contract.

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Descriptions, Drawer, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { toHijriShort } from '../../lib/hijri';
import { phoneRule } from '../../lib/phone';
import { useUnits } from '../administration/api';
import { usePositions } from '../workforce/api';
import { useContractTypes } from '../contracts/api';
import { NationalitySelect } from '../../components/NationalitySelect';
import { RankGradePicker, rankGradeLabel } from '../../components/RankGradePicker';
import { SpecialtySelect, specialtyLabel } from '../../components/SpecialtySelect';
import { JobPostPicker, jobPostLabel, type JobPostValue } from '../../components/JobPostPicker';
import { FacilityField, facilityLabel } from '../../components/FacilityField';
import { useEmployee, useEmployeeAction, useEmployees, useInvitations, useInviteEmployee, useOnboardingDefaults, type EmployeeRow } from './api';

import { GuideHelp } from '../guidelines/GuideHelp';
import { AssignDialog, NurseContextMenu, type AssignMode } from './AssignDialog';
import { keyAfterError } from '../../lib/idempotency';
const OPTIONAL_TEXT = ['middleName', 'jobTitle', 'fileNo', 'primaryPhone', 'emergencyContactPhone'] as const;

/** Form values → API body: empty strings become null, dates YYYY-MM-DD. */
function toBody(v: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    // Job Post (City): the picker's { regionCode, cityId } becomes the two API fields.
    if (k === 'jobPost') { const j = val as JobPostValue | null; if (j) { out.jobPostRegionCode = j.regionCode; out.jobPostCityId = j.cityId; } continue; }
    if (dayjs.isDayjs(val)) out[k] = (val as Dayjs).format('YYYY-MM-DD');
    else if (val === '' && (OPTIONAL_TEXT as readonly string[]).includes(k)) out[k] = null;
    else out[k] = val;
  }
  return out;
}

/** Fields 4–15 in the order of spec §3.1, plus placement. */
function EmployeeFields({ units, positions, onboarding, legacyNationality, legacyRankGrade, legacySpecialty, legacyJobPost, legacyFacility, savedFacilityId }: {
  units: Array<{ value: number | null; label: string }>; positions: Array<{ value: string; label: string }>; onboarding: boolean;
  legacyNationality?: string | null; legacyRankGrade?: string | null; legacySpecialty?: string | null; legacyJobPost?: string | null;
  legacyFacility?: string | null; savedFacilityId?: number | null;
}) {
  const { systemWideAdmin } = usePermissions();
  const { t, i18n } = useTranslation();
  const types = useContractTypes(false, onboarding); // owner decision 2026-10-03: the Draft contract's type
  const start = Form.useWatch('contractStart');
  const end = Form.useWatch('contractEnd');
  return (
    <>
      <Flex gap={8}>
        <Form.Item name="firstName" label={t('firstName')} rules={[{ required: true, whitespace: true }]} style={{ flex: 1 }}><Input maxLength={80} /></Form.Item>
        <Form.Item name="middleName" label={t('middleName')} style={{ flex: 1 }}><Input maxLength={80} /></Form.Item>
        <Form.Item name="lastName" label={t('lastName')} rules={[{ required: true, whitespace: true }]} style={{ flex: 1 }}><Input maxLength={80} /></Form.Item>
      </Flex>
      <Form.Item name="jobNumber" label={t('jobNumber')} extra={t('jobNumberHint')} rules={[{ required: true, whitespace: true }]}><Input maxLength={40} /></Form.Item>
      <Form.Item name="jobTitle" label={t('jobTitle')}><Input maxLength={120} /></Form.Item>
      <Form.Item name="fileNo" label={t('fileNo')}><Input maxLength={40} /></Form.Item>
      <Form.Item name="rankGradeCode" label={t('rankGrade')} rules={[{ required: true, message: t('rankGradeRequired') }]}
        extra={legacyRankGrade ? t('rankGradeLegacy', { value: legacyRankGrade }) : undefined}>
        <RankGradePicker />
      </Form.Item>
      <Form.Item name="nationalityCode" label={t('nationality')} rules={[{ required: true, message: t('nationalityRequired') }]}
        extra={legacyNationality ? t('nationalityLegacy', { value: legacyNationality }) : undefined}>
        <NationalitySelect />
      </Form.Item>
      <Form.Item name="jobPost" label={t('jobPostLocation')} rules={[{ required: true, message: t('jobPostRequired') }]}
        extra={legacyJobPost ? t('jobPostLegacy', { value: legacyJobPost }) : undefined}>
        <JobPostPicker />
      </Form.Item>
      <Form.Item name="facilityId" label={t('actualWorkPlace')} rules={[{ required: true, message: t('facilityRequired') }]}
        extra={legacyFacility ? t('facilityLegacy', { value: legacyFacility }) : undefined}>
        <FacilityField canManage={systemWideAdmin} savedId={savedFacilityId ?? null} />
      </Form.Item>
      <Form.Item name="specialtyCode" label={t('specialty')} rules={[{ required: true, message: t('specialtyRequired') }]}
        extra={legacySpecialty ? t('specialtyLegacy', { value: legacySpecialty }) : undefined}>
        <SpecialtySelect />
      </Form.Item>
      {onboarding && (
        <Form.Item name="contractTypeCode" label={t('contractType')} rules={[{ required: true, message: t('contractTypeRequired') }]}>
          <Select placeholder={t('contractTypeSelect')} loading={types.isLoading}
            options={(types.data?.items ?? []).map((x) => ({ value: x.code, label: i18n.language === 'ar' && x.nameAr ? x.nameAr : x.name }))} />
        </Form.Item>
      )}
      {onboarding && (
        <Flex gap={8}>
          <Form.Item name="contractStart" label={t('contractStart')} extra={start ? toHijriShort(start) : undefined} rules={[{ required: true }]} style={{ flex: 1 }}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="contractEnd" label={t('contractEnd')} extra={end ? toHijriShort(end) : undefined} rules={[{ required: true }]} style={{ flex: 1 }}><DatePicker style={{ width: '100%' }} /></Form.Item>
        </Flex>
      )}
      <Form.Item name="maritalStatus" label={t('maritalStatus')}>
        <Select allowClear options={['Single', 'Married', 'Others'].map((m) => ({ value: m, label: t(`marital_${m}`) }))} />
      </Form.Item>
      <Form.Item name="salary" label={t('salarySar')}><InputNumber min={0} precision={2} style={{ width: '100%' }} stringMode /></Form.Item>
      <Form.Item name="unitId" label={t('unit')}><Select options={units} /></Form.Item>
      {onboarding && <Form.Item name="positionCode" label={t('position')} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={positions} /></Form.Item>}
      <Form.Item name="contactEmail" label={t('contactEmail')} rules={[{ required: true, type: 'email' }]}><Input maxLength={200} /></Form.Item>
      <Flex gap={8}>
        <Form.Item name="primaryPhone" label={t('primaryPhone')} extra={t('phoneHint')} rules={[phoneRule(t('phoneInvalid'))]} style={{ flex: 1 }}><Input maxLength={24} dir="ltr" /></Form.Item>
        <Form.Item name="emergencyContactPhone" label={t('emergencyContactPhone')} extra={t('emergencyPhoneHint')} rules={[phoneRule(t('phoneInvalid'))]} style={{ flex: 1 }}><Input maxLength={24} dir="ltr" /></Form.Item>
      </Flex>
      <Form.Item name="hireDate" label={t('hireDate')}><DatePicker style={{ width: '100%' }} /></Form.Item>
    </>
  );
}

export default function NursesPage() {
  const { t, i18n } = useTranslation();
  const { message, modal } = App.useApp();
  const { hasRole } = usePermissions();
  const canWrite = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const canAssignPosition = hasRole('HR_ADMIN'); // E9
  const canAssign = hasRole('HR_ADMIN', 'SYSTEM_ADMIN'); // owner decision 2026-10-05: right-click menu, administrators only
  const [menu, setMenu] = useState<{ x: number; y: number; row: EmployeeRow } | null>(null);
  const [assigning, setAssigning] = useState<{ row: EmployeeRow; mode: AssignMode } | null>(null);
  const [filter, setFilter] = useState<{ q?: string; unitId?: number; page: number }>({ page: 1 });
  const employees = useEmployees(filter);
  const units = useUnits();
  const positions = usePositions();
  const action = useEmployeeAction();
  const [onboarding, setOnboarding] = useState<string | null>(null); // idempotency key while open
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const defaults = useOnboardingDefaults(canWrite);
  const [moving, setMoving] = useState(false);
  const detail = useEmployee(selected);
  const [onboardForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [positionForm] = Form.useForm<{ positionCode: string; reason: string }>();

  const unitOptions = [{ value: null, label: t('unassigned') }, ...(units.data?.items ?? []).map((u) => ({ value: u.id as number | null, label: `${u.code} — ${u.name}` }))];
  const positionOptions = (positions.data?.items ?? []).map((p) => ({ value: p.code, label: `${p.code} — ${i18n.language === 'ar' && p.titleAr ? p.titleAr : p.title}` }));

  async function run<T>(a: Parameters<typeof action.mutateAsync>[0], ok: string): Promise<T | undefined> {
    try { const out = await action.mutateAsync(a); message.success(ok); return out as T; } catch (e) {
      if (a.kind === 'onboard') setOnboarding((k) => (k ? keyAfterError(k, e) : k)); // a refusal is not replayed on the next submit
      message.error(describeApiError(e)); return undefined;
    }
  }

  const e = detail.data;
  return (
    <Card title={<>{t('nurses')} <GuideHelp section="nurses" /></>} extra={canWrite && <Button type="primary" onClick={() => { onboardForm.resetFields(); setOnboarding(crypto.randomUUID()); }}>{t('onboardEmployee')}</Button>}>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search aria-label={t('searchJobOrName')} allowClear placeholder={t('searchJobOrName')} style={{ width: 280 }} onSearch={(q) => setFilter({ ...filter, q: q || undefined, page: 1 })} />
        <Select aria-label={t('unit')} allowClear placeholder={t('unit')} style={{ width: 260 }} showSearch optionFilterProp="label"
          options={(units.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))}
          onChange={(v) => setFilter({ ...filter, unitId: v ?? undefined, page: 1 })} />
      </Flex>
      <Table<EmployeeRow>
        rowKey="id" loading={employees.isLoading} dataSource={employees.data?.items} scroll={{ x: true }}
        pagination={{ current: filter.page, pageSize: 50, total: employees.data?.total, onChange: (page) => setFilter({ ...filter, page }) }}
        onRow={(r) => ({
          onClick: () => setSelected(r.id), style: { cursor: 'pointer' },
          // Administrators: right-click (mouse, desktop or laptop) opens the assign menu; everyone else keeps the browser's menu.
          onContextMenu: canAssign ? (ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, row: r }); } : undefined,
        })}
        columns={[
          { title: t('jobNumber'), dataIndex: 'jobNumber' },
          { title: t('name'), dataIndex: 'fullName' },
          { title: t('unit'), render: (_, r) => r.unit?.code ?? <Tag>{t('unassigned')}</Tag> },
          { title: t('position'), render: (_, r) => r.position.title },
          { title: t('jobTitle'), dataIndex: 'jobTitle' },
          { title: t('status'), render: (_, r) => <Tag color={r.status === 'Active' ? 'green' : 'default'}>{r.status}</Tag> },
        ]}
      />

      {menu && (
        <NurseContextMenu at={{ x: menu.x, y: menu.y }} row={menu.row} onClose={() => setMenu(null)}
          onPick={(choice) => { const row = menu.row; setMenu(null); if (choice === 'open') setSelected(row.id); else setAssigning({ row, mode: choice }); }} />
      )}
      {assigning && <AssignDialog row={assigning.row} mode={assigning.mode} onClose={() => setAssigning(null)} />}
      <Drawer title={t('onboardEmployee')} open={onboarding !== null} onClose={() => setOnboarding(null)} size={640} destroyOnHidden>
        <Alert type="info" showIcon title={t('onboardHint')} style={{ marginBottom: 12 }} />
        <Form form={onboardForm} layout="vertical" initialValues={{ unitId: null, positionCode: defaults.data?.positionCode ?? undefined }} onFinish={async (v) => {
          const out = await run<{ employeeId: number; contractId: number }>({ kind: 'onboard', body: toBody(v), key: onboarding! }, t('onboarded'));
          if (out) { setOnboarding(null); setSelected(out.employeeId); }
        }}>
          <EmployeeFields units={unitOptions} positions={positionOptions} onboarding />
          <Button type="primary" htmlType="submit" loading={action.isPending}>{t('submit')}</Button>
        </Form>
      </Drawer>

      <Drawer title={e ? `${e.jobNumber} — ${e.fullName}` : ''} open={selected !== null} onClose={() => { setSelected(null); setEditing(false); }} size={640} destroyOnHidden
        extra={e?.view === 'FULL' && canWrite && !editing && (
          <Space>
            <Button onClick={() => {
              editForm.setFieldsValue({ ...e, hireDate: e.hireDate ? dayjs(e.hireDate) : undefined, jobPost: e.jobPostRegionCode && e.jobPostCityId ? { regionCode: e.jobPostRegionCode, cityId: e.jobPostCityId } : undefined });
              setEditing(true);
            }}>{t('edit')}</Button>
            {canAssignPosition && <Button onClick={() => { positionForm.setFieldsValue({ positionCode: e.positionCode, reason: '' }); setMoving(true); }}>{t('changePosition')}</Button>}
            <Button danger onClick={() => {
              let reason = '';
              modal.confirm({
                title: t('deleteEmployee'), okText: t('delete'), okButtonProps: { danger: true }, cancelText: t('cancel'),
                content: <Input.TextArea rows={3} placeholder={t('deleteReasonHint')} onChange={(ev) => { reason = ev.target.value; }} />,
                onOk: async () => { if (await run({ kind: 'delete', id: e.id, reason }, t('saved')) !== undefined) setSelected(null); },
              });
            }}>{t('delete')}</Button>
          </Space>
        )}>
        {e && !editing && (
          <>
            {e.view === 'BASELINE' && <Alert type="info" showIcon title={t('baselineView')} style={{ marginBottom: 12 }} />}
            <Descriptions column={1} size="small" bordered items={[
              ['jobNumber', e.jobNumber], ['name', e.fullName], ['unit', e.unit ? `${e.unit.code} — ${e.unit.name}` : t('unassigned')],
              ['position', `${e.position.code} — ${e.position.title}`], ['jobTitle', e.jobTitle], ['specialty', e.specialtyName ? specialtyLabel({ name: e.specialtyName, nameAr: e.specialtyNameAr }, i18n.language === 'ar')
                : e.specialty ? `${e.specialty} — ${t('specialtyUnmatched')}` : null], ['hireDate', e.hireDate],
              ['actualWorkPlace', e.facilityName ? facilityLabel({ name: e.facilityName, nameAr: e.facilityNameAr ?? null }, i18n.language === 'ar')
                : e.actualWorkPlace ? `${e.actualWorkPlace} — ${t('facilityUnmatched')}` : null], ['contactEmail', e.contactEmail], ['primaryPhone', e.primaryPhone],
              ...(e.view === 'FULL' ? [
                ['emergencyContactPhone', e.emergencyContactPhone],
                ['fileNo', e.fileNo], ['rankGrade', e.rankGradeCode ? rankGradeLabel(e.rankGradeCode, e.rankGradeName) : e.rankGrade ? `${e.rankGrade} — ${t('rankGradeUnmatched')}` : null],
                ['nationality', e.nationalityName ? (i18n.language === 'ar' && e.nationalityNameAr ? e.nationalityNameAr : e.nationalityName)
                  : e.nationality ? `${e.nationality} — ${t('nationalityUnmatched')}` : null],
                ['jobPostLocation', e.jobPostCityName && e.jobPostRegionName
                  ? jobPostLabel({ name: e.jobPostRegionName, nameAr: e.jobPostRegionNameAr ?? null }, { name: e.jobPostCityName, nameAr: e.jobPostCityNameAr ?? null }, i18n.language === 'ar')
                  : e.jobPostLocation ? `${e.jobPostLocation} — ${t('jobPostUnmatched')}` : null],
                ['maritalStatus', e.maritalStatus ? t(`marital_${e.maritalStatus}`) : null], ['salarySar', e.salary],
              ] : []),
            ].map(([k, v]) => ({ key: k as string, label: t(k as string), children: (v as string | null | undefined) ?? '—' }))} />
            {e.view === 'FULL' && canWrite && <AccountInvitation employeeId={e.id} />}
          </>
        )}
        {e && editing && (
          <Form form={editForm} layout="vertical" onFinish={async (v) => {
            if (await run({ kind: 'update', id: e.id, body: toBody(v) }, t('saved')) !== undefined) setEditing(false);
          }}>
            <EmployeeFields units={unitOptions} positions={positionOptions} onboarding={false} legacyNationality={e.nationalityCode ? null : e.nationality} legacyRankGrade={e.rankGradeCode ? null : e.rankGrade} legacySpecialty={e.specialtyCode ? null : e.specialty} legacyJobPost={e.jobPostCityId ? null : e.jobPostLocation}
              legacyFacility={e.facilityId ? null : e.actualWorkPlace} savedFacilityId={e.facilityId ?? null} />
            <Space><Button type="primary" htmlType="submit" loading={action.isPending}>{t('submit')}</Button><Button onClick={() => setEditing(false)}>{t('cancel')}</Button></Space>
          </Form>
        )}
      </Drawer>

      <Modal title={t('changePosition')} open={moving} onCancel={() => setMoving(false)} onOk={() => positionForm.submit()} okText={t('submit')} cancelText={t('cancel')}
        confirmLoading={action.isPending} forceRender>
        <Form form={positionForm} layout="vertical" onFinish={async (v) => {
          if (e && await run({ kind: 'position', id: e.id, ...v }, t('saved')) !== undefined) setMoving(false);
        }}>
          <Form.Item name="positionCode" label={t('position')} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={positionOptions} /></Form.Item>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 3, whitespace: true }]}><Input maxLength={500} /></Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/** Spec §3.2: HR invites the employee to create their own login; the link travels only by e-mail. */
function AccountInvitation({ employeeId }: { employeeId: number }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const invitations = useInvitations(employeeId, true);
  const invite = useInviteEmployee();
  const latest = invitations.data?.items[0];
  const claimed = latest?.status === 'CLAIMED';
  return (
    <Card size="small" title={t('loginAccount')} style={{ marginTop: 16 }}>
      <p style={{ marginTop: 0 }}>
        {latest
          ? t('invitationSummary', { status: t(`invitationStatus_${latest.status}`), sent: dayjs(latest.createdAt).format('YYYY-MM-DD HH:mm'), email: latest.email })
          : t('invitationNone')}
      </p>
      {!claimed && (
        <>
          <p style={{ color: 'var(--ant-color-text-secondary)' }}>{t('inviteHint')}</p>
          <Button type="primary" loading={invite.isPending} onClick={async () => {
            try {
              const out = await invite.mutateAsync(employeeId);
              message.success(t('inviteSent', { email: out.email }));
            } catch (err) { message.error(describeApiError(err)); }
          }}>{latest ? t('inviteResend') : t('inviteEmployee')}</Button>
        </>
      )}
    </Card>
  );
}
