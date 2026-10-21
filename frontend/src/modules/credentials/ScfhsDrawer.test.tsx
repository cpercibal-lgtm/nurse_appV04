import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createInstance } from 'i18next';
import { Alert, Button } from 'antd';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from '../../lib/i18n.en';
import { ScfhsDrawer } from './ScfhsDrawer';
import { WebsiteCheckForm } from './WebsiteCheckForm';

const state = vi.hoisted(() => ({ driver: 'mock' as 'mock' | 'live' | 'off' }));
const i18n = createInstance();

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }) }));
vi.mock('./WebsiteCheckForm', () => ({ WebsiteCheckForm: 'website-check-form' }));
vi.mock('./api', () => ({
  useScfhsChecks: () => ({ data: { driver: state.driver, items: [] }, isLoading: false }),
  useScfhsCheckNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// Stub the design system at the component boundary, as in ContractsPage.test.tsx.
vi.mock('antd', () => ({
  Alert: 'alert', Button: 'button', Drawer: 'drawer', Space: 'space', Table: 'table', Tag: 'tag', Typography: { Text: 'text' },
  App: { useApp: () => ({ message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }) },
}));

type Element = ReactElement<any>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) => isValidElement(child)
    ? [child as Element, ...elements((child as Element).props.children)] : []);
}
function drawer(driver: typeof state.driver): Element[] {
  state.driver = driver;
  return elements(ScfhsDrawer({ credential: { id: 1, title: 'SCFHS registration' }, onClose: () => undefined }));
}
const alertTitles = (tree: Element[]) => tree.filter((e) => e.type === Alert).map((e) => e.props.title);
const checkButton = (tree: Element[]) => tree.find((e) => e.type === Button)!;

describe('ScfhsDrawer and SCFHS_DRIVER (D-75)', () => {
  beforeAll(async () => { await i18n.init({ lng: 'en', resources: { en: { translation: en } } }); });

  it('off: says the checks are off, points to the website check and disables the SCFHS check', () => {
    const tree = drawer('off');
    expect(alertTitles(tree)).toContain(en.scfhsOffNotice);
    expect(checkButton(tree).props.disabled).toBe(true);
    expect(tree.some((e) => e.type === WebsiteCheckForm)).toBe(true);
  });

  it('simulated: no off notice, and the simulated check can run', () => {
    const tree = drawer('mock');
    expect(alertTitles(tree)).not.toContain(en.scfhsOffNotice);
    expect(alertTitles(tree)).toContain(en.scfhsMockNotice);
    expect(checkButton(tree).props.disabled).toBe(false);
  });
});
