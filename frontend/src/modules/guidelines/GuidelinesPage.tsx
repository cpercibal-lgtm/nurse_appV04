// Guidelines (user manual): what each screen is for, every task in one template
// (purpose → related), the workflows drawn as images, and search. Content and
// the printable manual come from ./content (scripts/manual/build.ts). This page
// only explains; the server still decides who may do what.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Col, Collapse, Empty, Flex, Grid, Input, Menu, Row, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { ArrowRightOutlined, BookOutlined, DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { MODULES, isModuleVisible } from '../../app/modules';
import { usePermissions } from '../../hooks/usePermissions';
import { usePreferences } from '../../hooks/usePreferences';
import { SECTIONS, sectionById, sectionNumber } from './content';
import { searchGuidelines } from './content/search';
import { ROLE_LABEL, STATUS_LABEL, type GuideRole, type GuideSection, type GuideTask } from './content/types';
import { FlowImage } from './FlowImage';
import { guideLink } from './GuideHelp';

export const MANUAL_PDF = '/guidelines/AIGH_Nursing_Workforce_User_Manual_V04.pdf';

const STATUS_COLOR = { IMPLEMENTED: 'green', PARTIAL: 'gold', PLANNED: 'red' } as const;
const ROLE_COLOR: Record<GuideRole, string> = { EMPLOYEE: 'blue', SUPERVISOR: 'orange', HR_ADMIN: 'green', SYSTEM_ADMIN: 'volcano' };

function RoleTags({ roles }: { roles: GuideRole[] }) {
  return <>{roles.map((r) => <Tag key={r} color={ROLE_COLOR[r]} style={{ marginInlineEnd: 4 }}>{ROLE_LABEL[r]}</Tag>)}</>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <Typography.Text strong>{label}</Typography.Text>
      <div>{children}</div>
    </div>
  );
}

function TaskBody({ task }: { task: GuideTask }) {
  return (
    <div>
      {task.statusNote && <Alert type={task.status === 'PLANNED' ? 'error' : 'warning'} showIcon style={{ marginBottom: 12 }} title={`${STATUS_LABEL[task.status]}: ${task.statusNote}`} />}
      <Field label="Purpose">{task.purpose}</Field>
      <Field label="Who can perform it">{task.who} <RoleTags roles={task.roles} /></Field>
      {task.before?.length ? <Field label="Before you start"><ul style={{ margin: 0, paddingInlineStart: 20 }}>{task.before.map((b) => <li key={b}>{b}</li>)}</ul></Field> : null}
      <Field label="Steps"><ol style={{ margin: 0, paddingInlineStart: 22 }}>{task.steps.map((s) => <li key={s} style={{ marginBottom: 2 }}>{s}</li>)}</ol></Field>
      <Field label="System result">{task.result}</Field>
      <Field label="Approval">{task.approval}</Field>
      <Field label="Next step">{task.next}</Field>
      {task.problems?.length ? (
        <Field label="Common problems">
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>{task.problems.map((p) => <li key={p.problem}><Typography.Text italic>{p.problem}</Typography.Text> — {p.fix}</li>)}</ul>
        </Field>
      ) : null}
      {task.related?.length ? (
        <Field label="Related">
          <Space size={4} wrap>{task.related.map((id) => <Link key={id} to={guideLink(id)}><Tag style={{ cursor: 'pointer' }}>{sectionNumber(id)}. {sectionById(id)?.title}</Tag></Link>)}</Space>
        </Field>
      ) : null}
      {task.flow && <FlowImage id={task.flow} />}
    </div>
  );
}

function SectionView({ section, taskId, onlyMine, mine }: { section: GuideSection; taskId: string | null; onlyMine: boolean; mine: Set<GuideRole> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const perms = usePermissions();
  const module = section.route ? MODULES.find((m) => m.path === section.route) : undefined;
  const canOpen = module && isModuleVisible(module, perms);
  const tasks = onlyMine ? section.tasks.filter((x) => x.roles.some((r) => mine.has(r))) : section.tasks;
  const [open, setOpen] = useState<string[]>(taskId ? [taskId] : []);
  useEffect(() => { setOpen(taskId ? [taskId] : []); }, [section.id, taskId]);

  return (
    <div lang="en" dir="ltr">
      <Flex justify="space-between" align="start" gap={12} wrap style={{ marginBottom: 8 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>{sectionNumber(section.id)}. {section.title}</Typography.Title>
        {canOpen && <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate(module.path)}>{t('guidelinesOpen', { page: t(module.labelKey) })}</Button>}
      </Flex>
      <div style={{ marginBottom: 8 }}><RoleTags roles={section.roles} /></div>
      <Typography.Paragraph style={{ fontSize: 15 }}>{section.summary}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}><b>Who:</b> {section.audience}</Typography.Paragraph>
      {section.where && <Typography.Paragraph type="secondary"><b>Where:</b> {section.where}</Typography.Paragraph>}
      {section.callouts?.map((c) => <Alert key={c.text} type={c.kind} showIcon style={{ marginBottom: 12 }} title={c.text} />)}
      {section.flows?.map((f) => <FlowImage key={f} id={f} />)}
      {section.tables?.map((tb) => (
        <div key={tb.title} style={{ marginBottom: 20 }}>
          <Typography.Title level={5}>{tb.title}</Typography.Title>
          <Table size="small" pagination={false} scroll={{ x: true }} rowKey={(r) => r.join('|')}
            dataSource={tb.rows} columns={tb.columns.map((c, i) => ({ title: c, key: c, render: (_: unknown, row: string[]) => row[i] }))} />
        </div>
      ))}
      {tasks.length > 0 && (
        <>
          <Typography.Title level={4} style={{ marginTop: 8 }}>Tasks</Typography.Title>
          <Collapse activeKey={open} onChange={(k) => setOpen(k as string[])}
            items={tasks.map((task) => ({
              key: task.id,
              label: (
                <span id={`task-${task.id}`}>
                  <Typography.Text strong>{sectionNumber(section.id)}.{section.tasks.indexOf(task) + 1} {task.title}</Typography.Text>{' '}
                  <Tag color={STATUS_COLOR[task.status]} style={{ marginInlineStart: 6 }}>{STATUS_LABEL[task.status]}</Tag>
                </span>
              ),
              extra: <RoleTags roles={task.roles} />,
              children: <TaskBody task={task} />,
            }))} />
        </>
      )}
      {onlyMine && tasks.length === 0 && section.tasks.length > 0 && <Empty description={t('guidelinesNoTasksForRole')} />}
    </div>
  );
}

export default function GuidelinesPage() {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const { language } = usePreferences();
  const perms = usePermissions();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const sectionId = sectionById(params.get('s') ?? '') ? params.get('s')! : SECTIONS[0]!.id;
  const taskId = params.get('t');
  const section = sectionById(sectionId)!;
  const prev = SECTIONS[sectionNumber(section.id) - 2];
  const next = SECTIONS[sectionNumber(section.id)];

  // What "my role" means here: the assignments held (a dormant System Admin still reads System Admin tasks).
  const mine = useMemo(() => {
    const r = new Set<GuideRole>();
    if (perms.isEmployee) r.add('EMPLOYEE');
    for (const role of ['SUPERVISOR', 'HR_ADMIN', 'SYSTEM_ADMIN'] as const) if (perms.holdsAssignment(role)) r.add(role);
    return r;
  }, [perms]);

  const hits = useMemo(() => (query.trim() ? searchGuidelines(query) : []), [query]);

  const go = (s: string, task?: string) => {
    setParams(task ? { s, t: task } : { s });
    setQuery('');
  };

  // Deep links (from a page's "?" button or a related link): bring the section, or the task, into view.
  useEffect(() => {
    const target = taskId ? document.getElementById(`task-${taskId}`) : top.current;
    const h = window.setTimeout(() => target?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => window.clearTimeout(h);
  }, [sectionId, taskId]);

  const nav = SECTIONS.map((s) => ({ key: s.id, label: `${sectionNumber(s.id)}. ${s.title}` }));

  return (
    <Card
      title={<Space><BookOutlined />{t('guidelines')}</Space>}
      extra={<Button icon={<DownloadOutlined />} href={MANUAL_PDF} download>{screens.sm ? t('guidelinesDownloadPdf') : 'PDF'}</Button>}
    >
      <div ref={top} className="guide-anchor" />
      {language === 'ar' && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('guidelinesEnglishOnly')} />}
      <Flex gap={12} wrap align="center" style={{ marginBottom: 12 }}>
        <Input.Search allowClear size="large" style={{ flex: '1 1 320px' }} placeholder={t('guidelinesSearch')} value={query}
          onChange={(e) => setQuery(e.target.value)} onSearch={(v) => setQuery(v)} aria-label={t('guidelinesSearch')} />
        <Space>
          <Switch checked={onlyMine} onChange={setOnlyMine} aria-label={t('guidelinesMine')} />
          <span>{t('guidelinesMine')}</span>
        </Space>
      </Flex>

      {query.trim() && (
        <Card size="small" title={t('guidelinesResults')} style={{ marginBottom: 16 }}>
          {hits.length === 0 ? <Empty description={t('guidelinesNoResults')} /> : (
            <div lang="en" dir="ltr" role="list">
              {hits.map((h) => (
                <button key={`${h.section.id}/${h.task?.id ?? ''}`} type="button" role="listitem" onClick={() => go(h.section.id, h.task?.id)}
                  style={{ display: 'block', width: '100%', textAlign: 'start', background: 'none', border: 0, borderBottom: '1px solid var(--ant-color-split, #f0f0f0)', padding: '8px 4px', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
                  <Typography.Link>{h.task ? h.task.title : `${sectionNumber(h.section.id)}. ${h.section.title}`}</Typography.Link>
                  <div><Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    {h.task ? `${sectionNumber(h.section.id)}. ${h.section.title} — ${h.task.purpose}` : h.section.summary.slice(0, 160)}
                  </Typography.Text></div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {sectionId !== 'hospital-workflow' && (
        <Alert type="success" showIcon style={{ marginBottom: 16 }} title={t('guidelinesHowItWorks')} description={t('guidelinesHowItWorksHint')}
          action={<Button size="small" onClick={() => go('hospital-workflow')}>{t('guidelinesOpenSection')}</Button>} />
      )}

      <Row gutter={[24, 16]}>
        <Col xs={24} lg={7} xl={6}>
          {screens.lg ? (
            <div style={{ position: 'sticky', top: 16 }}>
              <Typography.Text type="secondary" strong>{t('guidelinesSections')}</Typography.Text>
              <Menu mode="inline" selectedKeys={[sectionId]} items={nav} onClick={(e) => go(e.key)} style={{ borderInlineEnd: 'none', marginTop: 8 }} />
            </div>
          ) : (
            <Select style={{ width: '100%' }} value={sectionId} onChange={(v) => go(v)} options={nav.map((n) => ({ value: n.key, label: n.label }))} aria-label={t('guidelinesSections')} />
          )}
        </Col>
        <Col xs={24} lg={17} xl={18}>
          <SectionView section={section} taskId={taskId} onlyMine={onlyMine} mine={mine} />
          <Flex justify="space-between" style={{ marginTop: 24 }} gap={8} wrap lang="en">
            {prev ? <Button onClick={() => go(prev.id)}>‹ {prev.title}</Button> : <span />}
            {next ? <Button onClick={() => go(next.id)}>{next.title} ›</Button> : <span />}
          </Flex>
        </Col>
      </Row>
    </Card>
  );
}
