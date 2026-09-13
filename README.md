# HD MOTORS 设计知识库

面向公司局域网协作的多格式知识库。文档在浏览器中转换为适合阅读的 HTML，账号、分类、评论、收藏、回收站、操作记录和原始附件统一保存在服务器。

## 支持格式

| 格式 | 网页阅读方式 | 原文件 |
| --- | --- | --- |
| Markdown、TXT、HTML | 清理后显示为 HTML | 文本内容写入数据库 |
| DOCX | 正文转换为 HTML | 当前不另存 DOCX 原文件 |
| XLS、XLSX | 各工作表转换为可滚动 HTML 表格 | 当前不另存表格原文件 |
| PDF | 打开时按可视区域逐页渲染 | 保存到服务器 |
| PPTX | 转换为网页幻灯片预览 | 保存到服务器 |
| PNG、JPG、GIF、WebP | 响应式图片 | 保存到服务器 |

不支持旧版 `.doc` 和 `.ppt`；请先用 Office 另存为 `.docx`、`.pptx`。单个文件最大 100MB，PDF 最多 1000 页，转换后的 HTML 最大 9MB。

## 开发或试运行

要求 [Node.js 24 LTS](https://nodejs.org/en/download)（`24.18.0` 至 `<25`）。项目已锁定所有浏览器依赖，运行时不访问公共 CDN。

```bash
npm ci
npm run check
npm run dev
```

然后访问 `http://服务器IP:8787/`。首次访问会引导创建管理员。局域网正式部署不要双击 `index.html`，应始终访问服务器地址。

## 数据、备份与检查

- 正式数据：`data/knowledge.db` 与 `data/attachments/`
- 一致性备份：`npm run backup`
- 只读巡检：`npm run doctor`
- 发布补丁完整性检查：`npm run verify:release`
- 隔离回归：`npm test`（不会接触正式 `data/`）
- 恢复：先停止服务，再执行 `npm run restore -- "备份目录" --confirm`

局域网模式下，资料列表只同步元数据和摘要，正文按需加载，全文搜索由服务器执行，资料卡片默认每页显示 20 份，可切换为 10/20/30/40/50。`doctor` 同时检查容量增长、磁盘余量、回收站、日志和最近备份，可用于长期运维预警。

Windows 11 客户端、HTTPS、开机自启、每日备份、恢复演练和上线核对步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。
