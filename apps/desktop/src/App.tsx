import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  Document,
  SearchQuery,
  SourcesQuery,
  Status,
} from '@engramweave/contracts';
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
import { Sources, Jobs, Results } from './Lists';

export function App() {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<SourcePage | null>(null);
  const [jobs, setJobs] = useState<JobPage | null>(null);
  const [results, setResults] = useState<SearchPage | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'sources' | 'jobs' | 'search'>('sources');
  const [sourceState, setSourceState] =
    useState<NonNullable<SourcesQuery['state']>>('ready');
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
    if (!connected || view !== 'sources') return;
    let cancelled = false;
    void client
      .sources({ state: sourceState, offset: sourceOffset })
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
    status?.index_generation,
    report,
  ]);
  const connect = (start: boolean) =>
    action(async () => {
      connectionEpoch.current++;
      selection.current++;
      setDocument(null);
      setSources(null);
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
      setView('jobs');
      await refresh();
    });
  const select = (path: string) => {
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
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">E</span>
          <span>EngramWeave</span>
        </div>
        <span className="subtitle">Vault 资料索引</span>
        <span className={connected ? 'connection ready' : 'connection'}>
          {connected
            ? `Core ready · ${host?.mode === 'owned' ? '自行启动' : '外部连接'}`
            : 'Core 未连接'}
        </span>
      </header>
      <div className="workspace">
        <aside className="sidebar">
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
        </aside>
        <main>
          <div className="tabs" role="tablist" aria-label="P1 视图">
            {(['sources', 'jobs', 'search'] as const).map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={view === tab}
                onClick={() => setView(tab)}
              >
                {tab === 'sources'
                  ? 'Sources'
                  : tab === 'jobs'
                    ? 'Jobs'
                    : 'Search'}
              </button>
            ))}
          </div>
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
            <p className="notice">
              {nativeAvailable
                ? '先启动或连接 Core，再查看资料和任务。'
                : '这是界面预览。实际操作使用 Tauri Desktop 原生宿主。'}
            </p>
          )}
          {view === 'sources' && (
            <section>
              <div className="section-heading">
                <div>
                  <h1>资料来源</h1>
                  <p className="hint">登记状态与文件归档属性分别展示。</p>
                </div>
                <label>
                  登记状态
                  <select
                    disabled={!connected}
                    value={sourceState}
                    onChange={(event) => {
                      setSourceState(event.target.value as typeof sourceState);
                      setSourceOffset(0);
                      setSources(null);
                    }}
                  >
                    <option value="ready">可读取</option>
                    <option value="invalid">无效</option>
                    <option value="missing">文件缺失</option>
                    <option value="unsupported">不支持</option>
                  </select>
                </label>
              </div>
              <Sources page={sources} select={select} />
              {sources && (
                <div className="pagination">
                  <span>
                    共 {sources.total} 项 · 代次 {sources.index_generation} ·
                    发布 {sources.indexed_at ?? '无'}
                  </span>
                  <button
                    disabled={sourceOffset === 0 || !connected}
                    onClick={() =>
                      setSourceOffset((value) => Math.max(0, value - 20))
                    }
                  >
                    上一页
                  </button>
                  <button
                    disabled={sourceOffset + 20 >= sources.total || !connected}
                    onClick={() => setSourceOffset((value) => value + 20)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </section>
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
          {document && (
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
        </main>
      </div>
      <footer>
        仅显式扫描与重建 · 元数据和 Annotation 只读 · 原文在 Obsidian
        或网页中阅读{busy ? ' · 操作中…' : ''}
      </footer>
    </div>
  );
}
