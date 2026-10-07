import type { Document } from '@engramweave/contracts';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { lifecycleLabel, processingLabel } from './status-labels';
import { ErrorNotice } from './Feedback';
import type { Failure } from './client';

function display(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '—');
}

export function Detail({
  document,
  open,
  close,
  error,
}: {
  document: Document;
  open: (target: 'obsidian' | 'original') => void;
  close: () => void;
  error?: Failure | undefined;
}) {
  const panel = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<'details' | 'annotation' | 'links'>('details');
  useEffect(() => {
    setTab('details');
    // A side inspector stays in place; standalone search details remain reachable.
    if (!panel.current?.closest('.source-inspector'))
      panel.current?.scrollIntoView({ block: 'start' });
  }, [document.path]);
  const webpage = /^https?:\/\//i.test(document.original_locator ?? '');
  const tags = Array.isArray(document.metadata.tags)
    ? document.metadata.tags.filter(
        (value): value is string => typeof value === 'string',
      )
    : typeof document.metadata.tags === 'string'
      ? [document.metadata.tags]
      : [];
  const description =
    typeof document.metadata.description === 'string'
      ? document.metadata.description
      : '';
  return (
    <aside className="detail panel" aria-label="文档详情" ref={panel}>
      <div className="inspector-heading">
        <span className="row-symbol blue">
          <Icon name={document.source_type === 'web' ? 'link' : 'file'} />
        </span>
        <div className="row-copy">
          <h2 title={document.title || document.path}>
            {document.title || document.path}
          </h2>
          <span
            className="row-meta"
            title={document.original_locator ?? document.path}
          >
            {document.original_locator ?? document.path}
          </span>
        </div>
        <button
          className="inspector-close"
          onClick={close}
          aria-label="关闭详情"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="详情视图">
        {(['details', 'annotation', 'links'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {value === 'details'
              ? 'Details'
              : value === 'annotation'
                ? 'Annotation'
                : `Links (${document.original_references.length})`}
          </button>
        ))}
      </div>
      {tab === 'details' && (
        <div className="inspector-body" role="tabpanel" aria-label="Details">
          <div className="source-preview">
            <span className="preview-mark blue">
              <Icon
                name={
                  document.kind === 'knowledge'
                    ? 'note'
                    : document.source_type === 'web'
                      ? 'link'
                      : 'file'
                }
              />
            </span>
            <div>
              <strong>{document.title || document.path}</strong>
              <span>
                {typeof document.metadata.author === 'string'
                  ? document.metadata.author
                  : (document.source_type ?? 'Knowledge')}
              </span>
              {description && <p>{description}</p>}
            </div>
          </div>
          <dl className="property-list">
            <dt>
              <Icon name="file" />
              Type
            </dt>
            <dd>{document.source_type ?? 'Knowledge'}</dd>
            <dt>
              <Icon name="layers" />
              Processing
            </dt>
            <dd>
              {document.kind === 'source' ? (
                <span className="state-tag green">
                  {processingLabel(document.processing_status)}
                </span>
              ) : (
                '—'
              )}
            </dd>
            <dt><Icon name="file" />Lifecycle</dt>
            <dd className={document.lifecycle_status === 'discarded' ? 'lifecycle-discarded' : ''}>{lifecycleLabel(document.lifecycle_status)}</dd>
            <dt>
              <Icon name="clock" />
              Captured
            </dt>
            <dd>{document.captured_at ?? '未记录'}</dd>
            <dt>
              <Icon name="database" />
              Indexed
            </dt>
            <dd>{document.indexed_at ?? '尚未登记'}</dd>
            <dt>
              <Icon name="file" />
              Record
            </dt>
            <dd className="path">{document.path}</dd>
            {document.kind === 'source' && (
              <>
                <dt>
                  <Icon name="layers" />
                  Asset
                </dt>
                <dd>
                  {document.asset.kind}
                  <span className="row-meta">
                    {document.asset.availability}
                  </span>
                  <span className="path">{document.asset.locator}</span>
                </dd>
                <dt>
                  <Icon name="link" />
                  Locator
                </dt>
                <dd className="path">{document.original_locator ?? '无'}</dd>
              </>
            )}
          </dl>
          <section className="inspector-section">
            <div className="inspector-section-heading">
              <h3>Tags</h3>
              <span>只读</span>
            </div>
            <div className="tag-list">
              {tags.length ? (
                tags.map((tag, index) => <span key={index}>{tag}</span>)
              ) : (
                <small>没有标签</small>
              )}
            </div>
          </section>
          <section className="inspector-section">
            <h3>Properties / 元数据</h3>
            <dl className="metadata-properties">
              {Object.entries(document.metadata).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{display(value)}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>查看原始元数据 JSON</summary>
              <pre>{JSON.stringify(document.metadata, null, 2)}</pre>
            </details>
          </section>
          <details className="revision-details">
            <summary>索引校验 · Generation {document.index_generation}</summary>
            <div className={document.index_stale ? 'notice warning' : 'notice'}>
              {document.index_stale
                ? '索引已过时：当前文件与登记版本不同，请显式刷新。'
                : '当前文件与登记版本一致。'}
            </div>
            <dl>
              <dt>登记版本</dt>
              <dd className="hash">{document.indexed_revision ?? '无'}</dd>
              <dt>当前版本</dt>
              <dd className="hash">{document.revision}</dd>
            </dl>
          </details>
        </div>
      )}
      {tab === 'annotation' && (
        <section
          className="inspector-body"
          role="tabpanel"
          aria-label="Annotation"
        >
          <h3>Annotation · 用户上下文</h3>
          <p className="annotation">
            {document.annotation || '没有 Annotation'}
          </p>
        </section>
      )}
      {tab === 'links' && (
        <section className="inspector-body" role="tabpanel" aria-label="Links">
          <h3>原始引用</h3>
          {document.original_references.length ? (
            <ul className="reference-list">
              {document.original_references.map((reference, index) => (
                <li key={index}>
                  <span className="path">{reference.raw}</span>
                  <span className="reference-state">
                    {reference.availability}
                    {reference.alias ? ` · ${reference.alias}` : ''}
                    {reference.anchor ? ` · #${reference.anchor}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">没有原始引用</p>
          )}
        </section>
      )}
      <div className="inspector-body inspector-actions">
        <h3>Quick Actions</h3>
        <div className="actions">
          <button onClick={() => open('obsidian')}>
            <Icon name="external" />
            Open in Obsidian
          </button>
          {webpage && (
            <button onClick={() => open('original')}>
              <Icon name="link" />
              View in Browser
            </button>
          )}
        </div>
      </div>
      {error && <div className="inspector-body"><ErrorNotice error={error} /></div>}
      {document.index_stale && (
        <div className="notice warning" role="status">
          索引已过时，请显式刷新 Vault。
        </div>
      )}
      {document.diagnostics.map((item, index) => (
        <p className="notice warning" key={index}>
          {item.code} · {item.message}
        </p>
      ))}
    </aside>
  );
}
