// Nurse-to-bed KPIs (decisions D-11, D-70), as defined by the MoH Ada'a
// indicator profiles. One shift for supervisors, or a month as the cards report.
// What is counted comes from HR's settings and is listed under the figures.

import { useState } from 'react';
import { Alert, Card, Col, Collapse, DatePicker, Descriptions, Empty, Flex, Row, Segmented, Statistic, Tag } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { SHIFTS, useKpi, type Band, type ShiftType } from './api';

import { GuideHelp } from '../guidelines/GuideHelp';
const BAND_COLOR: Record<Band, string> = { Standard: 'green', Distress: 'gold', Failing: 'orange', Failed: 'red' };

export default function KpiPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'shift' | 'month'>('shift');
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [shift, setShift] = useState<ShiftType>('Morning');
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const kpi = useKpi(mode === 'month' ? { month } : { date, shift });
  const band = (b: Band) => <Tag color={BAND_COLOR[b]}>{t(`band_${b}`)}</Tag>;
  const period = kpi.data?.period;
  const codes = (list: string[]) => (list.length ? list.join(', ') : '—');

  return (
    <Card title={<>{t('kpi')} <GuideHelp section="kpi" /></>}>
      <Flex gap={12} wrap style={{ marginBottom: 16 }}>
        <Segmented value={mode} onChange={(v) => setMode(v as 'shift' | 'month')}
          options={[{ value: 'shift', label: t('kpiPeriodShift') }, { value: 'month', label: t('kpiPeriodMonth') }]} />
        {mode === 'shift' ? (
          <>
            <DatePicker value={dayjs(date)} allowClear={false} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} />
            <Segmented value={shift} onChange={(v) => setShift(v as ShiftType)} options={SHIFTS.map((s) => ({ value: s, label: t(`shift_${s}`) }))} />
          </>
        ) : (
          <DatePicker picker="month" value={dayjs(`${month}-01`)} allowClear={false} onChange={(d) => d && setMonth(d.format('YYYY-MM'))} />
        )}
      </Flex>
      <Alert type="info" showIcon title={t('kpiDefinition')} description={kpi.data && `${t('source')}: ${kpi.data.source}`} style={{ marginBottom: 16 }} />
      {period?.month && (
        <Alert type="info" style={{ marginBottom: 16 }}
          title={t(period.to < dayjs(`${period.month}-01`).endOf('month').format('YYYY-MM-DD') ? 'kpiMonthToDate' : 'kpiMonthWhole', { from: period.from, to: period.to, shifts: period.shifts })} />
      )}
      {!kpi.data ? <Card loading={kpi.isLoading}><Empty /></Card> : (
        <>
          <Card size="small" title={<>{t('kpiA')} {band(kpi.data.kpiA.band)}</>} extra={`${t('averageCode')}: ${kpi.data.kpiA.averageCode}`} style={{ marginBottom: 16 }}>
            <Row gutter={[16, 16]}>
              {kpi.data.kpiA.areas.map((a) => (
                <Col key={a.area} xs={24} md={8}>
                  <Card size="small" title={<>{a.area} {band(a.band)}</>}>
                    <Statistic title={t('ratio')} value={a.ratioLabel} />
                    <div>{t('nursesOnDuty')}: {a.nurses} · {t('beds')}: {a.beds} · {t('code')}: {a.code}</div>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
          <Card size="small" title={<>{t('kpiB')} {band(kpi.data.kpiB.band)}</>} style={{ marginBottom: 16 }}>
            <Statistic title={t('ratio')} value={kpi.data.kpiB.ratioLabel} />
            <div>{t('nursesOnDuty')}: {kpi.data.kpiB.nurses} · {t('beds')}: {kpi.data.kpiB.beds}</div>
          </Card>
          <Collapse size="small" items={[{
            key: 'basis', label: t('kpiCounted'), children: (
              <Descriptions size="small" column={1} bordered items={[
                { key: 'p', label: t('kpiNursePositions'), children: codes(kpi.data.basis.nursePositions) },
                { key: 'a', label: t('kpiAreaUnits'), children: codes(Object.entries(kpi.data.basis.areaUnits).map(([u, a]) => `${u} (${a})`)) },
                { key: 'i', label: t('kpiInpatientUnits'), children: codes(kpi.data.basis.inpatientBedUnits) },
                { key: 'n', label: t('kpiNonPatientCare'), children: codes(kpi.data.basis.nonPatientCareUnits) },
              ]} />
            ),
          }]} />
        </>
      )}
    </Card>
  );
}
