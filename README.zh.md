# dsh-easy-sync

轻量级 DeepSeek Harness 插件：**让某个工作区的对话数据跟着工作区一起走**。

你在多台设备上装 DSH、工作区文件（代码/文档）已经用 Syncthing / OneDrive / git 等同步好了，
但 DSH 的对话记录存放在每台设备自己的 `<DSH_HOME>/sessions/` 里，不会跟着工作区同步。
本插件补上这最后一块：

- 把一个工作区标记为 **sync 工作区**；
- 该工作区的**所有会话**都会在 `<工作区>/.dsh-sync/` 里存档一份；
- 每次 DSH 启动时，**优先从工作区存档恢复**对话（自动把会话 header 里的 `cwd`
  改写成本机工作区路径，所以不同设备路径不同也没关系）；
- 恢复出来的会话会立即挂回工作区列表，不需要重启第二次；
- 运行过程中持续增量归档，切换设备前无需手动操作；
- 桌面版 0.2.x 的会话 “…”（右键）菜单里可直接点“同步此工作区 / 从存档恢复”，
  非同步工作区不会显示这两项。

## 工作原理

```text
每台设备:
  <DSH_HOME>/sessions/--<规范化 cwd>--/<编码后的会话 id>/session.v4.jsonl.zstd
                                              │
                              ┌───────────────┴───────────────┐
                              │   dsh-easy-sync 插件           │
                              │   · 启动时恢复（archive 更新时）│
                              │   · 事件/回合结束增量归档       │
                              └───────────────┬───────────────┘
                                              │
同步工作区（随工作区被外部工具同步）:
  <workspace>/.dsh-sync.json                     ← opt-in 标记
  <workspace>/.dsh-sync/sessions/<会话 id>/...    ← 会话存档（原始日志字节）
  <workspace>/.dsh-sync/conflicts/...             ← 冲突副本（不会丢数据）
```

- 会话日志是追加式 JSONL（默认 zstd 帧）。恢复时只重写第一帧 header 里的 `cwd`，
  事件帧逐字节保留。
- 新旧判断依据日志最后一个事件的 `seq`：存档更新 → 恢复到本机；本机更新 → 回写存档；
  相同 → 只修复路径/header，不重写数据。
- 恢复的文件放在 DSH 要求的规范路径下（由 header 的 `id` + `cwd` 推导），
  再通过 `workspaceRegistry.attachSession` 立即出现在侧边栏，不依赖插件加载顺序。

## 安装

### 第 0 步：先把仓库复制到目标设备

本仓库目前没有远程地址，最稳妥的跨设备方式是 `git bundle`（不依赖 GitHub，能带走全部提交）：

在 Windows 上：

```powershell
cd C:\Users\Seint\Desktop\dsh-easy-sync
git bundle create dsh-easy-sync.bundle --all
```

把 `dsh-easy-sync.bundle` 放进你已经在同步的工作区（或任何传输方式），在 Mac 上：

```bash
git clone dsh-easy-sync.bundle dsh-easy-sync
cd dsh-easy-sync && git log --oneline -1
```

也可以直接复制整个仓库目录（排除 `node_modules`，仓库本身只有几百 KB），或者推送到你自己的私有 remote 再 clone。

要求：Node.js ≥ 22.15（使用 `node:zlib` 的 zstd API），DSH 0.1.5 及以上。
本插件零第三方运行时依赖。

### 方式一：CLI 管理的 profile（web / headless / 自定义 profile）

```powershell
dsh plugin --profile web add C:\path\to\dsh-easy-sync
```

或先 `cd` 到本仓库后：

```powershell
dsh plugin --profile web add .
```

该命令会调用 pnpm，把插件加入 profile 的依赖与 `dsh.profile.bundles`。
之后重启对应 profile 即可。

### 方式二：Windows 桌面版（Electron 管理的 `desktop` profile）

桌面版 profile 由 Electron 应用独占，`dsh plugin --profile desktop` 会拒绝执行。
可以用仓库里的安装脚本（会先备份 `package.json`）：

```powershell
pwsh -File .\scripts\install-desktop.ps1
# 卸载：
pwsh -File .\scripts\install-desktop.ps1 -Remove
```

没装 PowerShell 7 的机器（只有 Windows PowerShell 5.1）用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-desktop.ps1
```

然后**完全退出并重新打开** DeepSeek Harness 桌面版（不是刷新页面）。

脚本做了三件事：
1. 在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-easy-sync` 建立指向本仓库的junction；
2. 在 `...\desktop\package.json` 的 `dependencies` 中加入 `dsh-easy-sync`；
3. 把 `dsh-easy-sync` 追加到 `dsh.profile.bundles`。

> 也可以手动完成上述三步。安装前请确认桌面版完全退出，避免应用覆盖 profile 文件。
> 如果桌面版提供应用内插件管理器，优先使用它做等效操作；本脚本是不依赖 CLI 的兜底方案。
> 桌面版 0.2.x 重启后，同步工作区的会话 “…” 菜单里会多出同步/恢复两项（见“使用”）。

> 说明：本插件的端到端测试跑在隔离的 `dsh web` 实例上（见“开发与测试”）。
> 桌面版由 Electron 管理 profile，无法在纯命令行环境里做同等的重启级验证，
> 因此桌面版安装后请以启动日志与 `workspace_sync` 工具是否出现为准。

### 方式三：macOS / Linux 桌面版

Electron 管理的 `desktop` profile 同样不能用 `dsh plugin` 安装，仓库提供等价的 bash 脚本：

```bash
# 先在 Mac 上完全退出 DeepSeek Harness（⌘Q，不是关窗口）
bash scripts/install-desktop.sh        # 安装
bash scripts/install-desktop.sh -r     # 卸载
```

脚本默认操作 `~/.dsh/profiles/desktop`（设置了 `DSH_HOME` 时用 `$DSH_HOME/profiles/desktop`），
需要本机有 `node`（`brew install node`；装过 DSH CLI 的话已经有了）。它会：

1. 建符号链接 `node_modules/dsh-easy-sync -> 仓库目录`；
2. 在 profile 的 `package.json` 写入 `dependencies`；
3. 把 `dsh-easy-sync` 追加到 `dsh.profile.bundles`；
4. 修改前把 `package.json` 备份成 `package.json.dsh-easy-sync.bak-<时间>`。

如果 Mac 上用的是 CLI 管理的 profile（例如 `dsh web`），优先用：

```bash
dsh plugin --profile web add /path/to/dsh-easy-sync
```

不使用脚本时，手动等价于三步：

1. `mkdir -p ~/.dsh/profiles/desktop/node_modules`
   `ln -s /path/to/dsh-easy-sync ~/.dsh/profiles/desktop/node_modules/dsh-easy-sync`
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加
   `"dsh-easy-sync": "file:/path/to/dsh-easy-sync"`
3. 在同文件 `dsh.profile.bundles` 数组末尾追加 `"dsh-easy-sync"`

然后完全退出并重新打开应用。

### Mac 上第一次验证

1. 确认工作区里的 `.dsh-sync.json` 和 `.dsh-sync/` 已经随外部同步工具到达
   （Finder 里按 `⌘⇧.` 显示隐藏文件；Syncthing/iCloud/OneDrive 默认会同步点目录，
   如果排除过点目录要加回来）；
2. 打开 DeepSeek Harness，在侧边栏打开该工作区；
3. 对 agent 说“看一下同步状态”，应出现 `workspace_sync` 工具返回的工作区列表；
4. 如果没有按预期恢复，在 profile patch 里把 `logLevel` 设为 `debug`，重启后查看
   `~/.dsh/dsh-easy-sync/startup.json` 与 `registry.json`。

工作区路径不同（Windows `C:\...`、Mac `/Users/...`）不影响恢复：插件会把会话
header 里的 `cwd` 改写成 Mac 上的实际路径。

## 使用

### 在对话里让 agent 操作

插件注册了一个 `workspace_sync` 工具，直接对 agent 说即可，例如：

- “把当前工作区设为同步工作区” → `workspace_sync { action: "enable", path: "<工作区绝对路径>" }`
- “看一下同步状态” → `workspace_sync { action: "status" }`
- “立即同步一次” → `workspace_sync { action: "sync", path: "..." }`
- “只从存档恢复” → `workspace_sync { action: "restore", path: "..." }`
- “停止同步这个工作区（保留存档）” → `workspace_sync { action: "disable", path: "..." }`

`enable` 会立即：
1. 在工作区根写入 `.dsh-sync.json` 标记；
2. 创建 `.dsh-sync/sessions/`；
3. 把该工作区现有会话全部归档；
4. 把工作区注册进 DSH、把会话挂到工作区列表。

### 会话右键菜单（桌面版 0.2.x）

桌面版 0.2.x 的会话行 “…” 菜单（右键同一行也会打开它）里，属于同步工作区的会话会多出
两项：

- **同步此工作区**：先归档本地较新的会话，再从存档恢复较新的会话；
- **从存档恢复**：只做恢复，不把本地会话写回存档。

点击后菜单项会显示“同步中…”→“已同步”（失败显示“同步失败”），随后菜单自动关闭。
不是同步工作区的会话不显示这两项——插件先向本机宿主查询该会话所属工作区，查询失败或
未启用时静默隐藏，不会打扰普通会话。

> 这两项来自 DSH 桌面版给会话菜单预留的扩展位
> （`sidebar.workspaces.session.menu.item`）。工作区行的右键菜单由 DSH 内置
> （只有重命名/删除），没有扩展点，因此无法在这里加“设为同步工作区”；请用下面的
> `workspace_sync` 工具或手工写标记来启用工作区。
>
> 0.1.5 及更早的 CLI/Web 侧边栏没有这个扩展位，所以不会出现菜单项；agent 工具不受影响。

### 手工启用

在工作区根目录创建 `.dsh-sync.json`：

```json
{ "version": 1 }
```

插件会在下次启动（或在 15 秒轮询内）发现它。也可以在 profile 的
`cordis.patch.yml` 里显式列出工作区（见“配置”）。

### 新设备上的第一次

工作区文件同步到新设备后：

1. 启动 DSH，在 GUI 里打开该工作区；
2. 插件轮询发现标记（默认 15 秒内），从 `.dsh-sync/` 恢复全部会话并挂到工作区；
3. 之后每次启动都会在启动阶段直接恢复，无需打开操作。
   插件在启动时还会读取 DSH 自己维护的 `~/.dsh/storages/workspace.json`，
   所以只要这台设备打开过一次该工作区，后续即使 GUI 尚未加载也会先完成恢复。

> 若希望“零点击”：把工作区所在父目录加入插件配置的 `roots`，插件启动时就会扫描并
> 自动注册该工作区，无需先在 GUI 打开。

## 日志与诊断

DSH 目前没有把 `ctx.logger` 的输出接到 stderr 或文件，所以插件自己兜底：

- `warn` / `error` 级别始终同时写到 stderr（启动时的终端可见）；
- 把 `logLevel` 设为 `debug` 时，会在 `<DSH_HOME>/dsh-easy-sync/` 写出诊断快照：
  - `startup.json`：启动阶段发现了哪些工作区、恢复了/归档了哪些会话、警告；
  - `registry.json`：工作区注册表可见路径、补挂结果、attach 错误；
  - `tools.json`：`workspace_sync` 工具是否注册成功。

排查“为什么没恢复”时先看这几个文件。常见原因：

1. 工作区没有 `.dsh-sync.json` 标记，也没有出现在 `workspaces` / `roots` 配置里；
2. 新设备第一次打开工作区，但轮询间隔（默认 15 秒）还没到；
3. 会话文件与当前 DSH 版本的会话格式版本不同（见下节）。

## 版本兼容

会话文件是带物理版本号的 generation（例如 `session.v4.jsonl.zstd`），恢复时**保留存档里的
版本号，不迁移、不降级**。因此：

- 多台设备建议安装**相同版本**的 DSH；
- 桌面版与 `dsh` CLI 可能不是同一版本（本机实测：桌面运行时写 v4，而某个 CLI 安装只认 v3），
  混用时旧版本一方会拒绝读取新格式会话；
- 存档目录里可以同时存在不同 generation 的目录；插件按 id 分别处理，不会合并格式。

## 配置

在 profile 的 `cordis.patch.yml` 中按 id 覆盖（`id: dsh-easy-sync`）：

```yaml
- id: dsh-easy-sync
  config:
    roots:
      - D:\projects
    maxDepth: 3
    archiveDebounceMs: 1500
    workspacePollMs: 15000
    registerWorkspaces: true
    logLevel: info
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaces` | `[]` | 显式列出的同步工作区绝对路径（仍需 `.dsh-sync.json` 标记） |
| `roots` | `[]` | 启动时扫描这些目录，寻找带标记的工作区 |
| `maxDepth` | `3` | `roots` 扫描深度；命中标记后不再向下扫描 |
| `restoreOnStart` | `true` | 启动时是否从存档恢复 |
| `registerWorkspaces` | `true` | 是否自动把带标记的工作区注册进 DSH 工作区列表 |
| `archiveOnEvent` | `true` | 运行中是否在会话事件后增量归档 |
| `archiveDebounceMs` | `1500` | 归档去抖窗口（毫秒） |
| `workspacePollMs` | `15000` | 轮询新打开工作区的间隔；`0` 关闭 |
| `includeSubagents` | `true` | 保留字段；子代理会话本身就是普通会话，会随所在工作区归档 |
| `home` | `$DSH_HOME` 或 `~/.dsh` | 覆盖 DSH home（一般不需要） |
| `sessionsRoot` | `<home>/sessions` | 覆盖全局会话根目录（一般不需要） |
| `markerName` | `.dsh-sync.json` | 工作区标记文件名 |
| `archiveDirName` | `.dsh-sync` | 工作区内存档目录名 |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

## 同步策略与冲突

- **单写者假设**：同一时间只在一台设备上使用同一个工作区（这是“无缝切换”的常见用法）。
- 两台设备都写了同一会话时，以日志内最大事件 `seq` 判定新旧：严格更长的一方获胜，
  更短的一方会被覆盖。`seq` 相同即视为同一段历史，双方都不改写存档
  （header 里的 `cwd` 本来就允许因设备而异）；若确认内容不同、需要以某一端为准，
  删掉工作区 `.dsh-sync/sessions/<id>/` 后重启该端即可重新归档。
- 启动时发现同一会话存在多份本地副本，会保留历史最长的一份，其余移动到
  `<工作区>/.dsh-sync/conflicts/`，不会删除。
- 会话文件正在写入时，归档会先 `flush` 持久层（优先按会话 flush）；若仍读到不完整的
  尾帧，则裁剪到最后一个完整帧再归档，下一轮事件会补上剩余部分。
- 已归档的会话文件始终是完整可读的（临时文件 + 原子 rename）。

## 不做什么

- 不同步 `~/.dsh/attachments`（图片/附件）与全局设置、凭据。
- 不改变 DSH 的会话格式，不做跨版本迁移；恢复时保留原 generation 版本。
- 不在多设备并发编辑同一会话时做 CRDT 合并。
- 不替换或改写 DSH 自带的右键菜单：只在桌面 0.2.x 的会话菜单**追加**自己的两项，
  不改动内置项；工作区行菜单没有扩展点。

## 安全与回滚

- 插件初始化全程包裹异常：同步失败只记录日志，不会阻止 DSH 启动。
- 恢复写在临时文件后原子 rename；存档同样原子发布，外部同步工具不会读到半截文件。
- 会话菜单的两个宿主路由与 DSH 自己的 open-in-app 一样，先过 `connection` 服务的
  信任栅栏（`requestRejection`，Host/Origin + 登录 Cookie）；没有该服务时路由直接
  关闭（fail closed），不会暴露未鉴权的写入口。
- `disable` 只移除 `.dsh-sync.json` 标记（改名保留为 `.dsh-sync.json.disabled-<时间>`），
  不删除 `.dsh-sync/` 存档；把改名后的文件改回去即可重新启用。
- 桌面版安装脚本会备份 `package.json`，可用 `-Remove` 卸载。

## 已知限制

- 单写者假设：同一会话不要在两台设备上同时继续写（冲突会保留副本，但没有 CRDT 合并）。
- 不归档 `~/.dsh/attachments`、全局设置、凭据。
- 若本机 `sessions/` 为空且 DSH 配置了非默认编码（`compression: none`），插件无法探测到
  编码，会按默认 zstd 恢复；装过至少一个会话后即可正确探测。
- 本地 `sessions/` 下同一 id 的多份副本会被收敛：保留最长的一份，其余移到
  `<工作区>/.dsh-sync/conflicts/`，不会删除。
- 工作区目录被移动后，DSH 自己会静默过滤掉旧路径上的会话；插件下次启动会按新路径
  重新恢复（前提是工作区标记与存档跟着一起移动）。
- 会话菜单项只在桌面版 0.2.x（`dsh.client` 客户端包 + 会话菜单 slot）出现；0.1.x 或
  没有该 slot 的宿主只提供 `workspace_sync` 工具。
- 菜单项通过宿主 HTTP 路由工作（`/dsh-easy-sync/session`、
  `/dsh-easy-sync/session-action`），因此只在 web/桌面 profile 注册；headless profile
  不暴露这两个路由。

## 开发与测试

```powershell
npm test            # 单元测试（路径编码 / 会话文件 / 引擎 / 插件接线）
npm run test:unit   # 同上
npm run test:e2e    # 真实 dsh web 端到端（需要 DSH_E2E=1，见下）
```

端到端测试会：

1. 建一个隔离的 `DSH_HOME` 与临时 profile，把本仓库作为 bundle 挂进去；
2. 造一个“另一台设备”的工作区存档（header cwd 指向不存在的 `E:\other-device\...`）；
3. 启动 `dsh --profile e2e --port 0 --no-open`；
4. 断言启动阶段（不是稍后）就完成了恢复、header cwd 已改写成本机路径、
   工作区注册表里出现该工作区且会话已 attach、`workspace_sync` 工具已注册、
   会话菜单的两个宿主路由已注册且客户端 bundle 确实被打进 web 的合并脚本、
   存档文件未被改写。

```powershell
$env:DSH_E2E = '1'
npm run test:e2e
```

说明：端到端默认按 CLI 当前的会话格式版本 v3 造样本，可用
`DSH_E2E_HEADER_VERSION=4` 覆盖；`DSH_E2E_KEEP=1` 会保留测试目录便于排查。
它不会碰你真实的 `~/.dsh`（除了只读地引用 `profiles/node_modules` 里的共享依赖）。

目录：

```text
src/index.js        插件入口与 cordis 接线
src/engine.js       归档/恢复引擎（纯同步 fs，无服务依赖）
src/session-file.js zstd 多帧解析、头部 cwd 重写、破损尾部裁剪
src/paths.js        DSH 会话路径编码规则（与官方后端逐字一致）
src/config.js       配置、标记、工作区发现
src/web-routes.js   桌面客户端菜单使用的两个宿主 HTTP 路由（含信任栅栏）
client.js           桌面 0.2.x 客户端半：会话 “…” 菜单里的两项
test/               node:test 测试
scripts/            Windows PowerShell 与 macOS/Linux Bash 安装脚本
docs/               DSH 插件 API 侦察笔记
```

## License

MIT
