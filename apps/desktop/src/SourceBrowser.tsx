import { useState } from 'react';
import type { Document, SourcesQuery } from '@engramweave/contracts';
import type { Failure, SourcePage } from './client';
import { Detail } from './Detail';
import { Icon, type IconName } from './Icon';
import { lifecycleLabel, processingLabel } from './status-labels';
import { DocumentFailure, ErrorNotice } from './Feedback';

export type SourceState = 'all' | NonNullable<SourcesQuery['state']>;
export type SourceCounts = Record<SourceState, number>;
const categories: {
  state: SourceState;
  title: string;
  caption: string;
  tone: string;
  icon: IconName;
}[] = [
  {
    state: 'all',
    title: 'All Sources',
    caption: 'Total registered items',
    tone: 'blue',
    icon: 'file',
  },
  {
    state: 'ready',
    title: 'Ready',
    caption: 'Readable · Not progress',
    tone: 'green',
    icon: 'check',
  },
  {
    state: 'invalid',
    title: 'Invalid',
    caption: 'Invalid registration',
    tone: 'red',
    icon: 'help',
  },
  {
    state: 'missing',
    title: 'Missing',
    caption: 'File not found',
    tone: 'orange',
    icon: 'clock',
  },
  {
    state: 'unsupported',
    title: 'Unsupported',
    caption: 'Not supported',
    tone: 'violet',
    icon: 'file',
  },
];
export function SourceBrowser({
  page,
  counts,
  state,
  setState,
  sourceType,
  setSourceType,
  document,
  selectedPath,
  documentError,
  listError,
  countsError,
  select,
  close,
  open,
  connected,
  offset,
  setOffset,
  search,
}: {
  page: SourcePage | null;
  counts: SourceCounts | null;
  state: SourceState;
  setState: (state: SourceState) => void;
  sourceType: string;
  setSourceType: (type: string) => void;
  document: Document | null;
  selectedPath: string | null;
  documentError?: Failure | undefined;
  listError?: Failure | undefined;
  countsError?: Failure | undefined;
  select: (path: string) => void;
  close: () => void;
  open: (target: 'obsidian' | 'original') => void;
  connected: boolean;
  offset: number;
  setOffset: (offset: number) => void;
  search: (query: string) => void;
}) {
  const [term, setTerm] = useState('');
  const typeOptions = Array.from(
    new Set([
      'web',
      'manual',
      'pdf',
      sourceType,
      ...(page?.items
        .map((item) => item.source_type)
        .filter((type): type is string => Boolean(type)) ?? []),
    ]),
  ).filter((type) => type !== 'all');
  return (
    <div className="sources-page">
      <div className="source-stats">
        {categories.map((category) => (
          <button
            key={category.state}
            className={`source-stat ${category.tone} ${category.state === state ? 'selected' : ''}`}
            disabled={!connected}
            onClick={() => setState(category.state)}
          >
            <span className="row-symbol">
              <Icon name={category.icon} />
            </span>
            <span>
              <strong>{category.title}</strong>
              <b>{counts?.[category.state] ?? '—'}</b>
              <small>{category.caption}</small>
            </span>
            <svg
              className="stat-wave"
              viewBox="0 0 200 40"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                d="M0 31Q24-9 45 19T84 29T125 34H200V40H0Z"
                fill="currentColor"
              />
            </svg>
          </button>
        ))}
        <div className="source-stat blue">
          <span className="row-symbol">
            <Icon name="database" />
          </span>
          <span>
            <strong>Index</strong>
            <b>{page?.index_generation ?? '—'}</b>
            <small>Published generation</small>
          </span>
          <svg
            className="stat-wave"
            viewBox="0 0 200 40"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d="M0 31Q24-9 45 19T84 29T125 34H200V40H0Z"
              fill="currentColor"
            />
          </svg>
        </div>
      </div>
      <div className="sources-layout">
        <section className="source-list panel" aria-label="资料列表">
          <div className="source-toolbar">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (term.trim()) search(term);
              }}
            >
              <Icon name="search" />
              <input
                placeholder="Search sources by title, URL, or content…"
                aria-label="搜索 Sources"
                value={term}
                maxLength={200}
                onChange={(event) => setTerm(event.target.value)}
              />
              <button
                type="submit"
                aria-label="搜索 Sources"
                disabled={!connected || !term.trim()}
              >
                <Icon name="arrow" />
              </button>
            </form>
            <select
              aria-label="来源类型"
              disabled={!connected}
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
            >
              <option value="all">All Types</option>
              {typeOptions.map((type) => (
                <option value={type} key={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              aria-label="登记状态"
              disabled={!connected}
              value={state}
              onChange={(event) => setState(event.target.value as SourceState)}
            >
              {categories.map((category) => (
                <option key={category.state} value={category.state}>
                  {category.state === 'all' ? 'All States' : category.title}
                </option>
              ))}
            </select>
          </div>
          {listError && <ErrorNotice error={listError} />}
          {!listError && countsError && <ErrorNotice error={countsError} />}
          <div className="table-scroll">
            <table className="source-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Asset</th>
                  <th>State</th>
                  <th><span>Stage</span><small>Lifecycle</small></th>
                  <th>Captured</th>
                </tr>
              </thead>
              <tbody>
                {page?.items.map((source) => (
                  <tr
                    key={source.id}
                    className={selectedPath === source.path ? 'selected' : ''}
                  >
                    <td>
                      <div className="source-title-cell">
                        <span
                          className={`row-symbol ${source.source_type === 'manual' ? 'orange' : source.source_type === 'pdf' ? 'red' : 'blue'}`}
                        >
                          <Icon
                            name={
                              source.source_type === 'web'
                                ? 'link'
                                : source.source_type === 'manual'
                                  ? 'note'
                                  : 'file'
                            }
                          />
                        </span>
                        <button
                          className="row-copy row-select"
                          onClick={() => select(source.path)}
                        >
                          <span className="row-title">
                            {source.title || source.path}
                          </span>
                          <span
                            className="row-meta"
                            title={source.original_locator ?? source.path}
                          >
                            {source.original_locator ?? source.path}
                          </span>
                        </button>
                      </div>
                      {source.diagnostics.map((item, index) => (
                        <span className="diagnostic" key={index}>
                          {item.code}: {item.message}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span
                        className={`type-tag ${source.source_type === 'manual' ? 'green' : source.source_type === 'pdf' ? 'red' : 'blue'}`}
                      >
                        {source.source_type ?? 'Unknown'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="source-asset"
                        title={source.asset?.locator}
                      >
                        <Icon
                          name={
                            source.asset?.kind === 'external_ref'
                              ? 'external'
                              : source.asset?.kind === 'vault_file'
                                ? 'file'
                                : 'link'
                          }
                        />
                        {source.asset?.kind === 'external_ref'
                          ? 'External'
                          : source.asset?.kind === 'vault_file'
                            ? 'Vault file'
                            : source.asset?.kind === 'inline_markdown'
                              ? 'Inline'
                              : '—'}
                      </span>
                      <small className="row-meta">
                        {source.asset?.availability}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`state-tag ${categories.find((item) => item.state === source.state)?.tone}`}
                      >
                        <i />
                        {
                          categories.find((item) => item.state === source.state)
                            ?.title
                        }
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          source.processing_status === 'archived'
                            ? 'archive-tag'
                            : 'row-meta'
                        }
                      >
                        {processingLabel(source.processing_status)}
                      </span>
                      <small className={`row-meta ${source.lifecycle_status === 'discarded' ? 'lifecycle-discarded' : ''}`}>
                        {lifecycleLabel(source.lifecycle_status)}
                      </small>
                    </td>
                    <td>
                      <span
                        className="row-meta"
                        title={source.captured_at ?? '未记录采集时间'}
                      >
                        {source.captured_at
                          ? Number.isNaN(Date.parse(source.captured_at))
                            ? source.captured_at
                            : new Date(source.captured_at).toLocaleDateString(
                                undefined,
                                { month: 'short', day: 'numeric' },
                              )
                          : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!page?.items.length && (
            <p className="empty">
              {connected
                ? '没有符合条件的 Source。可刷新 Vault 或更改筛选。'
                : '连接 Core 后查看真实资料。'}
            </p>
          )}
          {page && (
            <div className="pagination">
              <span>
                共 {page.total} 项 · 代次 {page.index_generation} ·{' '}
                {page.indexed_at ?? '尚未发布'}
              </span>
              <button
                disabled={offset === 0 || !connected}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                上一页
              </button>
              <button
                disabled={offset + 20 >= page.total || !connected}
                onClick={() => setOffset(offset + 20)}
              >
                下一页
              </button>
            </div>
          )}
        </section>
        <div className="source-inspector">
          {document ? (
            <Detail document={document} close={close} open={open} error={documentError} />
          ) : documentError ? (
            <DocumentFailure error={documentError} path={selectedPath} close={close} />
          ) : (
            <aside className="panel inspector-empty">
              <span className="empty-symbol blue">
                <Icon name="file" />
              </span>
              <h2>A closer look</h2>
              <p>选择一份 Source，预览属性、元数据、Annotation 和原始引用。</p>
              <span>Read-only · Your files stay yours</span>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
