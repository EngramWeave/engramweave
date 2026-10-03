# EngramWeave P1

本地单 Vault Core，文件为真相源，SQLite 将作为可重建投影。当前 T00/T01 范围已实现：工程骨架、共享契约、配置校验、本机运行所有权及 health。扫描、查询、Capture 和 Desktop 尚未实现。

## 安装与验证

环境锁定 Node 24.19.0、npm 11.17.0、Windows 本地 NTFS。依赖由 package-lock.json 精确锁定。

```powershell
npm ci
npm run fixtures:prepare
npm run typecheck
npm test
```

真实资料和原样基线保持只读。测试配置/故障操作只在 `.local/test-runs/` 子目录进行。

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

T01 预期 `503 {"status":"degraded","core_version":"0.1.0","api_version":"1"}`，因为数据库在 T03 实现；503 不能视为完整 Core 已可用。Ctrl+C 正常停止；由宿主持有的 Node IPC 可发送 `{type:"stop"}` 正常关闭。停止后 instance.lock 移除，本地 token 保留；不开放 shutdown HTTP。

应用数据不会进入 Vault，不创建完整 Vault 目录树。Host 必须为配置的 `127.0.0.1:port`，拒绝浏览器 Origin。访问其余路由需 `Authorization: Bearer <data_dir/token>`，T01 尚未注册的路由认证后返回404。token不得贴到日志或公开材料。

## 工程与检查

- `packages/contracts/`：唯一 JSON Schema、推导类型、限额和九个 P1 API 契约。
- `packages/core/src/`：main/config/http/instance/errors。先绑端口、取独占运行权，后续才打开数据库。没有 Desktop 包和后续业务空包。
- `tests/core/`、`tests/contracts/`：Vitest 配置/HTTP/运行所有权/独立CLI/契约验证；`tests/helpers/` 为隔离目录工具。
- `docs/`：决定记录与冻结契约。

运行后检查：启动后 health 应503且不含路径；未认证 `/v1/status` 应401；同端口第二Core应失败；关闭后可重新启动；隔离Vault文件与目录不变。当前限制和技术版本见 [决定记录](docs/p1-decisions.md)，冻结含义见 [契约说明](docs/p1-contracts.md)。
