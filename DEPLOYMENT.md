# 公司内网部署与运维手册

## 1. 上线范围

本版本适合单部门或小型内网团队：一台常开 Windows 服务器承载 Node.js、SQLite 和附件，Windows 11 同事使用最新版 Microsoft Edge 或 Google Chrome 访问。当前审计数据约为 11 份资料、12 个账号、80MB，总体负载很轻。

正式推荐配置为 4 核 CPU、8GB 内存和本地 SSD；完整硬件档位、磁盘容量算法、操作系统、网络、证书和环境搭建要求见第 2 节。

```text
Windows 11 浏览器 ──HTTPS──> 公司 DNS / 服务器
                                  ├─ Node.js 24 LTS
                                  ├─ data/knowledge.db
                                  └─ data/attachments/
```

## 2. 服务器配置与环境搭建要求

### 2.1 硬件配置

| 使用规模 | CPU | 内存 | 数据盘 | 适用范围 |
| --- | --- | --- | --- | --- |
| 测试/试运行 | 2 核 | 4GB | 50GB SSD | 少于 100 份资料、10 人以内体验 |
| 正式推荐 | 4 核 | 8GB | 200GB 以上 SSD | 不超过约 1000 份资料、约 30 人同时在线 |
| 增长预留 | 8 核 | 16GB | 500GB 以上企业级 SSD | 大量 PDF/PPTX、附件达到数十至上百 GB |

正式服务器应使用有断电保护和运行监控的物理机或虚拟机，保持全天开机。CPU 必须是 x64 架构；系统盘、数据盘都应使用 SSD，不建议使用机械硬盘承载数据库。

磁盘按下面方式规划：

- `C:` 系统和程序盘：为系统、Node.js、项目和日志预留至少 20GB 可用空间。
- `D:` 正式数据盘：本地 NTFS，容量至少为预计 3 年原始资料总量的 1.3 倍，并始终保留 15% 或 10GB 以上空闲空间。
- `E:` 备份盘：优先使用另一块物理磁盘或公司备份存储。若使用内置完整备份，容量按“当前数据库和附件总量 × 保留份数 × 1.2”估算。
- 不允许把 `data` 放在 SMB 共享盘、NAS 映射盘、OneDrive、个人网盘、同步盘、压缩目录或多个服务器共同读写的位置。

### 2.2 操作系统与软件

正式环境要求：

- Windows Server 2022/2025 Standard 64 位，安装公司批准的最新安全更新；仅试运行时可使用 Windows 11 Pro 64 位常开电脑。
- Node.js 24 LTS x64，必须能在 PowerShell 中执行 `node` 和 `npm`；本项目不支持 Node 25 等奇数版本。
- Windows PowerShell 5.1 或 PowerShell 7。项目脚本兼容系统自带 Windows PowerShell 5.1。
- Windows Defender 或公司终端安全软件保持启用，不得排除数据与附件目录。
- 服务器无需安装 Microsoft Office、Java、Python 或数据库服务器；Word、Excel、PDF、PPTX 转换组件已包含在项目依赖中。
- IIS 不是必需组件。只有选择“IIS 终止 HTTPS”方案时才需要安装 IIS、URL Rewrite/ARR 或公司认可的反向代理组件。
- 服务器管理人员应保留最新版 Edge 或 Chrome，用于上线后的本机验收。

安装完成后必须确认：

```powershell
node --version       # 必须显示 v24.x.x
npm --version
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsArchitecture
Get-Volume | Select-Object DriveLetter, FileSystem, SizeRemaining, Size
```

### 2.3 网络、域名和证书

- 服务器使用固定 IP 或 DHCP 保留地址，建议配置公司内网 DNS，例如 `knowledge.company.local`。
- 使用千兆有线网络，不建议通过 Wi-Fi 提供正式服务。
- Windows 网络配置文件必须是“域”或“专用”；防火墙只允许公司内网网段访问知识库端口。
- 推荐客户端统一访问标准 HTTPS 端口 `443`；Node 直接提供 HTTPS 时也可使用 `8787`，但地址中需要保留端口号。
- 严禁把知识库端口映射到互联网，严禁在公网 DNS 中解析该地址。
- 服务器必须加入公司时间同步体系。系统时间偏差会影响会话有效期、日志审计和证书验证。
- 正式上线必须使用公司 Windows 11 客户端信任的证书，证书中的 DNS 名必须与访问地址一致。

上线前由网络管理员验证：

```powershell
Resolve-DnsName knowledge.company.local
Test-NetConnection knowledge.company.local -Port 443
w32tm /query /status
```

### 2.4 目录和运行账号

推荐固定目录：

```text
C:\HDKnowledgeBase\               项目代码、依赖、脚本和日志
D:\HDKnowledgeBaseData\           knowledge.db 与 attachments\
E:\HDKnowledgeBaseBackups\        完整备份和校验清单
C:\HDKnowledgeBase\cert\          证书与私钥（Node 直接 HTTPS 时）
```

不要从管理员的桌面、下载目录、U 盘或临时目录运行。默认计划任务使用 Windows `SYSTEM` 账号；如公司要求使用专用服务账号，该账号必须具有“作为批处理作业登录”权限，并只对项目日志目录、正式数据目录和备份目录拥有所需权限。普通用户不得通过共享文件夹直接接触数据库或附件。

### 2.5 环境变量

| 变量 | 推荐值/作用 | 是否必需 |
| --- | --- | --- |
| `HOST` | 直接提供服务时为 `0.0.0.0`；IIS 反向代理时为 `127.0.0.1` | 是 |
| `PORT` | 默认 `8787` | 否 |
| `DATA_DIR` | `D:\HDKnowledgeBaseData` | 正式环境建议设置 |
| `BACKUP_DIR` | `E:\HDKnowledgeBaseBackups` | 正式环境建议设置 |
| `BACKUP_KEEP` | 完整备份保留份数，默认 30；大容量时可设 7–14 | 否 |
| `TLS_CERT` / `TLS_KEY` | PEM 证书和私钥路径；必须同时设置 | Node 直接 HTTPS 时必需 |
| `TRUST_PROXY` | 只有后端仅监听本机且前方为可信 IIS 时设置为 `1` | 通常不设置 |

优先通过本手册提供的 PowerShell 脚本参数配置，不要直接修改 `server.mjs`。`TRUST_PROXY=1` 绝不能与对局域网直接开放的后端端口同时使用。

### 2.6 环境搭建步骤

1. 安装 Node.js 24 LTS x64，重启 PowerShell，确认 `node --version` 为 `v24.x.x`。
2. 将项目复制到 `C:\HDKnowledgeBase`，将正式数据和备份目录建立在规划好的磁盘。
3. 以管理员身份打开 PowerShell，安装锁定版本依赖并运行隔离测试：

```powershell
cd C:\HDKnowledgeBase
npm ci --omit=dev
npm run check
```

4. 按第 4 节配置 HTTPS，先以前台方式试运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1 `
  -HostAddress 0.0.0.0 -Port 8787 `
  -DataDirectory "D:\HDKnowledgeBaseData" `
  -TlsCertificate "C:\HDKnowledgeBase\cert\server.crt" `
  -TlsKey "C:\HDKnowledgeBase\cert\server.key"
```

5. 从另一台 Windows 11 电脑完成登录和格式预览验收。关闭前台试运行后，再按第 5 节注册开机启动、每日备份和每日巡检任务。
6. 首次产生正式数据后执行 `npm run doctor`，要求数据库完整性为 `ok`，且附件 `missing`、`orphaned` 均为空。

### 2.7 交付给 IT 的验收标准

- Node.js 为 24 LTS x64，`npm ci --omit=dev` 和 `npm run check` 全部通过。
- 数据目录为服务器本地 NTFS，项目、数据、备份三类目录位置明确且权限正确。
- 固定 IP、内网 DNS、HTTPS 证书和域/专用防火墙规则均生效。
- 重启服务器后知识库自动启动，服务、备份、巡检三个计划任务均存在。
- `/api/health` 返回 `status: healthy`，`npm run doctor` 不报告数据完整性或附件缺失问题。
- Windows 11 Edge/Chrome 均能登录、搜索并打开 DOCX、XLSX、PDF、PPTX 和图片。
- 完成一次备份，并在非生产目录完成一次校验或恢复演练。

## 3. 安装与首次验收

1. 在服务器安装官方 [Node.js 24 LTS](https://nodejs.org/en/download)，不要使用 Node 25 等奇数版本。
2. 将项目放在固定目录，例如 `C:\HDKnowledgeBase`，不要从下载目录或个人桌面长期运行。
3. 以 PowerShell 进入项目目录：

```powershell
npm ci --omit=dev
npm test
npm run doctor
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1
```

4. 试运行时从另一台 Windows 11 电脑访问 `http://服务器IP:8787/`，创建首个管理员，验证登录、导入、打开、评论、收藏、删除和恢复。
5. 正式开放前必须完成第 4 节 HTTPS；HTTP 仅用于隔离测试，因为 HTTP 无法加密局域网上传输的密码与会话。

`npm ci` 必须成功完成。所有网页依赖均从本机提供，因此服务器上线后即使不能访问互联网，Word、Excel、PDF 和 PPTX 预览也可以工作。

## 4. HTTPS（正式上线必做）

优先向公司 IT 申请包含内网 DNS 名（例如 `knowledge.company.local`）的受信任证书，让所有 Windows 11 电脑信任公司根证书。

### 方案 A：Node 直接使用 PEM 证书

证书和私钥必须是 PEM 文件，并仅允许 `SYSTEM` 和服务器管理员读取：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1 `
  -HostAddress 0.0.0.0 -Port 8787 `
  -TlsCertificate "C:\HDKnowledgeBase\cert\server.crt" `
  -TlsKey "C:\HDKnowledgeBase\cert\server.key"
```

同事统一访问 `https://knowledge.company.local:8787/`。服务检测到 HTTPS 后会自动给会话 Cookie 添加 `Secure`。

### 方案 B：IIS 终止 HTTPS

由 IIS 绑定公司证书并反向代理到 `http://127.0.0.1:8787`。此时后端仅监听本机，并启用可信代理：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-server.ps1 `
  -HostAddress 127.0.0.1 -Port 8787 -TrustProxy
```

只在请求一定来自本机 IIS 时使用 `-TrustProxy`。不要让启用该选项的 8787 端口直接暴露给局域网。

## 5. 开机自启和每日备份

以管理员身份运行 PowerShell。下面会注册三个 Windows 计划任务：开机启动服务、每天 02:00 备份、每天 06:00 容量与完整性巡检，并仅在“域/专用”网络配置防火墙：

```powershell
cd C:\HDKnowledgeBase
powershell -ExecutionPolicy Bypass -File .\scripts\register-windows-tasks.ps1 `
  -Port 8787 `
  -DataDirectory "D:\HDKnowledgeBaseData" `
  -BackupDirectory "E:\HDKnowledgeBaseBackups" `
  -TlsCertificate "C:\HDKnowledgeBase\cert\server.crt" `
  -TlsKey "C:\HDKnowledgeBase\cert\server.key"
```

脚本要求 Node.js 主版本恰好为 24。服务以 Windows `SYSTEM` 账号运行，日志写入 `logs\server.log`；单个日志超过 10MB 后，会在下次启动时轮换。

备份流程会短暂创建 `data\.maintenance`，新写入会收到“正在备份”的提示，正在进行的写入结束后再复制。每份备份包含经过 SQLite 完整性检查的数据库、全部原始附件、文件大小和 SHA-256 清单。默认保留最近 30 份，可用系统环境变量 `BACKUP_KEEP` 调整为 1–365。

备份目录最好位于另一块磁盘，并继续纳入公司备份系统。只在同一块硬盘保留备份，无法防止整盘损坏或勒索软件。不要把 `data\.maintenance` 手工长期保留；异常中断留下的锁超过 6 小时会自动失效。

内置备份是完整备份，耗时和空间会随附件总量线性增加。资料达到数十 GB 后，应由公司备份系统承担每日增量/去重和异机副本，内置完整备份只保留少量近期恢复点；例如通过 `BACKUP_KEEP=7` 改为保留 7 份。不要简单长期保存 30 份数百 GB 的完整副本。

## 6. 数据权限

普通同事只通过浏览器访问，不应获得服务器文件夹权限。以管理员 PowerShell 收紧正式数据目录权限（根据公司运维账号调整）：

```powershell
icacls "D:\HDKnowledgeBaseData" /inheritance:r
icacls "D:\HDKnowledgeBaseData" /grant "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
```

不要在 Windows Defender 中排除附件目录。知识库会保存原始 PDF、PPTX 和图片，但本身不替代企业防病毒、DLP 或文件合规系统。

## 7. 恢复演练

至少每季度在非生产电脑演练一次。正式恢复步骤：

```powershell
Stop-ScheduledTask -TaskName "HD-KnowledgeBase"
Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue
$env:DATA_DIR = "D:\HDKnowledgeBaseData"
npm run restore -- "E:\HDKnowledgeBaseBackups\2026-07-19T02-00-00-000Z" --confirm
Start-ScheduledTask -TaskName "HD-KnowledgeBase"
```

只有确认端口已不再监听后才能恢复。恢复程序会先校验全部 SHA-256 和数据库，再把原数据目录改名为 `*.before-restore-*`，恢复失败时自动回滚。恢复后验证登录、分类、最近 3 份文档、PDF、PPTX、评论和回收站。

## 8. 日常巡检与升级

每日确认三个计划任务最后结果为 `0x0`，每周检查磁盘空间、`logs\doctor.log` 和最近备份，每月运行：

```powershell
npm run doctor
npm audit --omit=dev
Invoke-RestMethod https://knowledge.company.local:8787/api/health
```

`doctor` 若报告 `missing` 附件或数据库完整性不是 `ok`，应停止写入并先保全当前 `data`，不要直接删除文件。

`doctor` 会监控资料/回收站数量、转换后 HTML、附件、操作日志、会话、数据库空闲页、磁盘余量和最近备份时间。`status: warning` 表示需要安排维护但数据仍完整；`status: attention` 或退出码 `2` 表示存在完整性/附件缺失风险，应立即停止写入排查。

| 指标 | 预警 | 建议动作 |
| --- | --- | --- |
| 磁盘余量 | 少于 10GB 或 15% | 扩容、迁移备份或清理确认不再需要的回收站资料 |
| 转换后 HTML | 50MB | 观察搜索耗时；接近 100MB 时规划 FTS 索引 |
| 有效资料 | 500 份 | 观察列表、搜索和备份；达到 1000 份前评估服务端分页 |
| 同时在线 | 约 30 人 | 压力测试；持续增长时迁移 PostgreSQL/对象存储 |
| 操作日志 | 10 万条 | 按公司审计留存制度归档，不能无策略直接删除 |
| 回收站 | 超过有效资料 25% 或存在 90 天以上资料 | 管理员确认保留期限后清理 |
| 最近备份 | 超过 36 小时 | 检查计划任务、权限、目标盘空间和日志 |

升级步骤：先备份，停止任务，替换代码（保留正式 `data`），执行 `npm ci --omit=dev` 和 `npm test`，再启动并做浏览器验收。不要跨 Node 主版本直接升级；本项目当前只支持 Node 24 LTS。

## 9. Windows 11 客户端兼容与已知边界

- 支持最新版 Edge、Chrome；不支持 Internet Explorer 或旧版 EdgeHTML。
- 浏览器需允许本站 Cookie 和“在新标签页打开”；公司策略若禁止弹出窗口，需要将知识库地址加入允许名单。
- PDF 按可视区域懒渲染，避免长 PDF 一次耗尽内存；高分屏渲染倍率已限制。
- Excel 只显示单元格结果，不执行公式或宏；超宽表格在文档背景内横向滚动。
- PPTX 保留原文件并在浏览器解析。复杂动画、宏、SmartArt、特殊字体或部分图表可能与 PowerPoint 不完全一致；这属于预览能力边界，关键演示仍应以原 PowerPoint 为准。
- 客户端登录只同步标题、分类、标签、摘要和附件元数据；正文在点开资料时按需读取，全文搜索在服务器执行，列表每次最多渲染 100 张卡片。这避免资料增多后每台电脑重复下载全部正文。当前搜索使用 SQLite 条件检索；当转换后 HTML 接近 100MB 或资料接近 1000 份时，应升级为 FTS 全文索引和真正的服务端分页。
- 当前是单机 SQLite 架构，不支持两台应用服务器同时连接同一个数据库，也不提供多人同时编辑同一份资料的版本合并。

## 10. 上线核对表

- [ ] Node.js 24 LTS，`npm ci --omit=dev`、`npm test`、`npm run doctor` 全部通过
- [ ] 项目、数据、备份目录固定，数据位于本地 NTFS，磁盘空间充足
- [ ] 公司 DNS 与受信任 HTTPS 证书生效，客户端无证书警告
- [ ] 防火墙仅开放域/专用网络；不对互联网开放
- [ ] 管理员至少两名；默认 `888888` 密码已由每人修改；离职账号已停用
- [ ] Windows Defender 未排除附件目录
- [ ] 开机任务、每日备份、30 份保留策略和异盘/异机备份均验证
- [ ] 在非生产目录完成一次恢复演练
- [ ] Edge 和 Chrome 各完成登录、搜索、DOCX/XLSX/PDF/PPTX/图片导入与阅读测试
- [ ] 管理员、编辑者、只读访客三种权限分别验收
