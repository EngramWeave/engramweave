# 文件与接口合同（P1 基础及 P2 A 扩展）

P2 B 的 Compiler、Draft 和 schema 2 迁移扩展见 [Compiler 与 Draft](compiler.md)；本文保留 Source／Knowledge、扫描、读取和 Capture 的基础合同。

唯一 API Schema 和推导类型位于 [contracts](../packages/contracts/src/index.ts)。Core 与 Desktop 使用同一份契约；数据库内部 ID 不写入用户 Markdown。部署、采集、扫描和恢复命令见 [Core](core.md)，本机宿主和原生打开见 [Desktop](desktop.md)。

## 文件模型

| 对象 | 文件与读取约定 | API 内容字段 |
|---|---|---|
| Inline Raw Source | `20_Sources/**/*.md`，Frontmatter 含 `type: raw_source`、非空 `source_type`；web 还需 HTTP/HTTPS `source` | `source_content` 为原始正文；`record_body/body` 为 null |
| Source Record / Asset | `.source.md` 指向本地 Wiki Link 或受支持外部 locator；不提取附件内容 | `record_body` 为 Record 说明；`source_content/body` 为 null；`asset` 表示定位和存在性 |
| 已有 Knowledge | `40_Knowledge/**/*.md`，允许普通 Markdown；`raw_source` 位于该目录时报冲突 | `body` 为已有知识正文；Source 专属内容、Asset 为 null |

严格读取 UTF-8，接受 BOM、LF/CRLF；读取不写回文件，Registry 仅在阶段缺失或为空时补写该属性，不重排正文或其他属性。日期保留字符串精度，author/tags 接受字符串或字符串数组，未知 JSON 兼容 metadata 保留。缺失或 YAML null 的 Annotation 读取为 `""`，响应独立于 metadata 和正文。description 等扩展字段不拼入原文，也不参与默认 metadata 检索。重复 YAML 键、不支持标签/结构、非 UTF-8 和超限均明确诊断。

Source 的 `processing_status` 接受 `pending/compiled/reviewed/planned/archived`。Registry 对缺失、null、空字符串分别补 processing_status: pending 和 lifecycle_status: active，包含历史和 discarded 材料；补写后重新读取文件并计算 revision。完整阶段在 refresh、rebuild 和离线恢复中保持。详情 GET 仍只读，尚未登记的空阶段返回 null；非法非空值或类型使 Source invalid。

Source 和 Knowledge 独立返回 `lifecycle_status=active/discarded`；缺失/null/空字符串按 active 读取，不补写。无有效文件属性的 invalid/missing/unsupported 列表项返回 null。登记字段仍为 `state=ready/invalid/missing/unsupported`，Job 字段仍为 `status=queued/running/succeeded/failed/interrupted`，各自独立。阶段和生命周期投影来自 metadata，错误及次数属于 Core。当前 Job 仍只有扫描；计数在实际任务实现时加入，不写 Source Properties。

安全属性补写及中断恢复见 [Core](core.md#属性补写与恢复)。本切片只登记文件已有阶段，不提供编译、Recompile、Review、discard 或归档动作。

## 九个 API

| 方法与路径 | 当前用途 |
|---|---|
| `GET /v1/health` | 不含资产路径的运行健康；数据库初始化前不可报 ready |
| `GET /v1/status` | 配置、实例、活动扫描、索引代次、计数、固定限额 |
| `POST /v1/scans` | 只接受 `refresh/rebuild`；返回 202 Job，同模式活动请求复用，异模式 409 |
| `GET /v1/jobs` | 当前和近期扫描任务，统一分页 |
| `GET /v1/jobs/{id}` | 单个 `scan_vault` Job，未知 ID 为 404 |
| `GET /v1/sources` | 默认 ready、按 path_key 排序；可按登记状态、类型、目录前缀筛选 |
| `GET /v1/documents?path=...` | 从当前受限文件读取详情，不刷新投影 |
| `GET /v1/search` | 默认 Knowledge，支持 Sources/all、字面 AND、字段和元数据过滤 |
| `POST /v1/captures` | 仅新建 web/manual inline Raw Source；首次 201；原字节或精确 pending 补写重放 200；compiled 精确形式还需关联 Draft 的输入 revision 证明，其他差异 409 |

health 外均需认证，Host 固定为配置的 `127.0.0.1:port`，浏览器 Origin 被拒绝。请求拒绝未知字段。公共字段用 snake_case、列表用 `items/total/limit/offset`，默认 limit=20、最大100；错误统一为 `error.code/message/details`，不含 token、堆栈或正文。无任意 SQL、文件读写、通用 Job、Source 删除/更新、Canonical 写入或 AI 接口。

## revision、索引和恢复边界

`revision` 是原文件字节 SHA-256，换行变化也会改变它。`indexed_revision` 是最后成功扫描的字节版本；未登记时为 null，generation=0，`index_stale=true`。详情读取比较当前 revision 与投影，但不更新数据库。逐文件 `indexed_at` 只在扫描稳定读取并计算 hash 后更新；列表时间表示整代发布，不能当成异常文件的成功读取时间。

refresh 仍读取全部候选并计算 hash，只复用未变化文件的解析；rebuild 强制解析。文件投影、代次和成功 Job 在同一事务发布；枚举失败或总量超限保留上一代，不能发布部分 missing。`index_stale` 比较 Record 字节，不代表附件状态或网站存活。

同路径更新保留内部 ID；移动/改名产生 missing + 新路径新 ID，不猜测重命名。同 URL/hash 的不同路径不合并。来源链为 Knowledge → Source Record → inline 内容、本地 Asset 或外部 locator；受限 Wiki Link 支持 alias/anchor，不做 basename 模糊搜索。外部 URI 只标 unverified，不联网或执行 scheme。

SQLite 只保存 documents/jobs/meta 三张表及可重建投影，位于 Vault 外，Schema 仍为 1。损坏或不兼容库不会自动删除；显式离线恢复取得独占运行权，隔离数据库及 journal/wal/shm 到新备份目录，再从全部受支持文件 rebuild。失败保留备份与诊断。恢复保持路径、完整阶段、生命周期、Annotation、正文及支持的语义查询；仅缺失/空阶段补 pending 并更新 revision，不保证内部 ID、旧 Job 历史或原扫描时间。

当前支持 Windows 本地 NTFS、单 Vault 和本机 Node 宿主；不承诺网络盘、云占位文件、多 Vault、跨平台安装包、OCR、外部网页存活或找回用户删除的资产。Core 可写入明确 Capture 请求的新 Source、登记时缺失/空阶段的补写，以及显式 Compiler 的新 Draft 和 pending→compiled 阶段；不写正式 Knowledge。两项 Analyzer、人工 Review 动作和整合仍在后续实现。

Sources 的浏览、筛选、Health 与批量生命周期合同见 [Sources](sources.md)。用户可编辑 Compiler 模板与重复执行见 [Compiler](compiler.md)。
