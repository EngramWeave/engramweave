import type { JobPage, SearchPage } from './client';

const contexts: Record<string, string> = {
  source_content: '原文内容',
  record_body: 'Record 说明',
  knowledge: '知识正文',
  user_context: '用户上下文 · Annotation',
  metadata: '元数据',
  title: '标题',
};
export function Jobs({ page }: { page: JobPage | null }) {
  if (!page?.items.length)
    return <p className="empty">没有扫描任务。扫描与重建均由用户显式触发。</p>;
  return (
    <div className="jobs">
      {page.items.map((job) => (
        <article key={job.id}>
          <div className="section-heading">
            <strong>
              {job.mode === 'rebuild' ? '重建索引' : '扫描 Vault'}
            </strong>
            <span>
              {job.status} · 已处理 {job.processed_files} 个文件
            </span>
          </div>
          <p className="path">
            {job.id} · {job.created_at}
          </p>
          {job.summary && (
            <p>
              新增 {job.summary.added} · 更新 {job.summary.updated} · 未变{' '}
              {job.summary.unchanged} · 缺失 {job.summary.missing} · 无效{' '}
              {job.summary.invalid} · 不支持 {job.summary.unsupported} · 代次{' '}
              {job.summary.index_generation}
            </p>
          )}
          {job.error && (
            <p className="notice warning">
              {job.error.code} · {job.error.message}
            </p>
          )}
          {job.summary?.warnings.map((item, index) => (
            <p className="diagnostic" key={index}>
              {item.code} · {item.path} · {item.message}
            </p>
          ))}
        </article>
      ))}
    </div>
  );
}
export function Results({
  page,
  select,
}: {
  page: SearchPage | null;
  select: (path: string) => void;
}) {
  if (!page)
    return (
      <p className="empty">输入关键词后搜索。默认范围是已有 Knowledge。</p>
    );
  if (!page.items.length)
    return (
      <p className="empty">没有匹配结果。请检查范围、关键词和最后扫描时间。</p>
    );
  return (
    <div className="results">
      {page.items.map((item) => (
        <article key={item.id}>
          <div className="section-heading">
            <button className="text-button" onClick={() => select(item.path)}>
              {item.title || item.path}
            </button>
            <span>{item.kind === 'source' ? 'Source' : 'Knowledge'}</span>
          </div>
          <p className="path">{item.path}</p>
          <p className="field-label">
            命中字段：{item.matched_fields.join(', ')} ·{' '}
            {contexts[item.snippet_context]}
          </p>
          <p className="snippet">{item.snippet}</p>
        </article>
      ))}
    </div>
  );
}
