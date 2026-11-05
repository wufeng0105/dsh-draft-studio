# v1.0.15 发布前审计

> 对象：`dsh-draft-studio` v1.0.15，git HEAD `91ef163`，工作区 clean。
> 只读审计；除本文件外未改任何文件；未跑真实模型调用。

## 标准加载

- `skill` 工具已加载 **`cordis-plugin-development`**（本次任务内加载成功，返回完整 skill 正文与 base directory）。
- 用 **`read`** 读取：
  - `references/host-plugin.md` —— 70 行（清单/显示元数据/图标/导出/安装观察）
  - `references/practices.md` —— 38 行（扩展点、稳定性、性能、UI 规则）
- 全程未用 shell/glob/grep/node 触碰 Skill 目录（已知 app.asar 限制，未重试）。
- 市场收录规则 `C:\Users\Administrator\Desktop\contributing.md` 亦以 `read` 读取（252 行），仅用于对齐「peerDependencies / engines 预发布」两条要求（`contributing.md:134,136`）。

## 八项检查

### 1. package.json 清单 —— PASS

- `dsh.bundle.patch` 存在：`package.json:29-37`（`"bundle": { "patch": "./cordis.patch.yml" }`），同时 `dsh.client.platform: "web"`、`immediately: true`。
- `files` 覆盖全部运行时文件：`package.json:18-28` 含 `index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`，另加 README/CHANGELOG/LICENSE/docs（第 4 项已用 `npm pack` 实测落地）。
- `private` 已移除：`git show 91ef163 -- package.json` 的输出含 `-"private": true,`，当前 `package.json:1-3` 无该字段。
- 补充：`exports` 覆盖 `.` / `./client` / `./locale/*.json` / `./icon`（`package.json:12-17`），与 `host-plugin.md:35` 的导出要求一致。

### 2. peerDependencies 是否可靠 —— PASS（附一条文档缺陷）

- 声明存在：`package.json:38-40` → `"peerDependencies": { "@deepseek-ai/schemastery": ">=3.0.0 || >=3.18.0-0 <4.0.0" }`；`node_modules`、`pnpm-lock.yaml` 均已删除（`Test-Path` 两者均 `False`）。
- 宿主确会提供：宿主运行时自身依赖该库（`app.asar/dsh/package.json:311` → `"@deepseek-ai/schemastery": "3.18.5"`）；同为 peer-only、无 `node_modules` 的已安装插件 `dsh-xdpool` 在本机 `Config.listConfigs` 返回 `status: "schema"`（Live 查询，entry `include:llm-xdpool`），证明 peer 方案在真实宿主上成立。DSH 生成的 profile 配置本身也关闭了 peer 自动安装（`app.asar` 内 `WORKSPACE_SETTINGS = "nodeLinker: hoisted\nautoInstallPeers: false\n"`），说明这是 DSH 的预期形态而非疏漏。
- 宿主不提供时的降级：`index.js:39-44` 的 `try { z = (await import(...)).default } catch { z = undefined }`，`index.js:122` `Config = z === undefined ? undefined : z.object({...})`。实测以普通 Node 从插件目录导入入口（无宿主运行时表）得到 `Config= undefined`、`apply= function` —— 模块不抛错、插件仍可装载；`readConfig` 对空 config 有全量默认值（`index.js:252-278`），改写链路不受影响，损失的是设置页（无 schema → 无设置命名空间）。**降级安全**。
- 缺陷：`index.js:23-28` 的 fact 3 仍写「declared as a normal dependency … Node resolves `@deepseek-ai/schemastery` from this package's own `node_modules`」——与当前 `peerDependencies` + 已删除 `node_modules` 相反（README:79 写的是「由宿主运行时提供」，与实现一致）。这是上一轮 H1 同类问题（注释与清单不一致）在本次改造后再次出现，方向相反。

### 3. engines.dsh 范围 —— PASS（三个指定版本），残留在范围外

实测（npm 自带 semver 7.8.6，`npx semver -r "<range>" <version>`）：

| 版本 | 结果 |
|---|---|
| `0.2.1-rc.5` | SATISFIES |
| `0.2.2-rc.1` | SATISFIES |
| `0.3.0` | excluded |

补充实测（同命令）：`0.2.1`、`0.2.2`、`0.2.2-rc.0`、`0.2.1-rc.6` 均 SATISFIES；`0.2.1-rc.4`、`0.3.0-rc.1`、`0.3.1`、`1.0.0` 均 excluded。
残留：`0.2.3-rc.0`、`0.2.4-rc.1`、`0.2.9-rc.3` 均 **excluded** —— SemVer 预发布规则按 `major.minor.patch` 元组生效，范围只给 `0.2.1`/`0.2.2` 两个元组加了预发布分支，宿主再往后发 rc（0.2.3-rc.x）时会再次显示不兼容。当前宿主为 `0.2.1-rc.5`（`app.asar/dsh/package.json:4`），不影响本次发布。

### 4. npm pack 内容 —— PASS

`npm pack --dry-run`（exit 0）输出 11 个文件：

```
CHANGELOG.md 16.6kB / LICENSE 1.1kB / README.md 5.5kB / client.js 80.7kB /
cordis.patch.yml 385B / docs/PROJECT-NOTES.md 6.7kB / icon.svg 373B /
index.js 43.7kB / locale/en.json 281B / locale/zh.json 254B / package.json 1.3kB
```

运行时必需文件齐全（index/client/patch/locale/icon/package.json），无 `node_modules`、无临时文件、无 `.git`；`OUTLINE.md` 与 `.gitattributes` 未进包，属有意排除，不影响安装。

### 5. locale 元数据真实性 —— PASS（附一处命名残留）

- `locale/en.json:2-5` / `locale/zh.json:2-5` 的 `meta.title`、`meta.description` 描述的是「原位改写草稿、不发送；四套可编辑预设；可选会话上下文；模型跟随或固定」。
- 对照代码：四套预设 + 每套一份完整提示词 → `index.js:128-134`（`promptGeneral/promptCode/promptWriting/promptTranslation`）、`client.js:1196-1210`（预设下拉 + `PromptEditor`）；上下文开关 → `client.js:1180-1194`；模型跟随/固定 + 固定模型下拉 + 思考强度 → `client.js:1212-1279`；`index.js:122-157` 共 15 个 Config 字段。描述未夸大、未虚构命令或数字。
- 残留：`client.js:1712` 的英文 `nav` 仍是 `'Prompt Refine'`，与 `meta.title: "Draft Studio"` 不一致（设置页导航会显示旧名）；`icon.svg:1` 的 `aria-label="Prompt Refine"` 同样未随改名更新。

### 6. cordis.patch.yml —— PASS

- `cordis.patch.yml:5-7`：`id: dsh-draft-studio`、`name: dsh-draft-studio`，与 `package.json:2` 的 `name` 完全一致。
- 当前 profile 中该 entry id 只有一行（`Config.listConfigs` 按 name 过滤返回 1 条），无重复；id 的全局唯一性无法在本机完全验证（跨 profile/市场不做全局 id 校验），标 **不确定**，但不构成上架阻断。

### 7. 代码合规（外部包引用 / CSS token）—— PASS

- 外部客户端包引用：`client.js` 只有 `const React = require('react')`（`client.js:51`）；全项目无 `require('@deepseek-ai/dsh-client` / `@deepseek-ai/dsh-*` 模块加载（`Select-String -Pattern "require\("` 仅命中该行）。符合 `practices.md:35`「不得 require Harness Client 包」。
- CSS：所有样式只引用 `--dsw-alias-*` 变量（共 15 个名字），并带字面色值兜底；无裸色值直接作为属性值（`#247bbf` / `rgba(...)` 只出现在 `var(...)` 的 fallback 位）。符合 `practices.md:34`「literal colors are for artwork only」的意图。
- 备注：`--dsw-alias-text-primary` / `--dsw-alias-danger` / `--dsw-alias-brand-soft` / `--dsw-alias-bg-secondary` 在本宿主资源里未命中（asar 文本检索 0 次；`Theme.listTokens` 两次 10s 超时，未取得权威清单），这些位置会走 fallback（`currentColor` 等），不破版，但主题一致性未权威验证 → 该子项标 **不确定**。

### 8. README 与实现一致性 —— PASS（抽查 3 条）

1. README:26「四态循环…运行中显示已用秒数」→ `client.js:1546-1580`：忙碌标签在渲染体内读 `Date.now()`，并显式声明「NO useMemo for the busy label」，每秒 tick 会真正更新；四态由 `data-state` 输出（`client.js:1594-1617`）。属实。
2. README:30-31「结果回来时草稿已变则保留待重试；点重试把保留结果放回当前输入框」→ `client.js:1414-1418`：parked 分支以 `draftRef.current`/`revRef.current`（当前草稿与当前 revision）调 `deliver`，不再重放旧 rev。属实。
3. README:36-42 设置页「两个开关 / 预设下拉 / 提示词编辑 / 模型来源 / 保存条显示未保存项数」→ `client.js:1156-1299`：两开关、`select` 预设、`PromptEditor`、模型分段+两个下拉、`foot.unsaved`/`foot.clean` 计数与放弃/保存按钮，逐项对应。属实。
（README:46「15 个字段」与 `index.js:122-157` 的 15 个字段一致。）

## 结论

**8 项检查：7 PASS、0 FAIL、1 项（第 6 项 id 全局唯一性）不确定；第 7 项的 token 权威清单为「不确定」，其余判据成立。**

结论等级：**修 2 处后可用（可发布）**。真正建议在提交市场前处理的（按优先）：

1. **本地 HTTP 路由准入仍只有 `Host` 头**：`index.js:895-912` + `index.js:976-985` 无 `Origin` / `Sec-Fetch-Site` / `Content-Type` 校验。任何网页可用无需预检的 `text/plain` POST 打到 `127.0.0.1:<port>/dsh-draft-studio/refine`，`Host` 由浏览器自动填为回环地址因而通过，从而消耗用户模型额度（响应因同源策略不可读，无数据外泄）。属「新增未鉴权写入口」，是审核最可能追问的一条。
2. **改名残留与错误注释（文档层）**：`index.js:23-28` 声称依赖是普通 `dependencies` 且由自身 `node_modules` 解析，与 `package.json:38-40` 的 peer 声明和已删除的 `node_modules` 相反；`client.js:1712` 英文导航仍是 `Prompt Refine`，`icon.svg:1` 的 `aria-label` 同。三处都会让审核/维护者读到与实现不符的身份或机制描述。

另外两条不阻断、可在下一版处理：`engines.dsh` 未覆盖 0.2.3+ 的 rc 元组（实测 `0.2.3-rc.0` excluded）；`package.json:33-36` 的 `dsh.client` 缺 `inject`（上一轮 H2，生态插件 `dshmarket` / `dsh-xdpool` 均声明）。
