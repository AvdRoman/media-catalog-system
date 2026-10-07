const KP = {
  key: 'd683225cef86fa8a035261070445fc66', // лучше заменить на свой ключ TMDB
  tmdbUrl: 'https://api.themoviedb.org/3',
  img: 'https://image.tmdb.org/t/p/w500',
  // --- аккаунт: у каждого пользователя своя библиотека; сервер (SQLite) — главное хранилище ---
  user: JSON.parse(localStorage.getItem('kp_user') || 'null'), tok: localStorage.getItem('kp_tok') || '',
  lk() { return 'kp_lib_' + (this.user ? this.user.id : 'guest'); },
  load() { try { return JSON.parse(localStorage.getItem(this.lk())) || []; } catch (e) { return []; } },
  save(l) { localStorage.setItem(this.lk(), JSON.stringify(l)); this.push(l); },
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
  nav() { const a = document.getElementById('me'); if (a) a.textContent = this.user ? '👤 ' + this.user.username : 'Войти'; },
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
  find(l, t, y) { return l.find(i => i.title.toLowerCase() === t.toLowerCase() && String(i.year) === String(y)); },
  // добавление с проверкой дубля «название + год»
  add(it) {
    const l = this.load(), ex = this.find(l, it.title, it.year);
    if (ex) return { dup: ex };
    it = { status: 'plan', rating: 0, tags: [], genres: [], collection: '', source: 'stream', url: '', inv: '', review: '', progress: '', runtime: 0, ...it,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), added: Date.now(), upd: Date.now() };
    l.push(it); this.save(l); return { item: it };
  },
  update(id, p) {
    const l = this.load(), i = l.find(x => x.id === id); if (!i) return;
    Object.assign(i, p, { upd: Date.now() });
    if (p.status === 'done' && !i.watched) i.watched = Date.now();
    this.save(l);
  },
  remove(id) { this.save(this.load().filter(i => i.id !== id)); },
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
