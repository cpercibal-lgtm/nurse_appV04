// The single list of application pages. Both the router and the navigation
// menu are built from it, so a page cannot be routed without appearing in the
// menu or vice versa. Each page is a lazily loaded chunk (route-level splitting).

import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import {
  AuditOutlined, BellOutlined, CheckCircleOutlined, ClockCircleOutlined, DashboardOutlined,
  FileProtectOutlined, FundOutlined, IdcardOutlined, SafetyCertificateOutlined, ScheduleOutlined,
  SettingOutlined, TeamOutlined, ApartmentOutlined, HistoryOutlined, UserOutlined, SafetyOutlined, LockOutlined, BookOutlined, NotificationOutlined,
} from '@ant-design/icons';
import type { TranslationKey } from '../lib/i18n';
import type { AppRole } from '../types/api';

export interface AppModule {
  path: string;
  labelKey: TranslationKey;
  icon: ReactNode;
  load: () => Promise<{ default: ComponentType }>;
  Page: LazyExoticComponent<ComponentType>;
  /** Shown in the menu only to holders of one of these assignments (UI hint; the server enforces). */
  requires?: AppRole[];
  /** Shown only to accounts linked to an employee record (self-service pages). */
  employeeOnly?: boolean;
}

function page(path: string, labelKey: TranslationKey, icon: ReactNode, load: AppModule['load'], access: { requires?: AppRole[]; employeeOnly?: boolean } = {}): AppModule {
  return { path, labelKey, icon, load, Page: lazy(load), ...access };
}

const STAFF: AppRole[] = ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'];

export const MODULES: AppModule[] = [
  page('/', 'dashboard', <DashboardOutlined />, () => import('../modules/dashboard/DashboardPage')),
  page('/nurses', 'nurses', <TeamOutlined />, () => import('../modules/nurses/NursesPage'), { requires: STAFF }),
  page('/contracts', 'contracts', <FileProtectOutlined />, () => import('../modules/contracts/ContractsPage')),
  page('/credentials', 'credentials', <SafetyCertificateOutlined />, () => import('../modules/credentials/CredentialsPage'), { requires: STAFF }),
  page('/my-profile', 'myProfile', <UserOutlined />, () => import('../modules/nurses/MyProfilePage'), { employeeOnly: true }),
  page('/my-data', 'myData', <LockOutlined />, () => import('../modules/privacy/MyDataPage'), { employeeOnly: true }), // D-55 (PDPL rights)
  page('/my-credentials', 'myCredentials', <IdcardOutlined />, () => import('../modules/credentials/MyCredentialsPage'), { employeeOnly: true }),
  page('/eligibility', 'eligibility', <CheckCircleOutlined />, () => import('../modules/eligibility/EligibilityPage'), { requires: STAFF }),
  page('/workforce', 'workforce', <ApartmentOutlined />, () => import('../modules/workforce/WorkforcePage')),
  page('/kpi', 'kpi', <FundOutlined />, () => import('../modules/workforce/KpiPage'), { requires: STAFF }),
  page('/scheduling', 'scheduling', <ScheduleOutlined />, () => import('../modules/scheduling/SchedulingPage')),
  page('/attendance', 'attendance', <ClockCircleOutlined />, () => import('../modules/attendance/AttendancePage')),
  page('/notifications', 'notifications', <BellOutlined />, () => import('../modules/notifications/NotificationsPage')),
  page('/announcements', 'announcements', <NotificationOutlined />, () => import('../modules/announcements/AnnouncementsPage')), // D-69: everyone reads; senders write
  page('/audit', 'audit', <AuditOutlined />, () => import('../modules/audit/AuditPage'), { requires: ['SYSTEM_ADMIN'] }), // D-20
  page('/sessions', 'signInHistory', <HistoryOutlined />, () => import('../modules/auth/SessionsPage')),
  page('/security', 'twoFactor', <SafetyOutlined />, () => import('../modules/auth/SecurityPage')),
  page('/admin', 'admin', <SettingOutlined />, () => import('../modules/administration/AdministrationPage'), { requires: ['HR_ADMIN', 'SYSTEM_ADMIN'] }),
  page('/guidelines', 'guidelines', <BookOutlined />, () => import('../modules/guidelines/GuidelinesPage')), // the user manual, for every signed-in user
];

/** Whether a page appears in this user's menu (a UI hint; the server authorizes every request). */
export function isModuleVisible(m: AppModule, can: { holdsAssignment: (...roles: AppRole[]) => boolean; isEmployee: boolean }) {
  return (!m.requires || can.holdsAssignment(...m.requires)) && (!m.employeeOnly || can.isEmployee);
}
