import type { JobPage, SearchPage, SourcePage } from './client';

const states: Record<string, string> = {
  ready: '可读取',
  invalid: '无效',
  missing: '文件缺失',
  unsupported: '不支持',
};
const contexts: Record<string, string> = {
  source_content: '原文内容',
  record_body: 'Record 说明',
  knowledge: '知识正文',
  user_context: '用户上下文 · Annotation',
  metadata: '元数据',
  title: '标题',
};
export function Sources({
  page,
  select,
}: {
  page: SourcePage | null;
  select: (path: string) => void;
}) {
  if (!page?.items.length)
    return (
      <p className="empty">
        没有符合条件的 Source。空库需要先显式扫描；也可更改登记状态筛选。
      </p>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>标题 / 路径</th>
            <th>来源类型</th>
            <th>登记状态</th>
            <th>归档属性</th>
            <th>Asset</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((source) => (
            <tr key={source.id}>
              <td>
                <button
                  className="text-button"
                  onClick={() => select(source.path)}
                >
                  {source.title || source.path}
                </button>
                <span className="path">{source.path}</span>
                {source.diagnostics.map((item, index) => (
                  <span className="diagnostic" key={index}>
                    {item.code}: {item.message}
                  </span>
                ))}
              </td>
              <td>{source.source_type ?? '未知'}</td>
              <td>{states[source.state]}</td>
              <td>
                {source.processing_status === 'archived' ? '已归档' : '未归档'}
              </td>
              <td>
                {source.asset
                  ? `${source.asset.kind} · ${source.asset.availability}`
                  : '无'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
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
