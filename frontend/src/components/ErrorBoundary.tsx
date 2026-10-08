// Last line of defence for a page that fails while rendering: a message and a
// Reload button instead of a blank screen. A page file from a replaced release
// normally reloads by itself (lib/freshImport); this shows when that could not
// happen (offline, or a reload already tried in the last 30 seconds). Plain
// elements on purpose: this is in the first-load bundle (200 KB gz budget), and
// it must show even when no further file can be loaded.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isStaleChunkError } from '../lib/freshImport';

function Fallback({ stale }: { stale: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="page-error" role="alert">
      <h2>{t(stale ? 'appUpdatedTitle' : 'pageErrorTitle')}</h2>
      <p>{t(stale ? 'appUpdatedHint' : 'pageErrorHint')}</p>
      <button type="button" onClick={() => window.location.reload()}>{t('reloadPage')}</button>
    </div>
  );
}

interface Props { children: ReactNode; /** A new value (the route) clears the error. */ resetKey?: string }
interface State { error: unknown; key?: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('page failed to render', error, info.componentStack);
  }

  render() {
    if (this.state.error) return <Fallback stale={isStaleChunkError(this.state.error)} />;
    return this.props.children;
  }
}
