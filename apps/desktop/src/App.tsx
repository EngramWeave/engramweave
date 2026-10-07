import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { Document, SearchQuery, Status } from '@engramweave/contracts';
import {
  client,
  failure,
  nativeAvailable,
  type Failure,
  type HostInfo,
  type SourcePage,
  type JobPage,
  type SearchPage,
} from './client';
import { Detail } from './Detail';
import { Shell, type View } from './Shell';
import { Dashboard } from './Dashboard';
import {
  SourceBrowser,
  type SourceState,
  type SourceCounts,
} from './SourceBrowser';
import { Jobs, Results } from './Lists';
import { CompilerSettings } from './CompilerSettings';
import { SourceCompiler } from './SourceCompiler';
import { DocumentFailure, ErrorNotice, ErrorToast, type ErrorPlacement } from './Feedback';

export function App() {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<SourcePage | null>(null);
  const [jobs, setJobs] = useState<JobPage | null>(null);
  const [results, setResults] = useState<SearchPage | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ErrorPlacement, Failure>>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('dashboard');
  const [sourceState, setSourceState] = useState<SourceState>('all');
  const [sourceType, setSourceType] = useState('all');
  const [sourceCounts, setSourceCounts] = useState<SourceCounts | null>(null);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [scope, setScope] =
    useState<NonNullable<SearchQuery['scope']>>('knowledge');
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState<SearchQuery | null>(null);
  const selection = useRef(0);
  const connectionEpoch = useRef(0);
  const pageEpoch = useRef(0);
  const connected = status !== null;
  const active =
    status?.active_job?.id ??
    jobs?.items.find((job) => ['queued', 'running'].includes(job.status))?.id ??
    null;

  const clearError = useCallback((placement: ErrorPlacement) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[placement];
      return next;
    });
  }, []);
  const dismissToast = useCallback(() => clearError('toast'), [clearError]);
  const report = useCallback((error: unknown, placement: ErrorPlacement = 'toast', epoch = connectionEpoch.current) => {
    if (epoch !== connectionEpoch.current) return;
    const value = failure(error);
    setErrors((current) => ({ ...current, [placement]: value }));
    if (
      ['CORE_UNAVAILABLE', 'INSTANCE_UNCERTAIN', 'UNAUTHORIZED'].includes(
        value.code,
      )
    ) {
      connectionEpoch.current++;
      selection.current++;
      setStatus(null);
      setDocument(null);
      setSources(null);
      setSourceCounts(null);
      setJobs(null);
      setResults(null);
    }
  }, []);
  const action = async (work: () => Promise<void>, placement: ErrorPlacement = 'toast') => {
    if (busy) return;
    setBusy(true);
    clearError(placement);
    const currentPage = pageEpoch.current;
    const currentSelection = selection.current;
    try {
      await work();
    } catch (error) {
      if (currentPage === pageEpoch.current && (placement !== 'document' || currentSelection === selection.current)) report(error, placement);
    } finally {
      if (nativeAvailable) {
        try {
          setHost(await client.info());
        } catch {
          /* Preserve the primary operation error. */
        }
      }
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!nativeAvailable) return;
    let cancelled = false;
    const epoch = connectionEpoch.current;
    void client
      .info()
      .then((value) => {
        if (!cancelled) setHost(value);
      })
      .catch((error) => {
        if (!cancelled) report(error, 'toast', epoch);
      });
    return () => {
      cancelled = true;
    };
  }, [report]);
  const refresh = useCallback(async () => {
    const epoch = connectionEpoch.current;
    const [status, jobs] = await Promise.all([client.status(), client.jobs()]);
    if (epoch !== connectionEpoch.current) return false;
    setStatus(status);
    setJobs(jobs);
    return (
      status.active_job !== null ||
      jobs.items.some((job) => ['queued', 'running'].includes(job.status))
    );
  }, []);
  useEffect(() => {
    if (!connected || !active) return;
    const epoch = connectionEpoch.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const pending = await refresh();
        if (!cancelled && pending)
          timer = setTimeout(() => {
            void poll();
          }, 1000);
      } catch (error) {
        if (!cancelled) report(error, 'toast', epoch);
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, active, refresh, report]);
  useEffect(() => {
    if (!connected || (view !== 'sources' && view !== 'dashboard')) return;
    const epoch = connectionEpoch.current;
    let cancelled = false;
    void client
      .sources({
        ...(view === 'dashboard'
          ? { state: 'ready' as const }
          : sourceState === 'all'
            ? {}
            : { state: sourceState }),
        ...(view === 'sources' && sourceType !== 'all'
          ? { source_type: sourceType }
          : {}),
        offset: view === 'dashboard' ? 0 : sourceOffset,
      })
      .then((value) => {
        if (!cancelled) {
          setSources(value);
          clearError('sources');
        }
      })
      .catch((error) => {
        if (!cancelled) report(error, view === 'sources' ? 'sources' : 'toast', epoch);
      });
    return () => {
      cancelled = true;
    };
  }, [
    connected,
    view,
    sourceState,
    sourceOffset,
    sourceType,
    status?.index_generation,
    report,
    clearError,
  ]);
  useEffect(() => {
    if (!connected || view !== 'sources') return;
    const epoch = connectionEpoch.current;
    setSourceCounts(null);
    let cancelled = false;
    const states = [
      'all',
      'ready',
      'invalid',
      'missing',
      'unsupported',
    ] as const;
    void Promise.all(
      states.map((state) =>
        client.sources({ limit: 1, ...(state === 'all' ? {} : { state }) }),
      ),
    )
      .then((pages) => {
        if (
          !cancelled &&
          pages.every(
            (page) => page.index_generation === pages[0]?.index_generation,
          )
        ) {
          setSourceCounts(
            Object.fromEntries(
              states.map((state, index) => [state, pages[index]!.total]),
            ) as SourceCounts,
          );
          clearError('counts');
        }
      })
      .catch((error) => {
        if (!cancelled) report(error, 'counts', epoch);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, view, status?.index_generation, report, clearError]);
  const connect = (start: boolean) =>
    action(async () => {
      connectionEpoch.current++;
      selection.current++;
      setDocument(null);
      setSelectedPath(null);
      setErrors({});
      setSources(null);
      setSourceCounts(null);
      setResults(null);
      setSearchInput(null);
      const value = await client.connect(start);
      setHost(value.host);
      setStatus(value.status);
      await refresh();
    }, 'connection');
  const scan = (mode: 'refresh' | 'rebuild') =>
    action(async () => {
      const currentPage = pageEpoch.current;
      await client.scan(mode);
      await refresh();
      if (mode === 'rebuild' && currentPage === pageEpoch.current) navigate('jobs');
    }, view === 'settings' ? 'operations' : 'toast');
  const navigate = (next: View) => {
    if (next !== view) {
      pageEpoch.current++;
      selection.current++;
      setDocument(null);
      setSelectedPath(null);
      setErrors({});
    }
    setView(next);
  };
  const select = (path: string) => {
    if (view === 'dashboard') navigate('sources');
    const current = ++selection.current;
    setDocument(null);
    setSelectedPath(path);
    clearError('document');
    void client
      .document(path)
      .then((value) => {
        if (selection.current === current) setDocument(value);
      })
      .catch((error) => {
        if (selection.current === current) report(error, 'document');
      });
  };
  const search = (event: FormEvent, offset = 0) => {
    event.preventDefault();
    navigate('search');
    selection.current++;
    setDocument(null);
    setSelectedPath(null);
    clearError('document');
    if (offset === 0) setResults(null);
    void action(async () => {
      const input: SearchQuery = { scope, q: query, offset };
      const page = await client.search(input);
      setSearchInput(input);
      setResults(page);
    }, 'search');
  };
  const staleSearch =
    results && status && results.index_generation !== status.index_generation;
  return (
    <Shell
      view={view}
      navigate={navigate}
      status={status}
      host={host}
      query={query}
      setQuery={setQuery}
      search={search}
      busy={busy}
      refreshVault={() => {
        void scan('refresh');
      }}
      active={Boolean(active)}
    >
      <ErrorToast error={errors.toast} dismiss={dismissToast} />
      {!connected && (
        <div className="connection-banner">
          <span>
            <i className="status-dot" />
            {nativeAvailable
              ? '启动或连接 Core，加载你的 Vault 数据。'
              : '界面预览 · 真实数据和操作需在 Desktop 中连接 Core。'}
          </span>
          <button className="view-all" onClick={() => navigate('settings')}>
            连接与状态
          </button>
        </div>
      )}
      {view === 'dashboard' && (
        <Dashboard
          status={status}
          sources={sources}
          jobs={jobs}
          navigate={navigate}
          select={select}
        />
      )}
      {view === 'settings' && (
        <section className="workspace-settings panel">
          <div className="settings-content">
            <h2>连接与状态</h2>
            <p className="hint">使用同一份独立 Core 配置。</p>
            <dl>
              <dt>配置</dt>
              <dd className="path">{host?.profile_path ?? '原生宿主不可用'}</dd>
              <dt>Vault</dt>
              <dd className="path">{status?.vault_path ?? '连接后显示'}</dd>
              <dt>最后扫描</dt>
              <dd>{status?.last_scan_at ?? '尚未扫描'}</dd>
              <dt>索引代次</dt>
              <dd>{status?.index_generation ?? '—'}</dd>
            </dl>
            <div className="connection-actions">
              <button
                disabled={busy || connected || !nativeAvailable}
                className="primary"
                onClick={() => {
                  void connect(true);
                }}
              >
                启动 Core
              </button>
              <button
                disabled={busy || !nativeAvailable}
                onClick={() => {
                  void connect(false);
                }}
              >
                {connected ? '重新握手' : '连接已有 Core'}
              </button>
              <button
                disabled={busy || host?.mode !== 'owned' || !nativeAvailable}
                onClick={() => {
                  void action(async () => {
                    setHost(await client.stop());
                    connectionEpoch.current++;
                    selection.current++;
                    setStatus(null);
                    setSources(null);
                    setSourceCounts(null);
                    setJobs(null);
                    setResults(null);
                    setDocument(null);
                    setSelectedPath(null);
                  }, 'connection');
                }}
              >
                停止自身 Core
              </button>
            </div>
            {errors.connection && <ErrorNotice error={errors.connection} />}
            <div className="rule" />
            <h3>显式操作</h3>
            <div className="connection-actions">
              <button
                disabled={busy || !connected || Boolean(active)}
                onClick={() => {
                  void scan('refresh');
                }}
              >
                扫描 Vault
              </button>
              <button
                disabled={busy || !connected || Boolean(active)}
                onClick={() => {
                  void scan('rebuild');
                }}
              >
                重建索引
              </button>
              <button
                disabled={busy || !connected}
                onClick={() => {
                  void action(async () => {
                    await refresh();
                  }, 'operations');
                }}
              >
                刷新状态
              </button>
            </div>
            <CompilerSettings connected={connected} />
            {errors.operations && <ErrorNotice error={errors.operations} />}
            <p className="hint">
              无活动任务时停止轮询。状态为上次确认结果；断线后需显式重新连接。
            </p>
            {status && (
              <p className="counts">
                {status.counts.sources} Sources · {status.counts.knowledge}{' '}
                Knowledge
                <br />
                {status.counts.invalid} 无效 · {status.counts.missing} 缺失 ·{' '}
                {status.counts.unsupported} 不支持
              </p>
            )}
            {status?.diagnostics.map((item, index) => (
              <p className="diagnostic" key={index}>
                {item.code} · {item.message}
              </p>
            ))}
          </div>
        </section>
      )}
      <div
        className={
          view === 'jobs' || view === 'search'
            ? 'content-panel panel'
            : 'detail-container'
        }
      >
        {view === 'sources' && (
          <SourceBrowser
            compilerActions={document?.kind === 'source' ? <SourceCompiler key={document.path} document={document} jobs={jobs} active={Boolean(active)} onStarted={() => { void refresh().catch(error => report(error, 'document')); }} onPublished={() => { void select(document.path); }} /> : undefined}
            page={sources}
            counts={sourceCounts}
            state={sourceState}
            setState={(value) => {
              selection.current++;
              setDocument(null);
              setSelectedPath(null);
              clearError('document');
              clearError('sources');
              setSourceState(value);
              setSourceOffset(0);
              setSources(null);
            }}
            sourceType={sourceType}
            setSourceType={(value) => {
              selection.current++;
              setDocument(null);
              setSelectedPath(null);
              clearError('document');
              clearError('sources');
              setSourceType(value);
              setSourceOffset(0);
              setSources(null);
            }}
            document={document}
            selectedPath={selectedPath}
            documentError={errors.document}
            listError={errors.sources}
            countsError={errors.counts}
            select={select}
            close={() => {
              selection.current++;
              setDocument(null);
              setSelectedPath(null);
              clearError('document');
            }}
            open={(target) => {
              if (document)
                void action(async () => {
                  await client.open(document.path, target);
                }, 'document');
            }}
            connected={connected}
            offset={sourceOffset}
            setOffset={(offset) => {
              selection.current++;
              setDocument(null);
              setSelectedPath(null);
              clearError('document');
              clearError('sources');
              setSourceOffset(offset);
            }}
            search={(term) => {
              setQuery(term);
              setScope('sources');
              navigate('search');
              setResults(null);
              void action(async () => {
                const input: SearchQuery = {
                  scope: 'sources',
                  q: term,
                  offset: 0,
                };
                setResults(await client.search(input));
                setSearchInput(input);
              }, 'search');
            }}
          />
        )}
        {view === 'jobs' && (
          <section>
            <h1>Jobs</h1>
            <p className="hint">
              {active
                ? '任务活动中，正在轮询进度。'
                : '没有活动任务，轮询已停止。'}
            </p>
            <Jobs page={jobs} />
          </section>
        )}
        {view === 'search' && (
          <section>
            <h1>查找资料</h1>
            <form className="search-form" onSubmit={search}>
              <label>
                范围
                <select
                  value={scope}
                  onChange={(event) =>
                    setScope(event.target.value as typeof scope)
                  }
                >
                  <option value="knowledge">Knowledge</option>
                  <option value="sources">Sources</option>
                  <option value="all">全部</option>
                </select>
              </label>
              <label className="query">
                关键词
                <input
                  value={query}
                  maxLength={200}
                  placeholder="例如 volatile、OpenClaw.NET"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={!connected || busy}
                type="submit"
              >
                搜索
              </button>
            </form>
            {errors.search && <ErrorNotice error={errors.search} />}
            {results && (
              <p className={staleSearch ? 'notice warning' : 'hint'}>
                共 {results.total} 项 · 结果代次 {results.index_generation} ·
                发布 {results.indexed_at ?? '无'}
                {staleSearch ? ' · 结果来自旧代次，请重新搜索。' : ''}
              </p>
            )}
            <Results page={results} select={select} />
            {results && searchInput && (
              <div className="pagination">
                <button
                  disabled={results.offset === 0 || busy || !connected}
                  onClick={() => {
                    selection.current++;
                    setDocument(null);
                    setSelectedPath(null);
                    clearError('document');
                    void action(async () => {
                      const input = {
                        ...searchInput,
                        offset: Math.max(0, results.offset - 20),
                      };
                      setResults(await client.search(input));
                      setSearchInput(input);
                    }, 'search');
                  }}
                >
                  上一页
                </button>
                <button
                  disabled={
                    results.offset + 20 >= results.total || busy || !connected
                  }
                  onClick={() => {
                    selection.current++;
                    setDocument(null);
                    setSelectedPath(null);
                    clearError('document');
                    void action(async () => {
                      const input = {
                        ...searchInput,
                        offset: results.offset + 20,
                      };
                      setResults(await client.search(input));
                      setSearchInput(input);
                    }, 'search');
                  }}
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        )}
        {document && view === 'search' && (
          <Detail
            document={document}
            error={errors.document}
            close={() => {
              selection.current++;
              setDocument(null);
              setSelectedPath(null);
              clearError('document');
            }}
            open={(target) => {
              void action(async () => {
                await client.open(document.path, target);
              }, 'document');
            }}
          />
        )}
        {!document && errors.document && view === 'search' && (
          <DocumentFailure error={errors.document} path={selectedPath} close={() => {
            selection.current++;
            setSelectedPath(null);
            clearError('document');
          }} />
        )}
      </div>
    </Shell>
  );
}
