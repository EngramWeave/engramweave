# 本地 Core

Core 只处理一个 Vault，通过显式扫描登记 `20_Sources/**/*.md` 和 `40_Knowledge/**/*.md`。原始文件是长期资产；SQLite 保存可重建的登记、文本检索投影和扫描任务。启动不自动扫描，不执行 AI，也不写知识文件。

Desktop 通过受限 Rust 桥接调用同一 Core，见 [Desktop 说明](desktop.md)。Native Host 创建的 Core 通过 `ENGRAMWEAVE_HOST_STDIN=1` 启用私有 stdin 生命周期控制：固定一行 `{"type":"stop"}` 或父管道关闭触发正常停止；普通独立 CLI 不读取 stdin 命令，也不开放 HTTP 停止路由。

## 运行

使用 Windows 本地 NTFS、Node 24.x 和 npm 11.x；项目验证版本为 `.node-version` 与 package-lock.json 中的版本。PowerShell 用于固定的 Windows 文件属性查询，以识别 Node Stats 未暴露的 Hidden 与 ReparsePoint 属性；它不执行用户命令或读取正文。

```powershell
npm ci
npm run build
npm run core -- --config D:/path/to/config.json
```

配置必须包含五个字段，拒绝未知字段：

```json
{
  "config_version": 1,
  "vault_path": "D:/path/to/vault",
  "data_dir": "D:/path/to/application-data",
  "host": "127.0.0.1",
  "port": 43127
}
```

路径必须是绝对目录，Vault 与 data_dir 不能互相包含。Core 不创建完整 Vault 目录树。它先绑定 HTTP 端口，再取得 data_dir 的 Windows 独占运行权，然后打开 SQLite；换端口不能绕过同 data_dir 的独占限制。数据库硬链接别名被拒绝。

SQLite 缺失时建立空库，generation=0。health 在数据库初始化成功后返回200 ready；初始化期间返回503。ready 表示运行和数据库可用，不代表已扫描。损坏、版本或约束不匹配、Vault 绑定不同的数据库明确报错，保留文件，不自动删除或恢复。

初始 SQLite schema_version=1，只有documents/jobs/meta三张表。documents.indexed_at允许null，以表示文件尚未成功读取校验；归档属性保存在metadata_json中，没有独立列或状态机。带indexed_at NOT NULL等不匹配约束的数据库返回SCHEMA_UNSUPPORTED，不自动转换或删除。验证不同布局时使用独立data_dir并保留旧库。

Ctrl+C 正常停止；宿主持有的 Node IPC 可发送 `{type:"stop"}` 请求停止。正常停止等待当前扫描结束，移除本实例描述，保留数据库和 token；不开放 shutdown HTTP。遗留活动扫描在新进程启动时标 interrupted，须显式重试。

仅保留最近100个结束Job，按finished_at降序、created_at降序、ID升序确定边界；queued/running不参与清理。启动中断标记和清理在同一事务完成，成功扫描的清理属于发布事务，失败Job的清理属于错误状态事务。清理只删除Job行，不触碰文件资产。

## 认证和请求

GET health 不需要认证，也不含 Vault 路径。其他 API 使用 data_dir 中的 token；不在浏览器存储或日志中保存 token。Host 必须精确匹配配置的 `127.0.0.1:port`；所有浏览器 Origin 被拒绝，Desktop 应使用原生桥接。

```powershell
$coreToken = Get-Content -LiteralPath D:/path/to/application-data/token -Raw
$coreHeaders = @{ Authorization = "Bearer $coreToken" }
Invoke-RestMethod -Uri http://127.0.0.1:43127/v1/status -Headers $coreHeaders
$scan = Invoke-RestMethod -Uri http://127.0.0.1:43127/v1/scans -Method Post -Headers $coreHeaders -ContentType application/json -Body '{"mode":"refresh"}'
Invoke-RestMethod -Uri "http://127.0.0.1:43127/v1/jobs/$($scan.job.id)" -Headers $coreHeaders
Invoke-RestMethod -Uri http://127.0.0.1:43127/v1/sources -Headers $coreHeaders
Invoke-RestMethod -Uri 'http://127.0.0.1:43127/v1/search?scope=sources&q=counter%2B%2B&fields=body' -Headers $coreHeaders
```

扫描提交返回202与Job，不等待完成；相同活动mode返回同一Job，reused=true，不同mode返回409 JOB_BUSY。refresh/rebuild 都完整枚举和按原始字节计算SHA-256；refresh允许复用未变化的有效解析，rebuild重新解析。一次完整扫描将文件投影、索引代次与成功Job在同一SQLite事务中发布。

文件级错误排除该文件，其他文件继续；整体枚举、Vault可用性和总量限制失败时，上一代投影保留。缺少从未存在的扫描根是正常空范围；曾存在的根整体消失会使扫描失败。相同路径更新保留ID，移动/改名按旧路径missing和新路径新ID处理；不同路径相同URL或内容不会合并。

## 文档和查询

GET `/v1/documents?path=...` 只读取受限路径的当前文件。metadata、annotation、source_content/record_body或Knowledge body分别返回。无登记时 indexed_revision/indexed_at=null、index_stale=true；登记后根据当前原始字节revision与索引revision判断新鲜度。搜索结果代表最后一次成功扫描，不实时刷新。

Source列表与Source详情分别返回已发布投影和当前文件的processing_status，仅有archived/null。missing、null或空字符串按未归档读取；metadata保留原始表示，不自动添加字段。其他非空值或类型使Source invalid。该属性与ready独立：已归档和未归档Source都参与扫描与搜索，P1不提供归档动作或编译候选筛选。

文件的indexed_at只在扫描实际稳定读取并计算revision后刷新，refresh复用解析也须重新读取字节；读取失败或missing保留先前校验时间，首次读取失败为null。列表indexed_at和status.last_scan_at表示一代投影发布完成，不能代表每条异常文件都读取成功。unchanged表示本轮读取后Record字节未变；Asset状态另行判断。详情读取不更新索引、时间或归档投影。

Search默认scope=knowledge，可选sources/all。q按空白拆成最多8词，AND字面子串匹配，统一NFC和Unicode小写。字段为title/body/annotation/metadata；metadata只索引URL、source_type、tags，description等扩展字段不进入检索。支持source_type、单tag和按目录段匹配的path_prefix过滤；空q至少需一个过滤。

结果按Knowledge优先、Source中paper优先、标题精确/包含优先、path_key排序。Annotation片段以user_context标注；独立Record正文以record_body标注。列表统一items/total/limit/offset；默认20、最多100。结果携带generation和indexed_at，generation变化后重新分页。

限额集中在共享contracts：单Markdown5MiB、候选最多10,000、本次实际累积读取最多100MiB（包括重读）、YAML aliases最多50，q最多200字符，snippet最多240字符。超限不截断文件，不发布部分索引。

Source必须具有type=raw_source、非空source_type。日期保持原精度；annotation缺失/null读取为空字符串；author/tags接受字符串或字符串数组；未知JSON兼容metadata保留。Knowledge允许无Frontmatter。非法YAML、重复键、未知tag、非UTF-8、目录/类型冲突不参与查询。内部ID不写入Markdown。

普通Source没有asset时，正文是inline Markdown；`.source.md`必须有asset，或有可识别的外部source locator。非inline的source_content为null，record_body只表示Record自身描述，不能当作附件正文。Asset检查不读取二进制内容。

Wiki Link保留raw、alias和anchor。无`./`或`../`前缀的目标按Vault相对路径解析；显式相对路径以当前Record目录为起点，规范化后仍必须位于Vault内。来源文档链接限于20_Sources和40_Knowledge，可省略`.md`；省略时检查原目标和追加`.md`的候选，两者都存在则ambiguous，不搜索全Vault同名文件。锚点不验证段落。隐藏/临时路径、Windows设备名/ADS、symlink/junction和大小写冲突均被拒绝。允许的外部http/https/zotero URI只标unverified，不联网或执行scheme。

Knowledge的metadata.sources和Source的source/asset原字符串均通过original_references返回解析结果。Asset状态为available/missing/unverified/unsupported；引用歧义或越界通过original_references的ambiguous/outside_scope及Asset诊断表达，登记state仍可为ready。详情检查当前资产可访问性，列表保存最后成功扫描的状态；两种扫描模式都会重新检查Asset，Record字节不变也不跳过。index_stale仅比较Record字节投影，不表示资产检查时间。

本版本尚未实现Desktop或性能验收。API使用[共享契约](../packages/contracts/src/index.ts)。

## Capture

POST `/v1/captures` 接收path和markdown，拒绝未知字段和非字符串值。path只允许20_Sources内安全Markdown路径；Core仅按请求创建目标父目录。输入须为完整的web/manual inline Raw Source，具有非空正文；不接受Knowledge、独立Asset Record、其他Source类型或正文编辑。URL只作为metadata读取，不抓取网页。已有合法processing_status按原字节保留，不生成归档属性。

JSON请求最多8MiB，UTF-8 Markdown最多5MiB，均按字节限制，超限413；流式请求同样受限制。输入验证后，目标同目录排他创建`.engramweave-capture-<UUID>.tmp`，完整写入、flush、关闭，再以NTFS硬链接创建最终路径。已有目标无法被硬链接替换；不支持硬链接时明确失败，没有rename/copy覆盖回退。清理仅删除本次请求创建且仍能确认身份的临时文件。

首次创建201、created=true；目标路径和全部字节相同的重放200、created=false；不同字节409 PATH_CONFLICT。返回path/revision/created/scan_required=true。文件保存不调用SQLite，也不创建Job或更新投影；随后显式scan才登记。数据库写入失败不会撤回已保存文件。服务尚未初始化或停止时Capture返回503。

进程在发布前退出，最终路径不存在，可重新提交；发布后响应丢失，同字节重试返回200。残留临时名字不被扫描为文档；扫描对严格匹配Core临时命名的残留报告CAPTURE_TEMPORARY_REMAINS，不自动删除残留或其他文件。临时名字的存在本身不构成允许自动删除的证明。

## 数据库恢复

正常rebuild由POST scans的mode=rebuild执行；新代事务发布前仍查询上一代，失败不会暴露部分结果。缺库启动会建立generation=0的空库，不自动扫描；当前文件仍可读，需显式扫描恢复登记。损坏、较新schema或不匹配约束报错，原库保留。

需要隔离旧库时，先停止Core，再执行离线命令：

```powershell
npm run core -- --recover --config D:/path/to/config.json
```

命令使用与Core一致的data_dir命名管道独占锁，不对任意PID发送信号；活动Core、无法确认退出的旧实例描述都会阻止恢复。它重新校验Vault/data_dir边界，仅操作配置应用数据目录内的core.sqlite、core.sqlite-journal、core.sqlite-wal、core.sqlite-shm，预检全部成员必须是非链接的普通文件，硬链接别名也被拒绝。token、其他数据文件、Vault资产不参与隔离。

每次以独立recovery-时间-UUID目录保留旧数据库家族，再创建新库并执行一次rebuild。成功输出core_recovered、backup_dir、isolated_files与成功Job。备份不会自动删除；缺库也可直接按普通启动/扫描流程恢复，不必先隔离。

文件隔离由逐个文件移动完成；如果中途失败，已移入备份的文件和仍在原位的成员都保留，错误输出backup_dir和isolated_files。新库创建或扫描失败也保留旧备份、新库及可持久化的失败Job诊断，不自动回滚覆盖文件。确认原因后可以再次显式恢复；每次使用新备份目录。恢复允许内部ID/Job历史变化，path/revision、Annotation、已有归档属性、正文与支持的语义查询均从文件重建。

## 验证

所有自动测试位于tests/。真实样本默认在本地私有副本中使用，fixture说明与运行报告保存在被Git忽略的`.local/p1/`。

```powershell
npm run fixtures:prepare
npm run typecheck
npm test
npm exec vitest run tests/source tests/files tests/storage tests/discovery
npm exec vitest run tests/http tests/e2e/source-slice.test.ts
npm exec vitest run tests/jobs tests/source/references.test.ts tests/http/assets.test.ts tests/files/publication.test.ts
npm exec -- vitest run tests/capture tests/http/captures.test.ts tests/storage/recovery.test.ts tests/storage/recovery-failures.test.ts tests/discovery/rebuild.test.ts tests/e2e/capture-recovery.test.ts
```

采集可在Core关闭时由现有Clipper直接落盘。验证这条路径应实际剪藏后启动Core、检查尚未扫描时列表为空，再显式扫描、读详情、用真实正文词查询、重复扫描并比较文件哈希。仓库模板版本不等于浏览器实际安装版本，应分别记录。
