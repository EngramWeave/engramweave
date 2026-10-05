import { useState, type ReactNode, type FormEvent } from 'react';
import type { Status } from '@engramweave/contracts';
import type { HostInfo } from './client';
import { Icon, type IconName } from './Icon';

export type View = 'dashboard' | 'sources' | 'jobs' | 'search' | 'settings';
const navigation: {
  label: string;
  icon: IconName;
  view?: View;
  note?: string;
}[] = [
  { label: 'Dashboard', icon: 'home', view: 'dashboard' },
  {
    label: 'Capture',
    icon: 'capture',
    note: 'Capture API 已提供；Desktop 暂不提供采集表单',
  },
  { label: 'Sources', icon: 'file', view: 'sources' },
  { label: 'Review', icon: 'list', note: '规划展示，尚未实现' },
  { label: 'Changes', icon: 'branch', note: '规划展示，尚未实现' },
  {
    label: 'Maintenance',
    icon: 'layers',
    note: 'Knowledge Maintenance · 规划展示，尚未实现',
  },
  { label: 'Search', icon: 'search', view: 'search' },
];

export function Shell({
  children,
  view,
  navigate,
  status,
  host,
  query,
  setQuery,
  search,
  busy,
  refreshVault,
  active,
}: {
  children: ReactNode;
  view: View;
  navigate: (view: View) => void;
  status: Status | null;
  host: HostInfo | null;
  query: string;
  setQuery: (query: string) => void;
  search: (event: FormEvent) => void;
  busy: boolean;
  refreshVault: () => void;
  active: boolean;
}) {
  const [systemExpanded, setSystemExpanded] = useState(true);
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/engramweave-mark.png" alt="" width="50" height="50" />
          <div>
            <strong>EngramWeave</strong>
            <span>Knowledge Operating Layer</span>
          </div>
        </div>
        <div className="sidebar-navigation">
          <nav className="navigation" aria-label="Main navigation">
            {navigation.map((item) => (
              <button
                key={item.label}
                className={
                  view === item.view ? 'nav-item selected' : 'nav-item'
                }
                onClick={item.view ? () => navigate(item.view!) : undefined}
                disabled={!item.view}
                aria-label={item.label}
                aria-current={view === item.view ? 'page' : undefined}
                title={item.note ?? item.label}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.view === 'sources' && status ? (
                  <span className="nav-count">{status.counts.sources}</span>
                ) : !item.view ? (
                  <span className="nav-planned">Soon</span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="nav-divider" />
          <button
            className={`nav-item ${view === 'settings' ? 'selected' : ''}`}
            onClick={() => navigate('settings')}
            aria-current={view === 'settings' ? 'page' : undefined}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className="global-refresh"
            onClick={refreshVault}
            disabled={!status || busy || active}
            title="显式扫描 Vault 并刷新本地索引"
          >
            <Icon name="refresh" />
            <span>{active ? 'Refreshing vault…' : 'Refresh workspace'}</span>
          </button>
          <div
            className="system-card"
            id="system-status"
            hidden={!systemExpanded}
          >
            <button
              className="system-heading"
              onClick={() => navigate('settings')}
              title="查看连接与状态"
            >
              <i className={`status-dot ${status ? 'online' : ''}`} />
              <span>
                <strong>System Status</strong>
                <small>
                  {status ? 'Core connected' : 'Connect your local Core'}
                </small>
              </span>
              <Icon name="chevron" />
            </button>
            <div className="system-row">
              <i className={`status-dot ${status ? 'online' : ''}`} />
              <span>Core</span>
              <span>{status ? 'Ready' : 'Offline'}</span>
            </div>
            <div className="system-row">
              <i
                className={`status-dot ${status?.database_initialized ? 'online' : ''}`}
              />
              <span>Database</span>
              <span>{status?.database_initialized ? 'Ready' : '—'}</span>
            </div>
            <button className="system-row" onClick={() => navigate('jobs')}>
              <i
                className={`status-dot ${status?.active_job ? 'online' : ''}`}
              />
              <span>Jobs</span>
              <span>
                {status ? (status.active_job ? '1 running' : 'Idle') : '—'}
              </span>
            </button>
            <div className="system-row">
              <i className={`status-dot ${status ? 'online' : ''}`} />
              <span>Index</span>
              <span>
                {status ? `Generation ${status.index_generation}` : '—'}
              </span>
            </div>
          </div>
          <div className="sidebar-footer">
            <Icon name="settings" />
            <span>v0.1.0</span>
            <button
              title={
                systemExpanded ? '收起 System Status' : '展开 System Status'
              }
              aria-label={
                systemExpanded ? '收起 System Status' : '展开 System Status'
              }
              aria-expanded={systemExpanded}
              aria-controls="system-status"
              onClick={() => setSystemExpanded((expanded) => !expanded)}
            >
              <Icon name="menu" />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="greeting">
            <span
              className={view === 'dashboard' ? 'sun-symbol' : 'page-symbol'}
            >
              <Icon
                name={
                  view === 'dashboard'
                    ? 'sun'
                    : view === 'sources'
                      ? 'file'
                      : view === 'jobs'
                        ? 'activity'
                        : view === 'search'
                          ? 'search'
                          : 'settings'
                }
              />
            </span>
            <div>
              <h1>
                {view === 'dashboard'
                  ? greeting
                  : {
                      sources: 'Sources',
                      jobs: 'Scan activity',
                      search: 'Find your knowledge',
                      settings: 'Your workspace',
                    }[view]}
              </h1>
              <p>
                {view === 'dashboard'
                  ? status
                    ? status.status === 'ready'
                      ? 'Your knowledge system is running smoothly.'
                      : 'Your local Core needs attention.'
                    : 'A little clarity for everything you know.'
                  : {
                      sources:
                        'Manage your captured materials and their context.',
                      jobs: 'A clear view of your local indexing tasks.',
                      search:
                        'Find notes, sources, and the context that connects them.',
                      settings:
                        'Connect your vault. Keep your knowledge close.',
                    }[view]}
              </p>
            </div>
          </div>
          <div className="topbar-right">
            <div className="topbar-tools">
              <form
                className="global-search"
                onSubmit={(event) => {
                  navigate('search');
                  if (query.trim() && status && !busy) search(event);
                  else event.preventDefault();
                }}
              >
                <Icon name="search" />
                <input
                  aria-label="搜索资料"
                  placeholder="Search notes, sources, or your knowledge…"
                  value={query}
                  maxLength={200}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit" aria-label="打开搜索">
                  <Icon name="arrow" />
                </button>
              </form>
              <button
                className="notification-button"
                aria-label="查看 Core 状态"
                title="查看 Core 状态"
                onClick={() => navigate('settings')}
              >
                <Icon name="bell" />
                {!status && <i />}
              </button>
              <div className="avatar" aria-hidden="true">
                <svg viewBox="0 0 44 44">
                  <defs>
                    <linearGradient id="sky" x2="0" y2="1">
                      <stop stopColor="#a5cdec" />
                      <stop offset="1" stopColor="#f2f9ff" />
                    </linearGradient>
                  </defs>
                  <rect width="44" height="44" fill="url(#sky)" />
                  <path d="m0 30 13-17 10 13 7-9 14 14v13H0Z" fill="#828b88" />
                  <path d="m8 20 5-7 5 8-5-2Z" fill="#fff" />
                  <path d="M0 32q10-4 23 1t21-1v12H0Z" fill="#4b6874" />
                </svg>
              </div>
            </div>
            <div className="date-line">
              <time dateTime={now.toISOString()}>
                {now.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </time>
              <span>Keep building your second brain.</span>
            </div>
          </div>
        </header>
        <div
          className="workspace-content"
          role="region"
          aria-label="Workspace content"
          tabIndex={0}
        >
          {children}
        </div>
        <footer className="workspace-footer">
          <span>
            <i className={`status-dot ${status ? 'online' : ''}`} />
            {status
              ? `Core ready · ${host?.mode === 'owned' ? '自行启动' : '外部连接'}`
              : 'Core 未连接'}
          </span>
          <span>仅显式扫描 · 资料只读{busy ? ' · 操作中…' : ''}</span>
        </footer>
      </main>
    </div>
  );
}
