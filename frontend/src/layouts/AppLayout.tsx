// Application shell (ported from V03 app/src/components/AppLayout.tsx).
// Dropped from V03: the footer claiming "PDPL · KSA me-central-1" (me-central-1
// is the UAE, and the browser cannot know the server region), the unread badge
// fed by the browser store (now served by GET /notifications), and the
// DEVELOPER role display (decision D-5).

import { useState, type ReactNode } from 'react';
import { App as AntApp, Avatar, Badge, Button, Dropdown, Flex, Layout, Menu, Tag, Tooltip } from 'antd';
import {
  BellOutlined, BulbOutlined, GlobalOutlined, HistoryOutlined, KeyOutlined, SafetyOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { isModuleVisible, MODULES } from '../app/modules';
import { useAuth } from '../hooks/useAuth';
import { usePermissions } from '../hooks/usePermissions';
import { usePreferences } from '../hooks/usePreferences';
import { useUnreadCount } from '../modules/notifications/api';
import { ChangePasswordModal } from './ChangePasswordModal';

// Plain spans instead of antd Typography in the shell: Typography bundles its
// editable/copyable features (Input, TextArea, clipboard) into the first load.
const { Header, Sider, Content } = Layout;

/** The menu key for a path is the module whose path is its longest prefix. */
function selectedKey(pathname: string): string {
  const match = MODULES.filter((m) => m.path === '/' ? pathname === '/' : pathname === m.path || pathname.startsWith(`${m.path}/`));
  return match[0]?.path ?? '';
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const { t } = useTranslation();
  const permissions = usePermissions();
  const pam = useAuth((s) => s.pam);
  const breakGlass = useAuth((s) => s.breakGlass);
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const roles = useAuth((s) => s.roles);
  const logout = useAuth((s) => s.logout);
  const unread = useUnreadCount();
  const unreadCount = unread.data ?? 0;
  const notificationsLabel = unreadCount > 0
    ? `${t('notifications')} ${unreadCount > 99 ? '99+' : unreadCount}`
    : t('notifications');
  const { language, setLanguage, theme, setTheme } = usePreferences();
  const isRtl = language === 'ar';
  const sidebarWidth = collapsed ? 64 : 244;

  async function signOut() {
    await logout(); // session store clears identity-bound queries on every sign-out
    navigate('/login', { replace: true });
  }

  const menuItems = MODULES.filter((m) => isModuleVisible(m, permissions)).map((m) => ({
    key: m.path,
    icon: m.icon,
    // Preload the page's chunk on hover/focus so navigation feels instant.
    label: <Link to={m.path} onMouseEnter={() => void m.load()} onFocus={() => void m.load()}>{t(m.labelKey)}</Link>,
  }));

  const userMenu = {
    items: [
      { key: 'email', label: user?.email, disabled: true },
      ...roles.map((r, i) => ({ key: `role-${i}`, label: `${r.role} · ${r.scopeType}${r.dormant ? ' (dormant)' : ''}`, disabled: true })),
      { type: 'divider' as const },
      ...(user?.isBreakGlass ? [] : [{ key: 'password', icon: <KeyOutlined />, label: t('changePassword'), onClick: () => setChangingPassword(true) }]),
      { key: 'sessions', icon: <HistoryOutlined />, label: t('signInHistory'), onClick: () => navigate('/sessions') },
      { key: 'security', icon: <SafetyOutlined />, label: t('twoFactor'), onClick: () => navigate('/security') },
      { key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void signOut() },
    ],
  };

  return (
    <AntApp>
      {/* WCAG 2.4.1: the first Tab stop lets keyboard and screen-reader users jump past the menu. */}
      <a href="#main-content" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>{t('skipToContent')}</a>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider
          trigger={null}
          collapsible
          collapsed={collapsed}
          width={244}
          collapsedWidth={64}
          breakpoint="lg"
          onBreakpoint={setCollapsed}
          className="app-sider"
          style={{ insetInlineStart: 0 }}
        >
          <div className="app-logo">
            {collapsed
              ? <img src="/logo-emblem.png" alt={t('appName')} width={40} height={38} />
              : <img src="/logo-sidebar.png" alt={t('appName')} width={210} height={96} style={{ maxWidth: '100%', height: 'auto' }} />}
          </div>
          <Menu theme="dark" mode="inline" selectedKeys={[selectedKey(location.pathname)]} items={menuItems} className="app-menu" />
          <div className="app-version">v{__APP_VERSION__}</div>
        </Sider>

        <Layout style={{ marginInlineStart: sidebarWidth, transition: 'margin 0.2s' }}>
          <Header className="app-header">
            <Flex align="center" gap={8} style={{ minWidth: 0, flex: '1 1 auto' }}>
              <Button type="text" aria-label={t('toggleMenu')} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
              <span className="app-title" title={t('appName')}>{t('appName')}</span>
            </Flex>
            <Flex align="center" gap={4}>
              {breakGlass && <Tag color="red">{t('breakGlassActive', { time: new Date(breakGlass.expiresAt).toLocaleTimeString() })}</Tag>}
              {pam && !breakGlass && (
                <Link to="/admin"><Tag color="orange">{t('elevatedUntil', { time: new Date(pam.expiresAt).toLocaleTimeString() })}</Tag></Link>
              )}
              <Tooltip title={t('notifications')}>
                <Link to="/notifications" aria-label={notificationsLabel}>
                  <span aria-hidden="true"><Badge count={unreadCount} size="small" overflowCount={99}><BellOutlined style={{ fontSize: 16, padding: 8 }} /></Badge></span>
                </Link>
              </Tooltip>
              <Tooltip title={theme === 'dark' ? t('lightMode') : t('darkMode')}>
                <Button type="text" aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')} icon={theme === 'dark' ? <BulbOutlined /> : <MoonOutlined />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
              </Tooltip>
              <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>
                {language === 'en' ? 'ع' : 'EN'}
              </Button>
              <Dropdown menu={userMenu} placement={isRtl ? 'bottomLeft' : 'bottomRight'}>
                <Flex align="center" gap={8} style={{ cursor: 'pointer', marginInlineStart: 4 }}>
                  <Avatar className="app-avatar">{user?.displayName[0]?.toUpperCase()}</Avatar>
                  {!collapsed && <span className="app-user">{user?.displayName}</span>}
                </Flex>
              </Dropdown>
            </Flex>
          </Header>
          <Content id="main-content" tabIndex={-1} className="app-content" style={{ margin: 20 }}>{children}</Content>
        </Layout>
        <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
      </Layout>
    </AntApp>
  );
}
