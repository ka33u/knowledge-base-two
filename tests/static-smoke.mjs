import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url))),index=await readFile(join(root,'index.html'),'utf8'),login=await readFile(join(root,'login.html'),'utf8'),app=await readFile(join(root,'app.js'),'utf8'),server=await readFile(join(root,'server.mjs'),'utf8'),manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
for(const [name,source] of [['index.html',index],['login.html',login]]){
  assert.doesNotMatch(source,/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i,`${name} 不能依赖公网脚本或样式`);
  assert.match(source,/<meta name="viewport"/i,`${name} 缺少响应式 viewport`);
}
for(const file of ['node_modules/marked/lib/marked.umd.js','node_modules/mammoth/mammoth.browser.min.js','node_modules/xlsx/dist/xlsx.full.min.js','node_modules/pdfjs-dist/build/pdf.min.mjs','node_modules/pdfjs-dist/build/pdf.worker.min.mjs','vendor/pptxjs/js/pptxjs.js','vendor/pptxjs/css/pptxjs.css'])await access(join(root,file));
assert.match(index,/id="profilePopover"/);assert.match(index,/id="changePasswordButton"/);assert.match(index,/id="logoutButton"/);assert.match(index,/id="accountPasswordDialog"/);
assert.equal((index.match(/data-filter="presentation"/g)||[]).length,1,'PPT 筛选项只能有一个');
assert.equal((app.match(/\$\('#noteForm'\)\.addEventListener\('submit'/g)||[]).length,1,'新建笔记只能绑定一个保存处理器');
assert.doesNotMatch(index,/event\.target\.id !== 'noteForm'/,'index.html 不应再次拦截笔记保存');
assert.match(app,/crypto\.getRandomValues/,'HTTP 环境下 UUID 必须使用安全随机回退');
assert.match(index,/requestRemoteBatch/,'超过 100 份的前端批量操作必须自动分批');
assert.doesNotMatch(app,/visibleDocumentLimit=100/,'搜索结果必须遵守每页数量');
assert.match(server,/\/api\/documents\/batch-purge/,'服务端必须提供批量永久删除接口');
assert.match(server,/process\.platform!==['"]win32['"]/,'数据目录回退必须区分操作系统');
assert.match(index,new RegExp(`app\\.js\\?v=[^"']+`),'前端脚本必须带缓存版本');
assert.equal(manifest.version,'1.2.0');
console.log('Static/offline smoke test passed');
