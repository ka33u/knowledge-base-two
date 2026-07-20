/**
 * 离线恢复。必须先停止知识库服务，并显式传入 --confirm。
 */
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url)));
const DATA_DIR=resolve(process.env.DATA_DIR||join(ROOT,'data'));
const backupArgument=process.argv.slice(2).find(argument=>argument!=='--confirm');
if(!backupArgument||!process.argv.includes('--confirm'))throw new Error('用法：npm run restore -- <备份目录> --confirm（恢复前必须停止服务）');
const backupDirectory=resolve(backupArgument),manifestPath=join(backupDirectory,'manifest.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
if(manifest.formatVersion!==1||!Array.isArray(manifest.files))throw new Error('备份清单格式不受支持');
const sha256=file=>new Promise((resolveHash,rejectHash)=>{const hash=createHash('sha256'),stream=createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',rejectHash);stream.on('end',()=>resolveHash(hash.digest('hex')))});
for(const item of manifest.files){const file=resolve(backupDirectory,String(item.path||'')),scope=relative(backupDirectory,file);if(scope.startsWith('..')||isAbsolute(scope))throw new Error('备份清单包含越界路径');const info=await stat(file);if(info.size!==item.size||await sha256(file)!==item.sha256)throw new Error(`备份文件校验失败：${item.path}`)}
const backupDb=join(backupDirectory,'knowledge.db'),checkDb=new DatabaseSync(backupDb,{readOnly:true});
try{const result=Object.values(checkDb.prepare('PRAGMA quick_check').get()||{})[0];if(result!=='ok')throw new Error(`备份数据库损坏：${result}`)}finally{checkDb.close()}
const healthUrl=process.env.HEALTH_URL||`http://127.0.0.1:${process.env.PORT||8787}/api/health`;
try{const response=await fetch(healthUrl,{signal:AbortSignal.timeout(1200)});if(response.ok)throw new Error('检测到知识库服务仍在运行，请先停止服务再恢复')}catch(error){if(error.message.includes('仍在运行'))throw error}
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),emergency=`${DATA_DIR}.before-restore-${stamp}`;
let movedExisting=false;
try{
  try{await rename(DATA_DIR,emergency);movedExisting=true}catch(error){if(error.code!=='ENOENT')throw error}
  await mkdir(DATA_DIR,{recursive:true});
  await cp(backupDb,join(DATA_DIR,'knowledge.db'),{force:false});
  await stat(join(backupDirectory,'attachments')).then(()=>cp(join(backupDirectory,'attachments'),join(DATA_DIR,'attachments'),{recursive:true,force:false})).catch(error=>{if(error.code!=='ENOENT')throw error});
  console.log(`恢复完成。原数据安全副本：${movedExisting?emergency:'无（原数据目录不存在）'}`);
} catch(error) {
  await rm(DATA_DIR,{recursive:true,force:true}).catch(()=>{});
  if(movedExisting)await rename(emergency,DATA_DIR).catch(()=>{});
  throw error;
}
