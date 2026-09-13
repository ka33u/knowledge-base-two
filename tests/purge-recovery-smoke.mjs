import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),dataDir=await mkdtemp(join(tmpdir(),'hd-kb-purge-recovery-')),attachments=join(dataDir,'attachments'),port=21_000+Math.floor(Math.random()*10_000);
await mkdir(attachments,{recursive:true});
const keptId='44444444-4444-4444-8444-444444444444',orphanId='55555555-5555-4555-8555-555555555555',suffix='66666666-6666-4666-8666-666666666666';
const database=new DatabaseSync(join(dataDir,'knowledge.db'));
database.exec("CREATE TABLE documents (id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT,type TEXT NOT NULL,tags_json TEXT NOT NULL DEFAULT '[]',content TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,created_by TEXT NOT NULL DEFAULT '')");
database.prepare('INSERT INTO documents(id,title,category,type,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(keptId,'中断恢复资料','未定义','pdf',new Date().toISOString(),new Date().toISOString());database.close();
await writeFile(join(attachments,`.${keptId}.${suffix}.purge`),'recover-me');
await writeFile(join(attachments,`.${orphanId}.${suffix}.purge`),'remove-me');
const server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
try{
  const until=Date.now()+10_000;let ready=false;while(Date.now()<until){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,80))}assert.equal(ready,true,`恢复测试服务未启动：${output}`);
  await access(join(attachments,keptId),constants.R_OK);
  await assert.rejects(access(join(attachments,`.${orphanId}.${suffix}.purge`),constants.F_OK));
  assert.match(output,/已恢复永久删除中断留下的附件/);
  console.log('Interrupted purge recovery smoke test passed');
} finally {
  server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,3000);server.once('exit',()=>{clearTimeout(timer);resolve()})});await rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
