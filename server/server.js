// Kinoproba: сервер без внешних пакетов (нужен Node.js 22.13+). Запуск: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'kinoproba.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, hash TEXT, bio TEXT DEFAULT '', created INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS items(user_id INTEGER, id TEXT, data TEXT, PRIMARY KEY(user_id, id));
CREATE TABLE IF NOT EXISTS collections(user_id INTEGER, name TEXT, descr TEXT DEFAULT '', public INTEGER DEFAULT 0, PRIMARY KEY(user_id, name));`);

// миграция старых баз: убираем столбец email (раньше он требовался при регистрации); аккаунты, пароли и библиотеки сохраняются
if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'email'").get()) {
  try {
    db.exec(`BEGIN;
      CREATE TABLE users_new(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, hash TEXT, bio TEXT DEFAULT '', created INTEGER);
      INSERT INTO users_new SELECT id, username, hash, bio, created FROM users;
      DROP TABLE users; ALTER TABLE users_new RENAME TO users;
      COMMIT;`);
    console.log('База обновлена: столбец email удалён');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// --- пароли: scrypt + соль (в базе нет паролей в открытом виде) ---
const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, stored) => {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64); return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const DAY30 = 30 * 864e5;
const session = uid => { const t = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t, uid, Date.now()); return t; };

// --- мини-роутер ---
const routes = [];
const route = (method, pattern, fn, needAuth = false, maxBody = 1e5) => routes.push({ method, needAuth, maxBody, fn, re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$') });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const err = (res, c, m) => send(res, c, { error: m });
const readBody = (req, max) => new Promise((ok, bad) => {
  let n = 0; const ch = [];
  req.on('data', c => { n += c.length; if (n > max) { bad(new Error('big')); req.destroy(); } else ch.push(c); });
  req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString()) : {}); } catch (e) { bad(e); } });
  req.on('error', bad);
});

// --- регистрация и вход ---
route('POST', '/api/register', ({ res, body }) => {
  const { username, password } = body || {};
  if (!/^[\w.-]{3,20}$/.test(username || '')) return err(res, 400, 'Логин: 3–20 символов (буквы, цифры, _ . -)');
  if ((password || '').length < 6) return err(res, 400, 'Пароль не короче 6 символов');
  try {
    const r = db.prepare('INSERT INTO users(username,hash,created) VALUES(?,?,?)').run(username, hashPw(password), Date.now());
    const id = Number(r.lastInsertRowid); send(res, 200, { token: session(id), user: { id, username } });
  } catch (e) { err(res, 409, 'Этот логин уже занят'); }
});
route('POST', '/api/login', ({ res, body }) => {
  const { login, password } = body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(login || '');
  if (!u || !checkPw(password || '', u.hash)) return err(res, 401, 'Неверный логин или пароль');
  send(res, 200, { token: session(u.id), user: { id: u.id, username: u.username } });
});
route('POST', '/api/logout', ({ req, res }) => { db.prepare('DELETE FROM sessions WHERE token = ?').run(req.headers.authorization.slice(7)); send(res, 200, { ok: true }); }, true);

// --- профиль ---
route('GET', '/api/me', ({ res, uid }) => {
  const u = db.prepare('SELECT id, username, bio, created FROM users WHERE id = ?').get(uid);
  send(res, 200, { ...u, items: db.prepare('SELECT COUNT(*) n FROM items WHERE user_id = ?').get(uid).n });
}, true);
route('PUT', '/api/me', ({ res, uid, body }) => { db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(String((body || {}).bio || '').slice(0, 300), uid); send(res, 200, { ok: true }); }, true);

// --- личная библиотека ---
route('GET', '/api/library', ({ res, uid }) => send(res, 200, db.prepare('SELECT data FROM items WHERE user_id = ?').all(uid).map(r => JSON.parse(r.data))), true);
route('PUT', '/api/library', ({ res, uid, body }) => {
  if (!Array.isArray(body)) return err(res, 400, 'Ожидался массив');
  const ins = db.prepare('INSERT OR REPLACE INTO items VALUES(?,?,?)');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM items WHERE user_id = ?').run(uid);
    body.forEach(i => { if (i && i.id) ins.run(uid, String(i.id), JSON.stringify(i)); });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  send(res, 200, { ok: true });
}, true, 10e6);

// --- подборки: фильмы пользователя с одним названием в поле «collection»; открыть для всех можно в профиле ---
const CN = "json_extract(i.data,'$.collection')";
route('GET', '/api/my/collections', ({ res, uid }) => send(res, 200, db.prepare(
  `SELECT g.name, g.n, COALESCE(c.descr,'') descr, COALESCE(c.public,0) public
   FROM (SELECT json_extract(data,'$.collection') name, COUNT(*) n FROM items WHERE user_id = ? AND json_extract(data,'$.collection') <> '' GROUP BY 1) g
   LEFT JOIN collections c ON c.user_id = ? AND c.name = g.name ORDER BY g.name`).all(uid, uid)), true);
route('PUT', '/api/my/collections', ({ res, uid, body }) => {
  const { name, descr, public: p } = body || {}; if (!name) return err(res, 400, 'Нет названия');
  db.prepare(`INSERT INTO collections VALUES(?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET descr = excluded.descr, public = excluded.public`)
    .run(uid, String(name), String(descr || '').slice(0, 200), p ? 1 : 0);
  send(res, 200, { ok: true });
}, true);
// публичный поиск: по названию подборки, автору, описанию и фильмам внутри (регистр не важен, в том числе для кириллицы)
route('GET', '/api/collections', ({ res, q }) => {
  const k = String(q.get('q') || '').trim().toLowerCase(), has = x => String(x || '').toLowerCase().includes(k);
  const titles = db.prepare(`SELECT json_extract(i.data,'$.title') t FROM items i WHERE i.user_id = ? AND ${CN} = ?`);
  const out = [];
  for (const c of db.prepare('SELECT c.user_id uid, u.username, c.name, c.descr FROM collections c JOIN users u ON u.id = c.user_id WHERE c.public = 1').all()) {
    const ts = titles.all(c.uid, c.name).map(r => r.t);
    if (ts.length && (!k || has(c.name) || has(c.username) || has(c.descr) || ts.some(has))) out.push({ ...c, n: ts.length });
  }
  send(res, 200, out.sort((x, y) => y.n - x.n).slice(0, 50));
});
route('GET', '/api/collections/:uid/:name', ({ res, p }) => {
  const c = db.prepare('SELECT * FROM collections WHERE user_id = ? AND name = ? AND public = 1').get(Number(p[0]), p[1]);
  if (!c) return err(res, 404, 'Подборка не найдена или закрыта автором');
  // личные поля (ссылки, рецензии, статусы, инв. номера) наружу не отдаём
  const items = db.prepare(`SELECT data FROM items i WHERE i.user_id = ? AND ${CN} = ?`).all(c.user_id, c.name).map(r => {
    const d = JSON.parse(r.data);
    return { title: d.title, year: d.year, type: d.type, poster: d.poster, tmdb: d.tmdb, imdb: d.imdb, genres: d.genres, director: d.director, runtime: d.runtime, seasons: d.seasons, overview: d.overview };
  });
  send(res, 200, { name: c.name, descr: c.descr, uid: c.user_id, owner: db.prepare('SELECT username FROM users WHERE id = ?').get(c.user_id).username, items });
});
route('GET', '/api/users/:name', ({ res, p }) => {
  const u = db.prepare('SELECT id, username, bio, created FROM users WHERE username = ?').get(p[0]);
  if (!u) return err(res, 404, 'Пользователь не найден');
  const cols = db.prepare(`SELECT c.name, c.descr, (SELECT COUNT(*) FROM items i WHERE i.user_id = c.user_id AND ${CN} = c.name) n FROM collections c WHERE c.user_id = ? AND c.public = 1`).all(u.id).filter(c => c.n);
  send(res, 200, { ...u, collections: cols });
});

// --- статика сайта (папку server с базой наружу не отдаём) ---
const ROOT = path.join(__dirname, '..'), SRV = path.join(ROOT, 'server');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function serveStatic(u, res) {
  let f; try { f = decodeURIComponent(u.pathname); } catch (e) { f = '/'; }
  if (f.endsWith('/')) f += 'index.html';
  const full = path.normalize(path.join(ROOT, f));
  if (!full.startsWith(ROOT) || full.startsWith(SRV)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(full, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }); res.end(data);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (!u.pathname.startsWith('/api/')) return serveStatic(u, res);
  const r = routes.find(r => r.method === req.method && r.re.test(u.pathname));
  if (!r) return err(res, 404, 'Не найдено');
  let uid;
  try {
    if (r.needAuth) {
      const t = (req.headers.authorization || '').slice(7);
      const s = t && db.prepare('SELECT user_id FROM sessions WHERE token = ? AND created > ?').get(t, Date.now() - DAY30);
      if (!s) { req.resume(); return err(res, 401, 'Нужно войти в аккаунт'); }
      uid = s.user_id;
    }
  } catch (e) { console.error(e); return err(res, 500, 'Ошибка сервера'); }
  let body; try { body = await readBody(req, r.maxBody); } catch (e) { return err(res, 400, 'Некорректный запрос'); }
  const ctx = { req, res, body, uid, q: u.searchParams, p: u.pathname.match(r.re).slice(1).map(decodeURIComponent) };
  try { r.fn(ctx); } catch (e) { console.error(e); err(res, 500, 'Ошибка сервера'); }
}).listen(process.env.PORT || 3000, () => {
  const port = process.env.PORT || 3000;
  console.log('Kinoproba: http://localhost:' + port);
  for (const list of Object.values(require('os').networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  из локальной сети (Wi-Fi): http://' + a.address + ':' + port);
  console.log('База данных: ' + DB_FILE);
});

// при остановке (Ctrl+C) всё из журнала WAL переносится в сам файл .db: его одного достаточно, чтобы скопировать или передать базу
const bye = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
