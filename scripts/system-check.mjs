/** 只读上线/巡检工具，不修改正式数据。 */
import { DatabaseSync } from 'node:sqlite';
import { readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=dirname(fileURLToPath(new URL('../server.mjs',import.meta.url)));
const DATA_DIR=resolve(process.env.DATA_DIR||join(ROOT,'data')),BACKUP_DIR=resolve(process.env.BACKUP_DIR||join(ROOT,'backups')),DB_PATH=join(DATA_DIR,'knowledge.db'),ATTACHMENT_DIR=join(DATA_DIR,'attachments');
try{await stat(DB_PATH)}catch(error){if(error.code==='ENOENT'){console.log(JSON.stringify({status:'uninitialized',message:'数据库尚未创建，请先启动服务并完成首次初始化'},null,2));process.exit(0)}throw error}
const database=new DatabaseSync(DB_PATH,{readOnly:true,timeout:5000});
const scalar=sql=>Number(Object.values(database.prepare(sql).get()||{})[0]||0);
let integrity='unknown',documents=[],users=0,comments=0,auditRows=0,activeSessions=0,expiredSessions=0,databasePages=0,freeDatabasePages=0,oldestTrashAt=null;
try{
  integrity=String(Object.values(database.prepare('PRAGMA quick_check').get()||{})[0]||'unknown');
  documents=database.prepare('SELECT id,type,metadata_json,length(content) AS content_bytes,deleted_at FROM documents').all();
  const userColumns=database.prepare('PRAGMA table_info(users)').all().map(column=>column.name);users=scalar(userColumns.includes('disabled_at')?'SELECT COUNT(*) FROM users WHERE disabled_at IS NULL':'SELECT COUNT(*) FROM users');
  const hasComments=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_comments'").get();comments=hasComments?scalar('SELECT COUNT(*) FROM document_comments'):0;
  const hasAudit=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get(),hasSessions=database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();auditRows=hasAudit?scalar('SELECT COUNT(*) FROM audit_log'):0;activeSessions=hasSessions?Number(database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at>?').get(Date.now()).count):0;expiredSessions=hasSessions?Number(database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expires_at<=?').get(Date.now()).count):0;
  databasePages=scalar('PRAGMA page_count');freeDatabasePages=scalar('PRAGMA freelist_count');oldestTrashAt=documents.filter(document=>document.deleted_at).map(document=>Date.parse(document.deleted_at)).filter(Number.isFinite).sort((a,b)=>a-b)[0]||null;
} finally { database.close() }
let attachmentNames=[];try{attachmentNames=(await readdir(ATTACHMENT_DIR,{withFileTypes:true})).filter(entry=>entry.isFile()&&!entry.name.endsWith('.tmp')).map(entry=>entry.name)}catch(error){if(error.code!=='ENOENT')throw error}
const attachmentSet=new Set(attachmentNames),expected=new Set();
for(const document of documents){let metadata={};try{metadata=JSON.parse(document.metadata_json||'{}')}catch{}const id=metadata.attachmentId||metadata.pdfId||metadata.presentationId;if(id)expected.add(String(id))}
const missing=[...expected].filter(id=>!attachmentSet.has(id)),orphaned=attachmentNames.filter(id=>!documents.some(document=>document.id===id));
const disk=await statfs(DATA_DIR),dbSize=(await stat(DB_PATH)).size,contentBytes=documents.reduce((sum,document)=>sum+Number(document.content_bytes||0),0),attachmentBytes=(await Promise.all(attachmentNames.map(name=>stat(join(ATTACHMENT_DIR,name)).then(info=>info.size)))).reduce((sum,size)=>sum+size,0),activeDocuments=documents.filter(document=>!document.deleted_at).length,trashDocuments=documents.length-activeDocuments,freeBytes=Number(disk.bavail)*Number(disk.bsize),totalBytes=Number(disk.blocks)*Number(disk.bsize),freeRatio=totalBytes?freeBytes/totalBytes:1;
let newestBackupAt=null,newestBackup=null;try{const backups=(await readdir(BACKUP_DIR,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^\d{4}-\d{2}-\d{2}T.+Z$/.test(entry.name)).map(entry=>entry.name).sort().reverse();newestBackup=backups[0]||null;if(newestBackup)newestBackupAt=(await stat(join(BACKUP_DIR,newestBackup,'manifest.json'))).mtimeMs}catch(error){if(error.code!=='ENOENT')throw error}
const warnings=[];if(activeDocuments>=500)warnings.push('有效资料已达到 500 份，建议规划分页和 FTS 全文索引');if(contentBytes>=50*1024*1024)warnings.push('转换后的 HTML 已超过 50MB，请关注搜索和列表响应时间');if(auditRows>=100_000)warnings.push('操作日志已超过 10 万条，请按公司留存制度归档');if(trashDocuments>=Math.max(50,Math.ceil(activeDocuments*.25)))warnings.push('回收站资料较多，请确认保留期限并由管理员清理');if(oldestTrashAt&&Date.now()-oldestTrashAt>90*864e5)warnings.push('回收站存在超过 90 天的资料，请确认是否需要永久保留');if(orphaned.length)warnings.push(`发现 ${orphaned.length} 个未关联附件，占用空间但不会在页面显示`);if(expiredSessions>=1000)warnings.push('过期会话较多，重启服务或执行维护后应自动清理');if(freeBytes<10*1024**3||freeRatio<0.15)warnings.push('数据盘剩余空间低于 10GB 或 15%');if(!newestBackupAt)warnings.push('未找到可验证的本地备份');else if(Date.now()-newestBackupAt>36*60*60_000)warnings.push('最近一次备份已超过 36 小时');if(databasePages&&freeDatabasePages/databasePages>0.3)warnings.push('数据库空闲页超过 30%，可在停机维护窗口评估执行 VACUUM');
const attention=integrity!=='ok'||missing.length>0;
const report={status:attention?'attention':warnings.length?'warning':'ok',integrity,warnings,activeUsers:users,comments,auditRows,sessions:{active:activeSessions,expired:expiredSessions},documents:{active:activeDocuments,trash:trashDocuments,oldestTrashAt:oldestTrashAt?new Date(oldestTrashAt).toISOString():null,convertedHtmlBytes:contentBytes},attachments:{count:attachmentNames.length,bytes:attachmentBytes,missing,orphaned},database:{bytes:dbSize,pages:databasePages,freePages:freeDatabasePages},storage:{freeBytes,totalBytes,freePercent:Number((freeRatio*100).toFixed(1)),estimatedThirtyFullBackupsBytes:(dbSize+attachmentBytes)*30},backup:{directory:BACKUP_DIR,newestBackup,newestBackupAt:newestBackupAt?new Date(newestBackupAt).toISOString():null}};
console.log(JSON.stringify(report,null,2));
if(attention)process.exitCode=2;
