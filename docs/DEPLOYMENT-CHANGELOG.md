# 内网部署变更记录（192.168.0.28）

> 本文记录**实际部署到生产环境**的内容：运行环境、运维配置、以及相对仓库基线的全部代码改动。
>
> 部署基线：`1095db5` — *Merge pull request #1 from ka33u/codex/intranet-production-hardening*
>
> 记录日期：2026-09-13

---

## 1. 运行环境

| 项目 | 值 |
|---|---|
| 服务器 | `192.168.0.28`（Windows Server） |
| Node.js | `v24.18.0` |
| 数据库 | Node.js 内置 `node:sqlite`（`DatabaseSync`），无外部依赖 |
| 安装目录 | `C:\HDKnowledgeBase` |
| 监听 | `0.0.0.0:8787`，**HTTP**（TLS 尚未启用） |
| 访问地址 | `http://192.168.0.28:8787/` |
| 远程运维 | OpenSSH（22 端口） |

> ### ⚠️ `vendor/*` 是虚拟路径，磁盘上没有这些文件
>
> `C:\HDKnowledgeBase\vendor` 目录下**只有 `pptxjs\`**。其余 `vendor/marked.js`、`vendor/xlsx.js`、
> `vendor/pdf.mjs`、`vendor/jquery.js` 等全部由 `server.mjs` 的 `staticFiles` 映射到 `node_modules/`：
>
> ```js
> staticFiles = new Map([
>   ['vendor/marked.js',  join(ROOT,'node_modules/marked/lib/marked.umd.js')],
>   ['vendor/mammoth.js', join(ROOT,'node_modules/mammoth/mammoth.browser.min.js')],
>   ['vendor/xlsx.js',    join(ROOT,'node_modules/xlsx/dist/xlsx.full.min.js')],
>   ['vendor/pdf.mjs',    join(ROOT,'node_modules/pdfjs-dist/build/pdf.min.mjs')],
>   ...
> ])
> ```
>
> 排查「vendor 文件不存在」时不要只看 `dir vendor`，**用 HTTP 验证**：
>
> ```bash
> curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.28:8787/vendor/pdf.mjs   # 期望 200
> ```

**实测资源可用性**（2026-09-13）：

```
/vendor/marked.js        200    43,009
/vendor/xlsx.js          200   951,904
/vendor/mammoth.js       200   635,882
/vendor/pdf.mjs          200   352,645
/vendor/pdf.worker.mjs   200 1,375,838
/vendor/pptxjs/pptxjs.js 200   814,756
/vendor/d3.js            200   151,725
```

---

## 2. 数据与备份

数据按需求从 C 盘迁到了 **D 盘**（避免 C 盘空间不足）。

| 用途 | 路径 | 状态 |
|---|---|---|
| 数据目录 | `D:\HDKnowledgeBaseData` | ✅ `knowledge.db` 存在 |
| 附件目录 | `D:\HDKnowledgeBaseData\attachments` | ✅ |
| 备份目录 | `D:\HDKnowledgeBaseBackups` | ✅ 每日 18:00 UTC 备份 |
| ~~C 盘残库~~ | `C:\HDKnowledgeBase\data\knowledge.db` | ✅ **已删除**（`Test-Path` = `False`） |

**服务端已加入 `DATA_DIR` 自动探测 + 启动日志**，不再依赖环境变量（详见第 4 节）：

```js
const DATA_DIR = (() => {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  const d = 'D:\\HDKnowledgeBaseData';
  if (existsSync(d)) return d;
  return resolve(join(ROOT, 'data'));
})();
```

> **部署后必查**：启动日志里 `SERVER DATA_DIR =` 必须指向 D 盘，且 C 盘不得存在 `knowledge.db`。
> 这一条是为了防止 `#4` 号 issue 描述的"数据全部消失"事故复发。

---

## 3. 运维配置

### 3.1 计划任务

```
TaskName                  State
--------                  -----
HD-KnowledgeBase          Running
HD-KnowledgeBase-Backup   Ready
HD-KnowledgeBase-Doctor   Ready
```

注册脚本：`scripts/register-windows-tasks.ps1`

### 3.2 防火墙

```
DisplayName               Enabled   Profile
-----------               -------   -------
HD Knowledge Base 8787    True      Domain, Private, Public
```

> 规则已补上 `Public`。原 `Enable-PSRemoting` 默认规则只覆盖 `Domain,Private`，
> 而该机网络配置文件是 `Public` —— 这是首次部署时 WinRM 连不上的原因之一（见 issue #1）。

### 3.3 禁用 Windows Update 自动重启

服务曾因系统自动重启而中断。已写入：

```powershell
$p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
Set-ItemProperty -Path $p -Name NoAutoRebootWithLoggedOnUsers -Value 1 -Type DWord
```

实测返回 `1`，已生效。

### 3.4 远程运维方式

首次引导用 WinRM，之后**固定使用 OpenSSH**（避免 WinRM 的多层配置问题）。

传输文件用 `scp`，**不要用 PowerShell 字符串管道**（中文乱码）。管理员的公钥必须在
`%ProgramData%\ssh\administrators_authorized_keys`。

---

## 4. 代码改动清单

以下为**线上实际运行版本**相对仓库基线 `1095db5` 的**全部**改动。

```
 app.js      | 16 insertions(+), 12 deletions(-)
 index.html  | 26 insertions(+), 10 deletions(-)
 server.mjs  |  2 insertions(+),  2 deletions(-)
 styles.css  |  1 insertion(+)
```

### 4.1 `server.mjs`（2 处）

**① `DATA_DIR` 自动探测 —— 防数据丢失**

```diff
-const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
+const DATA_DIR = (()=>{if(process.env.DATA_DIR)return resolve(process.env.DATA_DIR);var d='D:\\HDKnowledgeBaseData';if(existsSync(d))return d;return resolve(join(ROOT,'data'));})();
```

> 修复后果最严重的一个问题：计划任务没设 `DATA_DIR` 时，服务会静默读 C 盘的空库，
> 表现为"资料/分类/账号全部消失"。详见 issue #4。

**② Windows 路径分隔符修复 —— 防全站 404**

```diff
-const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/,'');
+const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/,'').replace(/\\/g,'/');
```

> `path.normalize()` 在 Windows 上把 `/` 转成 `\`，导致 `staticFiles` 的 Map 查不到键，
> 所有 `vendor/*` 返回 404。**Linux 上不复现，只在 Windows 生产环境暴露。**
>
> **本补丁至少丢失过 3 次** —— 每次从 GitHub 重新拉 `server.mjs` 覆盖线上就会丢。
> 详见 issue #5、#16。

### 4.2 `app.js`（6 组）

| # | 改动 | 说明 |
|---|---|---|
| 1 | 新增 `uuidv4` polyfill | `crypto.randomUUID` 在 HTTP 非安全上下文不可用（issue #6） |
| 2 | `visibleDocumentLimit` 默认 `100` → `20` | 「最近阅读」默认每页 20 |
| 3 | `currentDocs()` 拆分 & 排序修正 | 拆出 `baseResults()`（只过滤）/ `currentDocs()`（过滤+排序）；`recent` 视图在默认排序下按 `lastRead` 降序 |
| 4 | `renderDocs()` 改用 `currentDocs()` 并补全计数器 | **排序下拉失效的根因**（issue #7）；同时修正各视图/类型计数（issue #11） |
| 5 | `setView()` 重置为下拉值 | 原硬编码 `100`，改为读 `#pageSizeSelect` |
| 6 | 新增 `renderSheetContent()` | 多 sheet 页签 + 页内缩放（issue #9） |

调用点替换（`crypto.randomUUID()` → `uuidv4()`）：`logActivity`、`convertFile`、以及 `index.html` 内联脚本。

排序核心逻辑：

```js
function baseResults(){ /* 只做过滤：视图 / 分类 / 搜索 */ }
function currentDocs(){
  const all = baseResults();
  const matched = filter === 'all' ? all : all.filter(d => d.type === filter);
  const sort = view === 'latest' ? 'created' : $('#sortSelect').value;
  if (view === 'recent' && sort === 'updated')
    return matched.sort((a,b) => (b.lastRead||0) - (a.lastRead||0));
  return matched.sort((a,b) =>
    sort === 'title' ? a.title.localeCompare(b.title,'zh') :
    sort === 'created' ? b.created - a.created : b.updated - a.updated);
}
```

### 4.3 `index.html`（7 组）

1. 新增「最新导入」导航项 `data-view="latest"`
2. 「最近阅读」补上计数 `<em id="recentCount">`
3. 筛选栏补全类型计数：文档 / 表格 / PDF / 图片 / **PPT（新增筛选项）**
4. 新增每页下拉 `#pageSizeSelect`（10/20/30/40/50，默认 20）
5. 分类标题栏新增 `#editCategories`（默认 `hidden`）、`#addCategory` 改为默认 `hidden`
6. 批量操作栏新增 `#batchPurge`（永久删除），原「删除」文案改为「移入回收站」
7. 内联脚本：`crypto.randomUUID()` → `uuidv4()`；笔记表单处理器

### 4.4 `styles.css`（1 处新增）

新增表格阅读样式（相对基线**唯一**的改动，单行）：

```
.sheet-tabs / .sheet-tab / .sheet-panel
.sheet-toolbar / .sheet-zoom / .zoom-btn / .zoom-label
.sheet-scroll / .sheet-table-wrap
```

以及分类编辑模式与新增/编辑按钮的样式。

### 4.5 未纳入线上版本的改动

- `tests/api-smoke.mjs` —— 修复 Windows 下临时目录 `EBUSY`（`rm` 加 `maxRetries`/`retryDelay`）。
  属测试脚本，不影响运行时。
- **服务端 Excel 转换端点 `/api/convert-xlsx`（JSZip 自研 XML 解析）已从线上移除。**
  Excel 显示回退到浏览器端 SheetJS。原因：该路径虽然能取到单元格底色，但会破坏数值精度，
  收益不抵风险。详见 issue #8、#9。

---

## 5. 已实现的功能变更

| 功能 | 状态 | 对应 issue |
|---|---|---|
| 电子表格多 sheet 页签切换 | ✅ 上线 | #9 |
| 表格页内缩放（不影响整页） | ✅ 上线 | #9 |
| 单元格底色还原 | ⛔ 放弃 | #9 |
| Excel 内嵌图片提取 | ⛔ 放弃 | #9 |
| PDF 渲染提升至 3x（含 devicePixelRatio 适配） | ✅ 上线 | #10 |
| 回收站批量永久删除（仅管理员） | ✅ 上线 | #14 |
| 管理员分类编辑模式（普通账户不可见） | ✅ 上线 | #15 |
| 「最新导入」视图（最近 7 天） | ✅ 上线 | #12 |
| 「最近阅读」按上次浏览时间排序 | ✅ 上线 | #12 |
| 每页 10/20/30/40/50（默认 20） | ✅ 上线 | #12 |
| 侧边栏 / 分类 / 各类型计数修正 | ✅ 上线 | #11 |
| 排序下拉菜单 | ✅ 已修（待用户确认） | #7 |
| 局域网模式新建笔记持久化 | ✅ 上线 | #13 |
| UUID 降级 polyfill（兼容 HTTP） | ✅ 上线 | #6 |

---

## 6. 部署检查清单（交付前必过）

每次改动线上文件后，**逐项确认**：

```bash
# 1) 语法
node --check app.js && node --check server.mjs

# 2) 功能存在性（语法检查发现不了功能丢失！）
grep -c "uuidv4"                          app.js     # > 0
grep -c "const results=currentDocs()"     app.js     # > 0
grep -c "latestCount"                     app.js     # > 0
grep -c "HDKnowledgeBaseData"             server.mjs # > 0
grep -c "replace(/\\\\/g,'/')"            server.mjs # > 0
grep -c "/api/documents/batch-purge"      server.mjs # > 0
```

```powershell
# 3) 数据目录
#    启动日志 SERVER DATA_DIR 必须指向 D 盘
Test-Path 'C:\HDKnowledgeBase\data\knowledge.db'   # 必须为 False
```

```bash
# 4) 服务可用
curl -s http://192.168.0.28:8787/api/health        # {"ok":true,"status":"healthy",...}
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.0.28:8787/vendor/pdf.mjs   # 200

# 5) 登录页能打开（交给用户之前自己先验一遍）
```

**改动前端资源时，同步升级 `index.html` 里的 `?v=` 版本号**，否则用户的浏览器会继续用缓存的旧 `app.js` ——
这已经造成过多轮"改了但没效果"的误判。

**验收时让用户用无痕窗口**打开 `http://192.168.0.28:8787/`。

---

## 7. 已知缺口

| 缺口 | 影响 | 优先级 |
|---|---|---|
| 管理员仍是默认密码 | 安全风险 | 高 |
| 未启用 HTTPS | `crypto.randomUUID` 需 polyfill；传输明文 | 中 |
| 服务器网络配置文件仍为 `Public` | 防火墙规则需额外维护 `Public` 覆盖 | 中 |
| 计划任务重启后未配置自动恢复 | 系统重启后可能有服务空窗 | 中 |
| `scripts/verify-patches.mjs` 未编写 | 补丁丢失只能靠人工 grep 发现 | 中 |
| 扫描件 PDF 无文字层 | 全文搜索搜不到 | 低 |
| 窄屏下每页下拉被 `.sort-wrap{display:none}` 隐藏 | 手机无法调整每页数量 | 低 |
| 分类排序无并发冲突检测 | 多人同时排序会互相覆盖 | 低 |

---

## 8. 相关 issue

部署期间遇到的问题已逐条整理为 issue，根因与修复见各条正文：

- 部署环境：`#1` WinRM/防火墙 · `#2` PowerShell 传输 · `#3` 自动重启
- 数据安全：`#4` DATA_DIR 回退 · `#5` 路径分隔符 404 · `#6` randomUUID
- 功能缺陷：`#7` 排序失效 · `#8` Excel 精度 · `#9` 多 sheet/缩放 · `#10` PDF 清晰度
  · `#11` 计数不一致 · `#13` 笔记保存失败
- 功能需求：`#12` 最新导入/最近阅读 · `#14` 批量永久删除 · `#15` 分类编辑模式
- 工程流程：`#16` 还原文件丢失补丁
