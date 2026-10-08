// Kinoproba: сервер без внешних пакетов (нужен Node.js 22.13+). Запуск: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ключ Кинопоиска хранится в server/.env (файл в git не попадает) или в переменной окружения KINOPOISK_API_KEY
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) {}
const KP_KEY = (process.env.KINOPOISK_API_KEY || '').trim();
const KP_API = process.env.KINOPOISK_API_URL || 'https://api.kinopoisk.dev';

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

// --- рецензии: другим отдаются только те, у которых автор сам включил «Показывать другим пользователям» (revPublic) ---
const TONES = ['pos', 'neu', 'neg'];
const pubReview = d => {
  if (!d.revPublic || !String(d.review || '').trim()) return null;
  return { review: String(d.review).trim().slice(0, 3000), revTone: TONES.includes(d.revTone) ? d.revTone : '', revSpoiler: !!d.revSpoiler,
    revAt: Number(d.revAt) || 0, rating: Math.max(0, Math.min(5, Math.round(Number(d.rating)) || 0)) };
};

// --- подборки ---
// Состав подборки хранится в карточках фильмов (массив cols с названиями; старое поле collection с одной подборкой тоже читается),
// а описание и видимость («личная» — только владелец, «публичная» — все) лежат в таблице collections.
const incol = x => `(EXISTS (SELECT 1 FROM json_each(i.data,'$.cols') j WHERE j.value = ${x}) OR json_extract(i.data,'$.collection') = ${x})`;
const colNames = d => [...new Set([...(Array.isArray(d.cols) ? d.cols : []), d.collection].map(s => String(s || '').trim()).filter(Boolean))];
// мои подборки (и личные, и публичные); названия, которые уже есть в карточках, но не заведены, добавляются как личные
route('GET', '/api/my/collections', ({ res, uid }) => {
  const ins = db.prepare('INSERT OR IGNORE INTO collections(user_id, name) VALUES(?,?)');
  for (const r of db.prepare('SELECT data FROM items WHERE user_id = ?').all(uid)) colNames(JSON.parse(r.data)).forEach(n => ins.run(uid, n));
  send(res, 200, db.prepare(`SELECT c.name, COALESCE(c.descr,'') descr, COALESCE(c.public,0) public,
    (SELECT COUNT(*) FROM items i WHERE i.user_id = c.user_id AND ${incol('c.name')}) n
    FROM collections c WHERE c.user_id = ? ORDER BY c.name`).all(uid));
}, true);
// создать подборку: по умолчанию личная (public: false)
route('POST', '/api/my/collections', ({ res, uid, body }) => {
  const { descr, public: p } = body || {}, name = String((body || {}).name || '').trim().slice(0, 60);
  if (!name) return err(res, 400, 'Введите название подборки');
  // регистр не важен, в том числе для кириллицы (SQLite NOCASE сворачивает только латиницу)
  if (db.prepare('SELECT name FROM collections WHERE user_id = ?').all(uid).some(c => c.name.toLowerCase() === name.toLowerCase())) return err(res, 409, 'Подборка с таким названием уже есть');
  db.prepare('INSERT INTO collections VALUES(?,?,?,?)').run(uid, name, String(descr || '').slice(0, 200), p ? 1 : 0);
  send(res, 200, { ok: true, name });
}, true);
// изменить описание и видимость
route('PUT', '/api/my/collections', ({ res, uid, body }) => {
  const { name, descr, public: p } = body || {}; if (!name) return err(res, 400, 'Нет названия');
  db.prepare(`INSERT INTO collections VALUES(?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET descr = excluded.descr, public = excluded.public`)
    .run(uid, String(name), String(descr || '').slice(0, 200), p ? 1 : 0);
  send(res, 200, { ok: true });
}, true);
// удалить подборку: фильмы остаются в библиотеке, из них убирается только название подборки
route('DELETE', '/api/my/collections/:name', ({ res, uid, p }) => {
  const name = p[0], upd = db.prepare('UPDATE items SET data = ? WHERE user_id = ? AND id = ?');
  db.prepare('DELETE FROM collections WHERE user_id = ? AND name = ?').run(uid, name);
  for (const r of db.prepare('SELECT id, data FROM items WHERE user_id = ?').all(uid)) {
    const d = JSON.parse(r.data), names = colNames(d);
    if (names.includes(name)) { d.cols = names.filter(n => n !== name); delete d.collection; upd.run(JSON.stringify(d), uid, r.id); }
  }
  send(res, 200, { ok: true });
}, true);
// публичный поиск: только публичные подборки; по названию, автору, описанию и фильмам внутри (регистр не важен, в том числе для кириллицы)
route('GET', '/api/collections', ({ res, q }) => {
  const k = String(q.get('q') || '').trim().toLowerCase(), has = x => String(x || '').toLowerCase().includes(k);
  const titles = db.prepare(`SELECT json_extract(i.data,'$.title') t FROM items i WHERE i.user_id = ? AND ${incol('?')}`);
  const out = [];
  for (const c of db.prepare('SELECT c.user_id uid, u.username, c.name, c.descr FROM collections c JOIN users u ON u.id = c.user_id WHERE c.public = 1').all()) {
    const ts = titles.all(c.uid, c.name, c.name).map(r => r.t);
    if (ts.length && (!k || has(c.name) || has(c.username) || has(c.descr) || ts.some(has))) out.push({ ...c, n: ts.length });
  }
  send(res, 200, out.sort((x, y) => y.n - x.n).slice(0, 50));
});
route('GET', '/api/collections/:uid/:name', ({ res, p }) => {
  const c = db.prepare('SELECT * FROM collections WHERE user_id = ? AND name = ? AND public = 1').get(Number(p[0]), p[1]);
  if (!c) return err(res, 404, 'Подборка не найдена или закрыта автором');
  // личные поля (ссылки, статусы, инв. номера) наружу не отдаём; рецензия уходит только с разрешения автора (pubReview)
  const items = db.prepare(`SELECT data FROM items i WHERE i.user_id = ? AND ${incol('?')}`).all(c.user_id, c.name, c.name).map(r => {
    const d = JSON.parse(r.data), pr = pubReview(d);
    return { title: d.title, year: d.year, type: d.type, poster: d.poster, tmdb: d.tmdb, imdb: d.imdb, genres: d.genres, director: d.director, runtime: d.runtime, seasons: d.seasons, overview: d.overview, ...(pr ? { pubReview: pr } : {}) };
  });
  send(res, 200, { name: c.name, descr: c.descr, uid: c.user_id, owner: db.prepare('SELECT username FROM users WHERE id = ?').get(c.user_id).username, items });
});
route('GET', '/api/users/:name', ({ res, p }) => {
  const u = db.prepare('SELECT id, username, bio, created FROM users WHERE username = ?').get(p[0]);
  if (!u) return err(res, 404, 'Пользователь не найден');
  const cols = db.prepare(`SELECT c.name, c.descr, (SELECT COUNT(*) FROM items i WHERE i.user_id = c.user_id AND ${incol('c.name')}) n FROM collections c WHERE c.user_id = ? AND c.public = 1`).all(u.id).filter(c => c.n);
  send(res, 200, { ...u, collections: cols });
});
// публичные рецензии на фильм: ищем по TMDB ID (+тип), IMDb ID, ID Кинопоиска, а у ручных карточек — по названию и году
route('GET', '/api/reviews', ({ res, q }) => {
  const tmdb = Number(q.get('tmdb')) || 0, tv = q.get('type') === 'tv', imdb = q.get('imdb') || '', kp = Number(q.get('kp')) || 0;
  const title = String(q.get('title') || '').trim().toLowerCase(), year = String(q.get('year') || '').trim();
  if (!tmdb && !imdb && !kp && !title) return send(res, 200, []);
  const same = d => (tmdb && d.tmdb === tmdb && (d.type === 'tv') === tv) || (imdb && d.imdb === imdb) || (kp && d.kpId === kp) ||
    (title && String(d.title || '').trim().toLowerCase() === title && String(d.year || '') === year);
  const out = [];
  for (const r of db.prepare(`SELECT u.username, i.data FROM items i JOIN users u ON u.id = i.user_id WHERE json_extract(i.data,'$.revPublic') = 1`).all()) {
    const d = JSON.parse(r.data), pr = pubReview(d);
    if (pr && same(d)) out.push({ user: r.username, ...pr });
  }
  send(res, 200, out.sort((a, b) => b.revAt - a.revAt).slice(0, 50));
});

// --- общие каталоги ---
// kind = 'corp'  — корпоративный архив: виден только участникам, вступление по коду приглашения;
// kind = 'public' — публичный каталог (киноклуб, онлайн-сообщество): смотреть может кто угодно, добавлять — участники.
// Роли: owner (владелец: участники, код, удаление, любые карточки) и member (добавляет карточки, правит и удаляет только свои).
db.exec(`
CREATE TABLE IF NOT EXISTS spaces(id INTEGER PRIMARY KEY, name TEXT, descr TEXT DEFAULT '', kind TEXT, owner_id INTEGER, code TEXT UNIQUE, created INTEGER);
CREATE TABLE IF NOT EXISTS space_members(space_id INTEGER, user_id INTEGER, role TEXT, joined INTEGER, PRIMARY KEY(space_id, user_id));
CREATE TABLE IF NOT EXISTS space_items(space_id INTEGER, id TEXT, data TEXT, added_by INTEGER, added INTEGER, PRIMARY KEY(space_id, id));`);
const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const S = (v, n) => String(v ?? '').trim().slice(0, n);
const okPoster = u => /^https?:\/\//i.test(u) || /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u);
// карточка каталога: берём только известные поля и обрезаем длину (лишнее из запроса не сохраняется)
function cleanItem(b) {
  b = b || {}; const title = S(b.title, 200); if (!title) return null; const poster = S(b.poster, 400000);
  return { title, year: /^\d{4}$/.test(S(b.year, 4)) ? S(b.year, 4) : '', type: ['movie', 'tv', 'doc'].includes(b.type) ? b.type : 'movie',
    poster: okPoster(poster) ? poster : '', genres: (Array.isArray(b.genres) ? b.genres : []).map(g => S(g, 40)).filter(Boolean).slice(0, 12),
    tags: (Array.isArray(b.tags) ? b.tags : []).map(g => S(g, 40)).filter(Boolean).slice(0, 12),
    director: S(b.director, 120), runtime: Math.max(0, Math.min(99999, +b.runtime || 0)), overview: S(b.overview, 2000),
    imdb: /^tt\d{7,10}$/.test(b.imdb || '') ? b.imdb : '', tmdb: Number.isInteger(b.tmdb) ? b.tmdb : null,
    inv: S(b.inv, 80), url: /^https?:\/\//i.test(b.url || '') ? S(b.url, 500) : '' };
}
const spaceById = id => db.prepare('SELECT s.*, u.username owner FROM spaces s JOIN users u ON u.id = s.owner_id WHERE s.id = ?').get(Number(id) || 0);
const roleOf = (sid, uid) => uid ? (db.prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?').get(sid, uid) || {}).role || '' : '';
const spN = id => db.prepare('SELECT COUNT(*) n FROM space_items WHERE space_id = ?').get(id).n;
const spM = id => db.prepare('SELECT COUNT(*) n FROM space_members WHERE space_id = ?').get(id).n;
const spCard = (s, uid) => ({ id: s.id, name: s.name, descr: s.descr, kind: s.kind, owner: s.owner, n: spN(s.id), members: spM(s.id), role: roleOf(s.id, uid) });
// закрытый (корпоративный) каталог для посторонних «не существует»: 404, а не 403
const spaceFor = (id, uid, res, needRole = '') => {
  const s = spaceById(id), role = s ? roleOf(s.id, uid) : '';
  if (!s || (s.kind === 'corp' && !role)) { err(res, 404, 'Каталог не найден или закрыт'); return null; }
  if (needRole === 'member' && !role) { err(res, 403, 'Это действие доступно только участникам каталога'); return null; }
  if (needRole === 'owner' && role !== 'owner') { err(res, 403, 'Это действие доступно только владельцу'); return null; }
  return { s, role };
};
// публичные каталоги: список и поиск (без входа)
route('GET', '/api/spaces', ({ res, q, uid }) => {
  const k = String(q.get('q') || '').trim().toLowerCase(), has = x => String(x || '').toLowerCase().includes(k);
  const titles = db.prepare(`SELECT json_extract(data,'$.title') t FROM space_items WHERE space_id = ?`);
  const out = db.prepare(`SELECT s.*, u.username owner FROM spaces s JOIN users u ON u.id = s.owner_id WHERE s.kind = 'public' ORDER BY s.created DESC LIMIT 200`).all()
    .filter(s => !k || has(s.name) || has(s.descr) || has(s.owner) || titles.all(s.id).some(r => has(r.t))).map(s => spCard(s, uid));
  send(res, 200, out.sort((a, b) => b.n - a.n || b.members - a.members).slice(0, 60));
}, 'opt');
// каталоги, в которых я участвую (код приглашения — только владельцу)
route('GET', '/api/my/spaces', ({ res, uid }) => send(res, 200, db.prepare(
  `SELECT s.*, u.username owner FROM spaces s JOIN users u ON u.id = s.owner_id JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? ORDER BY s.name`).all(uid)
  .map(s => ({ ...spCard(s, uid), ...(s.owner_id === uid ? { code: s.code } : {}) }))), true);
route('POST', '/api/spaces', ({ res, uid, body }) => {
  const name = S((body || {}).name, 60), kind = (body || {}).kind === 'public' ? 'public' : (body || {}).kind === 'corp' ? 'corp' : '';
  if (!name) return err(res, 400, 'Введите название'); if (!kind) return err(res, 400, 'Не указан тип каталога');
  if (db.prepare('SELECT COUNT(*) n FROM spaces WHERE owner_id = ?').get(uid).n >= 20) return err(res, 400, 'Можно создать не больше 20 каталогов');
  const r = db.prepare('INSERT INTO spaces(name, descr, kind, owner_id, code, created) VALUES(?,?,?,?,?,?)').run(name, S(body.descr, 300), kind, uid, newCode(), Date.now());
  const id = Number(r.lastInsertRowid); db.prepare('INSERT INTO space_members VALUES(?,?,?,?)').run(id, uid, 'owner', Date.now());
  send(res, 200, { id });
}, true);
// вступить по коду приглашения (для корпоративного архива это единственный способ попасть внутрь)
route('POST', '/api/spaces/join', ({ res, uid, body }) => {
  const s = db.prepare('SELECT id, kind FROM spaces WHERE code = ?').get(S((body || {}).code, 20).toUpperCase());
  if (!s) return err(res, 404, 'Неверный код приглашения');
  db.prepare('INSERT OR IGNORE INTO space_members VALUES(?,?,?,?)').run(s.id, uid, 'member', Date.now()); send(res, 200, { id: s.id, kind: s.kind });
}, true);
// вступить в публичный каталог без кода
route('POST', '/api/spaces/:id/join', ({ res, uid, p }) => {
  const s = spaceById(p[0]); if (!s || s.kind !== 'public') return err(res, 404, 'Каталог не найден или закрыт');
  db.prepare('INSERT OR IGNORE INTO space_members VALUES(?,?,?,?)').run(s.id, uid, 'member', Date.now()); send(res, 200, { ok: true });
}, true);
route('POST', '/api/spaces/:id/leave', ({ res, uid, p }) => {
  const a = spaceFor(p[0], uid, res, 'member'); if (!a) return;
  if (a.role === 'owner') return err(res, 400, 'Владелец не может выйти: удалите каталог');
  db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(a.s.id, uid); send(res, 200, { ok: true });
}, true);
route('DELETE', '/api/spaces/:id', ({ res, uid, p }) => {
  const a = spaceFor(p[0], uid, res, 'owner'); if (!a) return;
  for (const t of ['space_items', 'space_members']) db.prepare(`DELETE FROM ${t} WHERE space_id = ?`).run(a.s.id);
  db.prepare('DELETE FROM spaces WHERE id = ?').run(a.s.id); send(res, 200, { ok: true });
}, true);
route('PUT', '/api/spaces/:id', ({ res, uid, p, body }) => {
  const a = spaceFor(p[0], uid, res, 'owner'); if (!a) return;
  const name = S((body || {}).name, 60) || a.s.name;
  db.prepare('UPDATE spaces SET name = ?, descr = ? WHERE id = ?').run(name, S((body || {}).descr, 300), a.s.id); send(res, 200, { ok: true });
}, true);
// новый код приглашения: старый перестаёт работать
route('POST', '/api/spaces/:id/code', ({ res, uid, p }) => {
  const a = spaceFor(p[0], uid, res, 'owner'); if (!a) return;
  const code = newCode(); db.prepare('UPDATE spaces SET code = ? WHERE id = ?').run(code, a.s.id); send(res, 200, { code });
}, true);
route('DELETE', '/api/spaces/:id/members/:mid', ({ res, uid, p }) => {
  const a = spaceFor(p[0], uid, res, 'owner'); if (!a) return;
  if (Number(p[1]) === uid) return err(res, 400, 'Себя исключить нельзя');
  db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(a.s.id, Number(p[1])); send(res, 200, { ok: true });
}, true);
// содержимое каталога. Посторонним в публичном каталоге не отдаются инв. номер и ссылка, список участников — только участникам
route('GET', '/api/spaces/:id', ({ res, uid, p }) => {
  const a = spaceFor(p[0], uid, res); if (!a) return;
  const items = db.prepare('SELECT i.id, i.data, i.added_by, i.added, u.username AS author FROM space_items i LEFT JOIN users u ON u.id = i.added_by WHERE i.space_id = ? ORDER BY i.added DESC').all(a.s.id).map(r => {
    const d = JSON.parse(r.data); if (!a.role) { delete d.inv; delete d.url; }
    return { id: r.id, ...d, by: r.author || '', added: r.added, mine: r.added_by === uid };
  });
  const memberList = a.role ? db.prepare('SELECT u.id, u.username, m.role FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.role DESC, u.username').all(a.s.id) : undefined;
  send(res, 200, { ...spCard(a.s, uid), items, memberList, ...(a.role === 'owner' ? { code: a.s.code } : {}) });
}, 'opt');
route('POST', '/api/spaces/:id/items', ({ res, uid, p, body }) => {
  const a = spaceFor(p[0], uid, res, 'member'); if (!a) return;
  const d = cleanItem(body); if (!d) return err(res, 400, 'Введите название');
  const dup = db.prepare('SELECT data FROM space_items WHERE space_id = ?').all(a.s.id).some(r => { const x = JSON.parse(r.data); return x.title.toLowerCase() === d.title.toLowerCase() && x.year === d.year; });
  if (dup) return err(res, 409, `«${d.title}»${d.year ? ' (' + d.year + ')' : ''} уже есть в каталоге`);
  const id = crypto.randomBytes(6).toString('hex'); db.prepare('INSERT INTO space_items VALUES(?,?,?,?,?)').run(a.s.id, id, JSON.stringify(d), uid, Date.now()); send(res, 200, { id });
}, true, 6e5);
// править и удалять карточку может её автор или владелец каталога
const ownItem = (res, uid, p) => {
  const a = spaceFor(p[0], uid, res, 'member'); if (!a) return null;
  const r = db.prepare('SELECT * FROM space_items WHERE space_id = ? AND id = ?').get(a.s.id, p[1]);
  if (!r) { err(res, 404, 'Карточка не найдена'); return null; }
  if (a.role !== 'owner' && r.added_by !== uid) { err(res, 403, 'Править и удалять можно только свои карточки'); return null; }
  return { a, r };
};
route('PUT', '/api/spaces/:id/items/:iid', ({ res, uid, p, body }) => {
  const o = ownItem(res, uid, p); if (!o) return; const d = cleanItem(body); if (!d) return err(res, 400, 'Введите название');
  const dup = db.prepare('SELECT id, data FROM space_items WHERE space_id = ?').all(o.a.s.id).some(r => { const x = JSON.parse(r.data); return r.id !== o.r.id && x.title.toLowerCase() === d.title.toLowerCase() && x.year === d.year; });
  if (dup) return err(res, 409, `«${d.title}» уже есть в каталоге`);
  db.prepare('UPDATE space_items SET data = ? WHERE space_id = ? AND id = ?').run(JSON.stringify(d), o.a.s.id, o.r.id); send(res, 200, { ok: true });
}, true, 6e5);
route('DELETE', '/api/spaces/:id/items/:iid', ({ res, uid, p }) => {
  const o = ownItem(res, uid, p); if (!o) return;
  db.prepare('DELETE FROM space_items WHERE space_id = ? AND id = ?').run(o.a.s.id, o.r.id); send(res, 200, { ok: true });
}, true);

// --- Кинопоиск (kinopoisk.dev): запросы идут через сервер, ключ в браузер не попадает ---
// TMDB остаётся основным источником (постер, описание); Кинопоиск добавляет рейтинги, ссылку и «где смотреть»
const kpCache = new Map(), kpHits = new Map();
async function kpGet(p) {
  const c = kpCache.get(p); if (c && c.t > Date.now()) return c.v; // кэш на 6 часов: экономит дневной лимит запросов
  const r = await fetch(KP_API + p, { headers: { 'X-API-KEY': KP_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error('Кинопоиск ответил ' + r.status), { status: r.status });
  const v = await r.json();
  if (kpCache.size > 500) kpCache.delete(kpCache.keys().next().value);
  kpCache.set(p, { v, t: Date.now() + 6 * 36e5 }); return v;
}
// не больше 40 запросов в минуту с одного адреса, чтобы посторонние не сожгли лимит ключа
const kpLimit = req => { const ip = req.socket.remoteAddress, n = Date.now(), a = (kpHits.get(ip) || []).filter(t => t > n - 6e4); a.push(n); kpHits.set(ip, a); return a.length <= 40; };
const httpUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
// ответ Кинопоиска -> компактная карточка для сайта
function kpNorm(m) {
  const tv = m.isSeries === true || ['tv-series', 'animated-series'].includes(m.type), ex = m.externalId || {}, rt = m.rating || {};
  return {
    kp: m.id, title: m.name || m.alternativeName || m.enName || '', original: m.alternativeName || m.enName || '',
    year: m.year ? String(m.year) : '', type: tv ? 'tv' : 'movie',
    poster: httpUrl((m.poster || {}).url || (m.poster || {}).previewUrl),
    overview: m.description || m.shortDescription || '',
    genres: (m.genres || []).map(g => g.name).filter(Boolean), countries: (m.countries || []).map(c => c.name).filter(Boolean),
    runtime: m.movieLength || m.seriesLength || 0, ageRating: m.ageRating || null,
    ratingKp: +Number(rt.kp || 0).toFixed(1), ratingImdb: +Number(rt.imdb || 0).toFixed(1), votesKp: (m.votes || {}).kp || 0,
    imdb: ex.imdb || '', tmdb: ex.tmdb || null,
    url: `https://www.kinopoisk.ru/${tv ? 'series' : 'film'}/${m.id}/`,
    // где смотреть (Иви, Okko, Кинопоиск и др.): есть только в полной карточке
    watch: ((m.watchability || {}).items || []).map(w => ({ name: w.name || '', url: httpUrl(w.url), logo: httpUrl((w.logo || {}).url) })).filter(w => w.name && w.url)
  };
}
const bad = m => Object.assign(new Error(m), { status: 400 });
const kpRoute = (pattern, fn) => route('GET', pattern, async ctx => {
  const { req, res } = ctx;
  if (!KP_KEY) return err(res, 503, 'Ключ Кинопоиска не задан: добавьте KINOPOISK_API_KEY в server/.env и перезапустите сервер');
  if (!kpLimit(req)) return err(res, 429, 'Слишком много запросов, подождите минуту');
  try { send(res, 200, await fn(ctx)); }
  catch (e) {
    console.error('Кинопоиск:', e.message);
    const s = e.status;
    if (s === 400) return err(res, 400, e.message);
    if (s === 404) return err(res, 404, 'Не найдено на Кинопоиске');
    err(res, 502, s === 401 || s === 403 ? 'Кинопоиск отклонил ключ' : s === 429 ? 'Дневной лимит запросов Кинопоиска исчерпан' : 'Кинопоиск сейчас недоступен');
  }
});
route('GET', '/api/kp/status', ({ res }) => send(res, 200, { enabled: !!KP_KEY }));
// поиск по названию
kpRoute('/api/kp/search', async ({ q }) => {
  const k = String(q.get('q') || '').trim().slice(0, 100); if (k.length < 2) return [];
  return ((await kpGet('/v1.4/movie/search?limit=8&query=' + encodeURIComponent(k))).docs || []).map(kpNorm);
});
// полная карточка по ID Кинопоиска
kpRoute('/api/kp/movie/:id', async ({ p }) => {
  if (!/^\d{1,9}$/.test(p[0])) throw bad('Некорректный ID Кинопоиска');
  return kpNorm(await kpGet('/v1.4/movie/' + p[0]));
});
// сопоставление: ищем фильм из TMDB на Кинопоиске по IMDb ID, затем по TMDB ID, затем по точному названию и году (null, если не уверены)
kpRoute('/api/kp/match', async ({ q }) => {
  const imdb = q.get('imdb') || '', tmdb = q.get('tmdb') || '', title = (q.get('title') || '').trim().slice(0, 150), year = +q.get('year') || 0;
  const yearOk = m => !year || !m.year || Math.abs(m.year - year) <= 1; // год защищает от совпавших «чужих» ID
  const first = d => (d.docs || []).find(yearOk);
  let m = null;
  if (/^tt\d{7,10}$/.test(imdb)) m = first(await kpGet('/v1.4/movie?limit=3&externalId.imdb=' + imdb));
  if (!m && /^\d{1,9}$/.test(tmdb)) m = first(await kpGet('/v1.4/movie?limit=3&externalId.tmdb=' + tmdb));
  if (!m && title && year) {
    const low = title.toLowerCase();
    m = ((await kpGet('/v1.4/movie/search?limit=10&query=' + encodeURIComponent(title))).docs || [])
      .find(x => x.year && Math.abs(x.year - year) <= 1 && [x.name, x.alternativeName, x.enName].some(n => String(n || '').toLowerCase() === low));
  }
  if (!m) return null;
  if (!m.watchability) m = await kpGet('/v1.4/movie/' + m.id);
  return kpNorm(m);
});

// --- статика сайта (папку server с базой наружу не отдаём) ---
const ROOT = path.join(__dirname, '..', 'public'), SRV = path.join(ROOT, 'server');
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
      if (s) uid = s.user_id;
      else if (r.needAuth !== 'opt') { req.resume(); return err(res, 401, 'Нужно войти в аккаунт'); }
    }
  } catch (e) { console.error(e); return err(res, 500, 'Ошибка сервера'); }
  let body; try { body = await readBody(req, r.maxBody); } catch (e) { return err(res, 400, 'Некорректный запрос'); }
  const ctx = { req, res, body, uid, q: u.searchParams, p: u.pathname.match(r.re).slice(1).map(decodeURIComponent) };
  try { await r.fn(ctx); } catch (e) { console.error(e); if (!res.headersSent) err(res, 500, 'Ошибка сервера'); }
}).listen(process.env.PORT || 3000, () => {
  const port = process.env.PORT || 3000;
  console.log('Kinoproba: http://localhost:' + port);
  for (const list of Object.values(require('os').networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  из локальной сети (Wi-Fi): http://' + a.address + ':' + port);
  console.log('База данных: ' + DB_FILE);
  console.log(KP_KEY ? 'Кинопоиск: ключ найден' : 'Кинопоиск: ключ не задан (добавьте KINOPOISK_API_KEY в server/.env), работает только TMDB');
});

// при остановке (Ctrl+C) всё из журнала WAL переносится в сам файл .db: его одного достаточно, чтобы скопировать или передать базу
const bye = () => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
