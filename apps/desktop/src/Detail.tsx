import type { Document } from '@engramweave/contracts';
import { useEffect, useRef } from 'react';

export function Detail({
  document,
  open,
  close,
}: {
  document: Document;
  open: (target: 'obsidian' | 'original') => void;
  close: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'start' });
  }, [document.path]);
  const webpage = /^https?:\/\//i.test(document.original_locator ?? '');
  return (
    <aside className="detail" aria-label="文档详情" ref={panel}>
      <div className="section-heading">
        <h2>{document.title || document.path}</h2>
        <button onClick={close}>关闭详情</button>
      </div>
      <p className="path">{document.path}</p>
      <div className="actions">
        <button onClick={() => open('obsidian')}>在 Obsidian 中打开</button>
        {webpage && (
          <button onClick={() => open('original')}>打开原网页</button>
        )}
      </div>
      <div className={document.index_stale ? 'notice warning' : 'notice'}>
        {document.index_stale
          ? '索引已过时：当前文件与登记版本不同，请显式扫描。'
          : '当前文件与登记版本一致。'}
        <br />
        索引代次 {document.index_generation} · 字节校验{' '}
        {document.indexed_at ?? '尚未登记'}
      </div>
      <dl>
        <dt>登记版本</dt>
        <dd className="hash">{document.indexed_revision ?? '无'}</dd>
        <dt>当前版本</dt>
        <dd className="hash">{document.revision}</dd>
        {document.kind === 'source' && (
          <>
            <dt>归档属性</dt>
            <dd>
              {document.processing_status === 'archived' ? '已归档' : '未归档'}
            </dd>
            <dt>来源类型</dt>
            <dd>{document.source_type}</dd>
            <dt>Asset</dt>
            <dd>
              {document.asset.kind} · {document.asset.availability}
              <br />
              <span className="path">{document.asset.locator}</span>
            </dd>
            <dt>原始定位</dt>
            <dd className="path">{document.original_locator ?? '无'}</dd>
          </>
        )}
      </dl>
      <h3>Annotation · 用户上下文</h3>
      <p className="annotation">{document.annotation || '没有 Annotation'}</p>
      <h3>元数据</h3>
      <pre>{JSON.stringify(document.metadata, null, 2)}</pre>
      <h3>原始引用</h3>
      {document.original_references.length ? (
        <ul>
          {document.original_references.map((reference, index) => (
            <li key={index}>
              <span className="path">{reference.raw}</span>
              <br />
              {reference.availability}
              {reference.alias ? ` · ${reference.alias}` : ''}
              {reference.anchor ? ` · #${reference.anchor}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p>没有原始引用</p>
      )}
      {document.diagnostics.map((item, index) => (
        <p className="notice warning" key={index}>
          {item.code} · {item.message}
        </p>
      ))}
    </aside>
  );
}
