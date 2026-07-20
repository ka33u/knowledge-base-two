import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),dataDir=await mkdtemp(join(tmpdir(),'hd-kb-capacity-')),port=20_000+Math.floor(Math.random()*20_000);
const server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
let output='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
const waitForServer=async()=>{const until=Date.now()+10_000;while(Date.now()<until){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)return}catch{}await new Promise(resolve=>setTimeout(resolve,80))}throw new Error(`容量测试服务未启动：${output}`)};

try{
  await waitForServer();
  const bootstrap=await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'capacity_admin',password:'capacity-password-123'})});assert.equal(bootstrap.status,201);const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
  const database=new DatabaseSync(join(dataDir,'knowledge.db'),{timeout:5000}),insert=database.prepare('INSERT INTO documents(id,title,category,type,tags_json,content,metadata_json,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)'),timestamp=new Date().toISOString();database.exec('BEGIN IMMEDIATE');try{for(let index=0;index<1000;index++){const id=`capacity-${String(index).padStart(4,'0')}`,marker=index===999?' 深层检索标记-999':'';insert.run(id,`容量资料 ${index}`,'国家标准','document','["容量测试"]',`<h2>设计参数 ${index}</h2><p>${'电机参数与计算结果 '.repeat(500)}${marker}</p>`,'{}',timestamp,timestamp,'capacity_admin')}database.exec('COMMIT')}catch(error){database.exec('ROLLBACK');throw error}finally{database.close()}
  const listStart=Date.now(),listResponse=await fetch(`http://127.0.0.1:${port}/api/documents`,{headers:{cookie,'Accept-Encoding':'gzip'}}),listText=await listResponse.text(),listElapsed=Date.now()-listStart,list=JSON.parse(listText);assert.equal(listResponse.status,200);assert.equal(list.documents.length,1000);assert.equal(Object.hasOwn(list.documents[0],'content'),false);assert.ok(list.documents[0].summary.length>0);assert.ok(Buffer.byteLength(listText)<2_000_000,'1000 份资料的元数据列表不应超过 2MB');assert.equal(listResponse.headers.get('content-encoding'),'gzip');
  const searchStart=Date.now(),searchResponse=await fetch(`http://127.0.0.1:${port}/api/documents/search?q=${encodeURIComponent('深层检索标记-999')}`,{headers:{cookie}}),searchElapsed=Date.now()-searchStart,search=await searchResponse.json();assert.equal(searchResponse.status,200);assert.deepEqual(search.ids,['capacity-0999']);
  const detailResponse=await fetch(`http://127.0.0.1:${port}/api/documents/capacity-0999`,{headers:{cookie}}),detail=await detailResponse.json();assert.equal(detailResponse.status,200);assert.ok(detail.document.content.length>5000);
  console.log(`Capacity smoke test passed: 1000 docs, list ${Buffer.byteLength(listText)} bytes/${listElapsed}ms, search ${searchElapsed}ms`);
} finally {
  server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(resolve,3000);server.once('exit',()=>{clearTimeout(timer);resolve()})});await rm(dataDir,{recursive:true,force:true});
}
