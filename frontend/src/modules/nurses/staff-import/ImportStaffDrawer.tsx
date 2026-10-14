// Import staff from the template (D-72). The file is read here, in the browser; the server
// receives the rows only, checks them (writes nothing), and imports all of them or none.
// Each row becomes an employee and a Draft contract, exactly as "Onboard employee" creates.

import { useState } from 'react';
import { Alert, App, Button, Drawer, Flex, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { ApiError } from '../../../services/http';
import { describeApiError } from '../../../lib/errors';
import { keyAfterError } from '../../../lib/idempotency';
import { useImportCheck, useImportCommit, useImportLists, type ImportReport, type ImportRowStatus } from '../api';
import type { ImportRow, ReadProblem } from './template';
import templateUrl from './AIGH_Staff_Import_Template_v3.xlsx?url';

const STATUS_COLOR: Record<ImportRowStatus, string> = { CREATE: 'green', UNCHANGED: 'default', CONFLICT: 'orange', REJECTED: 'red' };

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function save(bytes: Uint8Array | string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
/** A spreadsheet must not run a cell that starts like a formula (CSV injection). */
const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function ImportStaffDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const fetchLists = useImportLists();
  const check = useImportCheck();
  const commit = useImportCommit();
  const [file, setFile] = useState<{ name: string; sha: string; rows: ImportRow[] } | null>(null);
  const [problem, setProblem] = useState<ReadProblem | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [show, setShow] = useState<ImportRowStatus | 'ALL'>('ALL');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [downloading, setDownloading] = useState(false);
  const [reading, setReading] = useState(false);

  const reset = () => { setFile(null); setProblem(null); setReport(null); setDone(null); setShow('ALL'); setKey(crypto.randomUUID()); };
  const body = (f: NonNullable<typeof file>) => ({ templateVersion: 3, fileSha256: f.sha, rows: f.rows });

  async function downloadTemplate() {
    setDownloading(true);
    try {
      const [lists, { listsSheet, versionLine }, { fillTemplate }, res] = await Promise.all([
        fetchLists(), import('./template'), import('./xlsx'), fetch(templateUrl),
      ]);
      const today = dayjs().format('YYYY-MM-DD');
      const out = fillTemplate(new Uint8Array(await res.arrayBuffer()), listsSheet(lists), versionLine(lists, today));
      save(out, `AIGH_Staff_Import_Template_v3_${today}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (e) { message.error(describeApiError(e)); } finally { setDownloading(false); }
  }

  async function read(f: File) {
    reset();
    setReading(true);
    try {
      const { readStaffFile } = await import('./template');
      const bytes = new Uint8Array(await f.arrayBuffer());
      const out = readStaffFile(bytes);
      if (!out.ok) { setProblem(out.problem); return; }
      const next = { name: f.name, sha: await sha256(bytes), rows: out.rows };
      setFile(next);
      setReport(await check.mutateAsync(body(next)));
    } catch (e) { message.error(describeApiError(e)); } finally { setReading(false); }
  }

  function confirmImport() {
    if (!file || !report) return;
    modal.confirm({
      title: t('importStaffConfirmTitle'), okText: t('importStaffNow', { count: report.totals.create }), cancelText: t('cancel'),
      content: t('importStaffConfirm', { count: report.totals.create }),
      onOk: async () => {
        try {
          const out = await commit.mutateAsync({ body: body(file), key });
          setDone(out); setReport(out);
          message.success(t('importStaffDone', { count: out.created?.length ?? 0 }));
        } catch (e) {
          setKey((k) => keyAfterError(k, e));
          // Something changed since the check (e.g. someone onboarded the same job number): show the new report.
          if (e instanceof ApiError && e.code === 'STAFF_IMPORT_NOT_CLEAN') setReport(e.details as ImportReport);
          message.error(describeApiError(e));
        }
      },
    });
  }

  function problemsCsv() {
    if (!report) return;
    const lines = [['Row', 'Job Number', 'Status', 'Column', 'Code', 'Problem'].join(',')];
    for (const r of report.rows) for (const p of r.problems) lines.push([r.rowNumber, r.jobNumber, r.status, p.column, p.code, p.message].map(csvCell).join(','));
    save(`﻿${lines.join('\r\n')}\r\n`, `staff-import-problems-${dayjs().format('YYYY-MM-DD')}.csv`, 'text/csv;charset=utf-8');
  }

  const rows = (report?.rows ?? []).filter((r) => show === 'ALL' || r.status === show);
  const anyProblems = (report?.rows ?? []).some((r) => r.problems.length > 0);
  return (
    <Drawer title={t('importStaff')} open={open} onClose={() => { reset(); onClose(); }} size={900} destroyOnHidden>
      <Alert type="info" showIcon title={t('importStaffHint')} style={{ marginBottom: 12 }} />
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Button onClick={() => void downloadTemplate()} loading={downloading}>{t('importStaffTemplate')}</Button>
        <Upload accept=".xlsx" showUploadList={false} maxCount={1} beforeUpload={(f) => { void read(f); return false; }} disabled={reading || commit.isPending || done !== null}>
          <Button type="primary" loading={reading || check.isPending} disabled={done !== null}>{t('importStaffChoose')}</Button>
        </Upload>
        {done && <Button onClick={reset}>{t('importStaffAnother')}</Button>}
      </Flex>

      {problem && <Alert type="error" showIcon style={{ marginBottom: 12 }} title={t(`importStaffFile_${problem.code}`, problem)} />}

      {file && report && (
        <>
          <Typography.Paragraph>
            {t('importStaffFile', { name: file.name, count: file.rows.length })}
          </Typography.Paragraph>
          <Space wrap style={{ marginBottom: 12 }}>
            {(['CREATE', 'UNCHANGED', 'CONFLICT', 'REJECTED'] as const).map((s) => (
              <Tag key={s} color={STATUS_COLOR[s]}>{t(`importStatus_${s}`)}: {report.totals[s.toLowerCase() as keyof ImportReport['totals']]}</Tag>
            ))}
          </Space>
          {done
            ? <Alert type="success" showIcon style={{ marginBottom: 12 }} title={t('importStaffDone', { count: done.created?.length ?? 0 })} description={t('importStaffNext')} />
            : report.canImport
              ? <Alert type="success" showIcon style={{ marginBottom: 12 }} title={t('importStaffReady', { count: report.totals.create })} />
              : <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={report.totals.create === 0 && report.totals.conflict === 0 && report.totals.rejected === 0 ? t('importStaffNothing') : t('importStaffFix')} />}
          <Flex gap={8} wrap style={{ marginBottom: 12 }}>
            <Select aria-label={t('status')} style={{ width: 220 }} value={show} onChange={setShow}
              options={[{ value: 'ALL', label: t('all') }, ...(['CREATE', 'UNCHANGED', 'CONFLICT', 'REJECTED'] as const).map((s) => ({ value: s, label: t(`importStatus_${s}`) }))]} />
            {anyProblems && <Button onClick={problemsCsv}>{t('importStaffProblemsCsv')}</Button>}
            {!done && <Button type="primary" disabled={!report.canImport} loading={commit.isPending} onClick={confirmImport}>{t('importStaffNow', { count: report.totals.create })}</Button>}
          </Flex>
          <Table size="small" rowKey="rowNumber" dataSource={rows} pagination={{ pageSize: 50, showSizeChanger: false }} scroll={{ x: true }}
            columns={[
              { title: t('importRow'), dataIndex: 'rowNumber', width: 70 },
              { title: t('jobNumber'), dataIndex: 'jobNumber', render: (v: string | null) => v ?? '—' },
              { title: t('status'), dataIndex: 'status', render: (s: ImportRowStatus) => <Tag color={STATUS_COLOR[s]}>{t(`importStatus_${s}`)}</Tag> },
              { title: t('importProblems'), render: (_, r) => r.problems.length === 0 ? '—' : (
                <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                  {r.problems.map((p, i) => <li key={i}>{p.column ? <strong>{p.column}: </strong> : null}{p.message}</li>)}
                </ul>
              ) },
            ]} />
        </>
      )}
    </Drawer>
  );
}
