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

export function App() {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<SourcePage | null>(null);
  const [jobs, setJobs] = useState<JobPage | null>(null);
  const [results, setResults] = useState<SearchPage | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [error, setError] = useState<Failure | null>(null);
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
  const connected = status !== null;
  const active =
    status?.active_job?.id ??
    jobs?.items.find((job) => ['queued', 'running'].includes(job.status))?.id ??
    null;

  const report = useCallback((error: unknown) => {
    const value = failure(error);
    setError(value);
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
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      report(error);
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
    void client
      .info()
      .then((value) => {
        if (!cancelled) setHost(value);
      })
      .catch((error) => {
        if (!cancelled) report(error);
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
        if (!cancelled) report(error);
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
        if (!cancelled) setSources(value);
      })
      .catch((error) => {
        if (!cancelled) report(error);
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
  ]);
  useEffect(() => {
    if (!connected || view !== 'sources') return;
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
        )
          setSourceCounts(
            Object.fromEntries(
              states.map((state, index) => [state, pages[index]!.total]),
            ) as SourceCounts,
          );
      })
      .catch((error) => {
        if (!cancelled) report(error);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, view, status?.index_generation, report]);
  const connect = (start: boolean) =>
    action(async () => {
      connectionEpoch.current++;
      selection.current++;
      setDocument(null);
      setSources(null);
      setSourceCounts(null);
      setResults(null);
      setSearchInput(null);
      const value = await client.connect(start);
      setHost(value.host);
      setStatus(value.status);
      await refresh();
    });
  const scan = (mode: 'refresh' | 'rebuild') =>
    action(async () => {
      await client.scan(mode);
      if (mode === 'rebuild') navigate('jobs');
      await refresh();
    });
  const navigate = (next: View) => {
    if (next !== view) {
      selection.current++;
      setDocument(null);
    }
    setView(next);
  };
  const select = (path: string) => {
    if (view === 'dashboard') setView('sources');
    const current = ++selection.current;
    setDocument(null);
    setError(null);
    void client
      .document(path)
      .then((value) => {
        if (selection.current === current) setDocument(value);
      })
      .catch((error) => {
        if (selection.current === current) report(error);
      });
  };
  const search = (event: FormEvent, offset = 0) => {
    event.preventDefault();
    navigate('search');
    selection.current++;
    setDocument(null);
    void action(async () => {
      const input: SearchQuery = { scope, q: query, offset };
      const page = await client.search(input);
      setSearchInput(input);
      setResults(page);
    });
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
      {error && (
        <div className="notice warning" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
          {error.details !== undefined && (
            <pre>{JSON.stringify(error.details, null, 2)}</pre>
          )}
        </div>
      )}
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
                  });
                }}
              >
                停止自身 Core
              </button>
            </div>
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
                  });
                }}
              >
                刷新状态
              </button>
            </div>
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
            page={sources}
            counts={sourceCounts}
            state={sourceState}
            setState={(value) => {
              setSourceState(value);
              setSourceOffset(0);
              setSources(null);
            }}
            sourceType={sourceType}
            setSourceType={(value) => {
              setSourceType(value);
              setSourceOffset(0);
              setSources(null);
            }}
            document={document}
            select={select}
            close={() => {
              selection.current++;
              setDocument(null);
            }}
            open={(target) => {
              if (document)
                void action(async () => {
                  await client.open(document.path, target);
                });
            }}
            connected={connected}
            offset={sourceOffset}
            setOffset={setSourceOffset}
            search={(term) => {
              setQuery(term);
              setScope('sources');
              navigate('search');
              void action(async () => {
                const input: SearchQuery = {
                  scope: 'sources',
                  q: term,
                  offset: 0,
                };
                setResults(await client.search(input));
                setSearchInput(input);
              });
            }}
          />
        )}
        {view === 'jobs' && (
          <section>
            <h1>扫描任务</h1>
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
                    void action(async () => {
                      const input = {
                        ...searchInput,
                        offset: Math.max(0, results.offset - 20),
                      };
                      setResults(await client.search(input));
                      setSearchInput(input);
                    });
                  }}
                >
                  上一页
                </button>
                <button
                  disabled={
                    results.offset + 20 >= results.total || busy || !connected
                  }
                  onClick={() => {
                    void action(async () => {
                      const input = {
                        ...searchInput,
                        offset: results.offset + 20,
                      };
                      setResults(await client.search(input));
                      setSearchInput(input);
                    });
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
            close={() => {
              selection.current++;
              setDocument(null);
            }}
            open={(target) => {
              void action(async () => {
                await client.open(document.path, target);
              });
            }}
          />
        )}
      </div>
    </Shell>
  );
}
