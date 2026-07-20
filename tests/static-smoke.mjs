import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url))),index=await readFile(join(root,'index.html'),'utf8'),login=await readFile(join(root,'login.html'),'utf8');
for(const [name,source] of [['index.html',index],['login.html',login]]){
  assert.doesNotMatch(source,/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i,`${name} 不能依赖公网脚本或样式`);
  assert.match(source,/<meta name="viewport"/i,`${name} 缺少响应式 viewport`);
}
for(const file of ['node_modules/marked/lib/marked.umd.js','node_modules/mammoth/mammoth.browser.min.js','node_modules/xlsx/dist/xlsx.full.min.js','node_modules/pdfjs-dist/build/pdf.min.mjs','node_modules/pdfjs-dist/build/pdf.worker.min.mjs','vendor/pptxjs/js/pptxjs.js','vendor/pptxjs/css/pptxjs.css'])await access(join(root,file));
assert.match(index,/id="profilePopover"/);assert.match(index,/id="changePasswordButton"/);assert.match(index,/id="logoutButton"/);assert.match(index,/id="accountPasswordDialog"/);
console.log('Static/offline smoke test passed');
