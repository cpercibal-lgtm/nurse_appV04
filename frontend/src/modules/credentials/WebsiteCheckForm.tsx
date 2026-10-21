import { useState } from 'react';
import { App, Alert, Button, DatePicker, Form, Input, Select, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useDocuments, useRecordWebsiteCheck, type ScfhsStatus } from './api';
import { DocumentsDrawer } from './components';

/** Records an HR observation only; the existing lifecycle actions decide eligibility. */
export function WebsiteCheckForm({ credentialId }: { credentialId: number }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ status: ScfhsStatus; checkedAt: Dayjs; notes: string; evidenceDocumentId: number }>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const documents = useDocuments(credentialId);
  const save = useRecordWebsiteCheck();
  async function submit(values: { status: ScfhsStatus; checkedAt: Dayjs; notes: string; evidenceDocumentId: number }) {
    try {
      await save.mutateAsync({ id: credentialId, body: { ...values, checkedAt: values.checkedAt.toISOString() } });
      message.success(t('saved'));
      form.resetFields();
    } catch (e) { message.error(describeApiError(e)); }
  }
  return <>
    <Alert type="info" showIcon title={t('scfhsWebsiteNotice')} style={{ marginBottom: 12 }} />
    <Form form={form} layout="vertical" onFinish={submit}>
      <Form.Item name="status" label={t('scfhsAnswer')} rules={[{ required: true }]}>
        <Select options={(['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND', 'ERROR'] as const).map((status) => ({ value: status, label: t(`scfhsStatus_${status}`) }))} />
      </Form.Item>
      <Form.Item name="checkedAt" label={t('scfhsWebsiteCheckedAt')} rules={[{ required: true }]}>
        <DatePicker showTime style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="notes" label={t('scfhsWebsiteNotes')} rules={[{ required: true }, { whitespace: true }, { min: 10, max: 1000 }]}>
        <Input.TextArea rows={3} maxLength={1000} />
      </Form.Item>
      <Form.Item name="evidenceDocumentId" label={t('evidence')} rules={[{ required: true }]}>
        <Select loading={documents.isLoading} options={documents.data?.items.filter((d) => d.scanStatus === 'CLEAN' && !d.erasedAt).map((d) => ({ value: d.id, label: `v${d.version} · ${d.fileName}` }))} />
      </Form.Item>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" htmlType="submit" loading={save.isPending}>{t('scfhsRecordWebsiteCheck')}</Button>
        <Button onClick={() => setEvidenceOpen(true)}>{t('uploadEvidence')}</Button>
      </Space>
    </Form>
    <DocumentsDrawer credentialId={evidenceOpen ? credentialId : null} onClose={() => setEvidenceOpen(false)} canUpload />
  </>;
}
