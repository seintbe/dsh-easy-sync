# DSH 插件 API 侦察报告（dsh-easy-sync 专用）

> 侦察目标：把 `dsh-easy-sync` 做成一个「启动时把工作区里的会话存档恢复成会话、并让它们出现在 workspace 列表里」的宿主插件。
> 本文所有结论都标了可信度：**✅ 已证实**（读了源码或本地实测）/ **⚠️ 未证实**（读码推断，需复核）/ **❌ 已证伪**（实测反例）。
> 行号以本机已安装版本为准，升级后可能漂移；每个结论都给了 `文件:行号` 以便重新定位。

## 0. 路径速记与环境事实

| 记号 | 实际路径 |
| --- | --- |
| `$DSH` | `C:\Users\Seint\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| `$PKG` | `$DSH\node_modules\@deepseek-ai`（所有插件包） |
| `$HOME_DSH` | `C:\Users\Seint\.dsh`（当前用户的真实 DSH home） |
| `$TMPHOME` | `C:\Users\Seint\Desktop\dsh-easy-sync\.tmp\dshhome`（本次侦察用的隔离 home） |
| `$REPO` | `C:\Users\Seint\Desktop\dsh-easy-sync` |

版本事实（✅ 已证实，`dsh --version` + 读 package.json）：

- CLI/launcher 包 `@deepseek-ai/dsh` = **0.1.5-rc.1**（`$DSH\package.json`），所有插件包 = **0.1.5-rc.2**；`@deepseek-ai/cordis` = **4.0.2**，`@deepseek-ai/schemastery` = **3.18.2**。
- launcher 与插件包存在 **rc.1 / rc.2 版本错位**（launcher 单独发版导致）。结论：文档里的行号只能当作稳定锚点，**不要**在代码里断言 `version === '0.1.5'`。
- Node 24.15 / Windows / pnpm 11.7.0（`pnpm` 在 PATH 上，✅ 实测）。

---

## 1. 插件入口形态（`name` / `inject` / `Config` / `apply`）

### 1.1 最小形态（✅ 已证实，取自真实第三方插件）

`$HOME_DSH\profiles\desktop\node_modules\ds-bot\index.js:32-54` 是最干净的样板：

```js
// index.js（ESM）
export const name = 'ds-bot'                       // 可选
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController',
  'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']  // 可选（一旦声明=必需）
export function apply(ctx, config = {}) { ... }    // 必需
```

- **必须**导出 `apply`（或默认导出函数 / 带 `apply` 的对象 / class）。Loader 负责 CJS↔ESM 互操作与 `default` 解包：`$PKG\cordis-plugin-loader\src\index.ts:186-205`。
- `name` 只用于诊断与日志；`plugin.name === 'apply'` 会被当成匿名（`$PKG\cordis\src\registry.ts:322-335`）。
- **`inject` 一旦声明就是"硬依赖"**：任何一项服务永远不可用，该 entry 会永久 `PENDING`，整个 boot 失败（见 §3.3）。所以「只想用到时才用」的服务**不要**写进 `export const inject`。
- **`Config` 是可选的**（✅ 已证实，读码）：`resolveConfig` 在插件没有 `Config` 时把 loader 传进来的 config 原样透传，不做校验（`$PKG\cordis\src\fiber.ts:50-62`）。ds-bot 就没有 `Config`。

### 1.2 需要 schema 校验时的写法（✅ 已证实）

`$PKG\dsh-web-app\lib\index.js:33-38` 的写法就是官方套路：

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().default(5000).min(100),
  markerName: z.string().default('.dsh-easy-sync.json'),
})

export function apply(ctx, config) {
  // config 已经过 Config 校验 + 默认值填充
}
```

要点：

- 校验协议是 **Standard Schema**（`~standard.validate`），**不支持异步 validate**；校验失败抛 `ValidationError`，该 entry 直接失败 → **整个 boot 失败**（`$PKG\cordis\src\fiber.ts:50-62`、`registry.ts:330-360`）。
- `Config` 上若有静态 `simplify`，loader 写回配置时会用它（`$PKG\cordis-plugin-loader\src\index.ts:106-115`）。本插件不需要。
- 本仓库 `package.json:37-48` 已把 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 声明成 **可选 peerDependency**，这是对的：插件目录被 link 进 profile 后，这两个包由 `$DSH_HOME\profiles\node_modules` 兜底解析（见 §7.3）。

### 1.3 package.json 与「能不能自动被加载」

三种可能的投放方式，**只有第一种会被自动加载**（✅ 已证实）：

```jsonc
// A. 作为 profile 的一个 layer：必须声明 dsh.bundle.patch
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }

// B. 只是「装了但没人挂」：dsh plugin add 会告警 declares no dsh.bundle
{ "dependencies": {} }

// C. 有浏览器半边（本项目暂不需要，仅记录）
{ "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] } } }
```

- 只有声明了 `dsh.bundle.patch` 的依赖会在 `dsh plugin add` 之后被写进 `package.json` 的 `dsh.profile.bundles`（`$DSH\lib\plugin-*.js:46-78`，函数 `reconcilePlugins`）。
- `dsh.client` 是双面包约定，Node 半边会扫描 loader entries 里所有声明它的包，合成 `window.__DSH_BOOT__`（`$PKG\dsh-client-modules\lib\types\index.d.ts:1-30`、`lib\index.js:139-150`）。**与本插件的会话同步无关**，除非以后要做 UI。
- 本仓库 `package.json:49-53` 已经声明 `dsh.bundle.patch`，`$REPO\cordis.patch.yml:7-9` 是单条 `insert`，方向正确（见 §8.2 关于插入位置）。

---

## 2. 注册工具：`defineTool` + `ctx.tools.register`

### 2.1 契约（✅ 已证实，含实测）

```js
import { defineTool } from '@deepseek-ai/dsh-tools'   // 顶层导出，见该包 package.json exports

ctx.inject(['tools'], (child) => {
  const dispose = child.tools.register(defineTool({
    name: 'sync_probe_echo',
    description: '一句话说明这个工具干什么（模型能看到）。',
    parameters: {
      text: { type: 'string', required: true, description: '要回显的文本' },
    },
    output: {
      schema: { type: 'string' },                                   // 必填
      render: (_args, value) => [{ type: 'text', text: String(value) }], // 必填
    },
    async execute(args, exec) {
      return `echo:${args.text}`   // 返回值必须符合 output.schema
    },
  }))
})
```

- `defineTool` 在 `$PKG\dsh-tools\lib\types\schema.d.ts:239`，`register` 在 `lib\types\index.d.ts:601`、实现 `lib\index.js:2773-2782`。
- **`output: { schema, render }` 是运行期强制校验的**：缺 `output` / 缺 `render` 直接抛错；`run_code` 是保留名，注册即抛（`lib\index.js:2773-2782`）。
- `parameters` 是「名字 → 属性」的普通对象；`required: true` 写在**属性**上（不是数组）。`object` 类型必须带 `additionalProperties`。
- `register()` 返回 disposer；而且注册本身走 `ctx.effect`，**插件卸载会自动注销**（`lib\index.js:2781`）。
- 可见性：`ctx.tools.register` 从普通（未 scoped）插件上下文注册 → 落到 **global 层**，对所有 agent 可见（`$PKG\dsh-scope\lib\index.js:132-181` 的 `ScopedLayers`；`dsh-tools\lib\index.js:2854-2880` 的 `view()` 先铺 global 再让 scoped 覆盖）。
- **实测**（隔离 home 里真跑起来的一次 boot，见 §9 探针 C）：
  ```
  [probe-tool] defineTool + register worked; disposer type = function
  [probe-tool] visible global tool count = 1; includes probe = true
  ```
  且 9 秒后再查仍然是 `count=1 hasPwsh=false`。原因见下一条 👇

### 2.2 ⚠️ 重要陷阱：`ctx.tools.schemas()` 看不到内置工具，不代表工具没生效

- 合成后的 web profile 里，**几乎所有顶层 tool 行都是 `disabled: true`**（✅ 已证实，`$TMPHOME` 下 `dsh --profile web --dump-config` 输出）：
  ```yaml
  # == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
  - id: tool-pwsh
    name: '@deepseek-ai/dsh-tool-pwsh'
    disabled: true
  ```
  真正的工具名册由 **agent preset（scoped 上下文）**组成（⚠️ 未证实：这条是读码推断 —— preset 明确拒绝把服务泄漏成进程级全局，`$PKG\dsh-agent-presets\lib\index.js:906-921`，但"哪些行被搬进了 preset 的 scoped 子树"没有在 `--dump-config` 里体现）。
- 因此：**global 层的 `schemas()` 只包含"全局注册"的工具**。用它数工具数量会得到 1（只有自己注册的那个）——这是正确行为，不是故障。
- 结论：**要注册工具就用 `ctx.tools.register` 的全局层**（ds-bot 就是这样，实测可用）；**不要**靠 `schemas()` 的数量推断工具是否生效。

### 2.3 可选依赖的写法（✅ 已证实，本仓库已在用）

不要为了 `tools` 写顶层 `inject`，否则没装 tool 服务的极简宿主会直接启动失败：

```js
ctx.inject(['tools'], async (child) => {          // 只有服务可用时才跑
  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    if (typeof defineTool !== 'function') return
    child.tools.register(defineTool({ /* ... */ }))
  } catch (error) {
    ctx.logger?.('tools')?.warn?.(`tool registration skipped: ${error}`)
  }
})
```

本仓库 `src\index.js:217-227` 就是这么做的（动态 `import` + 判空 + try/catch），**保持现状**。

---

## 3. Cordis 生命周期：`ctx.inject` / `ctx.effect` / 异步 `apply`

### 3.1 `ctx.inject(deps, cb)` 的真实语义（✅ 已证实）

`$PKG\cordis\src\registry.ts:300-302`：

```js
inject(inject, callback) {
  return this.plugin({ inject, apply: callback, name: callback.name })
}
```

文档注释（`registry.ts:166-176`）明确两点：

1. 它是一颗**子 fiber**：`await ctx.inject([...], cb)` 会等这次加载结束；错误会 reject 到调用方（所以 `try/catch` 能兜住）。
2. **依赖服务发生变化时，回调会被卸载并重新执行**——回调里必须写成可重入（不要假设只跑一次）。

推论（✅）：`ctx.inject` 是**没有"可选"语义**的——依赖永不到达时子 fiber 永远 `PENDING`，但只要父插件的 `apply` 已经返回，**父 entry 仍然是 ACTIVE**，boot 不会因此失败。这正是「可选集成」的正确做法。

### 3.2 `ctx.effect(body, label)`（✅ 已证实）

`$PKG\cordis\src\fiber.ts:402-418`：

```js
ctx.effect(() => {
  const timer = setInterval(tick, 5000)
  return () => clearInterval(timer)          // 同步 disposer
}, 'dsh-easy-sync.poller')

ctx.effect(async () => {                      // 异步 body 也支持
  const handle = await openSomething()
  return () => handle.close()                 // 可返回 Promise<disposer>
}, 'dsh-easy-sync.watch')
```

- body **立即执行**；返回的 disposer 在 `fiber` 卸载时**逆序**执行；返回的 disposer 本身调用两次是 no-op。
- 在已 dispose 的 fiber 上调用会抛 `CordisError('INACTIVE_EFFECT')`。
- 非法的 body 返回值 → `TypeError`。
- 本仓库 `src\index.js:195`、`:321` 的用法正确（定时器/轮询清理）。

### 3.3 异步 `apply` **会被 boot 等待**（✅ 已证实，源码 + 实测）

链路：`Entry._start` → `registry.plugin(...)` → **`await fiber.await()`**（`$PKG\cordis-plugin-loader\src\config\entry.ts:291-302`）→ `EntryTree.await()` 等整棵树（`config\tree.ts:46-64`）→ `boot()` 在「整棵树 settle 之后」才返回（`$PKG\dsh-app-boot\lib\index.js:1525-1547`），再跑 `assertEntriesActivated`。

**实测证据**：探针插件 A 的 `apply` 是 async，体内 `await sleep(1500)`；`dsh web` 的 `dsh web: http://...` URL 行在 1500ms 之后才打印，且 boot 总耗时 ~4–6s。`$PKG\dsh-web-app\lib\index.js` 的收尾逻辑也是 `connectionCtx.get('loader')?.await()` 之后才打印 URL。

⚠️ 但要注意「等待」的代价：**一个慢的 async apply 会拖慢整个 GUI 启动**（桌面端用户感知为"卡住"）。本插件的策略应当反过来：

- 启动同步阶段（fs-only，几十毫秒）→ 放在 `apply` 同步体里（本仓库 `src\index.js:58-76` 的 `runStartupSync()` 就是）。
- 任何 IO 密集/可能慢的事情 → `void ctx.inject(...)` / `ctx.effect(...)` 里异步做，**不要 await 到 apply 的返回值里**。

### 3.4 兄弟条目是**并发**挂载的（✅ 已证实，源码 + 实测）

`$PKG\cordis-plugin-loader\src\config\group.ts:59-106`：`update()` 用 `Promise.allSettled(config.map(create))` **同时**启动所有兄弟条目。

- 实测：探针 `probe-order2` 的同步 `apply` 在 `probe-order` 的 async body 完成前就进入（`earlier plugin asyncDone = false`）。
- 「我把插件插在最后，所以它最后跑」是**错**的；只有「数组顺序」和「同一 entry 内的 await」有意义。
- 反例栈：一个故意 throw 的插件导致整棵树回滚，错误栈里出现 `at async Promise.allSettled (index 152)`——153 个顶层条目同时在起。

### 3.5 失败语义：**插件抛错 = 整个 GUI 起不来**（✅ 已证实，实测）

- `apply` 里同步/异步抛错 → 树回滚 → 进程退出码 1，错误形如：
  ```
  Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to apply loader entry probe-throw (dsh-probe-throw): probe-throw: deliberate apply failure
  ```
- 顶层 `export const inject` 不满足 → 该 entry 永远 PENDING → boot 失败：
  ```
  Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
  dsh-probe-pending: pending (waiting for service: definitelyNotAService)
  ```
  （源码：`$PKG\dsh-app-boot\lib\index.js:1483-1493`，`failures.push(\`${name}: pending (waiting for ${subject}: ...)\`)`，然后 throw）

**因此本插件的铁律**（本仓库 `src\index.js` 已经遵守，继续保持）：

1. `apply` 的同步体**绝不 throw**：外层套 `try/catch`，失败只记日志。
2. 一切可能失败的外部集成放进 `ctx.inject(...)` + 内层 `try/catch`（`src\index.js:82-119`、`:217-233`）。
3. 永远不要把「可能不存在的服务」写进顶层 `export const inject`。

---

## 4. 会话服务 `ctx.sessions` 与事件

### 4.1 `SessionStore` 能力面（✅ 已证实，`$PKG\dsh-session\lib\types\index.d.ts:330-445`）

| 方法 | 说明 |
| --- | --- |
| `create(id?, options?)` | 创建并**立即**进入 store + announce（`session/created`）；`id` 省略时铸 `session-<n>` |
| `prepare(id?, options?)` / `enter(session)` / `announce(session)` | 组合式创建事务（把 session 生命周期并进一个 `ctx.effect`，避免兄弟 effect 竞争） |
| `flush(session)` | **唯一的 flush 入口**，走 `session/flush` 并行事件，返回「是否有 durability listener 参与」 |
| `get(id)` / `list()` | **仅 live** 会话；`list()` 是创建顺序 |
| `fork(...)` | 从 live 源按稳定前缀 fork 子会话 |

关键点：`sessions.get/list` **只包含本次进程内 live 的会话**，磁盘上的历史会话它看不见。要枚举「可恢复的会话」必须用 §4.4 的接口。

### 4.2 `SessionHeader`（✅ 已证实，`$PKG\dsh-session\lib\types\types.d.ts:58-123`）

```ts
interface SessionHeader {
  readonly version: typeof SESSION_FORMAT_VERSION   // 当前 3
  readonly id: SessionId
  readonly createdAt: number                        // epoch ms
  readonly cwd?: string                             // 绝对路径，但**可能缺省**、且不保证 realpath 形式
  readonly parentSession?: SessionId
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```

- `cwd` 是**可选**的（老日志/子代理会话可能没有）→ 没有 cwd 的会话**无法**被 attach（见 §5.2）。
- 实测：`meta: { cwd: 'C:/Users/Seint/.../probe-ws-1' }` 存进 header 的就是这个正斜杠形式，**不是** realpath。所以 attach 内部才要做 `realpath` 比较。

### 4.3 四个事件（✅ 已证实，`$PKG\dsh-session\lib\types\index.d.ts:28-72`）

| 事件 | 模式 | 语义 / 约束 |
| --- | --- | --- |
| `session/created` | `emit`（同步） | **同步抛错 = 否决创建并回滚**；返回 Promise 的 reject 只记日志、无法否决；派发中请求 detach 会延后 |
| `session/disposed` | `emit` | 每个已 announce 的会话离开 store 时恰好一次（含发布回滚）；**listener 失败被记录并吞掉** |
| `session/event` | `emit` | **post-commit、fire-and-forget**：日志已落 append，回调后跑；observer 失败被记录并吞，不影响已提交的 append |
| `session/flush` | **`parallel`（被 await）** | durability checkpoint：所有 listener 并发跑、**调用方等全部结束**；任一 listener 抛错 → `ctx.sessions.flush()` 抛 `AggregateError` |

实现侧证据：`$PKG\cordis\src\events.ts:183-196` —— `parallel` = `Promise.allSettled` 后抛 `AggregateError`；`emit` = 同步 `.map(cb => cb(...args))`（同步 throw 会直达 emit 调用方）。

**对本插件的直接含义**（本仓库 `src\index.js:187-189` 的三处 `ctx.on` 已符合）：

- `session/event` / `session/flush` 里**只做调度**（`schedule()` 塞 debounce），绝不 await 长时间 IO：
  - `session/flush` 会**阻塞 flushes/关闭/落盘检查点**，在里面 await 大文件归档会拖死 shutdown。
  - `session/event` 是热路径，每条事件都会进来一次。
- listener 内部必须 `try/catch`（尤其 `session/flush`：抛错会让整个 checkpoint 报错）。
- **不要**监听 `session/created` 并抛错（会把别人的创建打回去）；本插件不监听它是正确的。

### 4.4 枚举/读取「非 live 的历史会话」（✅ 已证实）

三个入口，按用途选：

```js
// 1) 轻量：只要 header 快照（stat/list 语义，不读事件日志、不拿写所有权）
const snapshots = await ctx.sessionPersistence.list()
for (const snapshot of snapshots) {
  snapshot.header.id, snapshot.header.cwd, snapshot.revision
}
const one = await ctx.sessionPersistence.stat(id)   // undefined = 不存在

// 2) 全量：live 优先的统一语料，带排序/过滤/谱系
const records = await ctx.sessionQuery.listSessions()          // newest-first
const log     = await ctx.sessionQuery.readSession(id)         // 完整 header + 事件日志（不使其 live）
const lease   = await ctx.sessionQuery.observeSession(id)      // 观察 lease

// 3) 列出某会话的全部原始事件
const events = await ctx.sessionQuery.listEvents(id)
```

- `$PKG\dsh-session-persistence\lib\types\index.d.ts:99-155`：`create / open / flush / stat / list`；`list`/`stat` 是快照语义，注释里写明「empty created session 只有 `handle.flush()` 之后才会成为可持久列出」。
- `$PKG\dsh-session-query\lib\types\index.d.ts:63-143`：`listSessions`、`readSession`、`observeSession`、`listEvents`、`filterSessions`、`traceSession`。
- 本仓库若只是「按目录扫文件」，继续用自己的 `src\session-file.js` 也没问题；**但要把恢复出来的会话挂到 UI 的工作区下，仍必须走 §5 的 attach**。

### 4.5 `sessionPersistence.flush()` 到底是什么（✅ 已证实）

`$PKG\dsh-session-persistence\lib\types\index.d.ts:123-134`：

> Flush **every active write handle** owned by this service instance in one durability barrier … A handle closed concurrently counts as flushed … `@throws {AggregateError}` naming each session whose flush failed.

- 它是**服务级、全体句柄**的 durability barrier，**不是**「按 session flush」。
- 「按 session」是 `ctx.sessions.flush(session)`（§4.1 / §4.3）。
- 句柄级是 `handle.flush()`（`$PKG\dsh-session-persistence\lib\types\handle.d.ts`）。
- ⚠️ 别在插件里随手调 `sessionPersistence.flush()`：它会把所有会话的写句柄都刷一遍（还有可能拖慢别人）。用 `ctx.sessions.flush(session)`。

---

## 5. 工作区：`workspaceRegistry` 与 `attachSession`（本项目的核心）

### 5.1 服务与能力面（✅ 已证实）

- `$PKG\dsh-workspace\lib\types\index.d.ts:47-54`：`static inject` + `[Service.init]`；`Service.init` 里做「打开域 → 重建 canonical-cwd header 索引 → 一次性历史 bootstrap」。**服务 ACTIVE 之前，任何 `ctx.get('workspaceRegistry')` 都是 undefined**。
- registry 方法（同文件 `:79-139`）：
  ```js
  ctx.workspaceRegistry.create(path, title?)   // 返回 Workspace（path 为 realpath 规范化结果）
  ctx.workspaceRegistry.resolveByPath(path)    // 不创建、不修改；目录不存在则 reject
  ctx.workspaceRegistry.get(id) / list()       // list() 同步、按持久化顺序、不做 IO
  ctx.workspaceRegistry.delete(id) / insertBefore(id, beforeId?) / archiveSession(id)
  ```
- **`attachSession` 不在 registry 上**，在 **`Workspace` 实体**上（`$PKG\dsh-workspace\lib\types\types.d.ts` 的 `Workspace` 接口；实现 `lib\index.js:111-129`）：

```js
const workspace = ctx.workspaceRegistry.list().find((w) => w.path === workspacePath)
if (workspace !== undefined) await workspace.attachSession(sessionId)   // id 幂等
```

### 5.2 `attachSession` 的完整校验链（✅ 已证实，源码 + 实测）

`$PKG\dsh-workspace\lib\index.js:111-129` + `:748-761`（`readSessionHeader`）：

1. 若 `record.sessionIds` 里**没有**这个 id：
   1. `readSessionHeader(id)`：live 会话优先（用内存 header）→ header 缓存 → 否则触发一次 `sessionPersistence.list()` 重建缓存；都没有 → 抛 `cannot validate session '<id>': session persistence holds no such session`。
   2. `header.cwd === undefined` → 抛 `its stored header carries no cwd to validate against`。
   3. `realpathNormalize(header.cwd)` 失败 → 抛 `its cwd '<cwd>' does not resolve, so it cannot be validated`。
   4. `stat(cwd)` 不是目录 → 抛 `its cwd '<cwd>' is not a directory`。
   5. **`cwd !== record.path` → 抛 `its cwd resolves to '<other>'`**（字符串严格相等，见 §5.5 的坑）。
   6. `rememberSessionPath(id, cwd)`：把 id 记进内存索引，**这是 `sessionIds` getter 能看见它的前提**。
2. `mutate(...)`：把 id **前插**到 `sessionIds`，并写 storage（`$PKG\dsh-workspace\lib\index.js:173-191`）。

实测输出（探针 B，隔离 home）：

```
sessionIds.afterCreate            = []
attach 历史会话(sessionPersistence.create + flush + close) 后:
  workspace.sessionIds.includes(id) = true
  registry.list()[0].sessionIds     = ["session-probe-1792414003431"]
rejections:
  cwd 不匹配  → cannot attach session 'session-2' to workspace '<path>': its cwd resolves to '<other>'
  无 cwd      → ...: its stored header carries no cwd to validate against
  未知 id     → cannot validate session 'session-does-not-exist': session persistence holds no such session
detachSession 后 → 立即从 sessionIds 消失
最终顺序（前插）→ ["session-probe-1792414003431","session-1"]
```

### 5.3 `sessionIds` getter 的过滤逻辑（✅ 已证实）

```js
get sessionIds() {                                            // lib\index.js:102-104
  return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path)
}
```

- `host.sessionPath(id)` 来自启动时建立的 header 索引 + `rememberSessionPath`（`lib\index.js:325-330`、`:709-727`）。
- 也就是说：**持久化记录里"有"这个 id，不代表 UI 里"看得见"**。看不见的 id 会在**下一次任何 mutation** 时被 durable prune 掉（`mutate()` 的 `sessionIds.filter(...)` + `table.update`，`:173-191`）。
- 每次 mutation 都会更新 `updatedAt`，并触发 storage 的 `workspaces` 表变更事件。

### 5.4 即时可见性与持久化（✅ 已证实，探针 B）

- `attachSession` 返回时：`workspace.sessionIds` **立即**包含该 id（内存 record 已换新），storage 也已写入（`$TMPHOME\storages\workspace.json` 里能立刻看到）。
- 但 **UI 那张表不是直接读这个数组**：`WorkspaceController` 在**构造时**取一次 `workspaceRegistry.list()` 作为 baseline（`$PKG\dsh-api-workspace-controller\lib\index.js:42-55`、`:657-666`），之后靠 `domain/changed` 增量推送。
  - ⚠️ 已证实但容易踩：增量推送用的是**存储里的原始 record**（`changedWorkspaceView(change.key, change.value)`），而 baseline 用的是**过滤后的实体**（`workspaceView(workspace)` 走 `sessionIds` getter）。两者可能不一致 → 客户端可能短暂看到"未经过滤"的 id。
  - 结论：**只要 attach 成功，下一次 `workspaces` 表变更就会把新列表推到 UI**；但如果你在 UI 已经连上之后才 attach 一批会话，**不要**假设前端会自己重排/去重，服务端顺序（前插）就是最终顺序。

### 5.5 ⚠️ Windows 上的坑（读码推断 + 部分实测，标 **⚠️ 未证实** 的地方已注明）

1. **路径必须字节级相等**：`attachSession` 用 `cwd !== this.record.path`（严格字符串比较，`lib\index.js:122`）。`record.path` 是 `create` 时 `realpath` 化的结果；`header.cwd` 也要经 `realpathNormalize`。Windows 大小写、短文件名（8.3）、`\\?\` 前缀、UNC 路径都可能让两者不相等。
   - 建议：**永远用 `workspace.path`（registry 返回的实体字段）去比较/写盘**，不要自己拼路径。
   - 已实测：`C:/Users/Seint/...\probe-ws-1`（正斜杠）与 `create(path)` 产生的 `record.path` 经过 realpath 后一致，attach 成功 ✅。
2. **目录被移动/删除后，已 attach 的会话会被静默剪掉**：`realpath` 失败 → `sessionPaths` 没有该 id → getter 过滤掉 → 下次 mutation prune。`reportFilteredCandidates()` 会 `ctx.logger.warn(...)` 提示，但**没有导出事件**（`lib\index.js:737-747`）。
   - 建议：本插件自己的存档恢复逻辑**不要**依赖 DSH 的 workspace 记录做唯一真源；应以工作区目录里的存档文件为准，每次启动重建。
3. **`attachSession` 对"已在 record 里但索引缺失"的 id 是空操作**（`:112` 的 `if (!includes)` 直接跳过 → 不走 `rememberSessionPath`）→ 这种"僵尸 id"**无法通过再 attach 一次救回来**，只会在下次 mutation 被剪掉。
   - 实测验证：重启后 `visibleSessionIds` 只剩持久化会话；live-only 的 `session-1` 仍在**存储记录**里但**不在** getter 结果里，随后一次 attach 把它剪掉了。

### 5.6 官方调用方（✅ 已证实，可对照）

`$PKG\dsh-api-session-controller\lib\index.js:571-599`：`SessionCommandController.create` 里先 `agents.ensureSession(...)` 再 `await workspace.attachSession(sessionId)`，失败包成 `session/workspace-attach-failed`。fork 路径在 `:715-722`。

→ 说明「创建会话后立刻 attach」是**官方认可的时序**；我们的「恢复会话后 attach」是同一模式的离线版本，安全。

---

## 6. 日志：`ctx.logger` 与「失败不能阻断启动」

### 6.1 `ctx.logger` 能做什么（✅ 已证实）

```js
const log = ctx.logger('dsh-easy-sync')
log.info('restored %d session(s)', n)
log.warn('...'); log.error('...'); log.debug('...')
ctx.logger.buffer          // 内存 ring buffer（供 UI/诊断读取）
```

- 实现：`$PKG\cordis\src\logger.ts`（`LoggerService`、`ctx.logger(name)`、`.exporter()`、`buffer`）。
- 命名 logger 用 `ctx.logger('name')`；不带参就是 `ctx.logger.warn(...)` 的形式。

### 6.2 ⚠️ 关键现实：**安装树里没有任何把日志写到 stderr 或文件的 exporter**

- ✅ 已证实：全量搜索已安装的 `@deepseek-ai/*` 包，`.exporter(` 的注册点**只有** `cordis\lib\index.js:598` 一处（默认内存 buffer exporter）。
- ✅ 实测：探针里 `ctx.logger('probe').info(...)` / `.warn(...)` **一行都没出现在 stdout/stderr**；loader 的 `showLog` 又由 `tree.enableLogs` 控制（默认关闭，`$PKG\cordis-plugin-loader\src\index.ts:172`）。
- ⚠️ 未证实：Electron 桌面宿主**可能**自己装了 exporter 把 `ctx.logger.buffer` 转发到日志面板/文件（本机 `resources\app.asar` 182MB，未解析）。
- 结论与建议（本仓库 `src\index.js:587-610` 的 `createLogger` 方向正确）：
  1. 需要**人肉可见**的诊断 → 写 `process.stderr` / 自己的日志文件；`ctx.logger` 只当"给宿主/UI 看"的通道。
  2. 写日志的代码自身**绝不允许抛错**（包一层 try/catch，吞掉）。
  3. 不要把日志写在 hot path（`session/event`）里做同步 fs 写——用缓冲 + 定时 flush。

### 6.3 「失败不能阻断启动」清单（✅ 结合 §3.5 的实测）

| 位置 | 规则 |
| --- | --- |
| 顶层 `export const inject` | 只放**一定存在**的服务（本插件用 `[]`，即不声明） |
| `apply` 同步体 | 整体 `try/catch`；失败 `return`（entry 保持 ACTIVE） |
| 任何 await 的外部初始化 | 放进 `ctx.inject(...)` + 内层 `try/catch`（`src\index.js:82-119`） |
| `ctx.on(...)` 回调 | 内部 `try/catch`；`session/flush` 里禁止长时间 await |
| 定时器/轮询 | `ctx.effect` 返回 disposer；`unref()` 避免拖住进程退出（`src\index.js:144`、`:321`） |
| 可选包（`@deepseek-ai/dsh-tools`） | 动态 `import()` + 判空 + catch（`src\index.js:217-227`） |

---

## 7. 安装与隔离测试环境（✅ 全部实测）

### 7.1 `dsh plugin --profile <name> add <pkg|path>`（✅ 已证实，读码；本机未对真实 profile 执行）

`$DSH\lib\plugin-Ddi42qoW.js`：

1. profile 不存在 → 先按模板初始化（web 模板 = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`，`$PKG\dsh-app-boot\lib\index.js:328-349`）。
2. 在**profile 目录**里 `spawnSync('pnpm', args, { cwd: profileDir, stdio: 'inherit', shell: win32 })` → 参数**原样转发**给 pnpm。
3. 相对路径 spec 会锚定到**调用者 cwd**（所以在 `$REPO` 下 `add .` 是可行的）。
4. 成功后 `reconcilePlugins`：把声明了 `dsh.bundle.patch` 的依赖写进 `dsh.profile.bundles`；没声明的告警 `declares no dsh.bundle`。
5. `pnpm` 不在 PATH → 退出码 127。

**限制**：`dsh plugin` / `dsh --profile` **对 `desktop` profile 一律拒绝**（`$DSH\lib\bin.js:28-30`、`:92`、`:109`）：

```powershell
PS> dsh --profile desktop --help
error: profile "desktop" is managed exclusively by the Electron application
# exit=1（实测）
```

→ 桌面版只能由 Electron 的插件管理器安装（证据：`$HOME_DSH\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log` 里有 pnpm 安装记录，且 `desktop\package.json` 的 `dependencies` 里有 `ds-bot`）。
⚠️ 未证实：`ds-bot` **既不在** `dsh.profile.bundles`、**也不在** `desktop\cordis.patch.yml` 里，却确实生效了 → Electron 端一定在合成 patch 时额外注入了行。**不要**假设 CLI 的合成规则等于桌面端的合成规则；测试请用隔离 web profile。

### 7.2 隔离 `DSH_HOME`（✅ 已证实，这是本次所有实验的基础）

```powershell
$root = 'C:\Users\Seint\Desktop\dsh-easy-sync'
$env:DSH_HOME = "$root\.tmp\dshhome"          # 每次命令都显式设置，不要依赖父环境
$env:DSH_HOME                                  # C:\Users\Seint\Desktop\dsh-easy-sync\.tmp\dshhome

# 1) 随便跑一个命令就会自动初始化（含 profiles\web 模板、profiles\node_modules 自愈）
dsh web --help

# 2) 看合成后的完整条目树（540 行），含 layer 来源注释
dsh --profile web --dump-config
dsh --profile web --dump-default-config

# 3) 真启动，随机端口，不弹浏览器
node "C:\Users\Seint\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 0 --no-open
# 输出：dsh web: http://127.0.0.1:9348/?token=...
```

实测结论：

- 隔离 home 会被**自动补齐**：`.anonymous-user-id`、`profiles\web\{package.json,cordis.patch.yml,pnpm-workspace.yaml}`、以及 `profiles\node_modules` 下的 **240 个 junction**（指向安装树内的包）。
- **不需要手建 junction**（我一开始建了，后来证明多余；`healProfilesModuleFallback` 会自愈，`$PKG\dsh-app-boot\lib\index.js:657-676`、`:712-746`）。
- 多次启动拿到过 `127.0.0.1:9348 / 4569 / 8965 / 9009 / 10371`（`--port 0` = OS 分配）。**没有碰过** 8946 / 10958（用户/桌面在用的端口）。
- `--dump-config` 的 layer 注释形如：
  ```yaml
  # == @deepseek-ai/dsh-base
  # == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
  # == @deepseek-ai/dsh-web-app
  ```
  注意 `!!js` 表达式**不会**被求值（原样打印，例如 `disabled: !!js process.platform === 'win32'`）。

### 7.3 手工投放插件（不装 pnpm 也能测，✅ 已证实）

```powershell
$prof = "$env:DSH_HOME\profiles\web"
New-Item -ItemType Directory -Force "$prof\node_modules\my-plugin" | Out-Null
# 把 package.json + index.js 放进去（普通目录即可，不需要 pnpm 链接）

# 在 profile 的 patch 层里挂上
@'
- insert:
    - id: my-plugin
      name: my-plugin
'@ | Set-Content "$prof\cordis.patch.yml" -Encoding utf8
```

- 解析路径：`profiles\<name>\node_modules\<pkg>` → 找不到时会走到 `profiles\node_modules\@deepseek-ai\*`（240 个 junction）→ 所以 `import '@deepseek-ai/dsh-tools'` 能解析，且**与宿主是同一个模块实例**（junction 指向同一 realpath）。这一点很重要：`Service`/`symbols` 靠实例同一性，重复实例会出诡异问题。
- 实测：这样挂的探针插件 3 秒内被加载，`ctx.inject(['tools'])` 正常触发。
- ⚠️ 如果 profile 的 patch 写错了（比如引用了不存在的包），**整个 profile 起不来**。测试时保留一份"已知能启动"的 patch 备份。

### 7.4 `dsh web` 的 CLI 参数（✅ 已证实，`dsh web --help` + `$PKG\dsh-web-app\lib\startup.js`）

```
--host <host>                 默认 127.0.0.1；显式传 0.0.0.0 会被拒绝（安全策略）
--port <port>                 默认 3080；0 = 由 OS 分配
--no-open                     不自动打开浏览器
--trusted-host <authority...> 额外信任的 Host 头
-h, --help
```

`--help` 与非法参数都会走「不提供 `webStartup` 服务」的分支（`$PKG\dsh-web-app\lib\startup.js:29-33` 的注释原文：*on rejection (and on `--help`) nothing is provided*），于是注入 `webStartup` 的 `webserver` 行永远 PENDING、**不会绑定端口**。实测 `dsh web --help` 约 3.0s 退出 0 —— 这是个很好用的「只解析参数、不起服务」的探针。

---

## 8. 加载顺序与 workspace 初始化时机

### 8.1 patch layer 的合成顺序（✅ 已证实）

`$DSH\lib\profile-boot-*.js`（`runProfile`）+ `$PKG\dsh-app-boot\lib\index.js:886-909`：

```
bundles（按 dsh.profile.bundles 数组顺序，逐个应用其 cordis.patch.yml）
  → $DSH_HOME/profiles/<name>/cordis.patch.yml      （用户层）
  → $DSH_HOME/cordis.patch.yml                      （home 层）
  → --patch <path>（可重复，最后追加）
  → telemetry patch（内部）
```

- `insert` 的语义（`$PKG\dsh-app-boot\lib\index.js:59-108`）：
  - **带 `id`** → 插到目标 group 的 config **末尾**；
  - **不带 `id`** → `data.push(...insert)`，**追加到全局末尾**。
  - 本仓库 `cordis.patch.yml` 用的是「不带 id 的 insert」→ 条目排在**最后一个**（实测：合成树的最后一行就是这种 insert 的产物 `agent-presets`）。
- ⚠️ 「排在最后」**只影响数组顺序**，不保证 apply 完成顺序（§3.4 并发）。

### 8.2 那"顺序"还有什么用？（✅ 已证实）

1. **服务可用性**：cordis 的 DI 保证「provider 的 fiber ACTIVE 之后，依赖方才会被唤醒」。所以**跨插件依赖只应通过 `ctx.inject` 表达**，不要靠插入位置。
   - 实测：探针在 `apply` 里直接 `ctx.get('webServer')` / `ctx.get('workspaceRegistry')` 都是 `undefined`（因为没声明 inject，执行得太早）；只要 `ctx.inject(['workspaceRegistry'], ...)`，回调一定发生在 registry 的 `[Service.init]` 之后。
2. **同 id 的配置覆盖**：`- id: xxx` + `config:` 是"改已有行"的唯一方式（顺序在前面的层先写，后面的层覆盖）。
3. **禁用**：`disabled: true`（web 层就是这样关掉顶层 tool 行的，见 §2.2）。

### 8.3 workspace 初始化时序（✅ 已证实）

```
workspace 行（web patch 第 75 行）→ WorkspaceRegistry 构造 → [Service.init]:
   打开 storage domain → 重建 header 索引（realpath+stat 每个已知 header）→ 一次性历史 bootstrap
   → fiber ACTIVE
→ WorkspaceController（static inject = ['typert','workspaceRegistry']）构造
   → new WorkspaceFeed(ctx) → 立刻 workspaceRegistry.list() 作为 baseline
→ 之后只靠 domain/changed 增量
```

对本插件的含义：

- **启动恢复要在 `apply` 里尽快做**（fs-only，不依赖任何服务）：这样"会话文件"在 workspace 索引建立**之前**就位，registry 的 bootstrap 扫描能直接看到它们。
- **attach 必须等到 `workspaceRegistry` ACTIVE**（用 `ctx.inject(['workspaceRegistry'], ...)`），不能早、也不能"顺便在 apply 里 `ctx.get('workspaceRegistry')`"。
- 如果恢复发生得比 registry 的 bootstrap 晚，DSH 不会自动把新会话挂到工作区——必须自己 attach（这也是本项目存在的意义）。
- ⚠️ 未证实：registry bootstrap 的「一次性历史 bootstrap」是否会顺带把 `sessionIds` 为空的 workspace 自动填上已有会话。从 `attachSession` 是唯一写入路径（`mutate` 只被 attach/detach/insert/setTitle/delete 调用）来看，**不会**。但为稳妥，仍建议本插件显式 attach（幂等，重复 attach 是空操作）。

---

## 9. 本次实测的探针与原始证据

所有实验都在隔离 home `$TMPHOME` 下，探针源码留在 `$REPO\.tmp\dshhome\profiles\web\node_modules\`，日志在 `$REPO\.tmp\logs\`。

| 探针 | 目的 | 关键输出 |
| --- | --- | --- |
| `A`（probe-order / probe-order2） | 异步 apply 是否被等待；兄弟是否并发 | `[probe-order +171ms] A: sync apply entered; fiber state = 1`、`[probe-order2] sync apply entered; earlier plugin asyncDone = false`、`[probe-order +3323ms] A: async apply body settled after 1500ms` |
| `throw` | apply 抛错会怎样 | 整棵树回滚 + 进程 exit 1（错误文本见 §3.5） |
| `pending` | 顶层 inject 不满足会怎样 | `dsh: 1 entry did not activate` + `pending (waiting for service: definitelyNotAService)`，exit 1 |
| `B`（probe-ws） | attachSession 的即时可见性/持久化/拒绝路径/重启后过滤 | 见 §5.2 的实测输出；结果文件 `$REPO\.tmp\probe-b-result.json` |
| `C`（probe-tool） | `defineTool` + `ctx.tools.register` + logger 可见性 | `[probe-tool] defineTool + register worked; disposer type = function`；`visible global tool count = 1`；`ctx.logger` 两行均未出现在 stdout/stderr |

补充：`$REPO\.tmp\asar-list.mjs` 是尝试解析 `app.asar` 头部的只读脚本（182MB，未跑通，**与结论无关**，可以删）。

---

## 10. 风险清单（按严重度）

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | 顶层 `export const inject` 写错 | **整个 GUI 起不来**（不是本插件失败） | 顶层不声明；全部用 `apply` 内 `ctx.inject` |
| 2 | `apply` 抛错 | 同上 | 外层 try/catch + `return` |
| 3 | 假设"我最后加载" | 兄弟并发，时序不成立 | 只用 DI 表达依赖 |
| 4 | attach 一个"persistence 里没有 header"的 live-only 会话 | 重启后记录被静默剪掉，UI 丢会话 | 只 attach **已持久化**（`handle.flush()` 过）的会话；或在 attach 前 `ctx.sessions.flush(session)` |
| 5 | 工作区路径与 `header.cwd` realpath 不字节相等（Windows 大小写/短路径/UNC） | attach 抛错，会话进不了工作区 | 用 `workspace.path` 作为唯一比较基准；必要时对 header.cwd 先 realpath |
| 6 | 工作区目录被移动/删除 | 已 attach 的成员被静默 prune（只有一条 `logger.warn`） | 以工作区内的存档文件为真源，每次启动重建；不要依赖 DSH 记录 |
| 7 | `session/event` / `session/flush` 里做重活 | 拖慢每条消息 / 阻塞 durability checkpoint 与关闭 | 只做 debounce 调度（现有实现正确） |
| 8 | `ctx.logger` 看不到 | 线上排障无据 | 自带 stderr/文件 logger（现有 fallback 正确） |
| 9 | desktop profile 不可用 CLI 管理 | 无法脚本化安装到桌面版 | 用隔离 web profile 做验证；桌面版走 Electron 插件管理器 |
| 10 | 版本错位（launcher rc.1 / 包 rc.2） | 行号漂移、API 微调 | 只依赖本文标注的稳定面；升级后重跑 `--dump-config` 对比 |
| 11 | 误读 `ctx.tools.schemas()` | 误判工具没生效 | 见 §2.2，用"实际调用"验证而不是数数量 |

---

## 11. 给实现的三条硬结论

1. **插件壳**：`export const name` + `apply(ctx, config)`；**不写顶层 `inject`**；`apply` 同步体只做 fs-only 的启动恢复，且整体 try/catch；所有服务集成走 `ctx.inject([...], child => { try/catch })`。
2. **恢复 → 可见**：恢复出的会话必须是**已持久化**的（有 header、cwd 可 realpath、与 workspace.path 严格相等），然后在 `ctx.inject(['workspaceRegistry'])` 里对目标 `Workspace` 实体调用 `attachSession(id)`（前插、幂等、立即写 `storages\workspace.json`）。
3. **绝不拖慢/毒化宿主**：`session/event`/`session/flush` 只做调度；不监听 `session/created`（不要否决别人的创建）；异步初始化不要 await 进 `apply` 的返回路径；日志自带出口。

---

## 12. 附：桌面版 0.2.x 的客户端插件面（本仓库 client.js 的依据）

> 依据本机桌面运行时 0.2.1-rc.2（`app.asar` 内 55 个 `dsh-client-ui-*` 包），与
> 0.1.5 CLI 的 web 侧不同；0.1.5 没有下文这些会话菜单 slot。

### 12.1 双面包声明

```json
"exports": { ".": "./src/index.js", "./client": "./client.js" },
"dsh": { "client": { "platform": "web" } }
```

- `platform` 必填字符串；`inject` / `external` / `immediately` 可选。
- 客户端产物由 `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { ...; return module.exports } })`
  包装；factory 延迟物化，`require` 是同步的、只能取已注册模块或静态种子
  （`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等）。
- 手写该包装不需要构建步骤；本仓库 `client.js` 即是。
- 客户端 cordis 插件：`exports.apply(ctx)` + `exports.inject = ['slots','locale']`；
  `ctx.effect(() => ctx.locale.register(NS, { zh, en }), label)` 注册词典，
  `t = ctx.locale.bind(NS)`。

### 12.2 会话菜单扩展点（0.2.1）

| slot | owner props | hook context | 用途 |
| --- | --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `{ sessionId, displayTitle }` | `menuOpenState`（`[open, setOpen]`） | 会话 “…”/右键菜单行（list，order 500+ 排在内置项后） |
| `sidebar.workspaces.session.row.action` | 同上 | 无 | 会话行悬停按钮 |
| `sidebar.session.row.leading` / `.hover` | 会话行 | 无 | 行内前后缀 |

- 注册写法（list slot，`ctx.slots.inject` 等 slot 就绪后执行）：

```js
ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
  name: 'sidebar.workspaces.session.menu.item',
  id: 'my-plugin',
  order: 500,
  locale: NS,
}, Component))
```

- 组件收到 `sessionId`、`useMenuOpenState`（hook）与注入项；`MenuItemButton`
  来自 `@deepseek-ai/dsh-client-ui-primitives`，`onSelect` 里可 `setOpen(false)`。
- **工作区行菜单不可扩展**：0.2.1 源码注释明确只有 Rename/Delete，无 slot；
  不要试图通过替换侧边栏实现“设为同步工作区”。

### 12.3 宿主 HTTP 路由（给客户端调用）

0.2.1 的 `dsh-host-open-in-app` 是模板：

```js
export const inject = ['webServer', 'connection']
const reject = (req) => ctx.connection.requestRejection(req) // 401/403 则拒绝
ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), label)
```

- POST 必须校验 `content-type: application/json`、限制 body（64 KiB）；
  响应 `content-type: application/json; charset=utf-8` + `cache-control: no-store`。
- 本插件把这两个服务放在 `ctx.inject(['webServer','connection'], child => ...)`
  里，headless profile 永不注册路由；无 `connection` 时 fail closed。

### 12.4 版本差异速记

- 0.1.5 CLI：无 `sidebar.workspaces.session.menu.item`；`ctx.slots` 有
  `inject`/`register` 但未知 slot 不渲染——客户端半静默降级为空操作。
- 0.2.1 桌面：上述 slot 存在，会话菜单可用；添加 UI 后必须**完全重启** Electron。
- 两侧服务 API（`webServer.register`、`connection.requestRejection`）在 0.1.5 与
  0.2.1 实测一致，宿主路由可共用。
