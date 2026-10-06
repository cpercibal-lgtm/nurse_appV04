// Write, preview and send an announcement (D-69). Two steps: the form (saved as a
// draft), then who it reaches — counts from the server, whether a second
// administrator must approve, and when the last e-mail should go out.

import { useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, DatePicker, Descriptions, Drawer, Flex, Form, Input, InputNumber, Radio, Segmented, Select, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { keyAfterError } from '../../lib/idempotency';
import { useAllDepartments, useAllUnits, usePositions, useSpecialties } from '../workforce/api';
import {
  KINDS, usePeople, usePreview, useSaveDraft, useSubmit,
  type Announcement, type AnnouncementInput, type AnnouncementKind, type AudienceType, type Preview,
} from './api';

interface FormValues {
  kind: AnnouncementKind; title: string; body: string; titleAr?: string; bodyAr?: string; referenceNo?: string;
  startsAt?: Dayjs | null; endsAt?: Dayjs | null; location?: string; onlineUrl?: string; speaker?: string; ceHours?: number | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH'; audienceType: AudienceType; audienceIds: number[];
  roleFilter: string[]; positionFilter: string[]; specialtyFilter: string[]; expiresAt?: Dayjs | null;
}

const ROLES = ['HR_ADMIN', 'SUPERVISOR', 'SYSTEM_ADMIN'] as const;
const day = (iso: string | null | undefined) => (iso ? dayjs(iso) : null);

/** Starting values: a draft being edited, a copy of an earlier announcement, or a blank memo. */
function initialValues(from: Announcement | null): FormValues {
  if (!from) return { kind: 'MEMO', title: '', body: '', priority: 'LOW', audienceType: 'UNIT', audienceIds: [], roleFilter: [], positionFilter: [], specialtyFilter: [] };
  return {
    kind: from.kind, title: from.title, body: from.body, titleAr: from.titleAr ?? undefined, bodyAr: from.bodyAr ?? undefined, referenceNo: from.referenceNo ?? undefined,
    startsAt: day(from.startsAt), endsAt: day(from.endsAt), location: from.location ?? undefined, onlineUrl: from.onlineUrl ?? undefined,
    speaker: from.speaker ?? undefined, ceHours: from.ceHours, priority: from.priority === 'CRITICAL' ? 'HIGH' : from.priority,
    audienceType: from.audienceType, audienceIds: from.audienceIds, roleFilter: from.roleFilter, positionFilter: from.positionFilter,
    specialtyFilter: from.specialtyFilter, expiresAt: from.status === 'DRAFT' ? day(from.expiresAt) : null,
  };
}

/** Only the fields the kind uses are sent: the server refuses a memo with a date, a meeting with CE hours… */
function toInput(v: FormValues): AnnouncementInput {
  const event = v.kind !== 'MEMO';
  const text = (s: string | undefined) => (s?.trim() ? s.trim() : null);
  return {
    kind: v.kind, title: v.title.trim(), body: v.body.trim(), titleAr: text(v.titleAr), bodyAr: text(v.bodyAr), referenceNo: text(v.referenceNo),
    startsAt: event && v.startsAt ? v.startsAt.toISOString() : null, endsAt: event && v.endsAt ? v.endsAt.toISOString() : null,
    location: event ? text(v.location) : null, onlineUrl: event ? text(v.onlineUrl) : null,
    speaker: v.kind === 'SEMINAR' ? text(v.speaker) : null, ceHours: v.kind === 'SEMINAR' ? (v.ceHours ?? null) : null,
    priority: v.kind === 'MEMO' ? v.priority : v.priority === 'HIGH' ? 'MEDIUM' : v.priority,
    audienceType: v.audienceType, audienceIds: v.audienceType === 'HOSPITAL' ? [] : v.audienceIds,
    roleFilter: v.roleFilter, positionFilter: v.positionFilter, specialtyFilter: v.specialtyFilter,
    expiresAt: v.expiresAt ? v.expiresAt.endOf('day').toISOString() : null,
  };
}

export function ComposeDrawer({ open, draft, copyOf, onClose }: {
  open: boolean;
  /** An own draft to continue; null for a new announcement. */
  draft: Announcement | null;
  /** An earlier announcement whose text starts a new one. */
  copyOf: Announcement | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const ar = i18n.language === 'ar';
  const [form] = Form.useForm<FormValues>();
  const kind = Form.useWatch('kind', form) ?? 'MEMO';
  const audienceType = Form.useWatch('audienceType', form) ?? 'UNIT';
  const [id, setId] = useState<number | null>(draft?.id ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleLabels, setPeopleLabels] = useState<Map<number, string>>(new Map());
  const submitKey = useRef<string>(crypto.randomUUID());

  const save = useSaveDraft();
  const previewOf = usePreview();
  const submit = useSubmit();
  const people = usePeople(peopleQuery);
  const departments = useAllDepartments();
  const units = useAllUnits();
  const positions = usePositions();
  const specialties = useSpecialties(false);

  // What this sender may address (a UI hint: the server decides).
  const { hasRole, systemWideAdmin } = usePermissions();
  const roles = useAuth((s) => s.roles);
  const canDepartments = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');
  const unitOptions = useMemo(() => {
    const all = (units.data?.items ?? []).filter((u) => u.isActive);
    const grants = roles.filter((r) => (r.role === 'SUPERVISOR' || r.role === 'HR_ADMIN') || (r.role === 'SYSTEM_ADMIN' && hasRole('SYSTEM_ADMIN')));
    if (grants.some((g) => g.scopeType === 'SYSTEM')) return all;
    const unitIds = new Set(grants.filter((g) => g.scopeType === 'UNIT').flatMap((g) => g.scopeIds));
    const deptIds = new Set(grants.filter((g) => g.scopeType === 'DEPARTMENT').flatMap((g) => g.scopeIds));
    return all.filter((u) => unitIds.has(u.id) || deptIds.has(u.departmentId));
  }, [units.data, roles, hasRole]);
  const audiences: AudienceType[] = [...(systemWideAdmin ? ['HOSPITAL' as const] : []), ...(canDepartments ? ['DEPARTMENT' as const] : []), 'UNIT', 'PEOPLE'];
  const label = (name: string, nameAr: string | null) => (ar && nameAr ? nameAr : name);

  const personOptions = useMemo(() => {
    const known = new Map(peopleLabels);
    for (const p of people.data?.items ?? []) known.set(p.id, [p.displayName, p.jobNumber, p.unitName].filter(Boolean).join(' · '));
    return [...known].map(([value, l]) => ({ value, label: l }));
  }, [people.data, peopleLabels]);

  async function saveDraft(): Promise<number | null> {
    let values: FormValues;
    // Every stored value, not only the fields on screen (hidden sections keep theirs).
    try { await form.validateFields(); values = form.getFieldsValue(true) as FormValues; } catch { return null; }
    try {
      const saved = await save.mutateAsync({ id, input: toInput(values) });
      setId(saved.id);
      return saved.id;
    } catch (e) {
      message.error(describeApiError(e));
      return null;
    }
  }

  async function toPreview() {
    const saved = await saveDraft();
    if (saved === null) return;
    try { setPreview(await previewOf.mutateAsync(saved)); } catch (e) { message.error(describeApiError(e)); }
  }

  async function send() {
    if (id === null) return;
    try {
      const r = await submit.mutateAsync({ id, key: submitKey.current });
      message.success(r.status === 'PUBLISHED' ? t('annSentOk') : t('annPendingOk'));
      onClose();
    } catch (e) {
      submitKey.current = keyAfterError(submitKey.current, e);
      message.error(describeApiError(e));
    }
  }

  const start = copyOf ?? draft;
  return (
    <Drawer open={open} onClose={onClose} size={720} destroyOnHidden
      title={draft ? t('annEdit') : t('annNew')}
      footer={preview ? (
        <Flex justify="space-between">
          <Button onClick={() => setPreview(null)}>{t('annBackToEdit')}</Button>
          <Button type="primary" onClick={send} loading={submit.isPending} disabled={preview.recipients + preview.emailOnly === 0}>
            {preview.needsApproval ? t('annSendForApproval') : t('annSend')}
          </Button>
        </Flex>
      ) : (
        <Flex justify="end" gap={8}>
          <Button onClick={async () => { if ((await saveDraft()) !== null) { message.success(t('annDraftSaved')); onClose(); } }} loading={save.isPending && !previewOf.isPending}>{t('annSaveDraft')}</Button>
          <Button type="primary" onClick={toPreview} loading={previewOf.isPending}>{t('annPreviewSend')}</Button>
        </Flex>
      )}
    >
      {preview ? (
        <Flex vertical gap={16}>
          <Typography.Title level={5} style={{ margin: 0 }}>{t('annPreviewTitle')}</Typography.Title>
          <Descriptions column={1} bordered size="small" items={[
            { key: 'a', label: t('annPreviewAccountsLabel'), children: t('annPreviewAccounts', { n: preview.recipients }) },
            { key: 't', label: 'Telegram', children: t('annPreviewTelegram', { n: preview.telegramLinked }) },
            { key: 'e', label: t('annPreviewEmailOnlyLabel'), children: t('annPreviewEmailOnly', { n: preview.emailOnly }) },
            { key: 'm', label: t('annPreviewEtaLabel'), children: t('annPreviewEta', { minutes: preview.emailEtaMinutes }) },
          ]} />
          {preview.recipients + preview.emailOnly === 0
            ? <Alert type="error" showIcon title={t('annPreviewNobody')} />
            : <Alert type={preview.needsApproval ? 'warning' : 'info'} showIcon title={preview.needsApproval ? t('annPreviewApproval') : t('annPreviewDirect')} />}
        </Flex>
      ) : (
        <Form form={form} layout="vertical" initialValues={initialValues(start)}
          onValuesChange={(changed: Partial<FormValues>) => {
            if (changed.kind) form.setFieldValue('priority', changed.kind === 'MEETING' ? 'MEDIUM' : 'LOW'); // owner Q7 defaults
            if (changed.audienceType) form.setFieldValue('audienceIds', []);
          }}>
          <Alert type="info" showIcon style={{ marginBottom: 16 }} title={t('annNoPatientData')} />
          <Form.Item name="kind" label={t('annKindLabel')}>
            <Segmented options={KINDS.map((k) => ({ value: k, label: t(`annKind_${k}`) }))} />
          </Form.Item>
          <Form.Item name="title" label={t('annTitle')} rules={[{ required: true, whitespace: true }, { max: 150 }]}><Input maxLength={150} showCount /></Form.Item>
          <Form.Item name="body" label={t('annBody')} rules={[{ required: true, whitespace: true }, { max: 5000 }]}><Input.TextArea rows={6} maxLength={5000} showCount /></Form.Item>
          <Collapse size="small" style={{ marginBottom: 16 }} defaultActiveKey={start?.titleAr || start?.bodyAr ? ['ar'] : []} items={[{
            key: 'ar', label: t('annArabicText'), forceRender: true, children: (
              <>
                <Typography.Paragraph type="secondary">{t('annArabicHint')}</Typography.Paragraph>
                <Form.Item name="titleAr" label={t('annTitleAr')} rules={[{ max: 150 }]}><Input dir="rtl" maxLength={150} /></Form.Item>
                <Form.Item name="bodyAr" label={t('annBodyAr')} rules={[{ max: 5000 }]}><Input.TextArea dir="rtl" rows={5} maxLength={5000} showCount /></Form.Item>
              </>
            ),
          }]} />
          <Form.Item name="referenceNo" label={t('annReferenceNo')} rules={[{ max: 50 }]}><Input maxLength={50} style={{ maxWidth: 280 }} /></Form.Item>

          {kind !== 'MEMO' && (
            <>
              <Flex gap={12} wrap>
                <Form.Item name="startsAt" label={t('annStartsAt')} rules={[{ required: true }]}>
                  <DatePicker showTime={{ format: 'HH:mm', minuteStep: 5 }} format="YYYY-MM-DD HH:mm" disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
                </Form.Item>
                <Form.Item name="endsAt" label={t('annEndsAt')} dependencies={['startsAt']} rules={[({ getFieldValue }) => ({
                  validator: (_, v: Dayjs | null) => (!v || !getFieldValue('startsAt') || v.isAfter(getFieldValue('startsAt')) ? Promise.resolve() : Promise.reject(new Error(t('annEndAfterStart')))),
                })]}>
                  <DatePicker showTime={{ format: 'HH:mm', minuteStep: 5 }} format="YYYY-MM-DD HH:mm" />
                </Form.Item>
              </Flex>
              <Form.Item name="location" label={t('annLocation')} rules={[{ max: 200 }]}><Input maxLength={200} /></Form.Item>
              <Form.Item name="onlineUrl" label={t('annOnlineUrl')} rules={[{ max: 500 }, { pattern: /^https:\/\/\S+$/, message: t('annOnlineUrlRule') }]}><Input dir="ltr" placeholder="https://" /></Form.Item>
            </>
          )}
          {kind === 'SEMINAR' && (
            <Flex gap={12} wrap>
              <Form.Item name="speaker" label={t('annSpeaker')} rules={[{ max: 150 }]} style={{ flex: 1, minWidth: 240 }}><Input maxLength={150} /></Form.Item>
              <Form.Item name="ceHours" label={t('annCeHours')}><InputNumber min={0} max={999.9} step={0.5} precision={1} /></Form.Item>
            </Flex>
          )}
          <Form.Item name="priority" label={t('annPriority')}>
            <Select style={{ maxWidth: 200 }} options={(kind === 'MEMO' ? ['LOW', 'MEDIUM', 'HIGH'] : ['LOW', 'MEDIUM']).map((p) => ({ value: p, label: t(`priority_${p}`) }))} />
          </Form.Item>

          <Form.Item name="audienceType" label={t('annAudience')}>
            <Radio.Group optionType="button" options={audiences.map((a) => ({ value: a, label: t(`annAudience_${a}`) }))} />
          </Form.Item>
          {audienceType === 'DEPARTMENT' && (
            <Form.Item name="audienceIds" rules={[{ required: true, type: 'array', min: 1, message: t('annPickDepartments') }]}>
              <Select mode="multiple" placeholder={t('annPickDepartments')} optionFilterProp="label" loading={departments.isLoading}
                options={(departments.data?.items ?? []).filter((d) => d.isActive).map((d) => ({ value: d.id, label: label(d.name, d.nameAr) }))} />
            </Form.Item>
          )}
          {audienceType === 'UNIT' && (
            <Form.Item name="audienceIds" rules={[{ required: true, type: 'array', min: 1, message: t('annPickUnits') }]}>
              <Select mode="multiple" placeholder={t('annPickUnits')} optionFilterProp="label" loading={units.isLoading}
                options={unitOptions.map((u) => ({ value: u.id, label: label(u.name, u.nameAr) }))} />
            </Form.Item>
          )}
          {audienceType === 'PEOPLE' && (
            <Form.Item name="audienceIds" rules={[{ required: true, type: 'array', min: 1, message: t('annPickPeople') }]}>
              <Select mode="multiple" placeholder={t('annPickPeople')} showSearch filterOption={false} onSearch={setPeopleQuery} loading={people.isFetching}
                options={personOptions} notFoundContent={peopleQuery.trim().length < 2 ? t('annTypeTwoLetters') : undefined}
                onChange={(ids: number[]) => setPeopleLabels((m) => new Map([...m, ...personOptions.filter((o) => ids.includes(o.value)).map((o) => [o.value, o.label] as const)]))}
                labelRender={(p) => p.label ?? `#${p.value}`} />
            </Form.Item>
          )}
          <Collapse size="small" style={{ marginBottom: 16 }} items={[{
            key: 'f', label: t('annNarrow'), forceRender: true, children: (
              <>
                {audienceType !== 'PEOPLE' && <Typography.Paragraph type="secondary">{t('annNarrowHint')}</Typography.Paragraph>}
                <Form.Item name="roleFilter" label={t('annRoles')}>
                  <Select mode="multiple" allowClear options={ROLES.map((r) => ({ value: r, label: t(`annRole_${r}`) }))} />
                </Form.Item>
                <Form.Item name="positionFilter" label={t('annPositions')}>
                  <Select mode="multiple" allowClear optionFilterProp="label" options={(positions.data?.items ?? []).map((p) => ({ value: p.code, label: label(p.title, p.titleAr) }))} />
                </Form.Item>
                <Form.Item name="specialtyFilter" label={t('annSpecialties')}>
                  <Select mode="multiple" allowClear optionFilterProp="label" options={(specialties.data?.items ?? []).map((s) => ({ value: s.code, label: label(s.name, s.nameAr) }))} />
                </Form.Item>
              </>
            ),
          }]} />
          <Form.Item name="expiresAt" label={t('annExpires')} extra={t('annExpiresHint')}>
            <DatePicker disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
          </Form.Item>
        </Form>
      )}
    </Drawer>
  );
}
