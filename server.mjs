/**
 * 局域网知识库服务：Node.js 24 LTS（使用内置 node:sqlite）。
 * 默认只监听本机；设置 HOST=0.0.0.0 后可供局域网访问。
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, unlink, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, normalize, resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = (()=>{if(process.env.DATA_DIR)return resolve(process.env.DATA_DIR);var d='D:\\HDKnowledgeBaseData';if(existsSync(d))return d;return resolve(join(ROOT,'data'));})();
await mkdir(DATA_DIR, { recursive: true });
const ATTACHMENT_DIR = join(DATA_DIR, 'attachments');
await mkdir(ATTACHMENT_DIR, { recursive: true });
const MAINTENANCE_FILE = join(DATA_DIR,'.maintenance');
const db = new DatabaseSync(join(DATA_DIR, 'knowledge.db'), { timeout: 5000 });
const loginAttempts = new Map();
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), created_at TEXT NOT NULL, disabled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, type TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]', content TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY, color TEXT NOT NULL, created_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
    target TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, doc_id)
  );
  CREATE TABLE IF NOT EXISTS document_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES document_comments(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS attachment_files (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_comments_doc_created ON document_comments(doc_id, id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_documents_deleted_updated ON documents(deleted_at, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id DESC);
`);
if (!db.prepare("PRAGMA table_info(categories)").all().some(column => column.name === 'sort_order')) db.exec('ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === 'disabled_at')) db.exec('ALTER TABLE users ADD COLUMN disabled_at TEXT');
if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === 'created_by')) db.exec("ALTER TABLE documents ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(document_comments)").all().some(column => column.name === 'parent_id')) db.exec('ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE SET NULL');
if (!db.prepare("PRAGMA table_info(document_comments)").all().some(column => column.name === 'deleted_at')) db.exec('ALTER TABLE document_comments ADD COLUMN deleted_at TEXT');
db.exec('UPDATE categories SET sort_order=rowid WHERE sort_order=0');
db.exec("UPDATE documents SET created_by='系统迁移' WHERE created_by IS NULL OR created_by=''");
const integrityResult = Object.values(db.prepare('PRAGMA quick_check').get() || {})[0];
if (integrityResult !== 'ok') throw new Error(`数据库完整性检查失败：${integrityResult || '未知错误'}`);

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const staticFiles = new Map([
  ['index.html',join(ROOT,'index.html')],['login.html',join(ROOT,'login.html')],['app.js',join(ROOT,'app.js')],['styles.css',join(ROOT,'styles.css')],
  ['vendor/marked.js',join(ROOT,'node_modules/marked/lib/marked.umd.js')],['vendor/mammoth.js',join(ROOT,'node_modules/mammoth/mammoth.browser.min.js')],['vendor/xlsx.js',join(ROOT,'node_modules/xlsx/dist/xlsx.full.min.js')],
  ['vendor/pdf.mjs',join(ROOT,'node_modules/pdfjs-dist/build/pdf.min.mjs')],['vendor/pdf.worker.mjs',join(ROOT,'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')],
  ['vendor/jquery.js',join(ROOT,'node_modules/jquery/dist/jquery.min.js')],['vendor/d3.js',join(ROOT,'node_modules/d3/d3.min.js')],['vendor/nvd3.js',join(ROOT,'node_modules/nvd3/build/nv.d3.min.js')],['vendor/nvd3.css',join(ROOT,'node_modules/nvd3/build/nv.d3.min.css')],
  ['vendor/pptxjs/jszip.js',join(ROOT,'vendor/pptxjs/js/jszip.min.js')],['vendor/pptxjs/filereader.js',join(ROOT,'vendor/pptxjs/js/filereader.js')],['vendor/pptxjs/pptxjs.js',join(ROOT,'vendor/pptxjs/js/pptxjs.js')],['vendor/pptxjs/pptxjs.css',join(ROOT,'vendor/pptxjs/css/pptxjs.css')]
]);
const now = () => new Date().toISOString();
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { try { const [salt, hash] = String(stored || '').split(':'); const expected=Buffer.from(hash,'hex'); if(!salt||expected.length!==64)return false; const candidate=scryptSync(password,salt,64); return timingSafeEqual(candidate,expected); } catch { return false; } };
const safeDecode = value => { try{return decodeURIComponent(value)}catch{return value} };
const parseCookies = value => Object.fromEntries((value || '').split(';').map(v => { const index=v.indexOf('='); return index<0?[]:[v.slice(0,index).trim(),safeDecode(v.slice(index+1))]; }).filter(v => v.length === 2));
const baseHeaders = {
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; worker-src 'self' blob:"
};
const send = (res, status, payload, headers = {}) => { const body=JSON.stringify(payload),acceptEncoding=String(res.req?.headers['accept-encoding']||''); if(Buffer.byteLength(body)>16_384&&/\bgzip\b/i.test(acceptEncoding)){res.writeHead(status,{...baseHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Encoding':'gzip','Vary':'Accept-Encoding',...headers});const gzip=createGzip({level:zlibConstants.Z_BEST_SPEED});gzip.on('error',error=>{console.error('响应压缩失败',error);if(!res.destroyed)res.destroy(error)});return Readable.from([body]).pipe(gzip).pipe(res)} res.writeHead(status,{...baseHeaders,'Content-Type':'application/json; charset=utf-8','Content-Length':String(Buffer.byteLength(body)),'Cache-Control':'no-store',...headers});res.end(body); };
const redirect = (res, location) => { res.writeHead(302,{...baseHeaders,Location:location,'Cache-Control':'no-store'}); res.end(); };
const trustProxy = process.env.TRUST_PROXY === '1';
const requestIsSecure = req => Boolean(req.socket.encrypted)||(trustProxy&&String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https');
const sessionCookie = (req, sid, maxAge=604800) => `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${requestIsSecure(req)?'; Secure':''}`;
const validMutationOrigin = req => { if(['GET','HEAD','OPTIONS'].includes(req.method||''))return true; if(req.headers['sec-fetch-site']==='cross-site')return false; const origin=req.headers.origin; if(!origin)return true; const protocol=requestIsSecure(req)?'https':'http', host=trustProxy?(String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim()):(req.headers.host||''); return origin===`${protocol}://${host}`; };
const httpError = (status,message) => Object.assign(new Error(message),{status});
const readBody = req => new Promise((resolve, reject) => { let data='',size=0,done=false; req.on('data', chunk => { if(done)return; size+=chunk.length; if(size>10_000_000){done=true;data='';reject(httpError(413,'请求过大（最大 10MB）'));return} data+=chunk; }); req.on('end', () => { if(done)return; try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400,'JSON 格式无效')); } }); req.on('error', reject); });
const writeAttachment = (req,target) => new Promise((resolveWrite,rejectWrite)=>{const temporary=`${target}.${randomUUID()}.tmp`,output=createWriteStream(temporary,{flags:'wx'});let size=0,settled=false;const removeTemporary=()=>unlink(temporary).catch(()=>{});const fail=error=>{if(settled)return;settled=true;req.unpipe(output);output.destroy();req.resume();removeTemporary().finally(()=>rejectWrite(error))};req.on('data',chunk=>{size+=chunk.length;if(size>100*1024*1024)fail(httpError(413,'附件超过 100MB'))});req.once('aborted',()=>fail(httpError(400,'附件上传已中断')));req.once('error',fail);output.once('error',fail);output.once('finish',async()=>{if(settled)return;settled=true;try{await rename(temporary,target);resolveWrite(size)}catch(error){await removeTemporary();rejectWrite(error)}});req.pipe(output)});
const allowedAttachmentTypes = new Set(['application/pdf','application/vnd.openxmlformats-officedocument.presentationml.presentation','image/png','image/jpeg','image/gif','image/webp']);
const normalizeAttachmentType = value => { const type=String(value||'').split(';')[0].trim().toLowerCase(); return allowedAttachmentTypes.has(type)?type:'application/octet-stream'; };
const inferredAttachment = id => { const row=db.prepare('SELECT type,metadata_json FROM documents WHERE id=?').get(id); if(!row)return null; let metadata={}; try{metadata=JSON.parse(row.metadata_json||'{}')}catch{} const name=String(metadata.attachmentName||'').toLowerCase(); const type=row.type==='pdf'?'application/pdf':row.type==='presentation'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':name.endsWith('.png')?'image/png':name.match(/\.jpe?g$/)?'image/jpeg':name.endsWith('.gif')?'image/gif':name.endsWith('.webp')?'image/webp':'application/octet-stream'; return {content_type:type}; };
const documentTypes = new Set(['document','sheet','pdf','presentation','image']);
const cleanTags = value => [...new Set((Array.isArray(value)?value:[]).map(tag=>String(tag||'').trim()).filter(Boolean).slice(0,8).map(tag=>tag.slice(0,40)))];
const cleanMetadata = value => { const source=value&&typeof value==='object'?value:{},result={}; for(const key of ['pdfId','presentationId','attachmentId'])if(source[key]===null||/^[a-f0-9-]{36}$/i.test(String(source[key]||'')))result[key]=source[key]??null; if(source.pdfPages!==undefined&&Number.isInteger(Number(source.pdfPages))&&Number(source.pdfPages)>=0&&Number(source.pdfPages)<=5000)result.pdfPages=Number(source.pdfPages); if(source.attachmentName!==undefined)result.attachmentName=String(source.attachmentName||'').slice(0,255); return result; };
const validateDocumentInput = (body,existing=null) => { const title=String(body.title??existing?.title??'').trim().replace(/\s+/g,' '),type=String(body.type??existing?.type??''),category=String(body.category??existing?.category??'未定义').trim(),content=String(body.content??existing?.content??''); if(!title||title.length>120)throw httpError(400,'标题不能为空且最多 120 个字符'); if(!documentTypes.has(type))throw httpError(400,'资料类型无效'); if(!category||category.length>40||!db.prepare('SELECT 1 FROM categories WHERE name=?').get(category))throw httpError(400,'请选择有效分类'); if(Buffer.byteLength(content,'utf8')>9_000_000)throw httpError(413,'转换后的文档内容超过 9MB，请拆分后导入'); let previousMetadata={},previousTags=[];try{previousMetadata=JSON.parse(existing?.metadata_json||'{}')}catch{}try{previousTags=JSON.parse(existing?.tags_json||'[]')}catch{} return {title,type,category,content,tags:body.tags===undefined?cleanTags(previousTags):cleanTags(body.tags),metadata:body.metadata===undefined?cleanMetadata(previousMetadata):cleanMetadata(body.metadata)}; };
const previewText = value => String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\s+/g,' ').trim().slice(0,180);
const documentListRows = (userId,deleted=false) => db.prepare(`
  SELECT d.id,d.title,d.category,d.type,d.tags_json,d.metadata_json,d.created_at,d.updated_at,d.deleted_at,d.created_by,
         substr(COALESCE(d.content,''),1,2400) AS preview_source,
         EXISTS(SELECT 1 FROM user_favorites f WHERE f.user_id=? AND f.doc_id=d.id) AS favorite
  FROM documents d WHERE d.deleted_at IS ${deleted?'NOT NULL':'NULL'} ORDER BY ${deleted?'d.deleted_at':'d.updated_at'} DESC
`).all(userId).map(({preview_source,...row})=>({...row,summary:previewText(preview_source)}));
const sessionUser = req => { const id = parseCookies(req.headers.cookie).sid; if (!id) return null; const row = db.prepare('SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled_at IS NULL').get(id, Date.now()); return row || null; };
const audit = (user, action, target='') => db.prepare('INSERT INTO audit_log(user_id,action,target,created_at) VALUES(?,?,?,?)').run(user?.id || null, action, target, now());
const runTransaction = callback => { db.exec('BEGIN IMMEDIATE'); try{const result=callback();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error} };
const requireRole = (req, res, roles) => { const user = sessionUser(req); if (!user) { send(res,401,{error:'请先登录'}); return null; } if (!roles.includes(user.role)) { send(res,403,{error:'权限不足'}); return null; } return user; };
const loginKey = (req, username) => `${req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
const loginBlocked = key => { const state=loginAttempts.get(key); return Boolean(state?.until && state.until>Date.now()); };
const loginFailed = key => { const state=loginAttempts.get(key) || {count:0,until:0,updatedAt:0}; state.count++; state.updatedAt=Date.now(); if(state.count>=5){state.until=Date.now()+5*60_000;state.count=0} loginAttempts.set(key,state); };
const cleanupTransientState = () => { const timestamp=Date.now(); db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp); for(const [key,state] of loginAttempts)if(timestamp-(state.updatedAt||state.until||0)>10*60_000)loginAttempts.delete(key); };
cleanupTransientState(); setInterval(cleanupTransientState, 60*60_000).unref();
let activeMutations=0;
const maintenanceActive = () => { try{return Date.now()-statSync(MAINTENANCE_FILE).mtimeMs<6*60*60_000}catch{return false} };

const requestHandler = async (req, res) => {
  let countedMutation=false;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!validMutationOrigin(req)) return send(res,403,{error:'请求来源无效，请刷新页面后重试'});
    if (req.method === 'GET' && url.pathname === '/api/health') { db.prepare('SELECT 1').get(); return send(res,200,{ok:true,status:'healthy',maintenance:maintenanceActive(),activeMutations,uptimeSeconds:Math.floor(process.uptime())}); }
    if (!['GET','HEAD','OPTIONS'].includes(req.method||'')) { if(maintenanceActive())return send(res,503,{error:'系统正在执行备份，请稍后重试'},{'Retry-After':'30'}); activeMutations++;countedMutation=true; }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && !sessionUser(req)) {
      const next = `${url.pathname}${url.search}`;
      return redirect(res,`/login.html?next=${encodeURIComponent(next)}`);
    }
    if (req.method === 'GET' && url.pathname === '/login.html' && sessionUser(req)) return redirect(res,'/');
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res,200,{user:sessionUser(req),bootstrapRequired:!db.prepare('SELECT 1 FROM users LIMIT 1').get()});
    if (req.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
      const { username, password } = await readBody(req);
      if (!/^[\w.-]{3,32}$/.test(username || '') || String(password || '').length < 6 || String(password || '').length>128) return send(res,400,{error:'用户名需为 3-32 位；密码需为 6-128 位'});
      if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return send(res,409,{error:'管理员已初始化'});
      const sid=randomBytes(32).toString('hex'),result=runTransaction(()=>{if(db.prepare('SELECT 1 FROM users LIMIT 1').get())throw httpError(409,'管理员已初始化');const created=db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username,hashPassword(password),'admin',now());db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sid,created.lastInsertRowid,Date.now()+7*864e5,now());for(const [index,category] of [{name:'国家标准',color:'#c56a55'},{name:'行业标准',color:'#738dae'},{name:'设计手册',color:'#6f9b84'},{name:'企业标准',color:'#9777a8'},{name:'未定义',color:'#8c9692'}].entries())db.prepare('INSERT OR IGNORE INTO categories(name,color,created_at,sort_order) VALUES(?,?,?,?)').run(category.name,category.color,now(),index+1);audit({id:created.lastInsertRowid},'初始化管理员',username);return created}); return send(res,201,{user:{id:Number(result.lastInsertRowid),username,role:'admin'}},{'Set-Cookie':sessionCookie(req,sid)});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { username,password } = await readBody(req); const key=loginKey(req,username); if(loginBlocked(key))return send(res,429,{error:'尝试次数过多，请 5 分钟后再试'}); if(String(password||'').length>128){loginFailed(key);return send(res,401,{error:'用户名或密码错误'})} const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!user || user.disabled_at || !verifyPassword(String(password || ''),user.password_hash)) { loginFailed(key); return send(res,401,{error:'用户名或密码错误'}); }
      loginAttempts.delete(key); const sid=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sid,user.id,Date.now()+7*864e5,now()); audit(user,'登录',user.username); return send(res,200,{user:{id:user.id,username:user.username,role:user.role}},{'Set-Cookie':sessionCookie(req,sid)});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const sid=parseCookies(req.headers.cookie).sid,user=sessionUser(req); if(sid)db.prepare('DELETE FROM sessions WHERE id=?').run(sid); if(user)audit(user,'退出登录',user.username); return send(res,200,{ok:true},{'Set-Cookie':sessionCookie(req,'',0)}); }
    if (req.method === 'POST' && url.pathname === '/api/auth/password') {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const {currentPassword,newPassword}=await readBody(req);
      const account=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      if(!account||!verifyPassword(String(currentPassword||''),account.password_hash))return send(res,400,{error:'当前密码不正确'});
      if(String(newPassword||'').length<6||String(newPassword||'').length>128)return send(res,400,{error:'新密码需为 6-128 位'});
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(newPassword)),user.id); const sid=parseCookies(req.headers.cookie).sid; db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(user.id,sid||''); audit(user,'修改个人密码',user.username); return send(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/users') { const user=requireRole(req,res,['admin']); if(!user)return; return send(res,200,{users:db.prepare('SELECT id,username,role,created_at,disabled_at FROM users ORDER BY id').all()}); }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {username,password,role}=await readBody(req);
      if(!/^[\w.-]{3,32}$/.test(username||'') || String(password||'').length<6 || String(password||'').length>128 || !['admin','editor','viewer'].includes(role)) return send(res,400,{error:'请填写有效用户名、6-128 位密码及角色'});
      try { const result=db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username,hashPassword(password),role,now()); audit(user,'创建用户',username); return send(res,201,{user:{id:Number(result.lastInsertRowid),username,role}}); } catch { return send(res,409,{error:'用户名已存在'}); }
    }
    const userMatch=url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && req.method === 'PUT') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {role,password,disabled}=await readBody(req); const target=db.prepare('SELECT id,username,role,password_hash,disabled_at FROM users WHERE id=?').get(Number(userMatch[1])); if(!target)return send(res,404,{error:'用户不存在'});
      if(role!==undefined&&!['admin','editor','viewer'].includes(role))return send(res,400,{error:'无效角色'}); if(password!==undefined&&(String(password).length<6||String(password).length>128))return send(res,400,{error:'密码需为 6-128 位'}); if(disabled!==undefined&&typeof disabled!=='boolean')return send(res,400,{error:'账号状态无效'});
      if(Number(target.id)===Number(user.id)&&((role&&role!=='admin')||disabled===true))return send(res,400,{error:'不能降低或停用当前管理员账号'});
      const removesAdmin=target.role==='admin'&&target.disabled_at===null&&((role!==undefined&&role!=='admin')||disabled===true);if(removesAdmin&&Number(db.prepare("SELECT COUNT(*) AS value FROM users WHERE role='admin' AND disabled_at IS NULL").get().value)<=1)return send(res,400,{error:'系统必须保留至少一个可用管理员'});
      const disabledAt=disabled===true?(target.disabled_at||now()):disabled===false?null:target.disabled_at;runTransaction(()=>{db.prepare('UPDATE users SET role=?,password_hash=?,disabled_at=? WHERE id=?').run(role??target.role,password!==undefined?hashPassword(password):target.password_hash,disabledAt,target.id);if(password!==undefined||disabled===true)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);audit(user,disabled===true?'停用用户':disabled===false?'启用用户':'更新用户',target.username)}); return send(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/users/reset-passwords') {
      const user=requireRole(req,res,['admin']); if(!user)return; const password='888888', update=db.prepare('UPDATE users SET password_hash=? WHERE id=?'),accounts=db.prepare('SELECT id FROM users').all(); runTransaction(()=>{accounts.forEach(account=>update.run(hashPassword(password),account.id));db.prepare('DELETE FROM sessions').run();audit(user,'重置全部账号密码','全部账号')}); return send(res,200,{ok:true,count:accounts.length});
    }
    if (req.method === 'GET' && url.pathname === '/api/categories') { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; return send(res,200,{categories:db.prepare('SELECT name,color FROM categories ORDER BY sort_order,name').all()}); }
    if (req.method === 'POST' && url.pathname === '/api/categories') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {name,color}=await readBody(req); const clean=String(name||'').trim().replace(/\s+/g,' ');
      if(!clean||clean.length>40||!/^#[0-9a-fA-F]{6}$/.test(String(color||'')))return send(res,400,{error:'请填写分类名称和颜色'});
      try { const sortOrder=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM categories').get().value)+1; db.prepare('INSERT INTO categories(name,color,created_at,sort_order) VALUES(?,?,?,?)').run(clean,color,now(),sortOrder); audit(user,'创建分类',clean); return send(res,201,{category:{name:clean,color}}); } catch { return send(res,409,{error:'分类已存在'}); }
    }
    if (req.method === 'PUT' && url.pathname === '/api/categories/order') { const user=requireRole(req,res,['admin']); if(!user)return; const {order}=await readBody(req); if(!Array.isArray(order))return send(res,400,{error:'分类排序数据无效'}); const names=db.prepare('SELECT name FROM categories').all().map(row=>row.name); if(order.length!==names.length||new Set(order).size!==names.length||order.some(name=>!names.includes(name)))return send(res,400,{error:'分类排序不完整'}); const update=db.prepare('UPDATE categories SET sort_order=? WHERE name=?'); runTransaction(()=>{order.forEach((name,index)=>update.run(index+1,name));audit(user,'调整分类顺序',order.join('、'))}); return send(res,200,{ok:true}); }
    const categoryMatch=url.pathname.match(/^\/api\/categories\/(.+)$/);
    if (categoryMatch && req.method === 'DELETE') {
      const user=requireRole(req,res,['admin']); if(!user)return; const name=safeDecode(categoryMatch[1]);
      if(name==='未定义')return send(res,400,{error:'“未定义”是系统保留分类，不能删除'}); const existing=db.prepare('SELECT name FROM categories WHERE name=?').get(name); if(!existing)return send(res,404,{error:'分类不存在'});
      runTransaction(()=>{db.prepare('INSERT OR IGNORE INTO categories(name,color,created_at) VALUES(?,?,?)').run('未定义','#8c9692',now());db.prepare('UPDATE documents SET category=?,updated_at=? WHERE category=?').run('未定义',now(),name);db.prepare('DELETE FROM categories WHERE name=?').run(name);audit(user,'删除分类',name)}); return send(res,200,{ok:true,movedTo:'未定义'});
    }
    const attachmentMatch=url.pathname.match(/^\/api\/attachments\/([a-f0-9-]{36})$/i);
    if (attachmentMatch && req.method === 'PUT') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const id=attachmentMatch[1],contentType=normalizeAttachmentType(req.headers['content-type']),size=await writeAttachment(req,join(ATTACHMENT_DIR,id));
      db.prepare('INSERT INTO attachment_files(id,content_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_type=excluded.content_type,size=excluded.size,uploaded_by=excluded.uploaded_by,created_at=excluded.created_at').run(id,contentType,size,user.id,now()); audit(user,'上传附件',id); return send(res,201,{id,size,contentType});
    }
    if (attachmentMatch && req.method === 'DELETE') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const id=attachmentMatch[1]; if(db.prepare('SELECT 1 FROM documents WHERE id=?').get(id))return send(res,409,{error:'附件已关联资料，不能单独删除'});
      try{await unlink(join(ATTACHMENT_DIR,id))}catch(error){if(error.code!=='ENOENT')throw error} db.prepare('DELETE FROM attachment_files WHERE id=?').run(id); audit(user,'清理未关联附件',id); return send(res,200,{ok:true});
    }
    if (attachmentMatch && (req.method === 'GET'||req.method === 'HEAD')) {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const id=attachmentMatch[1],file=join(ATTACHMENT_DIR,id); if(!existsSync(file))return send(res,404,{error:'附件不存在'}); const fileStat=await stat(file),stored=db.prepare('SELECT content_type FROM attachment_files WHERE id=?').get(id)||inferredAttachment(id)||{},contentType=normalizeAttachmentType(stored.content_type),range=String(req.headers.range||'').match(/^bytes=(\d*)-(\d*)$/);
      let start=0,end=fileStat.size-1,status=200; if(range){start=range[1]?Number(range[1]):0; end=range[2]?Number(range[2]):end; if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=fileStat.size){res.writeHead(416,{...baseHeaders,'Content-Range':`bytes */${fileStat.size}`});return res.end()} end=Math.min(end,fileStat.size-1);status=206}
      const headers={...baseHeaders,'Content-Type':contentType,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600'}; if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${fileStat.size}`; res.writeHead(status,headers); if(req.method==='HEAD')return res.end(); return createReadStream(file,{start,end}).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/documents') { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; return send(res,200,{documents:documentListRows(user.id)}); }
    if (req.method === 'GET' && url.pathname === '/api/documents/trash') { const user=requireRole(req,res,['admin','editor']); if(!user)return; return send(res,200,{documents:documentListRows(user.id,true)}); }
    if (req.method === 'GET' && url.pathname === '/api/documents/search') {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const query=String(url.searchParams.get('q')||'').trim().slice(0,100); if(!query)return send(res,200,{ids:[]});
      const escaped=query.replace(/[\\%_]/g,character=>`\\${character}`),pattern=`%${escaped}%`;
      const ids=db.prepare("SELECT id FROM documents WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 500").all(pattern,pattern,pattern,pattern).map(row=>row.id);
      return send(res,200,{ids,truncated:ids.length===500});
    }
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const body=await readBody(req),clean=validateDocumentInput(body);
      const id=/^[a-f0-9-]{36}$/i.test(String(body.id||'')) ? body.id : randomUUID(), timestamp=now();
      if (db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)) return send(res,409,{error:'资料已存在'});
      db.prepare('INSERT INTO documents(id,title,category,type,tags_json,content,metadata_json,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,clean.title,clean.category,clean.type,JSON.stringify(clean.tags),clean.content,JSON.stringify(clean.metadata),timestamp,timestamp,user.username); audit(user,'创建资料',clean.title); return send(res,201,{id});
    }
    const favoriteMatch=url.pathname.match(/^\/api\/documents\/([\w-]+)\/favorite$/);
    if (favoriteMatch && req.method === 'PUT') {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const {favorite}=await readBody(req); const document=db.prepare('SELECT id FROM documents WHERE id=? AND deleted_at IS NULL').get(favoriteMatch[1]); if(!document)return send(res,404,{error:'资料不存在'});
      if(favorite)db.prepare('INSERT OR IGNORE INTO user_favorites(user_id,doc_id,created_at) VALUES(?,?,?)').run(user.id,document.id,now()); else db.prepare('DELETE FROM user_favorites WHERE user_id=? AND doc_id=?').run(user.id,document.id); audit(user,favorite?'收藏资料':'取消收藏',document.id); return send(res,200,{ok:true,favorite:!!favorite});
    }
    const commentMatch=url.pathname.match(/^\/api\/documents\/([\w-]+)\/comments(?:\/(\d+))?$/);
    if (commentMatch && req.method === 'GET' && !commentMatch[2]) {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return;
      const document=db.prepare('SELECT id FROM documents WHERE id=? AND deleted_at IS NULL').get(commentMatch[1]); if(!document)return send(res,404,{error:'资料不存在或已删除'});
      const comments=db.prepare('SELECT id,doc_id,user_id,parent_id,username,content,created_at,deleted_at FROM document_comments WHERE doc_id=? ORDER BY id ASC').all(document.id).map(comment=>({...comment,content:comment.deleted_at?'':comment.content,can_delete:!comment.deleted_at&&(user.role==='admin'||Number(comment.user_id)===Number(user.id)),can_reply:!comment.deleted_at}));
      return send(res,200,{comments});
    }
    if (commentMatch && req.method === 'POST' && !commentMatch[2]) {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const {content,parentId}=await readBody(req); const clean=String(content||'').trim();
      if(!clean)return send(res,400,{error:'评论内容不能为空'}); if(clean.length>2000)return send(res,400,{error:'评论最多 2000 个字符'});
      const document=db.prepare('SELECT id,title FROM documents WHERE id=? AND deleted_at IS NULL').get(commentMatch[1]); if(!document)return send(res,404,{error:'资料不存在或已删除'});
      const parentIdValue=parentId===null||parentId===undefined||parentId===''?null:Number(parentId); if(parentIdValue!==null&&(!Number.isSafeInteger(parentIdValue)||parentIdValue<1))return send(res,400,{error:'回复目标无效'}); if(parentIdValue!==null&&!db.prepare('SELECT id FROM document_comments WHERE id=? AND doc_id=? AND deleted_at IS NULL').get(parentIdValue,document.id))return send(res,404,{error:'要回复的评论不存在或已删除'}); if(parentIdValue!==null){let depth=0,current=parentIdValue;while(current!==null&&depth<6){const row=db.prepare('SELECT parent_id FROM document_comments WHERE id=? AND doc_id=?').get(current,document.id);current=row?.parent_id??null;depth++}if(depth>=5)return send(res,400,{error:'评论回复最多支持 5 层'});}
      const timestamp=now(), result=db.prepare('INSERT INTO document_comments(doc_id,user_id,parent_id,username,content,created_at) VALUES(?,?,?,?,?,?)').run(document.id,user.id,parentIdValue,user.username,clean,timestamp);
      audit(user,parentIdValue===null?'发表评论':'回复评论',document.title); return send(res,201,{comment:{id:Number(result.lastInsertRowid),doc_id:document.id,user_id:user.id,parent_id:parentIdValue,username:user.username,content:clean,created_at:timestamp,can_delete:true,can_reply:true}});
    }
    if (commentMatch && req.method === 'DELETE' && commentMatch[2]) {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const comment=db.prepare('SELECT c.id,c.user_id,c.username,c.deleted_at,d.title FROM document_comments c JOIN documents d ON d.id=c.doc_id WHERE c.id=? AND c.doc_id=?').get(Number(commentMatch[2]),commentMatch[1]);
      if(!comment)return send(res,404,{error:'评论不存在'}); if(user.role!=='admin'&&Number(comment.user_id)!==Number(user.id))return send(res,403,{error:'只能删除自己的评论'});
      if(comment.deleted_at)return send(res,404,{error:'评论已删除'}); db.prepare('UPDATE document_comments SET content=?,deleted_at=? WHERE id=?').run('',now(),comment.id); audit(user,'删除评论',comment.title); return send(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/documents/batch-delete') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const {ids}=await readBody(req); const clean=[...new Set(Array.isArray(ids)?ids.filter(id=>/^[\w-]+$/.test(String(id))).slice(0,100):[])];
      if(!clean.length)return send(res,400,{error:'请选择要删除的资料'}); const update=db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL'); let count=0; runTransaction(()=>{clean.forEach(id=>{const timestamp=now();count+=Number(update.run(timestamp,timestamp,id).changes)});audit(user,'批量移入回收站',`${count} 份资料`)}); return send(res,200,{ok:true,count});
    }
    if (req.method === 'POST' && url.pathname === '/api/documents/batch-restore') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const {ids}=await readBody(req); const clean=[...new Set(Array.isArray(ids)?ids.filter(id=>/^[\w-]+$/.test(String(id))).slice(0,100):[])];
      if(!clean.length)return send(res,400,{error:'请选择要恢复的资料'}); const update=db.prepare('UPDATE documents SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL'); let count=0; runTransaction(()=>{clean.forEach(id=>{count+=Number(update.run(now(),id).changes)});audit(user,'批量恢复资料',`${count} 份资料`)}); return send(res,200,{ok:true,count});
    }
    const docMatch=url.pathname.match(/^\/api\/documents\/([\w-]+)(?:\/(restore))?$/);
    if (docMatch && req.method === 'GET' && !docMatch[2]) { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const document=db.prepare('SELECT d.*, EXISTS(SELECT 1 FROM user_favorites f WHERE f.user_id=? AND f.doc_id=d.id) AS favorite FROM documents d WHERE d.id=?').get(user.id,docMatch[1]); if(!document||(document.deleted_at&&user.role==='viewer'))return send(res,404,{error:'资料不存在'}); return send(res,200,{document}); }
    if (docMatch && req.method === 'PUT' && !docMatch[2]) {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const body=await readBody(req); const existing=db.prepare('SELECT * FROM documents WHERE id=?').get(docMatch[1]); if(!existing)return send(res,404,{error:'资料不存在'}); const clean=validateDocumentInput(body,existing);
      db.prepare('UPDATE documents SET title=?,category=?,type=?,tags_json=?,content=?,metadata_json=?,updated_at=? WHERE id=?').run(clean.title,clean.category,clean.type,JSON.stringify(clean.tags),clean.content,JSON.stringify(clean.metadata),now(),docMatch[1]); audit(user,'编辑资料',existing.title); return send(res,200,{ok:true});
    }
    if (docMatch && req.method === 'DELETE' && !docMatch[2] && url.searchParams.get('purge') === '1') { const user=requireRole(req,res,['admin']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'请先将资料移入回收站'}); db.prepare('DELETE FROM documents WHERE id=?').run(docMatch[1]); db.prepare('DELETE FROM attachment_files WHERE id=?').run(docMatch[1]); try{await unlink(join(ATTACHMENT_DIR,docMatch[1]))}catch(error){if(error.code!=='ENOENT')throw error} audit(user,'永久删除资料',existing.title); return send(res,200,{ok:true}); }
    if (docMatch && req.method === 'DELETE' && !docMatch[2]) { const user=requireRole(req,res,['admin','editor']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'资料不存在或已删除'}); db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=?').run(now(),now(),docMatch[1]); audit(user,'移入回收站',existing.title); return send(res,200,{ok:true}); }
    if (docMatch && req.method === 'POST' && docMatch[2] === 'restore') { const user=requireRole(req,res,['admin','editor']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'回收站中未找到资料'}); db.prepare('UPDATE documents SET deleted_at=NULL,updated_at=? WHERE id=?').run(now(),docMatch[1]); audit(user,'恢复资料',existing.title); return send(res,200,{ok:true}); }
    if (req.method === 'GET' && url.pathname === '/api/audit') { const user=requireRole(req,res,['admin']); if(!user)return; return send(res,200,{items:db.prepare('SELECT a.*,u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all()}); }
    if (url.pathname.startsWith('/api/')) return send(res,404,{error:'接口不存在'});
    if (!['GET','HEAD'].includes(req.method||'')) return send(res,405,{error:'请求方法不支持'},{Allow:'GET, HEAD'});
    const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/,'').replace(/\\/g,'/');
    const file=staticFiles.get(requested); if (!file||!existsSync(file)) { res.writeHead(404,{...baseHeaders,'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    const fileStat=await stat(file),cacheControl=requested.startsWith('vendor/')?'public, max-age=3600':'no-store'; res.writeHead(200,{...baseHeaders,'Content-Type':mime[extname(file).toLowerCase()]||'application/octet-stream','Content-Length':String(fileStat.size),'Cache-Control':cacheControl}); if(req.method==='HEAD')return res.end(); return createReadStream(file).pipe(res);
  } catch (error) { console.error(error); if (!res.headersSent) { const status=Number(error.status)||500; send(res,status,{error:status<500?(error.message||'请求失败'):'服务端内部错误'}); } }
  finally { if(countedMutation)activeMutations=Math.max(0,activeMutations-1); }
};

const PORT = Number(process.env.PORT || 8787); const HOST = process.env.HOST || '127.0.0.1';
const tlsCert=process.env.TLS_CERT, tlsKey=process.env.TLS_KEY;
if(Boolean(tlsCert)!==Boolean(tlsKey))throw new Error('启用 HTTPS 时必须同时设置 TLS_CERT 和 TLS_KEY');
const server=tlsCert?createHttpsServer({cert:readFileSync(resolve(tlsCert)),key:readFileSync(resolve(tlsKey))},requestHandler):createHttpServer(requestHandler);
server.listen(PORT,HOST,()=>console.log(`知识库服务已启动：${tlsCert?'https':'http'}://${HOST}:${PORT}`));
server.headersTimeout=15_000; server.requestTimeout=10*60_000; server.keepAliveTimeout=5_000; server.maxRequestsPerSocket=1_000;
server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')});
const shutdown = signal => { console.log(`收到 ${signal}，正在安全停止服务…`); server.close(()=>{try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close()}finally{process.exit(0)}}); setTimeout(()=>process.exit(1),10_000).unref(); };
process.once('SIGINT',()=>shutdown('SIGINT')); process.once('SIGTERM',()=>shutdown('SIGTERM'));
