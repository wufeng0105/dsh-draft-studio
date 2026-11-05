# 发布流程：commit → tag → Release → npm

> 写给下一个接手发布的人。目标：把一次改动从工作树推到线上，并自己证明 **tag 里的源码 == GitHub Release 的资产 == npm 上那个包**。
>
> 方式：手工命令链 + 仓库自带门禁（`npm run self-check`、`node scripts/check-version.mjs`）。**不引入 changesets / release-it**：本仓是单包，多包版本图用不上；版本与打包的一致性已由这两个脚本断言，多一个发布工具只会多一条出错时更难查的路径。命令按 PowerShell 写。

## 0. 一次性前置

```powershell
gh auth status                                     # 需要 repo 权限（建 tag / Release）
npm login --registry=https://registry.npmjs.org    # 或走 §3.1 的 token 路线
npm whoami --registry=https://registry.npmjs.org   # 校验点：打印出用户名
```

`~/.npmrc` 的 `registry=` 可能指向镜像，而认证按 registry 分开存放——**本文每条 npm 命令都显式带 `--registry=https://registry.npmjs.org`**。

## 1. 定版本号，打 tag

**版本规则**：修 bug → patch；加能力 → minor；改包名、改路由、改配置字段语义 → 在 0.x 阶段用 minor，到 1.x 之后用 major。
npm 上的版本**不可变**，任何内容变化都要提号，不能重打同一个 tag。

**若本次在新 DSH 版本上验证过**，三处要同步更新，`check-version` 只断言前两处一致，第三处靠人：

| 位置 | 改什么 |
|---|---|
| `package.json` → `engines.dsh` | 新增一条 `>=0.2.N-rc.0 <0.3.0-0` 分支（**不要**合并成一个范围，见 §6 的坑） |
| `CHANGELOG.md` | 顶部加一节，写清改了什么，不用营销词 |
| `scripts/self-check.ps1` | 若有新的运行时契约，把对应检查项加进去 |

```powershell
# 1) 改 package.json 的 version；2) CHANGELOG.md 顶部加一节
node scripts/check-version.mjs --allow-untagged   # 校验点：V1–V4 OK，V5 提示尚无 tag（正常）
npm run self-check                                # 校验点：四层全 PASS（见 §1.1）

git add -A
git commit -m "release: v<VER> — <一句话>"
git status --porcelain                            # 校验点：输出为空（必须从干净的树发布）
git tag v<VER>                                    # 规范：v + 语义化版本（v1.0.16）
git push origin main
git push origin v<VER>
node scripts/check-version.mjs                    # 校验点：V5 OK（最新 tag == package.json 版本）
```

### 1.1 发布前必跑的自检

`npm run self-check` 检查四层，任何一层红都不该发版：

| 层 | 查什么 | 红了说明 |
|---|---|---|
| 源码语法 | `index.js` / `client.js` 能否 `node --check` | 语法错会让插件静默不加载，按钮直接消失 |
| 清单契约 | `dsh.bundle.patch`、`peerDependencies`、`engines.dsh` 的 `\|\|`、`files` 覆盖、locale 元数据 | 市场收录会拒，或用户装上就坏 |
| 宿主运行时 | DSH 进程、Web 端口、已装进 profile | 本机环境问题，不是发布问题，但挡住验证 |
| 端到端 | 真机 POST `/refine` | 前三层全绿也可能模型层坏了 |

只想验证不花模型额度就加 `-SkipLive`。

| 失败现象 | 原因 | 处理 |
|---|---|---|
| V5 红 `tag=v1.0.15 version=1.0.16` | 改了版本号未打 tag | 打 tag 后重跑（正常中间态） |
| V5 红：tag 名与版本不符 | 写成 `1.0.16` / `V1.0.16` | `git tag -d` 后按 `v<VER>` 重打；已推送则 `git push origin :refs/tags/<错的tag>` |
| `git status` 有输出 | 有未提交改动 | 先提交，否则线上包会带上仓库里没有的字节 |
| self-check 第 4 层 403 `UNTRUSTED_ORIGIN` | 调用没带 `Content-Type: application/json` 或带了非 loopback 的 `Origin` | 见 §5.3，这是设计行为不是 bug |

## 2. 创建 GitHub Release

```powershell
$notes = @'
## Draft Studio v<VER>

<两三句：这版改了什么、为什么>

已适配（verified）：**DSH <当前版本>**（`engines.dsh` 覆盖 0.2.1–0.2.9 的预发布）。
'@
Set-Content -LiteralPath "$env:TEMP\release-notes.md" -Value $notes -Encoding utf8

gh release create v<VER> --title "v<VER> — <一句话标题>" --notes-file "$env:TEMP\release-notes.md"
npm pack --registry=https://registry.npmjs.org     # 产出 dsh-draft-studio-<VER>.tgz
gh release upload v<VER> "dsh-draft-studio-<VER>.tgz"
Remove-Item "dsh-draft-studio-<VER>.tgz" -Force    # 别把产物留在仓库
```

- 标题写 `v<VER> — 做了什么`，不要只写版本号；说明与 `CHANGELOG.md` 同口径。
- **先推 tag 再建 Release**：`gh release create` 找不到 tag 会在默认分支上另建一个，那是错的。Release 的 `tagName` 必须等于 `v<VER>`。
- 校验点：`gh release view v<VER> --json tagName,assets --jq '{tag:.tagName,assets:[.assets[].name]}'`
- 写错说明 → `gh release edit v<VER> --notes-file ...`（不必重发版）；Release 挂错 tag → `gh release delete` 后按正确 tag 重建。

## 3. 发布到 npm

### 3.1 认证（二选一）

- **A. 账号开 2FA**：发布时交互式要 OTP（或 `npm publish --otp=<6位>`）。最干净，推荐长期用。
- **B. granular access token + Bypass 2FA**：网页 `Settings → Access Tokens → Generate New Token`，勾 **Bypass two-factor authentication**、权限 `Read and write (publish and stage)`、有效期 ≤90 天。

```powershell
$rc = (Get-Content "$env:USERPROFILE\.npmrc") | Where-Object { $_ -notmatch '_authToken' }
$rc += '//registry.npmjs.org/:_authToken=<NPM_BYPASS_2FA_TOKEN>'   # 占位符，别把真 token 写进仓库或对话
Set-Content -LiteralPath "$env:USERPROFILE\.npmrc" -Value $rc -Encoding utf8
```

**B 的坑**：表单里勾了 Bypass，token 记录也可能仍是 `false`，发布时报 `403 … bypass 2fa enabled is required`。生成后必须核实：

```powershell
$t = ((Get-Content "$env:USERPROFILE\.npmrc") | Where-Object { $_ -match '_authToken' }) -replace '.*=',''
curl.exe -s -H "Authorization: Bearer $t" https://registry.npmjs.org/-/npm/v1/tokens |
  Select-String -Pattern '"name"|"bypass_2fa"'
# 校验点：该 token 段内 "bypass_2fa": true；为 false 就删掉重建（用真实鼠标点，JS .click() 可能不生效）
```

**长期**：bypass-2FA token 已不能做账号治理类动作，直接发布将于 **2027-01** 停止支持（npm 官方时间表）——届时改用账号 2FA 或 Trusted Publishing。

### 3.2 包名

- 包名 = `package.json` 的 `name`（`dsh-draft-studio`，无 scope）。
- 发布前自查是否被占：`npm view dsh-draft-studio version --registry=https://registry.npmjs.org`（**404 = 可用**）。
- 本名已确认可用（npm / GitHub / 市场三处全空，2026-11-05 探测）。**若将来要加 scope，必须在首次发布前决定**——上架后改名等于换一个包，用户装不到更新。

### 3.3 发布与验证

```powershell
npm publish --registry=https://registry.npmjs.org
# 校验点：输出 "+ dsh-draft-studio@<VER>"，退出码 0

# 权威查询：按版本（绕过 packument 缓存；npm view 可能因 CDN 滞后仍显示旧版）
curl.exe -s "https://registry.npmjs.org/dsh-draft-studio/<VER>"
# 校验点：version / dist.shasum / gitHead 都是这一版，且 gitHead == tag 指向的提交
npm view dsh-draft-studio dist-tags --registry=https://registry.npmjs.org
```

| 失败现象 | 原因 | 处理 |
|---|---|---|
| `403 … bypass 2fa required` | token 没有 bypass | 按 §3.1 核实并重建 |
| `403 … may not perform this action` | 该动作属账号治理（unpublish、改可见性），bypass token 无权 | 用网页端做，或开账号 2FA |
| `EPUBLISHCONFLICT` | 版本已存在 | 提号重发，**不要** `--force` |
| 发布后 `npm view` 仍是旧版 | CDN 缓存 | 按上面的版本端点查；通常几十秒到几分钟 |

### 3.4 发布后确认「装得上、真的活」

线上可见 ≠ 装得上。用 **registry 形态**装一次（不是从工作树装），再做活体取证：

```
plugin_manager  action=install_bundle  target=dsh-draft-studio@<VER>
# 校验点：application=applied、warnings=[]、version=<VER>

cordis_inspect_query platform=host provider=Config method=listConfigs input={"name":"dsh-draft-studio"}
# 校验点：status: "schema"，limitations: []

cordis_inspect_query platform=client provider=Slots method=listSubTree input={"root":"conversation.input.right"}
# 校验点：本插件 occupant active: true

# 端到端
POST http://127.0.0.1:<port>/dsh-draft-studio/refine  {"draft":"自检"}
# 校验点：200 ok=true
```

两种安装形态要说清：registry 与 `file:` tgz 装的是**独立副本**（改源码不影响，要重装）；从目录装是 **link**，改源码立即生效。**验证线上包必须用前者**。

## 4. 三者一致性核对（发布完成的判定）

四条都成立才算发完：

```powershell
node scripts/check-version.mjs     # ① tag ↔ 版本 ↔ CHANGELOG：V1–V5 全绿
git describe --tags --abbrev=0     # ② = v<VER>
git rev-parse "v<VER>^{commit}"    #    tag 指向的提交
git status --porcelain             #    应为空
gh release view v<VER> --json tagName,assets --jq '{tag:.tagName,assets:[.assets[].name]}'   # ③

# ④ npm ↔ 仓库（内容同源，字节级）
$sh = npm view dsh-draft-studio dist.shasum --registry=https://registry.npmjs.org
$wt = Join-Path $env:TEMP "rel-check-$([guid]::NewGuid().ToString('N').Substring(0,6))"
git worktree add --detach $wt v<VER> | Out-Null
Push-Location $wt; npm pack --registry=https://registry.npmjs.org | Out-Null
$local = (Get-FileHash -Algorithm SHA1 (Get-ChildItem *.tgz | Select-Object -First 1).FullName).Hash.ToLower()
Pop-Location; git worktree remove $wt --force
"线上=$sh"; "tag树=$local"          # 校验点：两者相同 = 逐字节同源
```

shasum 不同时**别急着重发**：解包两侧按相对路径逐文件比 SHA-256，先分清「内容真的不同」还是「打包差异」。两个真实原因：

1. **行尾**：`core.autocrlf` 会让工作树里的 CRLF 对 `git status` 隐形，而打包取的是工作树字节——线上包与仓库差 1 字节。本仓已加 `.gitattributes`（`* text=auto eol=lf`），Windows 下新生成的文件发布前比对一次。
2. **树不干净**：`files` 里被改过的文件会进包（`files` 之外的文件不影响）。

## 5. 本仓特有的三个坑

### 5.1 依赖必须留在 `peerDependencies`

`@deepseek-ai/schemastery` 由**宿主提供**，本仓不装 `node_modules`、不带 `pnpm-lock.yaml`。如果你为了本地调试临时 `pnpm install`，发布前务必删掉产物并确认 `dependencies` 里没有 `@deepseek-ai/*`——`self-check` 第 2 层会拦。

### 5.2 `engines.dsh` 不能合并成单一范围

这是踩过的真坑。node-semver 只在「范围里存在一个与该版本 `major.minor.patch` 完全一致、且自身带预发布标签的比较符」时才放行预发布版本。于是：

```
">=0.2.1-rc.5 <0.3.0"        → 0.2.2-rc.1 被静默排除
">=0.2.1-0 <0.3.0-0"         → 0.2.2-rc.1 同样被排除
9 条显式分支（当前写法）      → 0.2.1–0.2.9 的 rc 全部放行
```

代价是字符串很长，但它是唯一可靠的写法。DSH 每发一个新的 `0.2.N`，就补一支。

### 5.3 `/refine` 的两种拒绝是设计行为

`POST /dsh-draft-studio/refine` 会拒绝两类请求，**都不是 bug**：

- **非 loopback `Host`** → 403 `UNTRUSTED_ORIGIN`
- **`Content-Type` 不是 `application/json`**，或 `Origin` 不是 loopback → 403 `UNTRUSTED_ORIGIN`

原因是只校验 `Host` 挡不住恶意网页：浏览器对 `text/plain` 的跨站 POST 不发预检，插件会拿用户额度跑别人的草稿。要求 JSON 单独就强制了预检。用 `curl` 或脚本测接口时记得带 `-H "Content-Type: application/json"`。

## 6. 回滚速查

| 阶段 | 可回滚 | 做法 |
|---|---|---|
| 只提交、未打 tag | 是 | 改完重新提交 |
| tag 已推、未发 npm、未建 Release | 是 | `git push origin :refs/tags/v<VER>` 删远端 tag，重打重推 |
| Release 已建、未发 npm | 是 | `gh release delete v<VER>` + 删 tag 重来 |
| **npm 已发布** | **否** | 向前修一版（patch）；坏版本用 `npm deprecate dsh-draft-studio@<VER> "原因"` 标注 |
| 线上包内容与仓库不符 | 否 | 提 patch 版重发，并在 CHANGELOG 写清原因 |

## 7. 与门禁的关系

发布前的判定全部来自仓库自身，**不新增第二个发布路径**：

| 脚本 | 断言什么 |
|---|---|
| `scripts/check-version.mjs` | tag ↔ `package.json` version ↔ `CHANGELOG` 节 ↔ `engines.dsh` 的 `\|\|` |
| `scripts/self-check.ps1` | 源码语法、清单契约、宿主运行时、端到端 |

## 8. 市场条目（发布后的另一条链路）

npm 与 Release 完成**不等于**上了市场。条目是市场仓库里的一个文件：

```
data/plugins/wufeng0105__dsh-draft-studio.yml
```

```yaml
url: https://github.com/wufeng0105/dsh-draft-studio
name: wufeng0105/dsh-draft-studio
category: usage
description:
  en: 'Rewrites the composer draft into a clearer, structured prompt in place, without sending it. Four editable presets, optional conversation context, and a model that either follows the session or is pinned.'
  zh: 把输入框里的草稿原位改写成更清晰的结构化提示词，不替你发送。四套可编辑预设、可选的会话上下文，模型可跟随会话或固定一个。
icon: https://raw.githubusercontent.com/wufeng0105/dsh-draft-studio/main/assets/icon-180.png
tarball: https://github.com/wufeng0105/dsh-draft-studio/releases/latest/download/dsh-draft-studio.tgz
```

规则见 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md`。两条最容易踩的：

- 描述**必须与代码一致**，评审会对着代码核每一句。写「46 个工具」就得真有 46 个。
- `tarball` 用 `latest/download/` 时**文件名字里不能带版本号**——带了就今天有效、下次发版 404。本仓 `npm pack` 产物默认带版本号，上传 Release 时先改名成 `dsh-draft-studio.tgz`；或用钉住 tag 的形式 `releases/download/v<VER>/dsh-draft-studio-<VER>.tgz`。
