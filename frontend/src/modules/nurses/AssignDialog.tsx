// Assign unit and position from the Nurses list (owner decision 2026-10-05): a right-click
// menu on a row opens a dialog with the current values, the new ones, what the change would
// do (the server runs it and rolls it back) and a reason kept in the audit trail.

import { useEffect, useState } from 'react';
import { Alert, App, Flex, Form, Input, Menu, Modal, Select, Space, Tag, Typography } from 'antd';
import { ApartmentOutlined, IdcardOutlined, SwapOutlined, ExportOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { keyAfterError } from '../../lib/idempotency';
import { useUnits } from '../administration/api';
import { usePositions } from '../workforce/api';
import { EligibilityTag } from '../credentials/components';
import { useAssignmentPreview, useEmployeeAction, type AssignmentTarget, type EmployeeRow } from './api';

export type AssignMode = 'both' | 'unit' | 'position';

/** The right-click menu: at the pointer, kept inside the window, closed by a click elsewhere, Escape or scrolling. */
export function NurseContextMenu({ at, row, onPick, onClose }: {
  at: { x: number; y: number }; row: EmployeeRow; onPick: (choice: AssignMode | 'open') => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const width = 260, height = 200;
  // Right-to-left (Arabic): the menu opens to the left of the pointer, as native menus do.
  const rtl = document.documentElement.dir === 'rtl';
  const left = Math.max(8, Math.min(rtl ? at.x - width : at.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - height - 8));
  return (
    <div role="menu" aria-label={t('assignMenu')} className="nurse-context-menu" style={{ position: 'fixed', left, top, width, zIndex: 1050 }}
      onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="nurse-context-menu-title">{row.jobNumber} — {row.fullName}</div>
      <Menu selectable={false} onClick={({ key }) => onPick(key as AssignMode | 'open')} items={[
        { key: 'both', icon: <SwapOutlined />, label: t('assignUnitAndPosition') },
        { key: 'unit', icon: <ApartmentOutlined />, label: t('assignUnit') },
        { key: 'position', icon: <IdcardOutlined />, label: t('assignPosition') },
        { type: 'divider' },
        { key: 'open', icon: <ExportOutlined />, label: t('openDetails') },
      ]} />
    </div>
  );
}

type FormValues = { unitId?: number | null; positionCode?: string; reason: string };

export function AssignDialog({ row, mode, onClose }: { row: EmployeeRow; mode: AssignMode; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const units = useUnits();
  const positions = usePositions();
  const action = useEmployeeAction();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const unitId = Form.useWatch('unitId', form);
  const positionCode = Form.useWatch('positionCode', form);
  const showUnit = mode !== 'position';
  const showPosition = mode !== 'unit';

  // Only what differs from today is sent (and previewed).
  const target: AssignmentTarget = {
    ...(showUnit && unitId !== undefined && unitId !== row.unitId ? { unitId } : {}),
    ...(showPosition && positionCode !== undefined && positionCode !== row.positionCode ? { positionCode } : {}),
  };
  const changes = target.unitId !== undefined || target.positionCode !== undefined;
  const preview = useAssignmentPreview(row.id, changes ? target : null);

  const unitLabel = (id: number | null) => (id === null ? t('unassigned') : (() => { const u = units.data?.items.find((x) => x.id === id); return u ? `${u.code} — ${u.name}` : '—'; })());
  const positionTitle = (code: string) => { const p = positions.data?.items.find((x) => x.code === code); return p ? `${p.code} — ${ar && p.titleAr ? p.titleAr : p.title}` : code; };
  const unitOptions = [
    { value: null as number | null, label: t('unassigned') },
    ...(units.data?.items ?? []).map((u) => ({ value: u.id as number | null, label: `${u.code} — ${u.name}` })),
  ];
  const positionOptions = (positions.data?.items ?? []).filter((p) => p.isActive).map((p) => ({
    value: p.code,
    label: <Space size={4}>{`${p.code} — ${ar && p.titleAr ? p.titleAr : p.title}`}{!p.isSchedulable && <Tag>{t('notRostered')}</Tag>}</Space>,
    search: `${p.code} ${p.title} ${p.titleAr ?? ''}`.toLowerCase(),
  }));

  async function submit(v: FormValues) {
    if (!changes) { message.info(t('assignmentNoChange')); return; }
    try {
      await action.mutateAsync({ kind: 'assign', id: row.id, key, body: { ...target, reason: v.reason.trim() } });
      message.success(t('assignmentDone'));
      onClose();
    } catch (e) {
      setKey((k) => keyAfterError(k, e)); // a refusal is not replayed on the next try
      message.error(describeApiError(e));
    }
  }

  const p = preview.data;
  const title = mode === 'unit' ? t('assignUnit') : mode === 'position' ? t('assignPosition') : t('assignUnitAndPosition');
  return (
    <Modal open title={`${title.replace(/…$/, '')} — ${row.jobNumber} ${row.fullName}`} onCancel={onClose} onOk={() => form.submit()}
      okText={t('assignConfirm')} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden width={560}>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ unitId: row.unitId, positionCode: row.positionCode, reason: '' }}>
        <Space size={12} align="start" style={{ width: '100%' }} wrap>
          {showUnit && (
            <Form.Item name="unitId" label={t('unit')} extra={`${t('now')}: ${unitLabel(row.unitId)}`} style={{ minWidth: 240, flex: 1 }}>
              <Select showSearch optionFilterProp="label" options={unitOptions} />
            </Form.Item>
          )}
          {showPosition && (
            <Form.Item name="positionCode" label={t('position')} extra={`${t('now')}: ${positionTitle(row.positionCode)}`} style={{ minWidth: 240, flex: 1 }}>
              <Select showSearch filterOption={(input, o) => (o?.search ?? '').includes(input.toLowerCase())} options={positionOptions} />
            </Form.Item>
          )}
        </Space>

        {changes && (
          preview.isError ? <Alert type="error" showIcon title={describeApiError(preview.error)} style={{ marginBottom: 12 }} />
          : p ? (
            <Alert type={p.eligibility?.status === 'INELIGIBLE' || p.shiftsToDraft.length ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }}
              title={t('assignmentImpact')}
              description={
                <Flex vertical gap={4}>
                  {p.eligibility && (
                    <span>{t('assignmentEligibility')} <EligibilityTag status={p.eligibility.status} />
                      {p.eligibility.reasons.length > 0 && (
                        <Typography.Text type="secondary"> {p.eligibility.reasons.slice(0, 4).map((r) => r.templateCode ?? r.code).join(', ')}{p.eligibility.reasons.length > 4 ? ` +${p.eligibility.reasons.length - 4}` : ''}</Typography.Text>
                      )}
                    </span>
                  )}
                  <span>{p.shiftsToDraft.length === 0 ? t('assignmentNoShifts')
                    : t('assignmentShiftsToDraft', { count: p.shiftsToDraft.length, list: p.shiftsToDraft.slice(0, 5).map((s) => `${s.date} ${s.shiftType}`).join(', ') + (p.shiftsToDraft.length > 5 ? ' …' : '') })}</span>
                </Flex>
              } />
          ) : <Alert type="info" showIcon title={t('assignmentChecking')} style={{ marginBottom: 12 }} />
        )}

        <Form.Item name="reason" label={t('reason')} extra={t('assignmentReasonHint')}
          rules={[{ required: true, whitespace: true, min: 10, message: t('assignmentReasonRequired') }]}>
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
