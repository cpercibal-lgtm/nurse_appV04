import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Result, Spin } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { usePreferences } from '../../hooks/usePreferences';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';

/** The token arrives after "#" so it never reaches a server log (D-67, as D-50). */
const tokenFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

// The link from the NEW mailbox (D-67): confirms the sign-in e-mail change.
// Every session of the account is signed out, this browser's included.
export default function ConfirmEmailPage() {
  const { t } = useTranslation();
  const { language, setLanguage } = usePreferences();
  const logout = useAuth((s) => s.logout);
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'done'; email: string } | { kind: 'error'; message: string }>({ kind: 'working' });
  const [token, setToken] = useState(tokenFromHash);
  // Reuse each token's promise when StrictMode restarts effects or the user
  // returns to a previous hash: confirmation tokens are single-use.
  const confirmations = useRef(new Map<string, Promise<{ email: string }>>());

  useEffect(() => {
    const onHash = () => setToken(tokenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!token) { setState({ kind: 'error', message: t('emailConfirmNoToken') }); return; }
    let active = true;
    setState({ kind: 'working' });
    let confirmation = confirmations.current.get(token);
    if (!confirmation) {
      confirmation = http.post<{ email: string }>('/auth/email-change/confirm', { token })
        .then(async (out) => {
          await logout().catch(() => undefined); // the server ended sessions, even if this link is no longer displayed
          return out;
        });
      confirmations.current.set(token, confirmation);
    }
    confirmation.then(
      (out) => { if (active) setState({ kind: 'done', email: out.email }); },
      (e) => { if (active) setState({ kind: 'error', message: describeApiError(e) }); },
    );
    return () => { active = false; };
  }, [token, logout, t]);

  return (
    <div className="login-backdrop">
      <Card style={{ width: 440, maxWidth: '100%' }} title={t('emailConfirmTitle')}>
        {state.kind === 'working' && <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
        {state.kind === 'done' && (
          <Result status="success" title={t('emailConfirmDone')} subTitle={<span dir="ltr">{state.email}</span>}
            extra={<Link to="/login"><Button type="primary">{t('login')}</Button></Link>} />
        )}
        {state.kind === 'error' && (
          <>
            <Alert type="error" showIcon title={state.message} style={{ marginBottom: 16 }} />
            <Link to="/login"><Button>{t('backToLogin')}</Button></Link>
          </>
        )}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>{language === 'en' ? 'العربية' : 'English'}</Button>
        </div>
      </Card>
    </div>
  );
}
