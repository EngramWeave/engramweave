# 本地 Core

Core 只处理一个 Vault，通过显式扫描登记 `20_Sources/**/*.md` 和 `40_Knowledge/**/*.md`。原始文件是长期资产；SQLite 保存可重建的登记、文本检索投影和扫描任务。启动不自动扫描，不执行 AI，也不写知识文件。

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

Ctrl+C 正常停止；宿主持有的 Node IPC 可发送 `{type:"stop"}` 请求停止。正常停止等待当前扫描结束，移除本实例描述，保留数据库和 token；不开放 shutdown HTTP。遗留活动扫描在新进程启动时标 interrupted，须显式重试。

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

Search默认scope=knowledge，可选sources/all。q按空白拆成最多8词，AND字面子串匹配，统一NFC和Unicode小写。字段为title/body/annotation/metadata；metadata只索引URL、source_type、tags，description等扩展字段不进入检索。支持source_type、单tag和按目录段匹配的path_prefix过滤；空q至少需一个过滤。

结果按Knowledge优先、Source中paper优先、标题精确/包含优先、path_key排序。Annotation片段以user_context标注；独立Record正文以record_body标注。列表统一items/total/limit/offset；默认20、最多100。结果携带generation和indexed_at，generation变化后重新分页。

限额集中在共享contracts：单Markdown5MiB、候选最多10,000、本次实际累积读取最多100MiB（包括重读）、YAML aliases最多50，q最多200字符，snippet最多240字符。超限不截断文件，不发布部分索引。

Source必须具有type=raw_source、非空source_type。日期保持原精度；annotation缺失/null读取为空字符串；author/tags接受字符串或字符串数组；未知JSON兼容metadata保留。Knowledge允许无Frontmatter。非法YAML、重复键、未知tag、非UTF-8、目录/类型冲突不参与查询。内部ID不写入Markdown。

本版本尚未实现Capture API、Asset/Provenance本地解析、完整数据库恢复入口、Desktop或性能验收。非inline资产仅保留引用与unverified/unsupported状态，不提取内容。未来实现必须继续使用[共享契约](../packages/contracts/src/index.ts)。

## 验证

所有自动测试位于tests/。真实样本默认在本地私有副本中使用，fixture说明与运行报告保存在被Git忽略的`.local/p1/`。

```powershell
npm run fixtures:prepare
npm run typecheck
npm test
npm exec vitest run tests/source tests/files tests/storage tests/discovery
npm exec vitest run tests/http tests/e2e/source-slice.test.ts
```

采集可在Core关闭时由现有Clipper直接落盘。验证这条路径应实际剪藏后启动Core、检查尚未扫描时列表为空，再显式扫描、读详情、用真实正文词查询、重复扫描并比较文件哈希。仓库模板版本不等于浏览器实际安装版本，应分别记录。
