// Planned vs actual attendance (spec §14.2, D-33). Clock events come from the
// badge system once its feed is defined; this page shows the gap view for
// staff and an employee's own clock events.

import { useState } from 'react';
import { Alert, Card, DatePicker, Empty, Flex, Select, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { useUnits } from '../administration/api';
import { useGaps, useOwnEvents, type Gap } from '../scheduling/api';

import { GuideHelp } from '../guidelines/GuideHelp';
const GAP_COLOR: Record<Gap['status'], string> = { UPCOMING: 'default', PENDING: 'blue', PRESENT: 'green', MISSING: 'red', INELIGIBLE_ON_DUTY: 'magenta' };
const time = (iso: string | null) => (iso ? dayjs(iso).format('DD MMM HH:mm') : '—');

export default function AttendancePage() {
  const { t } = useTranslation();
  const { hasRole } = usePermissions();
  const staff = hasRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR');
  const units = useUnits();
  const [unitId, setUnitId] = useState<number>();
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const gaps = useGaps(staff ? unitId : undefined, date);
  const from = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const own = useOwnEvents(from, dayjs().format('YYYY-MM-DD'), !staff);

  return (
    <Card title={<>{t('attendance')} <GuideHelp section="attendance" /></>}>
      <Alert type="info" showIcon title={t('attendanceFeedPending')} style={{ marginBottom: 12 }} />
      {!staff ? (
        <Table rowKey="id" size="small" loading={own.isLoading} dataSource={own.data?.items} pagination={{ pageSize: 30 }}
          columns={[{ title: t('when'), render: (_, e) => time(e.eventTimestamp) }, { title: t('event'), dataIndex: 'eventType' }, { title: t('source'), dataIndex: 'source' }]} />
      ) : (
        <>
          <Flex gap={8} wrap style={{ marginBottom: 12 }}>
            <Select aria-label={t('unit')} placeholder={t('unit')} style={{ width: 280 }} showSearch optionFilterProp="label" value={unitId} onChange={setUnitId}
              options={(units.data?.items ?? []).map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))} />
            <DatePicker value={dayjs(date)} allowClear={false} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} />
          </Flex>
          {gaps.error && <Alert type="error" showIcon title={describeApiError(gaps.error)} style={{ marginBottom: 12 }} />}
          {gaps.data && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={t('gapRule', { minutes: gaps.data.gapMinutes, early: gaps.data.earlyClockInMinutes })} />}
          {!unitId ? <Empty description={t('chooseUnit')} /> : (
            <Table<Gap> rowKey="assignmentId" size="small" loading={gaps.isLoading} dataSource={gaps.data?.items} pagination={false}
              columns={[
                { title: t('employee'), render: (_, g) => `${g.jobNumber} — ${g.fullName}` },
                { title: t('shift'), render: (_, g) => `${t(`shift_${g.shiftType}`)} (${time(g.shiftStart)} – ${time(g.shiftEnd)})` },
                { title: t('clockIn'), render: (_, g) => time(g.clockInAt) },
                { title: t('status'), render: (_, g) => <><Tag color={GAP_COLOR[g.status]}>{t(`gap_${g.status}`)}</Tag>{g.reasons.map((r) => <Tag key={r}>{r}</Tag>)}</> },
              ]} />
          )}
        </>
      )}
    </Card>
  );
}
