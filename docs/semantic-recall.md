# 基本语义召回

Core 对 `10_Ideas`、`40_Knowledge`、`50_Research` 中的普通 Markdown 提供混合检索：BM25 找词面相关片段，Embedding 找不同表达的相关内容，RRF 融合去重；可选 Reranker 根据当前查询重排。结果是可核对的候选，不代表正式关系成立。Research 的目录位置不表示用户认可，未召回也不能证明没有联系。

原始 Source 与附件不进入当前向量索引。结果详情中的 `original_references` 可沿已有来源链返回 Source；当前不提取 PDF、OCR 或网页内容。

## 配置和使用

在 Desktop Settings 的 Semantic Recall 中独立填写 Embedding endpoint、模型 ID、凭据和查询 instruction，保存后用 Test services 验证。兼容 `/v1/embeddings` 的服务返回浮点向量；`model` 使用服务 `/v1/models` 的 ID。Qwen3-Embedding 使用查询侧 `Instruct: …\nQuery: …`，文档侧使用标题、章节与原文片段，不把查询 instruction 加到文档。

本机服务可不填密钥；远端使用 HTTPS 和独立凭据。Embedding 与 Reranker 不借用 Compiler 的 endpoint、模型或密钥。Windows DPAPI 按当前用户保护凭据并绑定 endpoint；GET 只返回是否已配置。文档片段和查询只发送到明确选择的模型服务；错误不转发模型正文、密钥或堆栈。

1. 点击 Refresh workspace 完成本地登记。
2. 首次点击 Build Semantic Index；保存配置本身不调用模型。
3. Search → Semantic，选择三类范围，输入自然语言查询。Keyword 保留原有字面检索，并可选择 Ideas／Research。
4. 后续 Refresh workspace 先发布成功登记，再更新新增或变化的编码输入。普通编辑和程序启动不调用 Embedding，也不补跑中断任务。
5. 语义失败、过期和未覆盖独立显示在 Settings／Search／System Status；登记、Sources 和关键词搜索仍可用。恢复服务后显式 Update / Retry。

Reranker 默认关闭，可以在 Settings 设置默认值，也可以在某次查询中单独勾选。兼容 `/v1/rerank` 的服务接收 `query/documents/top_n/model`，返回完整、唯一的 `index/relevance_score`。每次查询只重排当前候选，Refresh 不调用它。重排失败明确提示，保留混合排名；Embedding 查询失败不会伪装成成功的语义检索。

## 索引与证据

`data_dir/semantic.sqlite` 是独立、可重建的派生缓存，保存 Vault 绑定、模型表示 fingerprint、文档 revision、片段、FTS5、向量和进度。文件是权威，不由缓存写回 Markdown。主 Registry schema 3 从经过校验的 schema 1／2 原子迁移，扩展 idea／research 类型，保留 Source ID、属性与已有 Job。

标题／段落切分保留原文和行定位，长段有界拆分，覆盖尾部。当前原文每片段最多 800 UTF-8 字节，标题和章节各保留最多 120 个 Unicode 字符作为编码上下文；这是明确的字节／字符预算，不是精确的模型 token 计数。代码块和长表格可能跨片段，章节上下文仍保留。实际服务仍需支持这些输入；超时或不兼容输入会报失败，不静默截断整篇笔记。

ICU 词边界生成索引与查询的同一分词输入，FTS5 按 BM25 查询并提高标题／章节／标签的词面权重。两个候选列表按片段身份去重，融合按排名计算，不直接相加不同量纲的分数。候选 20–50 个，默认 40；向量查询为 sqlite-vec 的精确检索。类型范围在两路候选查询时生效。

编码输入 hash 与模型／表示 fingerprint 决定复用，文件 revision 用于证据检查。仅改生命周期、行位置、mtime 或不进入编码的 Properties 不重复计算正文向量；重复片段复用生成结果。成功片段向量立即缓存，完整文档贡献在 SQLite 事务内替换；失败保留已成功缓存和旧文档贡献。删除／discarded 贡献依据成功登记快照移除，不调用 Embedding。

重排前以及返回前安全重读候选文件，校验 revision、当前解析状态和 lifecycle。已变化、失踪、损坏或 discarded 候选排除并报告。默认只检索 active、ready 的三类笔记。每份笔记最多三个片段，默认最多 20 份笔记；输出原文总预算 8000 UTF-8 字节，可能提前结束，返回明确截断诊断。类型、路径、revision、章节和原文件行号均可核对；分数不是关系成立概率。

向量与 FTS 查询、切分及存储在独立 worker 中执行；索引不在模型等待期间锁住笔记。连续 Refresh 的待更新请求合并，独立 Core 不依赖 Desktop 页面保持打开。修改文档模型／endpoint／表示方式需明确 Rebuild Semantic Index；查询 instruction、候选预算和 Reranker 改动不重算文档向量。启动只恢复中断状态，普通 Refresh 不启动首次或不兼容的全量重建。

语义缓存损坏不会使主 Registry 失效。损坏文件被保留；对于不兼容或不可读缓存，显式重建先隔离已验证的常规缓存文件，再创建新缓存。硬链接／reparse 等不安全文件保留并拒绝操作。明确重建更换当前派生索引；新空间完成前不能使用旧空间混合查询。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET／POST | `/v1/recall/settings` | 独立模型配置，凭据只写 |
| POST | `/v1/recall/test` | 用不含用户材料的短文本验证服务 |
| GET | `/v1/recall/status` | 初始化、覆盖、过期、进度和错误 |
| POST | `/v1/recall/index` | `mode: build/update/rebuild`，异步任务 |
| POST | `/v1/recall` | `q/scope/limit/rerank`，范围 all／knowledge／ideas／research |
| POST | `/v1/recall/context` | 按 `chunk_id/path/revision` 重新验证选中的原文证据 |

返回证据供后续 Analyzer 使用，当前不执行 Analyzer，不写正式关系。共享字段定义在 [contracts](../packages/contracts/src/index.ts)；接口仍受现有 Host、Origin 和本机 Bearer token 边界保护。Desktop 固定声明这些路由，模型等待使用独立连接快照，身份验证保持原有检查且不持有宿主生命周期锁。

## 验证与支持限制

`npm run typecheck`、`npm test` 覆盖合同、迁移、增量、恢复、安全路径、协议、失败隔离、候选新鲜度、中文分词和现有回归。真实模型验证显式开启：

```powershell
$env:ENGRAMWEAVE_REAL_RECALL = '1'
$env:ENGRAMWEAVE_EMBEDDING_ENDPOINT = 'http://127.0.0.1:8095/v1'
$env:ENGRAMWEAVE_RERANKER_ENDPOINT = 'http://127.0.0.1:8086/v1'
npx vitest run tests/recall/real-quality.test.ts
```

测试使用有标签的隔离模拟笔记，记录 Recall@10、MRR、nDCG 和阶段耗时到 `.local/p2-c1/real-quality.json`；不宣称已经验收用户真实库。性能测试使用合成向量，不证明语义理解。真实笔记规模、专业术语、中文词边界与量化模型质量仍应以实际查询核验；没有 universal 相似度阈值、ANN、query rewrite、跨文档自动关系或 PDF 语义检索。

实现借鉴 [Haystack 融合](https://github.com/deepset-ai/haystack/blob/main/haystack/components/joiners/document_joiner.py)、[LlamaIndex 增量缓存](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/ingestion/pipeline.py)、[txtai 混合检索](https://github.com/neuml/txtai/blob/master/src/python/txtai/embeddings/search/base.py) 和 [Omnisearch 笔记检索](https://github.com/scambier/obsidian-omnisearch/blob/master/src/search/search-engine.ts) 的机制，未引入这些框架或复制其代码。
