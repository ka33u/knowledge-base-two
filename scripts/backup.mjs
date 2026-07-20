/**
 * 一致性备份：短暂启用只读维护状态，备份 SQLite 和所有原始附件。
 * 可通过 DATA_DIR、BACKUP_DIR、HEALTH_URL 覆盖默认位置。
 */
import { backup, DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url)));
const option=name=>process.argv.slice(2).find(argument=>argument.startsWith(`--${name}=`))?.slice(name.length+3);
const DATA_DIR=resolve(option('data')||process.env.DATA_DIR||join(ROOT,'data'));
const BACKUP_ROOT=resolve(option('output')||process.env.BACKUP_DIR||join(ROOT,'backups'));
const DB_PATH=join(DATA_DIR,'knowledge.db');
const LOCK_PATH=join(DATA_DIR,'.maintenance');
const healthUrl=process.env.HEALTH_URL||`http://127.0.0.1:${process.env.PORT||8787}/api/health`;
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const destination=join(BACKUP_ROOT,stamp);

const insideData=relative(DATA_DIR,BACKUP_ROOT);
if(insideData===''||(!insideData.startsWith('..')&&!isAbsolute(insideData)))throw new Error('BACKUP_DIR 不能位于 DATA_DIR 内部');
await stat(DB_PATH).catch(()=>{throw new Error(`未找到数据库：${DB_PATH}`)});
await mkdir(BACKUP_ROOT,{recursive:true});
let existingLock=null;try{existingLock=await stat(LOCK_PATH)}catch(error){if(error.code!=='ENOENT')throw error}
if(existingLock){if(Date.now()-existingLock.mtimeMs<6*60*60_000)throw new Error('系统已处于维护/备份状态，请确认没有其他备份任务在运行');await unlink(LOCK_PATH)}
await writeFile(LOCK_PATH,JSON.stringify({reason:'backup',startedAt:new Date().toISOString(),pid:process.pid},null,2),{flag:'wx'});

const delay=milliseconds=>new Promise(resolveDelay=>setTimeout(resolveDelay,milliseconds));
const waitForWrites=async()=>{
  if(process.env.BACKUP_OFFLINE==='1')return;
  let healthAvailable=false,failures=0;
  for(let attempt=0;attempt<60;attempt++){
    try{const response=await fetch(healthUrl,{signal:AbortSignal.timeout(1500)});if(response.ok){healthAvailable=true;const health=await response.json();if(Number(health.activeMutations||0)===0)return;}}
    catch{failures++;if(!healthAvailable&&failures>=3)break}
    await delay(1000);
  }
  if(healthAvailable)throw new Error('等待正在进行的写入操作超时，备份已取消');
  // 服务可能已停止，或 HTTPS 健康检查未配置；给已开始的普通请求留出完成时间。
  await delay(10_000);
};
const sha256=file=>new Promise((resolveHash,rejectHash)=>{const hash=createHash('sha256'),stream=createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',rejectHash);stream.on('end',()=>resolveHash(hash.digest('hex')))});
const listFiles=async(directory,base=directory)=>{const output=[];for(const entry of await readdir(directory,{withFileTypes:true})){const absolute=join(directory,entry.name);if(entry.isDirectory())output.push(...await listFiles(absolute,base));else if(entry.isFile())output.push({absolute,relative:relative(base,absolute).replaceAll('\\','/')})}return output};

try{
  await waitForWrites();
  await mkdir(destination,{recursive:false});
  const sourceDb=new DatabaseSync(DB_PATH,{readOnly:true,timeout:5000});
  try{await backup(sourceDb,join(destination,'knowledge.db'))}finally{sourceDb.close()}
  const attachmentSource=join(DATA_DIR,'attachments'),attachmentDestination=join(destination,'attachments');
  await stat(attachmentSource).then(()=>cp(attachmentSource,attachmentDestination,{recursive:true,force:false,filter:source=>!source.endsWith('.tmp')})).catch(error=>{if(error.code!=='ENOENT')throw error});
  const verificationDb=new DatabaseSync(join(destination,'knowledge.db'),{readOnly:true});
  try{const result=Object.values(verificationDb.prepare('PRAGMA quick_check').get()||{})[0];if(result!=='ok')throw new Error(`备份数据库校验失败：${result}`)}finally{verificationDb.close()}
  const files=await listFiles(destination);const manifestFiles=[];
  for(const file of files){const info=await stat(file.absolute);manifestFiles.push({path:file.relative,size:info.size,sha256:await sha256(file.absolute)})}
  const packageInfo=JSON.parse(await readFile(join(ROOT,'package.json'),'utf8'));
  await writeFile(join(destination,'manifest.json'),JSON.stringify({formatVersion:1,createdAt:new Date().toISOString(),application:packageInfo.name,applicationVersion:packageInfo.version,nodeVersion:process.version,files:manifestFiles},null,2));
  const keep=Math.max(1,Math.min(365,Number(process.env.BACKUP_KEEP||30)||30)),backupNames=(await readdir(BACKUP_ROOT,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^\d{4}-\d{2}-\d{2}T.+Z$/.test(entry.name)).map(entry=>entry.name).sort().reverse();
  for(const expired of backupNames.slice(keep))await rm(join(BACKUP_ROOT,expired),{recursive:true,force:true});
  console.log(`备份完成：${destination}`);
} finally {
  await unlink(LOCK_PATH).catch(()=>{});
}
