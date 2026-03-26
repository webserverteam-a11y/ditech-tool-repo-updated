import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// --- Auth config ---
const DB_USER = process.env.DB_USER || 'admin';
const DB_PASS = process.env.DB_PASS || 'admin';
const COOKIE_NAME = 'db_session';
const sessions = new Map(); // token -> expiry

function getDb() {
  return new Database(DB_PATH);
}

// Ensure the DB file exists with WAL mode
(() => {
  const db = getDb();
  db.pragma('journal_mode = WAL');
  db.close();
})();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // 24h
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── LOGIN PAGE ────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DB Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2.5rem;width:100%;max-width:380px;box-shadow:0 25px 50px rgba(0,0,0,.4)}
h1{font-size:1.5rem;text-align:center;margin-bottom:.5rem;color:#f8fafc}
.sub{text-align:center;color:#94a3b8;font-size:.875rem;margin-bottom:1.5rem}
label{display:block;font-size:.875rem;color:#94a3b8;margin-bottom:.375rem}
input{width:100%;padding:.625rem .75rem;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f1f5f9;font-size:.9rem;margin-bottom:1rem;outline:none;transition:border .2s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:.75rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .2s}
button:hover{background:#2563eb}
.err{color:#f87171;font-size:.8rem;text-align:center;margin-bottom:1rem;display:none}
</style></head><body>
<div class="card">
<h1>&#128274; Database Admin</h1>
<p class="sub">Enter credentials to continue</p>
<div class="err" id="err">Invalid username or password</div>
<form id="f" method="POST" action="/db-access/login">
<label for="u">Username</label>
<input id="u" name="username" required autocomplete="username">
<label for="p">Password</label>
<input id="p" name="password" type="password" required autocomplete="current-password">
<button type="submit">Sign In</button>
</form>
</div>
<script>
const params=new URLSearchParams(location.search);
if(params.get('error')==='1')document.getElementById('err').style.display='block';
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const res=await fetch('/db-access/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:fd.get('username'),password:fd.get('password')})});
  if(res.ok){location.href='/db-access'}else{document.getElementById('err').style.display='block'}
});
</script></body></html>`;

// ─── ADMIN PANEL ───────────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Database Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:.75rem 1.5rem;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:1.1rem;color:#f8fafc}header h1 span{color:#3b82f6}
.logout{color:#94a3b8;text-decoration:none;font-size:.85rem;padding:.4rem .75rem;border:1px solid #475569;border-radius:6px;transition:all .2s}
.logout:hover{color:#f87171;border-color:#f87171}
.wrap{display:flex;flex:1;overflow:hidden}
.sidebar{width:220px;background:#1e293b;border-right:1px solid #334155;padding:1rem 0;overflow-y:auto;flex-shrink:0}
.sidebar h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;padding:0 1rem;margin-bottom:.5rem}
.sidebar .tbl{display:block;padding:.45rem 1rem;color:#cbd5e1;text-decoration:none;font-size:.875rem;cursor:pointer;transition:background .15s}
.sidebar .tbl:hover,.sidebar .tbl.active{background:#334155;color:#f1f5f9}
.sidebar .count{color:#64748b;font-size:.75rem;margin-left:.25rem}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.query-box{padding:1rem 1.5rem;background:#1e293b;border-bottom:1px solid #334155}
.query-box textarea{width:100%;min-height:80px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f1f5f9;padding:.75rem;font-family:'Cascadia Code','Fira Code',monospace;font-size:.85rem;resize:vertical;outline:none;transition:border .2s}
.query-box textarea:focus{border-color:#3b82f6}
.query-actions{display:flex;gap:.5rem;margin-top:.5rem;align-items:center}
.btn{padding:.5rem 1rem;border:none;border-radius:6px;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .15s}
.btn-primary{background:#3b82f6;color:#fff}.btn-primary:hover{background:#2563eb}
.btn-secondary{background:#334155;color:#cbd5e1}.btn-secondary:hover{background:#475569}
.status{font-size:.8rem;color:#94a3b8;margin-left:auto}
.result-area{flex:1;overflow:auto;padding:1rem 1.5rem}
.result-area table{width:100%;border-collapse:collapse;font-size:.825rem}
.result-area th{background:#334155;color:#94a3b8;text-transform:uppercase;font-size:.7rem;letter-spacing:.04em;padding:.5rem .75rem;text-align:left;position:sticky;top:0;border-bottom:2px solid #475569}
.result-area td{padding:.45rem .75rem;border-bottom:1px solid #1e293b;color:#e2e8f0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.result-area tr:hover td{background:#1e293b}
.result-area tr:nth-child(even) td{background:rgba(30,41,59,.5)}
.empty{text-align:center;color:#64748b;padding:3rem;font-size:.9rem}
.error-msg{background:#450a0a;border:1px solid #7f1d1d;color:#fca5a5;padding:.75rem 1rem;border-radius:8px;font-size:.85rem;margin-bottom:1rem}
.info{background:#172554;border:1px solid #1e3a5f;color:#93c5fd;padding:.5rem .75rem;border-radius:6px;font-size:.8rem}
.new-table-bar{padding:.75rem 1rem;border-top:1px solid #334155}
.new-table-bar input{background:#0f172a;border:1px solid #475569;border-radius:6px;color:#f1f5f9;padding:.4rem .6rem;font-size:.8rem;width:100%}
</style></head><body>
<header>
<h1>&#128450; <span>DB</span> Admin</h1>
<a href="/db-access/logout" class="logout">&#9109; Logout</a>
</header>
<div class="wrap">
<div class="sidebar" id="sidebar">
<h3>Tables</h3>
<div id="table-list"><div class="empty">Loading...</div></div>
</div>
<div class="main">
<div class="query-box">
<textarea id="sql" placeholder="SELECT * FROM table_name LIMIT 100;&#10;&#10;Tip: Press Ctrl+Enter to run"></textarea>
<div class="query-actions">
<button class="btn btn-primary" id="run-btn">&#9654; Run Query</button>
<button class="btn btn-secondary" id="clear-btn">Clear</button>
<span class="status" id="status"></span>
</div>
</div>
<div class="result-area" id="results"><div class="empty">Run a query or select a table from the sidebar</div></div>
</div>
</div>
<script>
const $=s=>document.querySelector(s);
const sql=$('#sql'),results=$('#results'),status=$('#status'),tableList=$('#table-list');

async function api(path,body){
  const opts={headers:{'Content-Type':'application/json'}};
  if(body){opts.method='POST';opts.body=JSON.stringify(body)}
  const r=await fetch('/db-access/api'+path,opts);
  return r.json();
}

async function loadTables(){
  const d=await api('/tables');
  if(!d.tables||d.tables.length===0){tableList.innerHTML='<div class="empty">No tables yet</div>';return}
  tableList.innerHTML=d.tables.map(t=>
    '<a class="tbl" data-name="'+t.name+'">'+t.name+'<span class="count">('+t.count+')</span></a>'
  ).join('');
  tableList.querySelectorAll('.tbl').forEach(el=>{
    el.addEventListener('click',()=>{
      tableList.querySelectorAll('.tbl').forEach(e=>e.classList.remove('active'));
      el.classList.add('active');
      sql.value='SELECT * FROM "'+el.dataset.name+'" LIMIT 200;';
      runQuery();
    });
  });
}

async function runQuery(){
  const q=sql.value.trim();
  if(!q){results.innerHTML='<div class="empty">Enter a SQL query</div>';return}
  status.textContent='Running...';
  const t0=performance.now();
  const d=await api('/query',{sql:q});
  const ms=Math.round(performance.now()-t0);
  if(d.error){
    results.innerHTML='<div class="error-msg">'+escHtml(d.error)+'</div>';
    status.textContent='Error';return;
  }
  if(d.changes!==undefined){
    results.innerHTML='<div class="info">Query OK. Rows affected: '+d.changes+'</div>';
    status.textContent=ms+'ms';loadTables();return;
  }
  if(!d.rows||d.rows.length===0){
    results.innerHTML='<div class="empty">No results</div>';
    status.textContent='0 rows · '+ms+'ms';return;
  }
  const cols=d.columns;
  let h='<table><thead><tr>'+cols.map(c=>'<th>'+escHtml(c)+'</th>').join('')+'</tr></thead><tbody>';
  d.rows.forEach(r=>{h+='<tr>'+cols.map(c=>'<td title="'+escAttr(String(r[c]??''))+'">'+escHtml(String(r[c]??'NULL'))+'</td>').join('')+'</tr>'});
  h+='</tbody></table>';
  results.innerHTML=h;
  status.textContent=d.rows.length+' rows · '+ms+'ms';
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function escAttr(s){return s.replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

$('#run-btn').addEventListener('click',runQuery);
$('#clear-btn').addEventListener('click',()=>{sql.value='';results.innerHTML='<div class="empty">Run a query or select a table</div>';status.textContent=''});
sql.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();runQuery()}});
loadTables();
</script></body></html>`;

// ─── MIDDLEWARE ─────────────────────────────────────────
export default function dbMiddleware(req, res, next) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Only handle /db-access routes
  if (!pathname.startsWith('/db-access')) return next();

  const cookies = parseCookies(req.headers.cookie);
  const authed = isValidSession(cookies[COOKIE_NAME]);

  // --- POST /db-access/login ---
  if (pathname === '/db-access/login' && req.method === 'POST') {
    readBody(req).then(body => {
      let username, password;
      try {
        const json = JSON.parse(body);
        username = json.username;
        password = json.password;
      } catch {
        sendJson(res, { error: 'Invalid request' }, 400);
        return;
      }

      if (username === DB_USER && password === DB_PASS) {
        const token = createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/db-access; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        sendJson(res, { error: 'Invalid credentials' }, 401);
      }
    }).catch(() => sendJson(res, { error: 'Bad request' }, 400));
    return;
  }

  // --- GET /db-access/logout ---
  if (pathname === '/db-access/logout') {
    if (cookies[COOKIE_NAME]) sessions.delete(cookies[COOKIE_NAME]);
    res.writeHead(302, {
      Location: '/db-access',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/db-access; HttpOnly; Max-Age=0`,
    });
    res.end();
    return;
  }

  // --- Login page (not authenticated) ---
  if (!authed) {
    if (pathname === '/db-access' || pathname === '/db-access/') {
      return sendHtml(res, LOGIN_HTML);
    }
    return sendJson(res, { error: 'Unauthorized' }, 401);
  }

  // ====== Authenticated routes below ======

  // --- GET /db-access (admin panel) ---
  if (pathname === '/db-access' || pathname === '/db-access/') {
    return sendHtml(res, ADMIN_HTML);
  }

  // --- GET /db-access/api/tables ---
  if (pathname === '/db-access/api/tables' && req.method === 'GET') {
    const db = getDb();
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();

      const result = tables.map(t => {
        const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
        return { name: t.name, count: count.c };
      });
      sendJson(res, { tables: result });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    } finally {
      db.close();
    }
    return;
  }

  // --- POST /db-access/api/query ---
  if (pathname === '/db-access/api/query' && req.method === 'POST') {
    readBody(req).then(body => {
      let sqlText;
      try {
        sqlText = JSON.parse(body).sql;
      } catch {
        return sendJson(res, { error: 'Invalid JSON' }, 400);
      }

      if (!sqlText || typeof sqlText !== 'string') {
        return sendJson(res, { error: 'Missing sql field' }, 400);
      }

      const db = getDb();
      try {
        const trimmed = sqlText.trim();
        const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);

        if (isSelect) {
          const stmt = db.prepare(trimmed);
          const rows = stmt.all();
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          sendJson(res, { columns, rows });
        } else {
          const result = db.exec(trimmed);
          sendJson(res, { changes: result ? result.changes || 0 : 0, message: 'Query executed' });
        }
      } catch (e) {
        sendJson(res, { error: e.message }, 400);
      } finally {
        db.close();
      }
    }).catch(() => sendJson(res, { error: 'Bad request' }, 400));
    return;
  }

  // Unknown /db-access route
  sendJson(res, { error: 'Not found' }, 404);
}
