import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url)));
const text=async file=>readFile(join(root,file),'utf8');
const [app,index,server,styles,manifest]=await Promise.all([text('app.js'),text('index.html'),text('server.mjs'),text('styles.css'),text('package.json')]);
const packageData=JSON.parse(manifest);

assert.equal(packageData.version,'1.2.0','发布版本号必须同步更新');
assert.match(server,/D:\\\\HDKnowledgeBaseData/,'缺少 Windows 正式数据目录保护');
assert.match(server,/url\.pathname\.replace\(\/\^\\\/\+\//,'静态资源路径必须使用跨平台 URL 分隔符');
assert.match(server,/\/api\/documents\/batch-purge/,'缺少批量永久删除接口');
assert.match(server,/stageAttachmentsForPurge/,'永久删除必须先暂存附件以支持失败恢复');
assert.match(server,/recoverInterruptedPurges/,'服务重启时必须恢复中断的附件删除');
assert.match(app,/function baseResults\(/,'缺少统一视图筛选基线');
assert.match(app,/view==='latest'/,'缺少最新导入视图');
assert.match(app,/crypto\.getRandomValues/,'HTTP 环境缺少安全 UUID 回退');
assert.match(app,/renderSheetContent/,'缺少 Excel 多工作表阅读器');
assert.match(app,/preferredScale=.*Math\.max\(2,/,'PDF 默认渲染清晰度不足');
assert.equal((index.match(/data-filter="presentation"/g)||[]).length,1,'PPT 筛选项重复或缺失');
assert.match(index,/expectedOrder/,'分类拖拽缺少并发冲突保护');
assert.match(index,/requestRemoteBatch/,'大量批量操作没有自动分批');
assert.doesNotMatch(index,/event\.target\.id !== 'noteForm'/,'笔记保存存在重复拦截器');
assert.match(styles,/\.sheet-tabs/,'缺少 Excel 工作表页签样式');

for(const file of ['scripts/register-windows-tasks.ps1','scripts/run-doctor.ps1','scripts/start-server.ps1','scripts/watchdog.ps1']){
  const bytes=await readFile(join(root,file));
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],`${file} 必须使用 UTF-8 BOM 兼容 Windows PowerShell 5.1`);
}

console.log(`Release patch verification passed: v${packageData.version}`);
