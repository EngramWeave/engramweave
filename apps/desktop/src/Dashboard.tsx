import type { ReactNode } from 'react';
import type { Status } from '@engramweave/contracts';
import type { JobPage, SourcePage } from './client';
import { Icon, type IconName } from './Icon';

export function Panel({
  title,
  icon,
  children,
  action,
  className = '',
  planned = false,
}: {
  title: string;
  icon: IconName;
  children: ReactNode;
  action?: () => void;
  className?: string;
  planned?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <h2>
          <span className="heading-icon">
            <Icon name={icon} />
          </span>
          {title}
        </h2>
        {planned ? (
          <span className="planned-tag">规划展示</span>
        ) : action ? (
          <button className="view-all" onClick={action}>
            View all <Icon name="arrow" />
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  title,
  value,
  caption,
  icon,
  tone,
  action,
}: {
  title: string;
  value: number | string;
  caption: string;
  icon: IconName;
  tone: string;
  action?: () => void;
}) {
  return (
    <button className={`stat-card ${tone}`} onClick={action} disabled={!action}>
      <span className="stat-symbol">
        <Icon name={icon} />
      </span>
      <span className="stat-copy">
        <span className="stat-title">{title}</span>
        <strong>{value}</strong>
        <span className="stat-caption">{caption}</span>
      </span>
      <Icon name="chevron" className="stat-chevron" />
      <span className="mini-bars" aria-hidden="true">
        {[7, 19, 13, 25, 17, 10, 14, 21].map((height, i) => (
          <i key={i} style={{ height }} />
        ))}
      </span>
      <svg
        className="stat-wave"
        viewBox="0 0 280 40"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 31Q24-9 45 19T84 29T125 34H280V40H0Z" fill="currentColor" />
      </svg>
    </button>
  );
}

function PlannedRows({ kind }: { kind: 'review' | 'changes' }) {
  const titles =
    kind === 'review'
      ? [
          'Ninfer Architecture Deep Dive',
          'Qwen3.8 Technical Report',
          'LLM Training Scaling Laws',
          'Claude Code Agent SDK',
          'Attention Is All You Need',
          'The Geography of Thought',
        ]
      : [
          'Ninfer Architecture',
          'Qwen3.8 Model Integration',
          'AI Ethics Reading Set',
          'Personal Goals & Planning',
        ];
  return (
    <div className="planned-rows" aria-label="仅供视觉展示的规划模块">
      {titles.map((title, i) => (
        <div className="compact-row" key={title}>
          {kind === 'review' && (
            <span className="display-checkbox" aria-hidden="true" />
          )}
          <span
            className={`row-symbol ${kind === 'changes' ? 'violet' : i % 3 === 1 ? 'red' : 'blue'}`}
          >
            <Icon
              name={
                kind === 'changes' ? 'branch' : i % 3 === 1 ? 'file' : 'link'
              }
            />
          </span>
          <span className="row-copy">
            <span className="row-title">{title}</span>
            <span className="row-meta">
              {kind === 'changes' ? 'ChangeSet preview' : 'Review preview'} ·
              示例内容
            </span>
          </span>
          <button className="row-action" disabled>
            {kind === 'changes' ? '查看变更' : '在 Obsidian 打开'}{' '}
            {kind === 'review' && <Icon name="external" />}
          </button>
        </div>
      ))}
    </div>
  );
}

function GraphPreview() {
  const nodes = [
    [15, 78],
    [27, 36],
    [50, 32],
    [60, 74],
    [60, 49],
    [91, 29],
    [107, 64],
    [133, 22],
    [141, 60],
    [156, 35],
    [157, 88],
    [180, 60],
    [184, 10],
    [205, 49],
    [218, 31],
    [229, 79],
    [239, 30],
  ] as const;
  const edges = [
    [0, 1],
    [0, 3],
    [0, 6],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 4],
    [2, 5],
    [3, 4],
    [3, 6],
    [3, 8],
    [4, 6],
    [5, 6],
    [5, 7],
    [5, 8],
    [6, 7],
    [6, 8],
    [6, 10],
    [7, 8],
    [7, 9],
    [7, 12],
    [8, 9],
    [8, 10],
    [8, 11],
    [9, 11],
    [9, 12],
    [10, 11],
    [11, 12],
    [11, 13],
    [11, 15],
    [12, 13],
    [12, 14],
    [13, 14],
    [13, 15],
    [14, 16],
    [15, 16],
  ] as const;
  return (
    <div className="graph-preview">
      <span>
        Knowledge Graph <small>结构示意</small>
      </span>
      <svg viewBox="0 0 254 100" aria-label="知识图谱视觉示意，不表示实际关联">
        {edges.map(([a, b], i) => (
          <line
            key={i}
            x1={nodes[a][0]}
            y1={nodes[a][1]}
            x2={nodes[b][0]}
            y2={nodes[b][1]}
            stroke="#dce6f6"
            strokeWidth=".7"
          />
        ))}
        {nodes.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={i % 3 === 0 ? 5.8 : 3.3}
            fill={
              i % 5 === 1
                ? '#09bf7a'
                : i % 5 === 4
                  ? '#ff9900'
                  : i % 7 === 1
                    ? '#7842ff'
                    : '#257aff'
            }
            stroke="white"
            strokeWidth="1"
          />
        ))}
      </svg>
    </div>
  );
}

export function Dashboard({
  status,
  sources,
  jobs,
  navigate,
  select,
}: {
  status: Status | null;
  sources: SourcePage | null;
  jobs: JobPage | null;
  navigate: (view: 'sources' | 'jobs' | 'search' | 'settings') => void;
  select: (path: string) => void;
}) {
  const counts = status?.counts;
  const overview = [
    {
      title: 'Notes',
      value: counts?.knowledge,
      icon: 'file',
      tone: 'blue',
      view: 'search',
    },
    { title: 'Concepts / Entities', icon: 'branch', tone: 'green' },
    {
      title: 'Sources',
      value: counts?.sources,
      icon: 'database',
      tone: 'violet',
      view: 'sources',
    },
    { title: 'Research Questions', icon: 'help', tone: 'violet' },
  ] as const;
  return (
    <div className="dashboard">
      <div className="stats-grid">
        <StatCard
          title="Sources"
          value={counts?.sources ?? '—'}
          caption="Readable sources in your vault"
          icon="file"
          tone="blue"
          action={() => navigate('sources')}
        />
        <StatCard
          title="Review Queue"
          value="—"
          caption="规划展示 · Awaiting review"
          icon="list"
          tone="violet"
        />
        <StatCard
          title="ChangeSets"
          value="—"
          caption="规划展示 · Awaiting approval"
          icon="branch"
          tone="orange"
        />
        <StatCard
          title="Knowledge Maintenance"
          value="—"
          caption="规划展示 · Knowledge upkeep"
          icon="layers"
          tone="green"
        />
      </div>
      <div className="dashboard-middle">
        <Panel
          title="Recent Captures"
          icon="file"
          action={() => navigate('sources')}
          className="captures-panel"
        >
          <div className="panel-caption">Sources · 当前索引，按路径排列</div>
          {sources?.items.length ? (
            sources.items.slice(0, 6).map((source) => (
              <div className="compact-row capture-row" key={source.id}>
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
                  <span className="row-meta" title={source.path}>
                    {source.path}
                  </span>
                </button>
                <span
                  className={`type-tag ${source.source_type === 'manual' ? 'green' : source.source_type === 'pdf' ? 'red' : 'blue'}`}
                >
                  {source.source_type === 'web'
                    ? 'Web'
                    : source.source_type === 'manual'
                      ? 'Note'
                      : (source.source_type ?? 'Source')}
                </span>
              </div>
            ))
          ) : (
            <div className="dashboard-empty">
              <span className="empty-symbol blue">
                <Icon name="file" />
              </span>
              <strong>
                {status ? 'Your sources start here' : 'Your vault, connected'}
              </strong>
              <p>
                {status
                  ? '显式扫描 Vault 后，在这里查看资料。'
                  : '启动或连接 Core，查看真实资料。'}
              </p>
              <button className="view-all" onClick={() => navigate('settings')}>
                {status ? '扫描与状态' : '连接 Core'} <Icon name="arrow" />
              </button>
            </div>
          )}
        </Panel>
        <Panel
          title="Review Queue"
          icon="list"
          planned
          className="review-panel"
        >
          <div className="filter-pills">
            <span className="selected">All</span>
            <span>Notes</span>
            <span>Web</span>
            <span>PDF</span>
            <span>Images</span>
          </div>
          <PlannedRows kind="review" />
        </Panel>
        <Panel
          title="ChangeSets"
          icon="branch"
          planned
          className="changes-panel"
        >
          <div className="filter-pills">
            <span className="selected">All</span>
            <span>Awaiting</span>
            <span>In Progress</span>
            <span>Recent</span>
          </div>
          <PlannedRows kind="changes" />
        </Panel>
      </div>
      <div className="dashboard-bottom">
        <Panel
          title="Knowledge Overview"
          icon="chart"
          action={() => navigate('search')}
          className="overview-panel"
        >
          <div className="overview-grid">
            {overview.map((item) => (
              <div className={`overview-tile ${item.tone}`} key={item.title}>
                <span className="row-symbol">
                  <Icon name={item.icon} />
                </span>
                <span>
                  <strong>
                    {'value' in item
                      ? (item.value?.toLocaleString() ?? '—')
                      : '—'}
                  </strong>
                  <span className="row-meta">{item.title}</span>
                </span>
                <span className="overview-label">
                  {'view' in item ? 'Indexed' : 'Planned'}
                </span>
              </div>
            ))}
          </div>
          <div className="graph-area">
            <GraphPreview />
            <div className="graph-legend">
              {overview.map((item) => (
                <div key={item.title}>
                  <i className={`legend-dot ${item.tone}`} />
                  <span>
                    {item.title === 'Concepts / Entities'
                      ? 'Concepts'
                      : item.title}
                  </span>
                  <span>
                    {'value' in item
                      ? (item.value?.toLocaleString() ?? '—')
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
        <Panel
          title="Knowledge Maintenance"
          icon="layers"
          planned
          className="maintenance-panel"
        >
          {[
            [
              'red',
              'Potential duplicate notes',
              '规划展示 · Similar content across sources',
            ],
            [
              'orange',
              'Stale notes',
              '规划展示 · Review or archive older notes',
            ],
            ['blue', 'Isolated notes', '规划展示 · Connections to explore'],
            [
              'violet',
              'Taxonomy suggestions',
              '规划展示 · Improve organization',
            ],
          ].map(([tone, title, caption]) => (
            <div className="maintenance-row" key={title}>
              <span className={`issue-dot ${tone}`}>
                <i />
              </span>
              <span className="row-copy">
                <span className="row-title">{title}</span>
                <span className="row-meta">{caption}</span>
              </span>
              <Icon name="chevron" />
            </div>
          ))}
        </Panel>
        <Panel
          title="Recent Activity"
          icon="activity"
          action={() => navigate('jobs')}
          className="activity-panel"
        >
          {jobs?.items.length ? (
            <div className="timeline">
              {jobs.items.slice(0, 6).map((job) => (
                <div className="activity-row" key={job.id}>
                  <i className="timeline-dot" />
                  <span
                    className={`row-symbol ${job.status === 'succeeded' ? 'green' : job.status === 'failed' ? 'red' : 'blue'}`}
                  >
                    <Icon
                      name={job.status === 'succeeded' ? 'check' : 'file'}
                    />
                  </span>
                  <span className="row-copy">
                    <span className="row-title">
                      {job.kind === 'compile_source' ? 'Compiler' : job.mode === 'rebuild' ? 'Index rebuild' : 'Vault scan'}{' '}
                      · {job.status}
                    </span>
                    <span className="row-meta">
                      {job.kind === 'compile_source' ? `${job.route} · ${job.model}` : `${job.processed_files} files processed`}
                    </span>
                  </span>
                  <time dateTime={job.created_at}>
                    {new Date(job.created_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <div className="dashboard-empty">
              <span className="empty-symbol blue">
                <Icon name="activity" />
              </span>
              <strong>A fresh beginning</strong>
              <p>扫描任务的真实记录会显示在这里。</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
