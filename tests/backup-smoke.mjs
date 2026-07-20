import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const execute=promisify(execFile),workdir=await mkdtemp(join(tmpdir(),'hd-kb-backup-test-'));
const dataDir=join(workdir,'data'),backupDir=join(workdir,'backups'),attachmentDir=join(dataDir,'attachments');
const backupScript=fileURLToPath(new URL('../scripts/backup.mjs',import.meta.url)),restoreScript=fileURLToPath(new URL('../scripts/restore-backup.mjs',import.meta.url));
try{
  await mkdir(attachmentDir,{recursive:true});
  const db=new DatabaseSync(join(dataDir,'knowledge.db'));db.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES('original');");db.close();
  await writeFile(join(attachmentDir,'fixture'),'attachment-original');
  const backupResult=await execute(process.execPath,[backupScript],{env:{...process.env,DATA_DIR:dataDir,BACKUP_DIR:backupDir,BACKUP_OFFLINE:'1'}});
  const destination=backupResult.stdout.trim().replace(/^.*备份完成：/s,'').trim(),manifest=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));
  assert.equal(manifest.formatVersion,1);assert.ok(manifest.files.some(file=>file.path==='knowledge.db'));assert.ok(manifest.files.some(file=>file.path==='attachments/fixture'));
  const changed=new DatabaseSync(join(dataDir,'knowledge.db'));changed.exec("UPDATE marker SET value='changed'");changed.close();await writeFile(join(attachmentDir,'fixture'),'attachment-changed');
  await execute(process.execPath,[restoreScript,destination,'--confirm'],{env:{...process.env,DATA_DIR:dataDir,HEALTH_URL:'http://127.0.0.1:1/api/health'}});
  const restored=new DatabaseSync(join(dataDir,'knowledge.db'),{readOnly:true});assert.equal(restored.prepare('SELECT value FROM marker').get().value,'original');restored.close();
  assert.equal(await readFile(join(attachmentDir,'fixture'),'utf8'),'attachment-original');
  console.log('Backup/restore smoke test passed');
} finally { await rm(workdir,{recursive:true,force:true}); }
