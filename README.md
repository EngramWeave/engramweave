<div align="center">

# EngramWeave

**你的知识，你来定稿。**

AI 编译，你定稿。面向长期学习与研究的个人知识编译系统。

![Status](https://img.shields.io/badge/Status-Early%20Development-orange?style=flat-square)
![Design](https://img.shields.io/badge/Design-Human--in--the--loop-7C3AED?style=flat-square)
![Knowledge](https://img.shields.io/badge/Knowledge-Markdown-7C3AED?style=flat-square&logo=markdown)

[项目设计与边界](CONTEXT.md) · [开发状态](#开发状态) · [快速开始](#快速开始) · [问题反馈](https://github.com/EngramWeave/engramweave/issues)

</div>

> 项目处于早期开发阶段，P1 本地基础已完成。下文描述产品设计与目标使用方式；完整的编译、分析、人工审阅和整合流程尚待实现，当前可用范围见[开发状态](#开发状态)。

---

## 你一定经历过

**收藏了，却还没有变成自己的知识。**

文章、论文和对话保存在不同地方。当时留下的内容明明有价值，过一段时间再看，却忘记为什么保存、想到过什么，以及它与已有笔记有什么关系。整理、维护交叉引用、检查矛盾和更新内容，逐渐变成另一份工作。

**或者，你已经试过让 AI 全自动接管。**

把资料交给 AI，让它编写笔记、建立链接、更新内容。它替你完成了许多工作，也可能替你做了未经审阅的判断：删掉了重要条件，把待验证的说法写成结论，或改动了你原本认可的内容。知识库越来越完整，你却越来越难判断哪些内容代表自己的理解。

---

## EngramWeave 的选择

**AI 负责编译，你负责定稿。**

把你已经判断值得保留的内容，连同当时的想法、疑问与理解一起投递。论文可以只投递选中的段落、高亮和批注。AI 尊重这份材料，去噪、适度提炼，形成可编辑草稿；独立的分析任务再提出疑问、联系与整合建议。

你在 Obsidian 中阅读和修改草稿，允许它进入整合规划。AI 根据当前知识库提出候选变更，你审查、修改并批准最终内容，系统再执行正式写入。

> **AI 认为** ≠ **我认可**
>
> AI 可以理解、建议和提案，最终决定属于你。

---

## 三条路线的不同选择

以下比较的是三种工作方式，具体工具可以采用不同组合。

| | 手工整理 | 全自动编写 | EngramWeave 的设计 |
|---|---|---|---|
| **谁整理内容** | 你撰写、分类和维护链接 | AI 生成并直接维护内容 | AI 生成草稿和分析，你审阅并修改 |
| **谁决定正式改动** | 你直接编辑 | 交给自动规则与 AI | 你审查候选变更，决定最终批准内容 |
| **需要投入什么** | 写作与维护劳动 | 规则配置与结果检查 | 对内容、关系和整合方案的判断 |
| **主要取舍** | 保持直接控制，整理成本较高 | 减少手工操作，需承担未经审阅改动的风险 | 自动整理与人工定稿结合，仍需要你参与判断 |

---

## 一次完整使用

以下是目标流程：

```text
选择值得保留的材料，连同理解与批注一起投递
      │
      ▼
Source 留存：保存投递内容与原材料位置引用
      │
      ▼
Knowledge Compiler
  Compiler：去噪、适度提炼 → Draft 标题与正文
  Draft Analyzer：Review Analyzer → Relation Analyzer
                  疑问、联系与建议只进入侧边栏
      │
      ▼
人工审阅：在 Obsidian 原生编辑器中修改 Draft
      │
      ▼
Review Complete：允许进入整合规划，Draft 仍可编辑
      │
      ▼
Integration Planner：统一规划如何融入当前知识库
      │
      ▼
候选 ChangeSet：对比当前本地文件，审查、编辑或打回
      │
      ▼
人工批准：确定最终内容与关系
      │
      ▼
确定性执行 → 本次涉及文件的 Git 提交
      │
      ▼
正式 Knowledge / Research → 检索、取回与来源追溯
      │
      └──► 长期维护：提出建议，正式修改仍需批准
```

---

## 核心能力

以下能力属于产品设计；实现进度见[开发状态](#开发状态)。

**📥 采集与来源留存** — 一次明确投递形成一份独立 Source，保留材料、批注和原始位置。网页可保存剪藏内容，论文通过引用回到 Zotero；不要求复制整篇论文，也不随之后的 Zotero 高亮修改同步更新。

**🧠 知识编译** — 整理你投递的内容与个人理解，只生成标题和正文。全文可以提供上下文，不能因此扩大整理范围；AI 自己提出的问题和建议不混进正文。

**🔎 草稿分析与关系发现** — Review Analyzer 核对内容、提出疑问；Relation Analyzer 发现与 Knowledge、Ideas、Research 的联系、冲突及整合线索。首个实用版本计划具备基本语义召回，以寻找表达不同但有意义的联系。

**⚖️ 人工审阅** — 正文继续使用 Obsidian 原生编辑器，侧边栏提供来源批注与分析参考。你可以直接修改，也可要求重编译并保留已有修改。Review Complete 允许进入规划，不冻结草稿；关系建议在后续 ChangeSet 中审查批准。

**📐 统一整合与变更提案** — Planner 根据草稿、分析、你的整合意图及当前知识库，提出跨文件的新建、修改、重组、融合或废弃结果，统一生成候选 ChangeSet。你可以对照当前文件取舍内容、编辑候选或打回重新规划，批准前不修改正式知识。

**📄 正式知识与研究材料** — 可独立使用的概念、原理和方法进入 `40_Knowledge`；围绕特定论文、实验或问题的结果、条件、证据和分析进入 `50_Research`。两者共用审阅与整合流程，以普通 Markdown 保存在你的 Vault 中。

**🔍 检索与取回** — 从关键词、元数据、语义和关系等角度找回内容，沿正式笔记 → Source Record → 原材料回溯。长期价值是需要时重新加载自己的认知。

**🛠️ 知识维护与科研增强** — 随后逐步增强重复、冲突、过时内容检查，以及研究问题和证据之间的关联。维护建议由你主动查看，不推送、不静默合并或删除；Research Question 可以就是课题下的一篇普通笔记。

**🔌 模型与 Agent 接入** — 首个实用版本计划让 Compiler、Review Analyzer、Relation Analyzer、Integration Planner 分别选择 API 或 Codex 路径与模型。必要工具供 Agent 读取上下文，复杂研究、跨笔记维护与更广的外部工具能力后续扩展。

---

## 三条不可妥协的约束

**🔐 数据主权** — Source、Annotation、Draft 和正式知识都是用户资产，保持为开放文件或可访问的外部资料。论文与书目以 Zotero 为准；数据库保存运行状态及可重建投影，不成为这些内容的唯一保存位置。

**🛡️ 人工控制** — AI 只生成草稿、分析和提案。未经批准的候选不修改正式内容，批准后的变更由确定性执行器应用。正式文件的版本历史交给 Git；未被 Git 跟踪的 Draft 需要独立的修改保留与恢复能力。

**🌱 长期演化** — 维护只建议、不推送；不做强制复习或提醒。随时记录，随用随取。

---

## 承载形态

| 形态 | 角色 | 当前进度 |
|---|---|---|
| 🖥️ **Desktop + Core** | Desktop 管理配置、状态与任务；Core 独立承担处理和工作流 | 本地 Core 与 Desktop 基础已实现 |
| 🔌 **Obsidian** | 原生阅读、编辑和导航，插件提供工作流侧边栏 | 工作流插件待实现 |
| 📚 **Zotero** | 管理论文和书目，插件投递明确选择的阅读材料 | 投递插件计划纳入 P2 |
| 📎 **Web / Manual Capture** | 复用已有 Web Clipper 与模板，或通过 Core 保存规范 Source | 已支持基础文件投递和 web/manual Capture API |
| 📱 **其他采集端** | 按需要扩展 Mobile、多模态和远程采集 | 后续阶段 |

---

## 开发状态

**P1 已完成，后续实施从 P2 开始。** 当前仓库包含：

- 独立运行的本地单 Vault Core、Source 登记与显式扫描。
- 当前文件读取、来源引用和本地 Asset 定位、关键词与元数据检索。
- web/manual Markdown Capture 和离线数据库投影恢复。
- Tauri Desktop 的 Core 启停／连接、状态、Sources、扫描 Jobs、Search 与原生打开。

当前扫描范围是 `20_Sources` 和 `40_Knowledge`；保存 Capture 后仍需显式扫描。`processing_status` 目前只读取 `archived` 或空值，不自动补 `pending` 或推进处理阶段。Desktop 中的 Review、ChangeSets 等规划区域仅作展示，不代表工作流已经实现。

P2 计划接入 Zotero 选段投递、状态与调度、基本语义召回、API／Codex 编译分析和 Obsidian 人工审阅。P3 完成统一 Planner、ChangeSet 审查与执行、Git 提交和再次找回，形成首个实用闭环。完整编译、语义检索、整合、维护与科研增强尚未交付。

---

## 快速开始

### 环境依赖

- Windows 本地 NTFS。
- Node.js **24.19.0** 与 npm **11.17.0**；版本依据见 `.node-version` 与 `package.json`。
- 构建 Desktop 另需 Rust MSVC 工具链、Windows SDK 和 WebView2，见 [Desktop 说明](docs/desktop.md)。
- Obsidian 用于现有 Vault 的阅读与编辑；当前 Core 可独立运行。

### 安装与构建

```powershell
git clone https://github.com/EngramWeave/engramweave.git
cd engramweave
npm ci
npm run build
```

### 启动 Core

准备已有 Vault 和独立的应用数据目录，两者不能互相包含。把以下配置保存为 `D:/path/to/config.json`，替换为你的实际绝对路径：

```json
{
  "config_version": 1,
  "vault_path": "D:/path/to/vault",
  "data_dir": "D:/path/to/application-data",
  "host": "127.0.0.1",
  "port": 43127
}
```

```powershell
npm run core -- --config D:/path/to/config.json
```

启动后需显式扫描才会有检索结果。配置、认证、扫描、Capture 与恢复操作见 [Core 使用说明](docs/core.md)。

### 启动 Desktop

在另一终端中指定同一配置：

```powershell
$env:ENGRAMWEAVE_CONFIG = 'D:/path/to/config.json'
npm run desktop:dev
```

Desktop 可启动自身 Core，也可连接已运行的 Core。当前构建面向本机开发环境，尚未提供可分发安装包；操作说明见 [Desktop](docs/desktop.md)。

---

## 开发与参与

本仓库包含共享契约、Core 和 Desktop；Obsidian、Zotero 等客户端在各自仓库维护。

- [项目上下文](CONTEXT.md)：当前支持边界与计划中的领域语义。
- [Core 使用与验证](docs/core.md)：配置、API 操作、恢复和验证方法。
- [Desktop 使用与构建](docs/desktop.md)：原生宿主与桌面操作。
- [P1 文件与接口合同](docs/p1-contracts.md)：当前受支持的文件、接口与资产边界。
- [贡献约定](AGENTS.md)：实现、文档和测试约定。

欢迎通过 [Issues](https://github.com/EngramWeave/engramweave/issues) 反馈问题和使用需求。

---

<div align="center">

**允许你放心遗忘细节，因为重要的认知已经被可靠地保存，能够在需要时重新找回。**

如果这个方向对你有启发，欢迎 Star ⭐ 和参与共建。

</div>
