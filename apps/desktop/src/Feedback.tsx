import { useEffect } from 'react';
import type { Failure } from './client';
import { Icon } from './Icon';

export type ErrorPlacement = 'connection' | 'operations' | 'sources' | 'counts' | 'search' | 'document' | 'toast';

export function ErrorNotice({ error, dismiss }: { error: Failure; dismiss?: () => void }) {
  return (
    <div className="notice warning error-notice" role="alert">
      <div className="error-heading">
        <strong>{error.code}</strong>
        {dismiss && <button className="error-dismiss" aria-label="Dismiss error" onClick={dismiss}><Icon name="close" /></button>}
      </div>
      <p>{error.message}</p>
      {error.details != null && (
        <details className="error-details">
          <summary>Details</summary>
          <pre>{JSON.stringify(error.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function DocumentFailure({ error, path, close }: { error: Failure; path: string | null; close: () => void }) {
  return (
    <aside className="panel document-failure" aria-label="Document error">
      <div className="inspector-heading">
        <span className="row-symbol orange"><Icon name="file" /></span>
        <div className="row-copy"><h2>Document unavailable</h2><p className="path">{path}</p></div>
        <button className="inspector-close" aria-label="Close details" onClick={close}><Icon name="close" /></button>
      </div>
      <ErrorNotice error={error} />
    </aside>
  );
}

export function ErrorToast({ error, dismiss }: { error: Failure | undefined; dismiss: () => void }) {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [error, dismiss]);
  return error ? <div className="error-toast" aria-label="Error notification"><ErrorNotice error={error} dismiss={dismiss} /></div> : null;
}
