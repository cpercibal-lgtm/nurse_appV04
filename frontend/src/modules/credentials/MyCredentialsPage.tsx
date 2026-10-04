// Employee self-service (spec §8.1 Employee column: own submission, evidence,
// alerts; §6.1.1 "Renewal Required — Grace Period Active").

import { useState } from 'react';
import { Alert, App, Button, Card, Empty, Flex, Form, Modal, Select, Space, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { appliesToNationality, useCredentialAction, useMyCredentials, useMyEligibility, useMyRequirements, useTemplates, type CredentialRow, type Template } from './api';
import { useMyEmployee } from '../nurses/api';
import { CredentialStatusTag, DocumentsDrawer, EligibilityTag, LifecycleTag, normaliseTracking, ReasonList, TrackingFields } from './components';

import { GuideHelp } from '../guidelines/GuideHelp';
export default function MyCredentialsPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const mine = useMyCredentials();
  const reqs = useMyRequirements();
  const templates = useTemplates();
  const eligibility = useMyEligibility();
  const me = useMyEmployee();
  const action = useCredentialAction();
  const [docsFor, setDocsFor] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<CredentialRow | null>(null);
  const [form] = Form.useForm();
  const templateId = Form.useWatch('templateId', form) as number | undefined;
  const tplOf = (id: number | undefined): Template | undefined => templates.data?.items.find((x) => x.id === id);

  const inGrace = mine.data?.items.some((c) => c.graceExpiryDate && c.lifecycle !== 'Active');

  async function submitNew(v: { templateId: number; trackingData?: Record<string, unknown> }) {
    try {
      await action.mutateAsync({ kind: 'record', self: true, body: { templateId: v.templateId, trackingData: normaliseTracking(v) } });
      message.success(t('submittedForVerification'));
      setAdding(false); form.resetFields();
    } catch (e) { message.error(describeApiError(e)); }
  }

  async function submitRenewal(v: { trackingData?: Record<string, unknown> }) {
    if (!renewing) return;
    try {
      await action.mutateAsync({ kind: 'renew', id: renewing.id, body: { trackingData: normaliseTracking(v) } });
      message.success(t('renewalSubmitted'));
      setRenewing(null); form.resetFields();
    } catch (e) { message.error(describeApiError(e)); }
  }

  const held = new Set(mine.data?.items.map((c) => c.templateId));
  const missing = reqs.data?.items.filter((r) => r.policyStatus !== 'OPTIONAL' && !held.has(r.templateId)) ?? [];
  // Owner decision 2026-10-04: a type not for my nationality (e.g. Passport and Iqama for a Saudi national) may be submitted, never required.
  const optionalForMe = new Set(me.data ? templates.data?.items.filter((x) => !appliesToNationality(x, me.data.nationalityCode)).map((x) => x.id) : []);
  const optionalTag = (templateId: number) => (optionalForMe.has(templateId) ? <Tag>{t('optionalForYou')}</Tag> : null);

  return (
    <Flex vertical gap={16}>
      {inGrace && <Alert type="warning" showIcon title={t('graceAlert')} />}
      {eligibility.data && (
        <Card size="small" title={t('myEligibility')}>
          <Space align="start"><EligibilityTag status={eligibility.data.status} /><ReasonList reasons={eligibility.data.reasons} /></Space>
        </Card>
      )}
      {missing.length > 0 && (
        <Alert type="error" showIcon title={t('missingRequired')} description={missing.map((r) => `${r.template.code} — ${r.template.name}`).join(' · ')} />
      )}
      <Card title={<>{t('myCredentials')} <GuideHelp section="self-service" task="my-credentials" /></>} extra={<Button type="primary" onClick={() => { form.resetFields(); setAdding(true); }}>{t('addCredential')}</Button>}>
        <Table<CredentialRow>
          rowKey="id" loading={mine.isLoading} dataSource={mine.data?.items} pagination={false} scroll={{ x: true }}
          locale={{ emptyText: <Empty description={t('noData')} /> }}
          columns={[
            { title: t('credential'), render: (_, r) => <>{r.template.code} — {r.template.name} {optionalTag(r.templateId)}</> },
            { title: t('status'), render: (_, r) => <Space size={4} wrap><CredentialStatusTag status={r.status} /><LifecycleTag label={r.lifecycle} /></Space> },
            { title: t('expiryDate'), render: (_, r) => r.expiryDate ?? '—' },
            {
              title: '', render: (_, r) => (
                <Flex gap={4}>
                  <Button size="small" onClick={() => setDocsFor(r.id)}>{t('evidence')}</Button>
                  {['Valid', 'ExpiringSoon', 'Expired'].includes(r.status) && !r.pendingData && (
                    <Button size="small" onClick={() => { form.resetFields(); setRenewing(r); }}>{t('renew')}</Button>
                  )}
                  {r.pendingData && <Tag color="blue">{t('life_OnProcess')}</Tag>}
                </Flex>
              ),
            },
          ]}
        />
      </Card>

      <DocumentsDrawer credentialId={docsFor} onClose={() => setDocsFor(null)} canUpload />

      <Modal title={t('addCredential')} open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submitNew}>
          <Form.Item name="templateId" label={t('credential')} rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={templates.data?.items.filter((x) => x.isActive).map((x) => ({ value: x.id, label: `${x.code} — ${x.name}${optionalForMe.has(x.id) ? ` (${t('optionalForYou')})` : ''}` }))} />
          </Form.Item>
          {tplOf(templateId) && <TrackingFields defs={tplOf(templateId)!.fieldDefs} />}
        </Form>
      </Modal>

      <Modal title={renewing ? `${t('renew')}: ${renewing.template.name}` : ''} open={renewing !== null} onCancel={() => setRenewing(null)} onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden>
        <Alert type="info" showIcon title={t('renewalHint')} style={{ marginBottom: 12 }} />
        <Form form={form} layout="vertical" onFinish={submitRenewal}>
          {renewing && tplOf(renewing.templateId) && <TrackingFields defs={tplOf(renewing.templateId)!.fieldDefs} />}
        </Form>
      </Modal>
    </Flex>
  );
}
