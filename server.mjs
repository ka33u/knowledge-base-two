/**
 * 局域网知识库服务：Node.js 25+（使用内置 node:sqlite，无第三方依赖）。
 * 默认只监听本机；设置 HOST=0.0.0.0 后可供局域网访问。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
await mkdir(DATA_DIR, { recursive: true });
const ATTACHMENT_DIR = join(DATA_DIR, 'attachments');
await mkdir(ATTACHMENT_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'knowledge.db'));
const loginAttempts = new Map();
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), created_at TEXT NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_document_comments_doc_created ON document_comments(doc_id, id);
`);
if (!db.prepare("PRAGMA table_info(categories)").all().some(column => column.name === 'sort_order')) db.exec('ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
if (!db.prepare("PRAGMA table_info(documents)").all().some(column => column.name === 'created_by')) db.exec("ALTER TABLE documents ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(document_comments)").all().some(column => column.name === 'parent_id')) db.exec('ALTER TABLE document_comments ADD COLUMN parent_id INTEGER REFERENCES document_comments(id) ON DELETE SET NULL');
if (!db.prepare("PRAGMA table_info(document_comments)").all().some(column => column.name === 'deleted_at')) db.exec('ALTER TABLE document_comments ADD COLUMN deleted_at TEXT');
db.exec('UPDATE categories SET sort_order=rowid WHERE sort_order=0');
db.exec("UPDATE documents SET created_by='系统迁移' WHERE created_by IS NULL OR created_by=''");

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const staticFiles = new Set(['index.html','login.html','app.js','styles.css']);
const now = () => new Date().toISOString();
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => { const [salt, hash] = stored.split(':'); const candidate = scryptSync(password, salt, 64); return timingSafeEqual(candidate, Buffer.from(hash, 'hex')); };
const parseCookies = value => Object.fromEntries((value || '').split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
const send = (res, status, payload, headers = {}) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(payload)); };
const readBody = req => new Promise((resolve, reject) => { let data=''; let done=false; req.on('data', chunk => { data += chunk; if(data.length > 10_000_000 && !done) { done=true; reject(new Error('请求过大（最大 10MB）')); req.destroy(); } }); req.on('end', () => { if(done)return; try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON 格式无效')); } }); req.on('error', reject); });
const readBuffer = req => new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>100*1024*1024){reject(new Error('附件超过 100MB'));req.destroy();return}chunks.push(chunk)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)});
const sessionUser = req => { const id = parseCookies(req.headers.cookie).sid; if (!id) return null; const row = db.prepare('SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?').get(id, Date.now()); return row || null; };
const audit = (user, action, target='') => db.prepare('INSERT INTO audit_log(user_id,action,target,created_at) VALUES(?,?,?,?)').run(user?.id || null, action, target, now());
const requireRole = (req, res, roles) => { const user = sessionUser(req); if (!user) { send(res,401,{error:'请先登录'}); return null; } if (!roles.includes(user.role)) { send(res,403,{error:'权限不足'}); return null; } return user; };
const loginKey = (req, username) => `${req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
const loginBlocked = key => { const state=loginAttempts.get(key); return state?.until && state.until>Date.now(); };
const loginFailed = key => { const state=loginAttempts.get(key) || {count:0,until:0}; state.count++; if(state.count>=5){state.until=Date.now()+5*60_000;state.count=0} loginAttempts.set(key,state); };
const cleanupSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
cleanupSessions(); setInterval(cleanupSessions, 60*60_000).unref();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && !sessionUser(req)) {
      const next = `${url.pathname}${url.search}`;
      res.writeHead(302,{Location:`/login.html?next=${encodeURIComponent(next)}`}); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/login.html' && sessionUser(req)) { res.writeHead(302,{Location:'/'}); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res,200,{user:sessionUser(req),bootstrapRequired:!db.prepare('SELECT 1 FROM users LIMIT 1').get()});
    if (req.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
      if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return send(res,409,{error:'管理员已初始化'});
      const { username, password } = await readBody(req);
      if (!/^[\w.-]{3,32}$/.test(username || '') || String(password || '').length < 6) return send(res,400,{error:'用户名需为 3-32 位；密码至少 6 位'});
      const result = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username,hashPassword(password),'admin',now());
      const sid=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sid,result.lastInsertRowid,Date.now()+7*864e5,now());
      for (const [index,category] of [{name:'国家标准',color:'#c56a55'},{name:'行业标准',color:'#738dae'},{name:'设计手册',color:'#6f9b84'},{name:'企业标准',color:'#9777a8'},{name:'未定义',color:'#8c9692'}].entries()) db.prepare('INSERT OR IGNORE INTO categories(name,color,created_at,sort_order) VALUES(?,?,?,?)').run(category.name,category.color,now(),index+1);
      audit({id:result.lastInsertRowid},'初始化管理员',username); return send(res,201,{user:{id:Number(result.lastInsertRowid),username,role:'admin'}},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { username,password } = await readBody(req); const key=loginKey(req,username); if(loginBlocked(key))return send(res,429,{error:'尝试次数过多，请 5 分钟后再试'}); const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!user || !verifyPassword(String(password || ''),user.password_hash)) { loginFailed(key); return send(res,401,{error:'用户名或密码错误'}); }
      loginAttempts.delete(key); const sid=randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sid,user.id,Date.now()+7*864e5,now()); audit(user,'登录',user.username); return send(res,200,{user:{id:user.id,username:user.username,role:user.role}},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const user=sessionUser(req); if(user)audit(user,'退出登录',user.username); return send(res,200,{ok:true},{'Set-Cookie':'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}); }
    if (req.method === 'POST' && url.pathname === '/api/auth/password') {
      const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const {currentPassword,newPassword}=await readBody(req);
      const account=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      if(!account||!verifyPassword(String(currentPassword||''),account.password_hash))return send(res,400,{error:'当前密码不正确'});
      if(String(newPassword||'').length<6)return send(res,400,{error:'新密码至少 6 位'});
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(newPassword)),user.id); const sid=parseCookies(req.headers.cookie).sid; db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(user.id,sid||''); audit(user,'修改个人密码',user.username); return send(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/users') { const user=requireRole(req,res,['admin']); if(!user)return; return send(res,200,{users:db.prepare('SELECT id,username,role,created_at FROM users ORDER BY id').all()}); }
    if (req.method === 'POST' && url.pathname === '/api/users') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {username,password,role}=await readBody(req);
      if(!/^[\w.-]{3,32}$/.test(username||'') || String(password||'').length<6 || !['admin','editor','viewer'].includes(role)) return send(res,400,{error:'请填写有效用户名、至少 6 位密码及角色'});
      try { const result=db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username,hashPassword(password),role,now()); audit(user,'创建用户',username); return send(res,201,{user:{id:Number(result.lastInsertRowid),username,role}}); } catch { return send(res,409,{error:'用户名已存在'}); }
    }
    const userMatch=url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && req.method === 'PUT') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {role,password}=await readBody(req); const target=db.prepare('SELECT id,username,role FROM users WHERE id=?').get(Number(userMatch[1])); if(!target)return send(res,404,{error:'用户不存在'});
      if(role!==undefined&&!['admin','editor','viewer'].includes(role))return send(res,400,{error:'无效角色'}); if(password!==undefined&&String(password).length<6)return send(res,400,{error:'密码至少 6 位'});
      if(Number(target.id)===Number(user.id)&&role&&role!=='admin')return send(res,400,{error:'不能降低当前管理员权限'});
      db.prepare('UPDATE users SET role=?,password_hash=? WHERE id=?').run(role??target.role,password!==undefined?hashPassword(password):db.prepare('SELECT password_hash FROM users WHERE id=?').get(target.id).password_hash,target.id); if(password!==undefined)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); audit(user,'更新用户',target.username); return send(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/users/reset-passwords') {
      const user=requireRole(req,res,['admin']); if(!user)return; const password='888888', update=db.prepare('UPDATE users SET password_hash=? WHERE id=?'); const accounts=db.prepare('SELECT id FROM users').all(); accounts.forEach(account=>update.run(hashPassword(password),account.id)); db.prepare('DELETE FROM sessions').run(); audit(user,'重置全部账号密码','全部账号'); return send(res,200,{ok:true,count:accounts.length});
    }
    if (req.method === 'GET' && url.pathname === '/api/categories') { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; return send(res,200,{categories:db.prepare('SELECT name,color FROM categories ORDER BY sort_order,name').all()}); }
    if (req.method === 'POST' && url.pathname === '/api/categories') {
      const user=requireRole(req,res,['admin']); if(!user)return; const {name,color}=await readBody(req); const clean=String(name||'').trim().replace(/\s+/g,' ');
      if(!clean||clean.length>40||!/^#[0-9a-fA-F]{6}$/.test(String(color||'')))return send(res,400,{error:'请填写分类名称和颜色'});
      try { const sortOrder=Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM categories').get().value)+1; db.prepare('INSERT INTO categories(name,color,created_at,sort_order) VALUES(?,?,?,?)').run(clean,color,now(),sortOrder); audit(user,'创建分类',clean); return send(res,201,{category:{name:clean,color}}); } catch { return send(res,409,{error:'分类已存在'}); }
    }
    if (req.method === 'PUT' && url.pathname === '/api/categories/order') { const user=requireRole(req,res,['admin']); if(!user)return; const {order}=await readBody(req); if(!Array.isArray(order))return send(res,400,{error:'分类排序数据无效'}); const names=db.prepare('SELECT name FROM categories').all().map(row=>row.name); if(order.length!==names.length||new Set(order).size!==names.length||order.some(name=>!names.includes(name)))return send(res,400,{error:'分类排序不完整'}); const update=db.prepare('UPDATE categories SET sort_order=? WHERE name=?'); order.forEach((name,index)=>update.run(index+1,name)); audit(user,'调整分类顺序',order.join('、')); return send(res,200,{ok:true}); }
    const categoryMatch=url.pathname.match(/^\/api\/categories\/(.+)$/);
    if (categoryMatch && req.method === 'DELETE') {
      const user=requireRole(req,res,['admin']); if(!user)return; const name=decodeURIComponent(categoryMatch[1]);
      if(name==='未定义')return send(res,400,{error:'“未定义”是系统保留分类，不能删除'}); const existing=db.prepare('SELECT name FROM categories WHERE name=?').get(name); if(!existing)return send(res,404,{error:'分类不存在'});
      db.prepare('INSERT OR IGNORE INTO categories(name,color,created_at) VALUES(?,?,?)').run('未定义','#8c9692',now()); db.prepare('UPDATE documents SET category=?,updated_at=? WHERE category=?').run('未定义',now(),name); db.prepare('DELETE FROM categories WHERE name=?').run(name); audit(user,'删除分类',name); return send(res,200,{ok:true,movedTo:'未定义'});
    }
    const attachmentMatch=url.pathname.match(/^\/api\/attachments\/([a-f0-9-]{36})$/i);
    if (attachmentMatch && req.method === 'PUT') { const user=requireRole(req,res,['admin','editor']); if(!user)return; const bytes=await readBuffer(req); await writeFile(join(ATTACHMENT_DIR,attachmentMatch[1]),bytes); audit(user,'上传附件',attachmentMatch[1]); return send(res,201,{id:attachmentMatch[1],size:bytes.length}); }
    if (attachmentMatch && req.method === 'GET') { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; const file=join(ATTACHMENT_DIR,attachmentMatch[1]); if(!existsSync(file))return send(res,404,{error:'附件不存在'}); res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store'}); return res.end(await readFile(file)); }
    if (req.method === 'GET' && url.pathname === '/api/documents') { const user=requireRole(req,res,['admin','editor','viewer']); if(!user)return; return send(res,200,{documents:db.prepare('SELECT d.*, EXISTS(SELECT 1 FROM user_favorites f WHERE f.user_id=? AND f.doc_id=d.id) AS favorite FROM documents d WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC').all(user.id)}); }
    if (req.method === 'GET' && url.pathname === '/api/documents/trash') { const user=requireRole(req,res,['admin','editor']); if(!user)return; return send(res,200,{documents:db.prepare('SELECT d.*, EXISTS(SELECT 1 FROM user_favorites f WHERE f.user_id=? AND f.doc_id=d.id) AS favorite FROM documents d WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC').all(user.id)}); }
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const body=await readBody(req);
      if (!String(body.title||'').trim() || !String(body.type||'').trim()) return send(res,400,{error:'标题和类型不能为空'});
      const id=/^[a-f0-9-]{36}$/i.test(String(body.id||'')) ? body.id : randomUUID(), timestamp=now(), metadata=body.metadata&&typeof body.metadata==='object'?{...body.metadata}:{}; delete metadata.favorite;
      if (db.prepare('SELECT 1 FROM documents WHERE id=?').get(id)) return send(res,409,{error:'资料已存在'});
      db.prepare('INSERT INTO documents(id,title,category,type,tags_json,content,metadata_json,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,String(body.title).trim(),String(body.category||''),String(body.type),JSON.stringify(Array.isArray(body.tags)?body.tags:[]),String(body.content||''),JSON.stringify(metadata),timestamp,timestamp,user.username); audit(user,'创建资料',body.title); return send(res,201,{id});
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
      const parentIdValue=parentId===null||parentId===undefined||parentId===''?null:Number(parentId); if(parentIdValue!==null&&(!Number.isSafeInteger(parentIdValue)||parentIdValue<1))return send(res,400,{error:'回复目标无效'}); if(parentIdValue!==null&&!db.prepare('SELECT id FROM document_comments WHERE id=? AND doc_id=? AND deleted_at IS NULL').get(parentIdValue,document.id))return send(res,404,{error:'要回复的评论不存在或已删除'});
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
      if(!clean.length)return send(res,400,{error:'请选择要删除的资料'}); const update=db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL'); let count=0; clean.forEach(id=>{count+=Number(update.run(now(),now(),id).changes)}); audit(user,'批量移入回收站',`${count} 份资料`); return send(res,200,{ok:true,count});
    }
    if (req.method === 'POST' && url.pathname === '/api/documents/batch-restore') {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const {ids}=await readBody(req); const clean=[...new Set(Array.isArray(ids)?ids.filter(id=>/^[\w-]+$/.test(String(id))).slice(0,100):[])];
      if(!clean.length)return send(res,400,{error:'请选择要恢复的资料'}); const update=db.prepare('UPDATE documents SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL'); let count=0; clean.forEach(id=>{count+=Number(update.run(now(),id).changes)}); audit(user,'批量恢复资料',`${count} 份资料`); return send(res,200,{ok:true,count});
    }
    const docMatch=url.pathname.match(/^\/api\/documents\/([\w-]+)(?:\/(restore))?$/);
    if (docMatch && req.method === 'PUT' && !docMatch[2]) {
      const user=requireRole(req,res,['admin','editor']); if(!user)return; const body=await readBody(req); const existing=db.prepare('SELECT * FROM documents WHERE id=?').get(docMatch[1]); if(!existing)return send(res,404,{error:'资料不存在'});
      const metadata=body.metadata&&typeof body.metadata==='object'?{...body.metadata}:{...JSON.parse(existing.metadata_json)}; delete metadata.favorite;
      db.prepare('UPDATE documents SET title=?,category=?,type=?,tags_json=?,content=?,metadata_json=?,updated_at=? WHERE id=?').run(String(body.title??existing.title).trim(),String(body.category??existing.category),String(body.type??existing.type),JSON.stringify(Array.isArray(body.tags)?body.tags:JSON.parse(existing.tags_json)),String(body.content??existing.content),JSON.stringify(metadata),now(),docMatch[1]); audit(user,'编辑资料',existing.title); return send(res,200,{ok:true});
    }
    if (docMatch && req.method === 'DELETE' && !docMatch[2] && url.searchParams.get('purge') === '1') { const user=requireRole(req,res,['admin']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'请先将资料移入回收站'}); db.prepare('DELETE FROM documents WHERE id=?').run(docMatch[1]); try{await unlink(join(ATTACHMENT_DIR,docMatch[1]))}catch(error){if(error.code!=='ENOENT')throw error} audit(user,'永久删除资料',existing.title); return send(res,200,{ok:true}); }
    if (docMatch && req.method === 'DELETE' && !docMatch[2]) { const user=requireRole(req,res,['admin','editor']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'资料不存在或已删除'}); db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=?').run(now(),now(),docMatch[1]); audit(user,'移入回收站',existing.title); return send(res,200,{ok:true}); }
    if (docMatch && req.method === 'POST' && docMatch[2] === 'restore') { const user=requireRole(req,res,['admin','editor']); if(!user)return; const existing=db.prepare('SELECT title FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(docMatch[1]); if(!existing)return send(res,404,{error:'回收站中未找到资料'}); db.prepare('UPDATE documents SET deleted_at=NULL,updated_at=? WHERE id=?').run(now(),docMatch[1]); audit(user,'恢复资料',existing.title); return send(res,200,{ok:true}); }
    if (req.method === 'GET' && url.pathname === '/api/audit') { const user=requireRole(req,res,['admin']); if(!user)return; return send(res,200,{items:db.prepare('SELECT a.*,u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all()}); }
    if (url.pathname.startsWith('/api/')) return send(res,404,{error:'接口不存在'});
    const requested = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[/\\]+/,'');
    if (!staticFiles.has(requested)) { res.writeHead(404,{'X-Content-Type-Options':'nosniff'}); return res.end('Not found'); }
    const file = join(ROOT, requested); if (!existsSync(file)) { res.writeHead(404,{'X-Content-Type-Options':'nosniff'}); return res.end('Not found'); }
    res.writeHead(200,{'Content-Type':mime[extname(file).toLowerCase()],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'same-origin'}); res.end(await readFile(file));
  } catch (error) { console.error(error); if (!res.headersSent) send(res,500,{error:error.message || '服务端错误'}); }
});

const PORT = Number(process.env.PORT || 8787); const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT,HOST,()=>console.log(`知识库服务已启动：http://${HOST}:${PORT}`));
