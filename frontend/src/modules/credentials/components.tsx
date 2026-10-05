import { useState } from 'react';
import { App, Button, DatePicker, Drawer, Form, Input, InputNumber, Space, Table, Tag, Tooltip, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useTypeLabels } from './labels';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';
import { useCredentialAction, useDocuments, type CredentialStatus, type EligibilityStatus, type FieldDef, type Lifecycle, type Reason } from './api';
import { RankGradePicker } from '../../components/RankGradePicker';

const CRED_COLOR: Record<CredentialStatus, string> = {
  PendingVerification: 'blue', Valid: 'green', ExpiringSoon: 'gold', Expired: 'red', Suspended: 'volcano', Revoked: 'magenta',
};
const LIFE_COLOR: Record<Lifecycle, string> = { Active: 'green', SubjectToRenew: 'gold', OnProcess: 'blue', Expired: 'red' };
const ELIG_COLOR: Record<EligibilityStatus, string> = {
  ELIGIBLE: 'green', ELIGIBLE_WITH_GRACE: 'gold', ELIGIBLE_WITH_POLICY_WARNING: 'orange', INELIGIBLE: 'red',
};

export function CredentialStatusTag({ status }: { status: CredentialStatus }) {
  const { t } = useTranslation();
  return <Tag color={CRED_COLOR[status]}>{t(`cred_${status}`)}</Tag>;
}

export function LifecycleTag({ label }: { label: Lifecycle }) {
  const { t } = useTranslation();
  return <Tag color={LIFE_COLOR[label]}>{t(`life_${label}`)}</Tag>;
}

export function EligibilityTag({ status }: { status: EligibilityStatus }) {
  const { t } = useTranslation();
  return <Tag color={ELIG_COLOR[status]}>{t(`elig_${status}`)}</Tag>;
}

/** Reasons as the engine gave them: blocking in red, warnings in amber, notes in grey. */
export function ReasonList({ reasons }: { reasons: Reason[] }) {
  if (reasons.length === 0) return <span>—</span>;
  const color = { BLOCK: 'red', WARN: 'gold', INFO: 'default' } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {reasons.map((r, i) => (
        <Tooltip key={i} title={r.message}>
          <Tag color={color[r.severity]} style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>
            {r.code}{r.templateCode ? ` · ${r.templateCode}` : ''}{r.until ? ` · ${r.until.slice(0, 10)}` : ''}
          </Tag>
        </Tooltip>
      ))}
    </div>
  );
}

/** Form items generated from a template's field definitions (spec §5.1.3). Dates are sent as YYYY-MM-DD. */
export function TrackingFields({ defs }: { defs: FieldDef[] }) {
  const { fieldLabel } = useTypeLabels();
  return (
    <>
      {[...defs].sort((a, b) => a.displayOrder - b.displayOrder).map((d) => (
        <Form.Item key={d.key} name={['trackingData', d.key]} label={fieldLabel(d)} rules={[{ required: d.required }]}>
          {d.type === 'date' ? <DatePicker style={{ width: '100%' }} /> : d.type === 'number' ? <InputNumber style={{ width: '100%' }} />
            // The SCFHS licence's classification is a Rank/Grade code (owner decision 2026-10-03).
            : d.type === 'select' && d.key === 'classification' ? <RankGradePicker /> : <Input maxLength={500} />}
        </Form.Item>
      ))}
    </>
  );
}

/** Converts DatePicker values in trackingData to YYYY-MM-DD strings. */
export function normaliseTracking(values: { trackingData?: Record<string, unknown> }) {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(values.trackingData ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = dayjs.isDayjs(v) ? v.format('YYYY-MM-DD') : (v as string | number);
  }
  return out;
}

/** Evidence versions for one credential: list, upload, download (owner and scoped HR only — D5). */
export function DocumentsDrawer({ credentialId, onClose, canUpload }: { credentialId: number | null; onClose: () => void; canUpload: boolean }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const docs = useDocuments(credentialId);
  const action = useCredentialAction();
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    if (credentialId === null) return;
    setUploading(true);
    try {
      await action.mutateAsync({ kind: 'upload', id: credentialId, file });
      message.success(t('saved'));
    } catch (e) {
      message.error(describeApiError(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Drawer title={t('evidence')} open={credentialId !== null} onClose={onClose} size={640} destroyOnHidden>
      {canUpload && (
        <Upload accept="application/pdf,image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={(f) => { void upload(f); return false; }}>
          <Button icon={<UploadOutlined />} loading={uploading} style={{ marginBottom: 12 }}>{t('uploadEvidence')}</Button>
        </Upload>
      )}
      <Table
        rowKey="id" size="small" pagination={false} loading={docs.isLoading} dataSource={docs.data?.items}
        columns={[
          { title: 'v', dataIndex: 'version', width: 48 },
          { title: t('fileName'), dataIndex: 'fileName', ellipsis: true },
          { title: t('status'), render: (_, d) => <>{d.erasedAt && <Tag color="red">{t('personalDataErased')}</Tag>}{d.isCurrentEvidence && <Tag color="green">{t('currentEvidence')}</Tag>}<Tag>{d.reviewStatus}</Tag><Tag color={d.scanStatus === 'CLEAN' ? 'default' : 'red'}>{d.scanStatus}</Tag></> },
          { title: t('uploaded'), render: (_, d) => new Date(d.uploadedAt).toLocaleString() },
          {
            title: '', render: (_, d) => d.scanStatus === 'CLEAN' && !d.erasedAt && credentialId !== null
              ? <Space size={4}><Button size="small" onClick={() => http.openDocument(`/credentials/${credentialId}/documents/${d.id}`).catch((e) => message.error(describeApiError(e)))}>{t('view')}</Button><Button size="small" onClick={() => http.download(`/credentials/${credentialId}/documents/${d.id}`, d.fileName).catch((e) => message.error(describeApiError(e)))}>{t('download')}</Button></Space>
              : null,
          },
        ]}
      />
    </Drawer>
  );
}
