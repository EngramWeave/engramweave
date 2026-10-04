# EngramWeave P1

本地单 Vault Core，文件为真相源，SQLite 保存可重建投影。支持显式扫描、Source 登记、当前文件读取、扫描任务查询、基础关键词检索，以及受限的本地 Asset 与来源引用解析。Capture、完整恢复入口和 Desktop 尚未实现。

Source的processing_status是只读的长期归档属性：archived或null，与登记ready独立。已归档资料照常扫描和检索；Core不生成或写入归档标记。文件indexed_at只在扫描成功读取并计算hash后更新，详情读取不刷新投影。

## 安装与验证

环境锁定 Node 24.19.0、npm 11.17.0、Windows 本地 NTFS。依赖由 package-lock.json 精确锁定。

```powershell
npm ci
npm run fixtures:prepare
npm run typecheck
npm test
```

原样基线保留作可复核输入。自动测试的编辑、删除和故障操作只在 `.local/test-runs/` 子目录进行；用户明确授权的测试 Vault 也可手工用于验证。

## 独立启动

首次先构建：`npm run build`。在 Vault 外准备 JSON（这里的 Vault 应使用隔离副本）：

```json
{
  "config_version": 1,
  "vault_path": "D:/code/EngramWeave/engramweave/.local/fixtures/r1-vault",
  "data_dir": "D:/code/EngramWeave/engramweave/.local/manual/data",
  "host": "127.0.0.1",
  "port": 43127
}
```

将它保存到 `.local/manual/config.json`，再启动：

```powershell
npm run core -- --config D:/code/EngramWeave/engramweave/.local/manual/config.json
curl.exe -i http://127.0.0.1:43127/v1/health
```

数据库初始化成功后，预期 `200 {"status":"ready","core_version":"0.1.0","api_version":"1"}`；尚未扫描时索引代次为0。Ctrl+C 正常停止；宿主可通过自有Node IPC发送 `{type:"stop"}`。停止后instance.lock移除，数据库和token保留；不开放shutdown HTTP。

应用数据不会进入Vault，不创建完整Vault目录树。Host必须为配置的`127.0.0.1:port`，拒绝浏览器Origin。health之外的路由需`Authorization: Bearer <data_dir/token>`。token不得贴到日志或公开材料。

## 工程与检查

- `packages/contracts/`：唯一 JSON Schema、推导类型、限额和九个 P1 API 契约。
- `packages/core/src/`：运行入口、受限文件读取、解析、SQLite投影、显式扫描、任务、HTTP及检索。先绑端口、取独占运行权，再打开数据库。
- `tests/core/`、`tests/contracts/`：Vitest 配置/HTTP/运行所有权/独立CLI/契约验证；`tests/helpers/` 为隔离目录工具。
- `docs/`：维护的使用与开发说明；本地验证证据位于`.local/p1/`。

运行后检查：health返回ready且不含路径；未认证status为401；第二实例被拒绝；显式扫描后才能检索文件；关闭后可重新启动；普通扫描与读取保持文件哈希不变。API操作与限制见[Core说明](docs/core.md)。
