import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { ConfigProvider, theme as antTheme } from 'antd';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { MODULES } from './app/modules';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageSkeleton } from './components/PageSkeleton';
import { useAuth } from './hooks/useAuth';
import { usePreferences } from './hooks/usePreferences';
import { freshImport } from './lib/freshImport';

// Only what the first paint needs is in the initial bundle (budget: 200 KB gz,
// scripts/check-bundle-size.mjs). The signed-in shell (menu, dropdowns,
// tooltips), the login form and the 404 page each load on demand; the shell
// is requested while the session check is still in flight.
const loadLayout = () => import('./layouts/AppLayout').then((m) => ({ default: m.AppLayout }));
// freshImport: a file of a replaced release reloads the page once instead of a blank screen.
const AppLayout = lazy(freshImport(loadLayout));
const LoginPage = lazy(freshImport(() => import('./modules/auth/LoginPage')));
const ClaimPage = lazy(freshImport(() => import('./modules/auth/ClaimPage')));
const ResetPasswordPage = lazy(freshImport(() => import('./modules/auth/ResetPasswordPage')));
const ConfirmEmailPage = lazy(freshImport(() => import('./modules/auth/ConfirmEmailPage')));
const NotFound = lazy(freshImport(() => import('./components/NotFound')));

/** Waits for the startup session check, then either renders the page or sends the user to /login. */
function RequireSession({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'checking') return <PageSkeleton />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      {/* A failing page shows its error inside the layout, so the menu stays usable; another page clears it. */}
      <AppLayout><ErrorBoundary resetKey={location.pathname}><Suspense fallback={<PageSkeleton />}>{children}</Suspense></ErrorBoundary></AppLayout>
    </Suspense>
  );
}

function LoginRoute() {
  const status = useAuth((s) => s.status);
  if (status === 'checking') return <PageSkeleton />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <Suspense fallback={<PageSkeleton />}><LoginPage /></Suspense>;
}

export function App() {
  const { language, theme } = usePreferences();

  // Restore a prior session from the HttpOnly refresh cookie. The client's
  // single-flight refresh makes StrictMode's double invocation harmless.
  useEffect(() => {
    // Start fetching the shell in parallel with the session check, so a
    // restored session does not wait for a second round trip.
    void loadLayout();
    void useAuth.getState().restore();
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  return (
    <ConfigProvider
      direction={language === 'ar' ? 'rtl' : 'ltr'}
      theme={{
        algorithm: theme === 'dark' ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        // V03 brand palette.
        token: { colorPrimary: '#1a6b4e', colorLink: '#2563eb', colorSuccess: '#16a34a', colorWarning: '#d97706', colorError: '#dc2626', borderRadius: 8 },
        components: {
          Layout: { siderBg: '#0f3024', triggerBg: '#0a2019' },
          Menu: { darkItemBg: '#0f3024', darkSubMenuItemBg: '#0a2019', darkItemSelectedBg: '#1a6b4e', itemHeight: 42 },
        },
      }}
    >
      <BrowserRouter>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            {/* Registration by invitation (spec §3.2): public, whatever the session state. */}
            <Route path="/claim" element={<Suspense fallback={<PageSkeleton />}><ClaimPage /></Suspense>} />
            {/* Password reset (D-50): public. */}
            <Route path="/reset-password" element={<Suspense fallback={<PageSkeleton />}><ResetPasswordPage /></Suspense>} />
            {/* Sign-in e-mail change (D-67): public, the link from the new mailbox. */}
            <Route path="/confirm-email" element={<Suspense fallback={<PageSkeleton />}><ConfirmEmailPage /></Suspense>} />
            {MODULES.map(({ path, Page }) => (
              <Route key={path} path={path} element={<RequireSession><Page /></RequireSession>} />
            ))}
            <Route path="*" element={<RequireSession><NotFound /></RequireSession>} />
          </Routes>
        </ErrorBoundary>
      </BrowserRouter>
    </ConfigProvider>
  );
}
