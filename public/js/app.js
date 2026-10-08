const KP = {
  key: 'd683225cef86fa8a035261070445fc66', // лучше заменить на свой ключ TMDB
  tmdbUrl: 'https://api.themoviedb.org/3',
  img: 'https://image.tmdb.org/t/p/w500',
  // --- аккаунт: у каждого пользователя своя библиотека; сервер (SQLite) — главное хранилище ---
  user: JSON.parse(localStorage.getItem('kp_user') || 'null'), tok: localStorage.getItem('kp_tok') || '',
  lk() { return 'kp_lib_' + (this.user ? this.user.id : 'guest'); },
  load() { try { return (JSON.parse(localStorage.getItem(this.lk())) || []).map(i => this.norm(i)); } catch (e) { return []; } },
  // фильм может входить в несколько подборок: названия лежат в массиве cols (старое поле collection с одной подборкой переносится сюда)
  norm(i) {
    if (!i || typeof i !== 'object') return i;
    i.cols = [...new Set([...(Array.isArray(i.cols) ? i.cols : []), i.collection].map(c => String(c || '').trim()).filter(Boolean))]; delete i.collection; return i;
  },
  save(l) {
    try { localStorage.setItem(this.lk(), JSON.stringify(l)); }
    catch (e) { // хранилище браузера (~5 МБ) переполнено; предупреждаем не чаще раза в 5 секунд
      if (Date.now() - (this._qa || 0) > 5000) alert('Не хватает места в браузере, изменения не сохранены. Удалите карточки с загруженными постерами или вставьте ссылку на постер вместо файла.');
      this._qa = Date.now(); return false;
    }
    this.push(l); return true;
  },
  async api(p, o = {}) {
    const r = await fetch('/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.tok }, body: o.body ? JSON.stringify(o.body) : undefined });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      // ответ без JSON-поля error — значит, отвечал не сервер Kinoproba (Live Server, GitHub Pages, nginx и т.п.)
      if (!d || !d.error) throw new Error(`Ошибка ${r.status}: страница открыта не через сервер Kinoproba. Запустите «node server.js» в папке server и откройте http://localhost:3000`);
      throw new Error(d.error);
    }
    return d;
  },
  push(l) { if (!this.tok) return; clearTimeout(this._t); this._t = setTimeout(() => this.api('/library', { method: 'PUT', body: l }).catch(() => {}), 600); },
  async pull() {
    if (!this.tok) return;
    try { const s = await this.api('/library'); if (s.length) localStorage.setItem(this.lk(), JSON.stringify(s)); else if (this.load().length) this.push(this.load()); }
    catch (e) { if (/войти/.test(e.message)) this.logout(); }
  },
  login(d) { // гостевая библиотека переносится в новый аккаунт
    const g = localStorage.getItem('kp_lib_guest'); this.user = d.user; this.tok = d.token;
    localStorage.setItem('kp_user', JSON.stringify(d.user)); localStorage.setItem('kp_tok', d.token);
    if (g && !localStorage.getItem(this.lk())) localStorage.setItem(this.lk(), g);
  },
  logout() { if (this.tok) this.api('/logout', { method: 'POST' }).catch(() => {}); localStorage.removeItem('kp_user'); localStorage.removeItem('kp_tok'); this.user = null; this.tok = ''; },
  nav() { const a = document.getElementById('me'); if (a) a.textContent = this.user ? '👤 ' + this.user.username : 'Вход'; },
  async tmdb(path, q = '', lang = 'ru-RU') {
    const r = await fetch(`${this.tmdbUrl}${path}?api_key=${this.key}&language=${lang}${q}`);
    if (!r.ok) throw new Error('TMDB ' + r.status);
    return r.json();
  },
  // карточка из TMDB: жанры, режиссёр, длительность, постер
  async fromTmdb(id, type = 'movie') {
    const m = await this.tmdb(`/${type}/${id}`, '&append_to_response=credits,external_ids');
    const dir = ((m.credits.crew || []).find(c => c.job === 'Director') || (m.created_by || [])[0] || {}).name || '';
    return {
      tmdb: +id, type: type === 'tv' ? 'tv' : 'movie',
      title: m.title || m.name, year: (m.release_date || m.first_air_date || '').slice(0, 4),
      poster: m.poster_path ? this.img + m.poster_path : '', genres: (m.genres || []).map(g => g.name),
      seasons: (m.seasons || []).filter(s => s.season_number > 0 && s.episode_count).map(s => ({ n: s.season_number, c: s.episode_count })), w: [],
      director: dir, overview: m.overview || '', imdb: (m.external_ids || {}).imdb_id || '',
      runtime: m.runtime || ((m.episode_run_time || [45])[0] * (m.number_of_episodes || 1))
    };
  },
  // --- Кинопоиск: запросы идут через наш сервер (/api/kp/…), ключ в браузер не попадает. TMDB остаётся основным источником ---
  kp(path) { return this.api('/kp' + path); },
  // найти фильм на Кинопоиске по IMDb ID / TMDB ID / названию и году; null, если не нашли или Кинопоиск недоступен
  async kpMatch(m) {
    try { return await this.kp('/match?' + new URLSearchParams({ imdb: m.imdb || '', tmdb: m.tmdb || '', title: m.title || '', year: m.year || '' })); }
    catch (e) { return null; }
  },
  // данные TMDB главные; Кинопоиск добавляет рейтинги, ссылку и то, чего не хватает (постер, описание, жанры)
  mergeKp(it, k) {
    if (!k) return it;
    return { ...it, kpId: k.kp, kpUrl: k.url, ratingKp: k.ratingKp, ratingImdb: k.ratingImdb,
      poster: it.poster || k.poster, overview: it.overview || k.overview, imdb: it.imdb || k.imdb,
      genres: (it.genres && it.genres.length) ? it.genres : k.genres, runtime: it.runtime || k.runtime };
  },
  // карточка из TMDB + Кинопоиск
  async fromTmdbPlus(id, type) { const b = await this.fromTmdb(id, type); return this.mergeKp(b, await this.kpMatch(b)); },
  // карточка по Кинопоиску: основа — TMDB (если Кинопоиск знает его ID), иначе данные самого Кинопоиска
  async fromKp(id) {
    const k = await this.kp('/movie/' + id); let base = null;
    if (k.tmdb) { try { base = await this.fromTmdb(k.tmdb, k.type); } catch (e) {} }
    if (base && k.year && base.year && Math.abs(base.year - k.year) > 1) base = null; // ID TMDB для фильмов и сериалов пересекаются
    if (!base) base = { type: k.type, title: k.title, year: k.year, poster: k.poster, genres: k.genres, seasons: [], w: [], director: '', overview: k.overview, imdb: k.imdb, runtime: k.runtime };
    return this.mergeKp(base, k);
  },
  // стриминговые сервисы пользователя («у меня есть Иви и Кинопоиск»): названия из TMDB и Кинопоиска приводятся к одному ключу
  SVC: { kp: ['Кинопоиск', ['кинопоиск', 'kinopoisk']], ivi: ['Иви', ['иви', 'ivi']], okko: ['Okko', ['okko']], wink: ['Wink', ['wink']], premier: ['Premier', ['premier']], kion: ['KION', ['kion']], start: ['START', ['start']], more: ['more.tv', ['more']] },
  svcKey(name) { const n = String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); return Object.keys(this.SVC).find(k => this.SVC[k][1].some(a => n.startsWith(a))) || ''; },
  mySvc() { try { return JSON.parse(localStorage.getItem('kp_svc')) || []; } catch (e) { return []; } },
  // --- ручные карточки ---
  // постер: только http(s)-ссылка или картинка data:image; символы, ломающие CSS url('…'), кодируются
  safePoster(u) {
    u = String(u || '').trim();
    if (!/^(https?:\/\/|data:image\/(jpeg|png|webp|gif);base64,)/i.test(u)) return '';
    return u.replace(/['"()\\\s<>]/g, c => c.charCodeAt(0) < 128 ? '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') : encodeURIComponent(c));
  },
  // IMDb ID (tt1234567) из ID или из ссылки на страницу фильма
  imdbId(s) { return (String(s || '').match(/tt\d{7,10}/) || [''])[0]; },
  // файл с устройства -> уменьшенный JPEG (data URL), чтобы карточка не раздувала библиотеку: ~20–40 КБ вместо мегабайтов
  imgToData(file, maxW = 320, maxH = 480, q = 0.8) {
    return new Promise((ok, bad) => {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return bad(new Error('Подходит JPG, PNG, WebP или GIF'));
      if (file.size > 15e6) return bad(new Error('Файл больше 15 МБ. Выберите изображение поменьше'));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const k = Math.min(1, maxW / img.width, maxH / img.height), c = document.createElement('canvas'), x = c.getContext('2d');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        x.fillStyle = '#190909'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        ok(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => { URL.revokeObjectURL(url); bad(new Error('Не удалось прочитать изображение')); };
      img.src = url;
    });
  },
  find(l, t, y) { return l.find(i => i.title.toLowerCase() === t.toLowerCase() && String(i.year) === String(y)); },
  // добавление с проверкой дубля «название + год»
  add(it) {
    const l = this.load(), ex = this.find(l, it.title, it.year) || (it.tmdb && l.find(i => i.tmdb === it.tmdb && i.type === it.type)) || (it.kpId && l.find(i => i.kpId === it.kpId));
    if (ex) return { dup: ex };
    it = { status: 'plan', rating: 0, tags: [], genres: [], cols: [], source: 'stream', url: '', inv: '', review: '', progress: '', runtime: 0, ...it,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), added: Date.now(), upd: Date.now() };
    l.push(it); if (!this.save(l)) return { fail: true }; return { item: it };
  },
  update(id, p) {
    const l = this.load(), i = l.find(x => x.id === id); if (!i) return;
    Object.assign(i, p, { upd: Date.now() });
    if (p.status === 'done' && !i.watched) i.watched = Date.now();
    return this.save(l);
  },
  remove(id) { this.save(this.load().filter(i => i.id !== id)); },
  // --- подборки: состав хранится в карточках (cols), а описание и видимость («личная» / «публичная») — на сервере ---
  myCols() { return this.tok ? this.api('/my/collections') : Promise.resolve([]); },
  createCol(name, descr, pub) { return this.api('/my/collections', { method: 'POST', body: { name, descr, public: !!pub } }); },
  saveCol(c) { return this.api('/my/collections', { method: 'PUT', body: { name: c.name, descr: c.descr || '', public: !!c.public } }); },
  // добавить фильм в подборку / убрать из неё (дату изменения не трогаем, чтобы не сбивать напоминания)
  toggleCol(id, name, on) {
    const l = this.load(), i = l.find(x => x.id === id); if (!i) return false;
    const s = new Set(i.cols); on ? s.add(name) : s.delete(name); i.cols = [...s]; return this.save(l);
  },
  // удалить подборку: фильмы остаются в библиотеке
  async deleteCol(name) {
    const l = this.load(); l.forEach(i => { i.cols = i.cols.filter(c => c !== name); }); this.save(l);
    await this.api('/my/collections/' + encodeURIComponent(name), { method: 'DELETE' });
  },
  // --- рецензии: текст + впечатление + пометка «спойлеры» + «показывать другим» (всё хранится в самой карточке) ---
  RV: { pos: ['👍', 'Понравилось'], neu: ['😐', 'Нейтрально'], neg: ['👎', 'Не понравилось'] }, RV_MAX: 3000,
  tone(k) { return Object.hasOwn(this.RV, k) ? this.RV[k] : null; },
  hasRv(i) { return !!(i && String(i.review || '').trim()); },
  // рецензия для чтения; r = { review, revTone, revSpoiler, revAt, rating }; who — автор (у чужих рецензий);
  // own — своя рецензия: спойлер не скрываем, оценку не дублируем (она рядом, в блоке со звёздами)
  rvView(r, who = '', own = false) {
    const e = this.esc, t = this.tone(r.revTone), sp = !!r.revSpoiler, hide = sp && !own, n = Math.max(0, Math.min(5, Math.round(+r.rating) || 0));
    return `<div class="rv ${t ? r.revTone : ''}"><div class="rv-h">${who ? `<a class="rv-who" href="profile.html?u=${encodeURIComponent(who)}">${e(who)}</a>` : ''}${t ? `<span class="rv-tone">${t[0]} ${t[1]}</span>` : ''}${!own && n ? `<span class="rv-st" title="Оценка ${n} из 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : ''}${own && sp ? '<span class="rv-tone">⚠ спойлеры</span>' : ''}${r.revAt ? `<small>${new Date(r.revAt).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}</small>` : ''}</div>
      <div class="rv-t${hide ? ' spoil' : ''}">${e(r.review)}</div>${hide ? '<button type="button" class="b g rv-sp">⚠ Есть спойлеры — показать</button>' : ''}</div>`;
  },
  // форма рецензии внутри box; done(true) — сохранено, done(false) — отмена
  rvForm(box, id, done) {
    const it = this.load().find(x => x.id === id); if (!it) return done(false);
    const had = this.hasRv(it); let tone = this.tone(it.revTone) ? it.revTone : '';
    box.innerHTML = `<div class="rv-form">
      <div class="rv-tones" role="group" aria-label="Впечатление">${Object.entries(this.RV).map(([k, v]) => `<button type="button" class="chip" data-t="${k}">${v[0]} ${v[1]}</button>`).join('')}</div>
      <textarea rows="7" maxlength="${this.RV_MAX}" aria-label="Текст рецензии" placeholder="Чем запомнился фильм? Что понравилось, что нет? Кому бы вы его посоветовали?"></textarea>
      <div class="hint rv-cnt"></div>
      <label class="rv-ck"><input type="checkbox" name="sp"><span>В тексте есть спойлеры <small>(другим он будет скрыт, пока не нажмут «показать»)</small></span></label>
      <label class="rv-ck"><input type="checkbox" name="pub"><span>Показывать другим пользователям <small>(на странице фильма и в открытых подборках)</small></span></label>
      <div class="hint rv-login"></div>
      <p class="ferr" role="alert"></p>
      <div class="fact"><button type="button" class="b" data-r="s">Сохранить рецензию</button><button type="button" class="b g" data-r="c">Отмена</button></div></div>`;
    const ta = box.querySelector('textarea'), ck = n => box.querySelector(`[name="${n}"]`), err = box.querySelector('.ferr');
    ta.value = it.review || ''; ck('sp').checked = !!it.revSpoiler;
    ck('pub').checked = !!this.tok && (had ? !!it.revPublic : true); ck('pub').disabled = !this.tok;
    box.querySelector('.rv-login').textContent = this.tok ? '' : 'Войдите в аккаунт, чтобы рецензию могли прочитать другие пользователи.';
    const count = () => box.querySelector('.rv-cnt').textContent = `${ta.value.length} / ${this.RV_MAX}`;
    const tones = () => box.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === tone));
    ta.oninput = () => { count(); err.textContent = ''; }; count(); tones();
    box.onclick = ev => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.t) { tone = tone === b.dataset.t ? '' : b.dataset.t; return tones(); }
      if (b.dataset.r === 'c') return done(false);
      if (b.dataset.r !== 's') return;
      const text = ta.value.trim();
      if (!text) { err.textContent = had ? 'Рецензия пустая. Напишите текст или нажмите «Отмена»; удалить рецензию можно кнопкой под ней.' : 'Напишите текст рецензии.'; return; }
      const same = text === String(it.review || '').trim();
      if (this.update(id, { review: text, revTone: tone, revSpoiler: ck('sp').checked, revPublic: !!this.tok && ck('pub').checked, revAt: same && it.revAt ? it.revAt : Date.now() })) done(true);
    };
    ta.focus();
  },
  // блок «Моя рецензия»: пустое состояние → форма → готовая рецензия с кнопками «Изменить» и «Удалить»
  // o.edit — сразу открыть форму; o.change() — после сохранения и удаления; o.cancel() — «Отмена», если рецензии ещё нет;
  // o.close() — для диалога: добавляет кнопку «Закрыть» и закрывает диалог после удаления рецензии
  rvMine(box, id, o = {}) {
    const it = this.load().find(x => x.id === id); if (!it) { box.innerHTML = ''; box.onclick = null; return; }
    const go = (edit, changed) => { if (changed && o.change) o.change(); this.rvMine(box, id, { ...o, edit }); };
    if (o.edit) return this.rvForm(box, id, ok => { if (ok) go(false, true); else if (!this.hasRv(it) && o.cancel) o.cancel(); else go(false, false); });
    if (!this.hasRv(it)) {
      box.innerHTML = '<div class="rv-empty"><span>У вас пока нет рецензии на этот фильм.</span><button type="button" class="b edit" data-r="n">✎ Написать рецензию</button></div>';
      box.onclick = ev => { if (ev.target.closest('[data-r="n"]')) go(true); };
      return;
    }
    box.innerHTML = this.rvView(it, '', true) + `<div class="rv-bar"><small>${it.revPublic ? '🌐 Видна другим пользователям' : '🔒 Видна только вам'}</small><span class="rv-acts"><span class="edit"><button type="button" class="b g" data-r="e">Изменить</button><button type="button" class="b g" data-r="d">Удалить</button></span>${o.close ? '<button type="button" class="b g" data-r="x">Закрыть</button>' : ''}</span></div>`;
    box.onclick = ev => {
      const b = ev.target.closest('[data-r]'); if (!b) return;
      if (b.dataset.r === 'e') go(true);
      if (b.dataset.r === 'x' && o.close) o.close();
      if (b.dataset.r === 'd' && confirm('Удалить рецензию?')) {
        this.update(id, { review: '', revTone: '', revSpoiler: false, revPublic: false, revAt: 0 });
        if (o.close) { if (o.change) o.change(); o.close(); } else go(false, true);
      }
    };
  },
  // свободные фильмы: открытые проекты Blender Foundation (CC BY) и «Носферату» (1922, общественное достояние)
  DEMO: [
    { title: 'Big Buck Bunny', year: '2008', director: 'Sacha Goedegebure', genres: ['Анимация', 'Комедия'], runtime: 10, url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
    { title: 'Sintel', year: '2010', director: 'Colin Levy', genres: ['Анимация', 'Фэнтези'], runtime: 15, url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
    { title: 'Tears of Steel', year: '2012', director: 'Ian Hubert', genres: ['Фантастика'], runtime: 12, url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' },
    { title: 'Elephants Dream', year: '2006', director: 'Bassam Kurdali', genres: ['Анимация', 'Фантастика'], runtime: 11, url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
    { title: 'Nosferatu', year: '1922', director: 'F. W. Murnau', genres: ['Ужасы'], runtime: 94, url: 'https://archive.org/download/publicmovies212/Nosferatu.mp4' }
  ],
  async demo() {
    let n = 0;
    for (const d of this.DEMO) {
      let m = {};
      try { // постер и IMDb ID из TMDB, если доступен
        const r = (await this.tmdb('/search/movie', '&query=' + encodeURIComponent(d.title) + '&year=' + d.year)).results[0];
        if (r) { const x = await this.fromTmdb(r.id); m = { tmdb: x.tmdb, poster: x.poster, imdb: x.imdb, overview: x.overview }; }
      } catch (e) {}
      if (this.add({ type: 'movie', source: 'stream', tags: ['бесплатно', 'демо'], ...d, ...m }).item) n++;
    }
    return n;
  },
  esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  ST: { plan: 'В планах', progress: 'В процессе', done: 'Просмотрено' },
  SRC: { stream: 'Стриминг', local: 'Локальный файл', disc: 'Диск / носитель' },
  TY: { movie: 'Фильм', tv: 'Сериал', doc: 'Документальный' }
};
// спойлер в рецензии открывается по кнопке «показать» (работает на любой странице)
document.addEventListener('click', ev => {
  const b = ev.target.closest && ev.target.closest('.rv-sp'); if (!b) return;
  const t = b.parentNode.querySelector('.rv-t'); if (t) t.classList.remove('spoil'); b.remove();
});
