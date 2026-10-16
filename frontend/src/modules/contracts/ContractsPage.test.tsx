import { Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { Alert, Button, Drawer, Input, Modal, Table } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../lib/i18n.en';
import { ar } from '../../lib/i18n.ar';
import ContractsPage from './ContractsPage';
import { useContractDocs, type ContractRow } from './api';

const state = vi.hoisted(() => ({
  rows: [] as ContractRow[], userId: 7,
  roles: ['HR_ADMIN'],
  mutateAsync: vi.fn(),
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const i18n = createInstance();

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }) }));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: (select: (s: { user: { id: number } }) => unknown) => select({ user: { id: state.userId } }),
}));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ hasRole: (...roles: string[]) => roles.some((role) => state.roles.includes(role)) }),
}));
vi.mock('../guidelines/GuideHelp', () => ({ GuideHelp: 'guide-help' }));
vi.mock('./ContractTypesDrawer', () => ({ ContractTypesDrawer: 'contract-types' }));
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  useContracts: () => ({ data: { items: state.rows, total: state.rows.length }, isLoading: false }),
  useContractTypes: () => ({ data: { items: [] } }),
  useContractAction: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
  useContractDocs: vi.fn(() => ({ data: { items: [] }, isLoading: false })),
  useCreatable: () => ({}), useRenewable: () => ({}),
}));
// Stub the design system at the component boundary; exercise the page's state
// and event handlers without requiring a DOM or Ant Design portals.
vi.mock('antd', () => ({
  Alert: 'alert', Button: 'button', Card: 'card', DatePicker: 'date-picker', Drawer: 'drawer',
  Flex: 'flex', Modal: 'modal', Select: 'select', Space: 'space', Table: 'table', Tag: 'tag', Upload: 'upload',
  App: { useApp: () => ({ message: state.message }) },
  Form: Object.assign(() => null, {
    Item: 'form-item',
    useForm: () => [{ setFieldsValue: vi.fn(), resetFields: vi.fn(), submit: vi.fn() }],
    useWatch: () => undefined,
  }),
  Input: { TextArea: 'text-area' },
}));

// Props span third-party component types, including Table render callbacks.
// Keep this test boundary permissive instead of duplicating Ant Design's types.
type Element = ReactElement<any>;
type Event = (page: Element) => void;

function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) => isValidElement(child)
    ? [child as Element, ...elements((child as Element).props.children)] : []);
}

function one(node: ReactNode, type: unknown): Element {
  const matches = elements(node).filter((e) => e.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

// The server renderer supports render-phase state updates. Replay synchronous
// events in a hook-owning component with real React state, without mocking
// hooks or depending on their order in the page. UI components stay unrendered.
function play(...events: Event[]): Element {
  let result: Element | undefined;
  function Scenario() {
    const [step, setStep] = useState(0);
    const page = ContractsPage();
    if (step < events.length) {
      events[step]!(page);
      setStep(step + 1);
    } else result = page;
    return null;
  }
  renderToStaticMarkup(<Scenario />);
  expect(result).toBeDefined();
  return result!;
}

function button(node: ReactNode, label: string): Element {
  const matches = elements(node).filter((e) => e.type === Button && e.props.children === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function review(page: Element): Element {
  const matches = elements(page).filter((e) => e.type === Modal
    && e.props.title.startsWith(`${i18n.t('reviewDateChange')} #`));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function rowActions(page: Element, id: number): ReactNode {
  const table = elements(page).find((e) => e.type === Table && e.props.rowKey === 'id')!;
  const row = table.props.dataSource.find((r: ContractRow) => r.id === id);
  return table.props.columns.at(-1).render(undefined, row);
}

const openReview = (id: number): Event => (page) => button(rowActions(page, id), i18n.t('reviewDateChange')).props.onClick();
const openCopy: Event = (page) => button(one(review(page).props.children, Alert).props.action, i18n.t('dateChangeOpenCopy')).props.onClick();
const closeCopy: Event = (page) => one(page, Drawer).props.onClose();

function contract(id: number, requestedById = 8): ContractRow {
  return {
    id, employeeId: id + 100, jobNumber: `N-${id}`, employeeName: `Nurse ${id}`, positionCode: 'RN', unitCode: 'ICU',
    status: 'Approved', view: 'FULL', startDate: '2026-10-01', endDate: '2027-10-01',
    startDateHijri: '1448-04-20', endDateHijri: '1449-04-30',
    contractTypeCode: null, contractTypeName: null, contractTypeNameAr: null,
    pendingDateChange: {
      id: id + 200, startDate: '2026-10-02', endDate: '2027-10-02', startDateHijri: '1448-04-21', endDateHijri: '1449-05-01',
      reason: 'Typing error, see uploaded contract copy', requestedById, requestedByName: `HR ${requestedById}`,
      requestedAt: '2026-10-15T09:00:00Z',
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.mutateAsync.mockReset();
  state.userId = 7;
  state.roles = ['HR_ADMIN'];
  state.rows = [contract(11), contract(22)];
  await i18n.init({ lng: 'en', resources: { en: { translation: en }, ar: { translation: ar } }, interpolation: { escapeValue: false } });
});

describe('opening the contract copy from a date-change review', () => {
  it.each([
    ['en', false], ['en', true], ['ar', false], ['ar', true],
  ] as const)('keeps the %s review open when the requester is the current user: %s', async (language, mine) => {
    await i18n.changeLanguage(language);
    state.rows[1] = contract(22, mine ? state.userId : 8);
    expect(one(play(), Drawer).props.open).toBe(false);
    expect(useContractDocs).toHaveBeenLastCalledWith(null);

    const page = play(openReview(22), (p) => {
      const alert = one(review(p).props.children, Alert);
      expect(alert.props.type).toBe(mine ? 'info' : 'warning');
      expect(alert.props.title).toBe(i18n.t(mine ? 'dateChangeOwnHint' : 'dateChangeReviewHint'));
      openCopy(p);
    });
    expect(useContractDocs).toHaveBeenLastCalledWith(22);
    expect(one(page, Drawer).props).toMatchObject({ open: true, title: `${i18n.t('contractCopy')} #22` });
    const modal = review(page);
    expect(modal.props.open).toBe(true);
    expect(one(modal.props.children, Table).props.dataSource).toMatchObject([
      { start: '2026-10-01', end: '2027-10-01', hs: '1448-04-20', he: '1449-04-30' },
      { start: '2026-10-02', end: '2027-10-02', hs: '1448-04-21', he: '1449-05-01' },
    ]);
    const decisions = elements(modal.props.footer).filter((e) => e.type === Button).map((e) => e.props.children);
    expect(decisions).toEqual(mine
      ? [i18n.t('cancel'), i18n.t('withdraw')]
      : [i18n.t('cancel'), i18n.t('reject'), i18n.t('approve')]);
    expect(elements(modal.props.children).filter((e) => e.type === Input.TextArea)).toHaveLength(mine ? 0 : 1);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['', true], ['    ', true], ['abcd', true], ['  abcd  ', true], ['\t\n\u00a0', true],
    ['abcde', false], ['  abcde  ', false], ['تختلف', false], ['  The dates differ from the copy  ', false],
  ] as const)(
    'preserves rejection note %j and its validation when returning from the copy', (note, rejectDisabled) => {
      const page = play(openReview(22), (p) => {
        one(review(p).props.children, Input.TextArea).props.onChange({ target: { value: note } });
      }, openCopy, closeCopy);
      expect(one(page, Drawer).props.open).toBe(false);
      expect(useContractDocs).toHaveBeenLastCalledWith(null);
      expect(review(page).props.open).toBe(true);
      expect(one(review(page).props.children, Input.TextArea).props.value).toBe(note);
      expect(button(review(page).props.footer, i18n.t('reject')).props.disabled).toBe(rejectDisabled);
      expect(state.mutateAsync).not.toHaveBeenCalled();
    },
  );

  it('opens the next reviewed contract rather than retaining the previous copy', () => {
    const page = play(openReview(11), openCopy, closeCopy, (p) => review(p).props.onCancel(), openReview(22), openCopy);
    expect(useContractDocs).toHaveBeenLastCalledWith(22);
    expect(one(page, Drawer).props.title).toBe(`${i18n.t('contractCopy')} #22`);
    expect(review(page).props.title).toContain('#22');
    expect(review(page).props.open).toBe(true);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([11, 22])('clears the previous rejection note when opening review #%s', (nextId) => {
    const page = play(openReview(11), (p) => {
      one(review(p).props.children, Input.TextArea).props.onChange({ target: { value: 'Wrong dates for contract 11' } });
    }, openCopy, closeCopy, (p) => review(p).props.onCancel(), openReview(nextId));

    expect(review(page).props.open).toBe(true);
    expect(review(page).props.title).toContain(`#${nextId}`);
    expect(one(review(page).props.children, Input.TextArea).props.value).toBe('');
    expect(button(review(page).props.footer, i18n.t('reject')).props.disabled).toBe(true);
    expect(one(page, Drawer).props.open).toBe(false);
    expect(useContractDocs).toHaveBeenLastCalledWith(null);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it('can reopen the same copy without clearing the note or submitting a decision', () => {
    const page = play(openReview(22), (p) => {
      one(review(p).props.children, Input.TextArea).props.onChange({ target: { value: 'Check the end date' } });
    }, openCopy, closeCopy, openCopy);

    expect(one(page, Drawer).props).toMatchObject({ open: true, title: `${i18n.t('contractCopy')} #22` });
    expect(useContractDocs).toHaveBeenLastCalledWith(22);
    expect(review(page).props.open).toBe(true);
    expect(one(review(page).props.children, Input.TextArea).props.value).toBe('Check the end date');
    expect(button(review(page).props.footer, i18n.t('reject')).props.disabled).toBe(false);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it.each(['HR_ADMIN', 'SYSTEM_ADMIN'])('allows %s to review a pending change', (role) => {
    state.roles = [role];
    const page = play(openReview(22), openCopy);
    expect(review(page).props.open).toBe(true);
    expect(one(page, Drawer).props.open).toBe(true);
    expect(useContractDocs).toHaveBeenLastCalledWith(22);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['SUPERVISOR', 'FULL'], ['EMPLOYEE', 'FULL'], ['HR_ADMIN', 'REDUCED'], ['SYSTEM_ADMIN', 'REDUCED'],
  ] as const)('hides the review for %s with a %s view', (role, view) => {
    state.roles = [role];
    state.rows = [{ ...contract(11), view }];
    const page = play();
    expect(elements(rowActions(page, 11)).some((e) => e.type === Button && e.props.children === i18n.t('reviewDateChange'))).toBe(false);
    expect(one(page, Drawer).props.open).toBe(false);
    expect(useContractDocs).toHaveBeenLastCalledWith(null);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it('does not expose the review shortcut without a pending request', () => {
    state.rows = [{ ...contract(11), pendingDateChange: null }];
    const page = play();
    expect(elements(rowActions(page, 11)).some((e) => e.type === Button && e.props.children === i18n.t('reviewDateChange'))).toBe(false);
    expect(elements(page).some((e) => e.type === Button && e.props.children === i18n.t('dateChangeOpenCopy'))).toBe(false);
    expect(one(page, Drawer).props.open).toBe(false);
  });
});

describe.each(['en', 'ar'])('date-change decisions after inspecting the copy (%s)', (language) => {
  it.each([
    ['approve', false, '   ', undefined],
    ['reject', false, '  Dates differ from the signed copy  ', 'Dates differ from the signed copy'],
    ['withdraw', true, '', undefined],
  ] as const)('submits %s for the reviewed contract with a trimmed optional note', async (decision, mine, note, expectedNote) => {
    await i18n.changeLanguage(language);
    state.rows[1] = contract(22, mine ? state.userId : 8);
    state.mutateAsync.mockResolvedValueOnce({ contractStatus: 'Active', eligibility: 'ELIGIBLE' });
    const page = play(openReview(22), ...(mine ? [] : [(p: Element) => {
      one(review(p).props.children, Input.TextArea).props.onChange({ target: { value: note } });
    }]), openCopy, closeCopy);

    expect(state.mutateAsync).not.toHaveBeenCalled();
    const label = decision === 'withdraw' ? i18n.t('withdraw') : i18n.t(decision);
    button(review(page).props.footer, label).props.onClick();

    expect(state.mutateAsync).toHaveBeenCalledExactlyOnceWith({ kind: 'dateDecision', id: 22, decision, note: expectedNote });
    await vi.waitFor(() => expect(state.message.success).toHaveBeenCalledExactlyOnceWith(i18n.t(`dateChangeDone_${decision}`)));
    if (decision === 'approve') {
      expect(state.message.info).toHaveBeenCalledExactlyOnceWith(i18n.t('contractNowStatus', {
        status: i18n.t('contract_Active'), eligibility: 'ELIGIBLE',
      }));
    } else expect(state.message.info).not.toHaveBeenCalled();
    expect(state.message.error).not.toHaveBeenCalled();
  });

  it('reports a refused decision without a success or status notification', async () => {
    await i18n.changeLanguage(language);
    state.mutateAsync.mockRejectedValueOnce(new Error('The request was already decided'));
    const page = play(openReview(22), openCopy, closeCopy);
    button(review(page).props.footer, i18n.t('approve')).props.onClick();

    expect(state.mutateAsync).toHaveBeenCalledExactlyOnceWith({ kind: 'dateDecision', id: 22, decision: 'approve', note: undefined });
    await vi.waitFor(() => expect(state.message.error).toHaveBeenCalledExactlyOnceWith('The request was already decided'));
    expect(state.message.success).not.toHaveBeenCalled();
    expect(state.message.info).not.toHaveBeenCalled();
  });
});
