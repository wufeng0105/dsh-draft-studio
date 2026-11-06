# 宿主契约清单

> **这份文件解决什么问题**：本插件没有 `node_modules`，全部能力都来自宿主。宿主升级后，如果某个契约变了，插件可能**静默失效**——不报错、不崩溃，只是按钮点了没反应，或者设置页整页空白。
>
> 下面把「我们依赖宿主的每一个点」列全，并给出**每一项断了会长什么样、怎么验**。升级后按最后那节核对一遍，十五分钟能定位到具体哪一条断了。
>
> 共 **25 项**，分五类。契约一律按**符号名**指认（行号会漂，名字不会）。

---

## 一、装载层：不满足则插件根本不出现

这一类断了，插件在界面上**完全没有痕迹**——不是坏，是不存在。这是最难查的一类。

| # | 契约 | 在哪 | 断了的表现 | 怎么验 |
|---|---|---|---|---|
| 1 | `window.__ModuleLoader__.load({ id, factory })` | `client.js` 顶层 | 浏览器半包整块不执行；输入框旁没有按钮、设置页没有本插件 | DevTools 控制台看是否报 `__ModuleLoader__ is not defined` |
| 2 | `require('react')` | `client.js` 的 `factory` 内 | `factory` 抛错，同上 | 同上 |
| 3 | `package.json` → `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-conversation"]` | `package.json` | 声明了一个不存在的宿主包 → 加载不到 | `npm run self-check` 第 2 层 |
| 4 | `package.json` → `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中有一行 `insert` | `package.json`、`cordis.patch.yml` | 宿主根本不装载本包 | `npm run self-check` 第 2 层 |
| 5 | 槽位 `conversation.input.right`（**list** 型） | `client.js` 的 `apply` | 输入框旁没有按钮，其余功能正常 | 看输入框右侧有没有那几颗图标 |
| 6 | 槽位 `settings.section`（**list** 型） | `client.js` 的 `apply` | 设置页没有「草稿工坊」这一项 | 打开 设置 → 找本插件 |

---

## 二、客户端服务：`ctx` 上挂的东西

这一类断了通常有报错，但报错信息不一定指向真因。

| # | 契约 | 在哪 | 断了的表现 | 怎么验 |
|---|---|---|---|---|
| 7 | `ctx.slots.inject(key, fn)` 与 `ctx.slots.register({ name, id, order, locale, inject }, Component)` | `client.js` | 注册失败 → 对应界面不出现 | 控制台；`npm run self-check` 第 3 层会看条目是否 active |
| 8 | `ctx.locale.register(ns, dicts)` 与 `ctx.locale.bind(ns)` | `client.js` | 界面显示 key 原文（如 `label.idle`）而不是中文 | 看设置页文案是否是 `xxx.yyy` 形式 |
| 9 | `ctx.configForms.get(entryId)` 返回表单句柄 | `client.js` 的 `SettingsPageController` | 设置页显示「不可用」，输入框降级为**一颗**按钮 | 设置页顶部状态行 |
| 10 | 表单句柄三方法：`getSnapshot()`、`subscribe(fn)`、`mutate(ops, revision)` | 同上 | 设置页能显示但不能保存；或保存后不刷新 | 改一格 → 看状态行是否变「未保存」→ 保存 → 重开 |
| 11 | 快照形状 `{ status, writable, revision, value, user, base }`；`status === 'ready'` 才可写 | 同上 | 页面停在「不可用」；或勾选/名称读不出来 | 同上 |
| 12 | `ctx.remote.$on(event, cb)`，四个事件名：`llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` | `client.js` 的 `CATALOG_EVENTS` | 模型目录不再自动刷新（换模型后下拉还是旧的） | 切一个模型 → 回设置页看下拉是否跟着变 |
| 13 | `ctx.remote.session.modelCatalog()` → `{ ok, value: { groups: [{ id, models: [{ id, reasoning: { efforts } }] }] } }` | `client.js` 的 `createCatalogStore` | 「固定模型」下拉为空或永久禁用 | 设置页切到「固定模型」→ 看下拉能不能展开 |
| 14 | `ctx.inject(deps, fn)`，且 `remote.session` 必须**显式**写在 deps 里 | `client.js` 的 `apply` | 访问 `remote.session` 抛「cannot get property … without inject」 | 控制台报错原文 |

---

## 三、槽位 props 与编辑器行为

这一类最阴：**API 都在、形状也对，但行为变了**。我们踩过两次。

| # | 契约 | 在哪 | 断了的表现 | 怎么验 |
|---|---|---|---|---|
| 15 | `useInput(selector)`，state 含 `draft`、`draftRev`、`phase`、`occurrences` | `client.js` 的 `RefineControl` / `RefineButton` | 按钮不显示（`draft` 读不到）；或结果写回后守卫失效 | 输入框打字 → 按钮该出现；点一下 → 应该能改 |
| 16 | `inputActions.insertText(text, { start, end, draftRev })` → `boolean` | `client.js` 的 `replaceDraft` | 改了但写不回去；按钮会提示失败原因 | 点按钮 → 草稿应被改写；失败时有具体原因文案 |
| 17 | `phase` 的取值：`submitting`、`adjudicating`、`sending` 等 | `client.js` 的 `refusalReason`、`useDiscardRunOnSend` | 发送后转圈不停；或错误地拒绝写回 | 改写中直接发送 → 转圈应立刻消失 |
| 18 | `occurrences` 里芯片的坐标语义：**命令芯片**（`/` 菜单）在 detect 投影占 1 字符、宿主不发布换算数据；**引用芯片**（`@`）坐标可折算 | `client.js` 的芯片相关注释与 `replaceDraft` | 草稿含 `/` 命令芯片时，结果写不回去（这是已知限制，不是 bug） | 见 `README.md` 的「边界」一节 |

---

## 四、宿主侧服务（`index.js`）

这一类只能在宿主进程里验。

| # | 契约 | 在哪 | 断了的表现 | 怎么验 |
|---|---|---|---|---|
| 19 | `ctx.inject(['llm', 'webServer'], fn)`；路由必须挂在这两个服务都在的作用域里 | `index.js` 的 `apply` | 路由不注册 → 点按钮报「接口不可用（HTTP 4xx）」 | `npm run self-check` 第 3、4 层 |
| 20 | `webServer.register({ kind: 'exact', path, handler(req, res) })`，`req`/`res` 是 **node:http** 原生对象（不是 WHATWG） | `index.js` | 路由 404/405；或读取请求体失败 | `npm run self-check` 第 4 层会真打一次 |
| 21 | `llm.listProviders()`、`llm.resolveModelInfo(provider, model, signal)`、`llm.prepareCall(...)` → `{ config, stream() }` | `index.js` 的 `generate` | 「跟随会话」时找不到模型；或改写直接超时 | 点一次按钮，看是否返回 |
| 22 | `call.stream({ ...call.config, system, messages, signal })` 的 chunk 协议：`text-delta`、`reasoning-delta`、`finish`（`finish.kind` 决定重试策略） | 同上 | 结果为空或报「模型没有返回可用的提示词」 | 同上 |
| 23 | `scope.get('agentDefaultModel')?.currentSelection()` → `{ provider, model }` | `index.js` 的 `resolveRoute` | 「跟随会话」取不到默认模型 | 设成跟随 → 点一次按钮 |
| 24 | `@deepseek-ai/schemastery` 的 `z.object / string / number / boolean / enum / array().default().volatile()` | `index.js` 顶部 | 设置页字段全丢（Config 变成 `undefined`，本仓已对此做了降级） | `npm run self-check` 第 3 层看 Config schema 是否注册 |

---

## 五、样式 token

| # | 契约 | 在哪 | 断了的表现 | 怎么验 |
|---|---|---|---|---|
| 25 | 16 个 `--dsw-alias-*` 变量（`bg-layer-1/2`、`border-l2`、`brand`、`brand-soft`、`label-primary/secondary/tertiary`、`text-primary/tertiary`、`danger`、`interactive-bg-hover`、`bg-secondary`、`state-business-primary`、`state-error-primary`） | `client.js` 的 `CSS` 常量 | **不会坏**：每个 `var()` 都带字面 fallback，只是深浅色可能不跟随 | 切一次深色主题，看图标与框线是否变色 |

---

## 六、升级后 15 分钟核对清单

按顺序做，前四步是机械的：

```powershell
node --check index.js ; node --check client.js          # 1. 语法
npm run self-check -- -SkipLive -Port <当前端口>          # 2. 四层：语法 / 清单 / 宿主运行时 / 端到端
npm run check-version                                     # 3. 版本与 CHANGELOG 一致性
```

4. **插件条目是否 active**：设置 → 插件，找 `dsh-draft-studio`，状态应为启用且未报错（对应第 5、6、7 项）。
5. **设置页打得开吗**：能找到「草稿工坊」页、六个格子都在、文案是中文不是 key（对应第 8–11、13 项）。
6. **打一次真实改写**：随便打几个字 → 点一颗按钮 → 草稿应被改写；失败时看提示文案（对应第 15–17、19–23 项）。
7. **降级路径**：如果第 5 步显示「不可用」，说明 `configForms` 那一路断了——此时输入框应该只剩一颗按钮且仍可用（第 9 项）。
8. **状态行只在宿主回报过时出现**：任选一颗按钮改写一次，回到设置页应看到「上次改写：…」；若宿主是旧的（响应里没有 `context` 字段），这一行**整行不出现**——不出现是正确行为，不是缺失。
9. **失败提示带具体原因**：把固定模型的 provider 改成一个未启用的，再点改写——提示里应出现「模型提供商「…」未启用」这类**带 provider 名**的句子，而不是泛化的「请先选择一个模型」。

---

## 七、本插件对外接口（`POST /dsh-draft-studio/refine`）

> 上面几节是「宿主给我们什么」；这一节反过来，是「**我们对外返回什么**」——客户端、自检脚本、以及任何直接调这个路由的人都按这张表读。

**请求体**：只允许三个字段，多传的一律不读（`presetId` 非法时静默回落到配置里的 `preset`）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `draft` | string | 必填，要改写的草稿 |
| `sessionId` | string | 可选，读会话上下文用 |
| `presetId` | string | 可选，`general`/`code`/`writing`/`translation`；**只传标识，绝不传提示词文本** |

**成功响应**（HTTP 200）：**7 个字段**

| 字段 | 值 |
|---|---|
| `ok` | `true` |
| `text` | 改写结果 |
| `finish` | 恒为 `'stop'` |
| `route` | `{ provider, model }` |
| `preset` | 实际使用的预设 key |
| `context` | `{ status, turns?, chars? }`，见下表 |
| `error` | `null` |

**失败响应**（HTTP 200）：**5 个字段**，没有 `route` / `preset` / `context`

| 字段 | 值 |
|---|---|
| `ok` | `false` |
| `code` | 稳定错误码（`EMPTY_DRAFT` / `DISABLED` / `NO_MODEL` / `NO_ADAPTER` / `TIMEOUT` / `EMPTY` / `UNAVAILABLE` / …） |
| `text` | `''` |
| `finish` | **等于 `code`**（与成功时的 `'stop'` 不同，这是既有约定） |
| `error` | 面向人的说明 |

**例外状态码**：405（方法不是 POST）、403（Host 非 loopback / 跨站 / Content-Type 不对）、400（body 不是 JSON）、503（插件卸载）。

**`context.status` 六态**

| 值 | 含义 | `turns`/`chars` |
|---|---|---|
| `ok` | 读到并送进模型了 | 有 |
| `disabled` | 设置里「读取上下文」关着 | 无 |
| `noSession` | 请求没带 `sessionId` | 无 |
| `unreachable` | 会话取不到（或读投影抛错） | 无 |
| `empty` | 会话还没有可读历史 | 无 |
| `filtered` | 历史被条数/字数预算筛空 | 无 |

**客户端约定**：设置页那行「上次改写」的可见性 **≡ 宿主回报过 `context`**；缺这个字段就什么都不显示（不是显示「未知」）。
## 八、这份清单管不到什么（诚实边界）

**「契约都在」不等于「插件能用」。** 我们自己的三个事故都是 API 齐全、功能已死：

| 事故 | 点还在 | 形状对 | 结果 |
|---|---|---|---|
| 1.0.13 模型下拉永久禁用 | 在 | 对 | 照坏——订阅没接上，目录加载完页面不重绘 |
| 1.0.5 命令芯片写回必失败 | 在 | 对 | 照坏——坐标语义 clipboard ↔ detect 差 1 字符 |
| 1.1.0「点 B 用了 A 的提示词」 | 在 | 对 | 照坏——函数没变，但取值路径的语义变了 |

所以这份清单给的是**分诊**能力：升级后哪一处断了，能立刻指出是哪一条契约，而不是从三千行里重新找。它给不了「一切正常」的保证——那个只能靠第 6 步真的打一次。

维护这份清单的规则：**任何新引入的宿主 API，都要先在这一页加一行，再写代码。**
