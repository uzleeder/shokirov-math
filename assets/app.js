// ============================================================
//  Shokirov Math Academy — frontend yordamchilari (lokal API)
// ============================================================
const API_BASE = window.API_BASE || '';

// --- Token (localStorage) ---
function getToken() { try { return localStorage.getItem('smacad_token'); } catch (e) { return null; } }
function setToken(t) { try { t ? localStorage.setItem('smacad_token', t) : localStorage.removeItem('smacad_token'); } catch (e) {} }

// --- API so'rovlari ---
async function apiFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const t = getToken(); if (t) headers['Authorization'] = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('Serverga ulanib bo\'lmadi. Server ishga tushganmi?');
  }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error((data && data.error) || ('Xatolik: ' + res.status)); err.status = res.status; throw err; }
  return data;
}
const api = {
  get: (p) => apiFetch(p),
  post: (p, b) => apiFetch(p, { method: 'POST', body: b }),
  patch: (p, b) => apiFetch(p, { method: 'PATCH', body: b }),
  del: (p) => apiFetch(p, { method: 'DELETE' })
};

// --- Auth ---
async function apiLogin(email, password) {
  const d = await api.post('/api/auth/login', { email, password });
  setToken(d.token); return d.user;
}
async function currentProfile() {
  if (!getToken()) return null;
  try { const d = await api.get('/api/me'); return d.user; }
  catch (e) { setToken(null); return null; }
}
async function guard(requiredRole) {
  const p = await currentProfile();
  if (!p) { location.href = 'login.html'; return null; }
  if (requiredRole && p.role !== requiredRole) {
    location.href = p.role === 'teacher' ? 'admin.html' : p.role === 'director' ? 'director.html' : 'student.html';
    return null;
  }
  return p;
}
function signOut() { setToken(null); location.href = 'login.html'; }

// --- Theme (dark/light) ---
(function () {
  try {
    let t = localStorage.getItem('theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) {}
}

// --- Kichik UI yordamchilari ---
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Brauzerning "uz-UZ" formati "2026 M08 14" deb chiqaradi — o'zbekcha oy nomlarini o'zimiz yozamiz
const OYLAR = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
               'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
function fmtDate(d) {
  if (!d) return '';
  try {
    const s = String(d);
    const dt = new Date((s.includes('T') ? s : s.replace(' ', 'T')) + (s.length <= 10 ? 'T00:00:00' : ''));
    if (isNaN(dt)) return s;
    return `${dt.getDate()}-${OYLAR[dt.getMonth()]}, ${dt.getFullYear()}`;
  } catch (e) { return d; }
}
// Rasmni kvadrat qilib kichraytirib, data URL (JPEG) qaytaradi
function resizeImageToDataURL(file, size) {
  size = size || 256;
  return new Promise((resolve, reject) => {
    if (!file.type || file.type.indexOf('image/') !== 0) return reject(new Error('Bu rasm fayli emas'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(img.width, img.height);
      const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Rasmni o\'qib bo\'lmadi')); };
    img.src = url;
  });
}

// Avatar HTML: rasm bo'lsa — rasm, bo'lmasa — ism harfi
function avatarHTML(user, cls) {
  cls = cls || 'avatar';
  const name = (user && user.full_name) ? user.full_name : '';
  if (user && user.avatar) return `<span class="${cls}" style="background-image:url('${user.avatar}');background-size:cover;background-position:center;"></span>`;
  return `<span class="${cls}">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
}

function toast(msg, ok) {
  if (ok === undefined) ok = true;
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('bad', !ok);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ============ Kalendar (o'qituvchi va talaba panellarida umumiy) ============
const K_UZ  = { lesson: 'Dars', exam: 'Imtihon', holiday: 'Dam olish', event: 'Tadbir' };
const K_CLS = { lesson: 'lesson', exam: 'exam', holiday: 'holiday', event: 'event' };

// oy: "2026-08", rows: /api/events javobi, ochirsa: o'chirish tugmasi ko'rsatilsinmi
function kalendarHTML(oy, rows, ochirsa) {
  const [y, m] = oy.split('-').map(Number);
  const kunSoni = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const jsBirinchi = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const bosh = jsBirinchi === 0 ? 6 : jsBirinchi - 1;      // dushanbadan boshlanadi
  const bugun = new Date().toISOString().slice(0, 10);

  // Har bir kunga hodisalarni taqsimlash (ko'p kunlik hodisa har kuniga tushadi)
  const kunlar = {};
  for (const e of rows) {
    const oxir = e.end_day || e.day;
    for (let d = new Date(e.day + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= oxir; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      if (k.slice(0, 7) === oy) (kunlar[k] = kunlar[k] || []).push(e);
    }
  }

  let kataklar = '';
  for (let i = 0; i < bosh; i++) kataklar += '<div class="cday out"></div>';
  for (let d = 1; d <= kunSoni; d++) {
    const k = `${oy}-${String(d).padStart(2, '0')}`;
    const es = kunlar[k] || [];
    kataklar += `<div class="cday${k === bugun ? ' today' : ''}${es.length ? ' has' : ''}">
      <span class="n">${d}</span>
      ${es.slice(0, 3).map(e => `<i class="ev ${K_CLS[e.kind]}" title="${esc(e.title)}">${esc(e.title)}</i>`).join('')}
      ${es.length > 3 ? `<i class="ev more">+${es.length - 3}</i>` : ''}
    </div>`;
  }

  const royxat = rows.slice().sort((a, b) => (a.day + (a.start_time || '')).localeCompare(b.day + (b.start_time || '')));
  return `
    <div class="cal">
      <div class="chead">${['Du', 'Se', 'Cho', 'Pay', 'Ju', 'Sha', 'Yak'].map(x => `<span>${x}</span>`).join('')}</div>
      <div class="cgrid">${kataklar}</div>
    </div>
    ${royxat.length ? `<div class="stack" style="margin-top:16px;">${royxat.map(e => `
      <div class="item">
        <div class="top">
          <div>
            <h4>${esc(e.title)}</h4>
            <div class="small muted">${fmtDate(e.day)}${e.end_day ? ' — ' + fmtDate(e.end_day) : ''}${e.start_time ? ' · ' + esc(e.start_time) : ''}${e.course_name ? ' · ' + esc(e.course_name) : ''}</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span class="ev-pill ${K_CLS[e.kind]}">${K_UZ[e.kind]}</span>
            ${ochirsa ? `<button class="xbtn" onclick="hodisaOchir(${e.id})" title="O'chirish">×</button>` : ''}
          </div>
        </div>
        ${e.description ? `<div class="small" style="margin-top:8px;">${esc(e.description)}</div>` : ''}
      </div>`).join('')}</div>` : '<div class="empty" style="margin-top:14px;">Bu oyda hodisa yo\'q</div>'}`;
}

// ============ Bildirishnomalar (qo'ng'iroqcha) ============
const BIL_ICON = {
  grade:      '<path d="M3 3v18h18"/><path d="M7 15v2M12 10v7M17 6v11"/>',
  feedback:   '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  assignment: '<path d="M9 3h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1z"/><path d="M9 13l2 2 4-4"/>',
  work:       '<path d="M9 3h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1z"/><path d="M9 13l2 2 4-4"/>',
  payment:    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  event:      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  cert:       '<circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-3 5 3-1.5-8"/>',
  application:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5z"/>',
  reset:      '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
};

let BIL = [];

// Sahifadagi #bilBtn tugmasi va #bilPanel oynasini boshqaradi
function bilInit() {
  const btn = document.getElementById('bilBtn');
  if (!btn) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); bilToggle(); });
  document.addEventListener('click', (e) => {
    const p = document.getElementById('bilPanel');
    if (p && p.classList.contains('open') && !p.contains(e.target)) p.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const p = document.getElementById('bilPanel'); if (p) p.classList.remove('open'); }
  });
  bilYangila();
  setInterval(bilYangila, 60000);   // har daqiqada tekshiradi
}

async function bilYangila() {
  try {
    const { n } = await api.get('/api/notifications/count');
    const d = document.getElementById('bilDot');
    if (d) { d.textContent = n > 99 ? '99+' : n; d.style.display = n ? '' : 'none'; }
  } catch (e) {}
}

async function bilToggle() {
  const p = document.getElementById('bilPanel');
  if (p.classList.contains('open')) { p.classList.remove('open'); return; }
  p.classList.add('open');
  const box = document.getElementById('bilList');
  box.innerHTML = '<div class="empty">Yuklanmoqda…</div>';
  try { BIL = await api.get('/api/notifications'); }
  catch (e) { box.innerHTML = `<div class="empty">Xato: ${esc(e.message)}</div>`; return; }

  if (!BIL.length) { box.innerHTML = '<div class="empty">Hozircha bildirishnoma yo\'q</div>'; return; }
  box.innerHTML = BIL.map(x => `
    <button class="bil-item${x.seen ? '' : ' yangi'}" onclick="bilOch(${x.id})">
      <span class="ic ${esc(x.kind)}"><svg viewBox="0 0 24 24">${BIL_ICON[x.kind] || BIL_ICON.event}</svg></span>
      <span class="tx">
        <b>${esc(x.title)}</b>
        ${x.body ? `<em>${esc(x.body)}</em>` : ''}
        <i>${fmtVaqt(x.created_at)}</i>
      </span>
    </button>`).join('');
}

// Bosilganda: o'qilgan deb belgilaydi va tegishli bo'limni ochadi
async function bilOch(id) {
  const x = BIL.find(b => b.id === id);
  document.getElementById('bilPanel').classList.remove('open');
  if (x && !x.seen) { try { await api.post('/api/notifications/seen', { id }); } catch (e) {} bilYangila(); }
  if (x && x.tab && typeof switchTab === 'function') switchTab(x.tab);
}

async function bilHammasi() {
  try { await api.post('/api/notifications/seen', {}); } catch (e) { return toast(e.message, false); }
  bilYangila();
  BIL.forEach(x => x.seen = true);
  document.querySelectorAll('#bilList .bil-item').forEach(el => el.classList.remove('yangi'));
  toast("Hammasi o'qilgan deb belgilandi");
}

// "5 daqiqa oldin", "2 kun oldin" — yaqin vaqtlar uchun
function fmtVaqt(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d)) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'hozirgina';
  if (s < 3600) return Math.floor(s / 60) + ' daqiqa oldin';
  if (s < 86400) return Math.floor(s / 3600) + ' soat oldin';
  if (s < 604800) return Math.floor(s / 86400) + ' kun oldin';
  return fmtDate(t);
}

// ============ Hisobotni yuklab olish ============
// <a href> Authorization sarlavhasini yubora olmaydi — shuning uchun
// fayl fetch bilan olinadi va blob orqali yuklab olinadi.
async function yuklab(path, nom) {
  const t = getToken();
  let res;
  try {
    res = await fetch(API_BASE + path, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  } catch (e) { return toast('Serverga ulanib bo\'lmadi', false); }

  if (!res.ok) {
    let m = 'Xatolik: ' + res.status;
    try { const d = await res.json(); if (d && d.error) m = d.error; } catch (e) {}
    return toast(m, false);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nom || 'hisobot.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Yuklab olindi: ' + a.download);
}

// ============ Mobil tekshiruv yordamchisi (faqat lokalda ishlaydi) ============
// Konsolda mobilAudit() deb chaqiriladi: ekrandan chiqib ketgan, ustma-ust tushgan
// yoki barmoq uchun juda kichik elementlarni topadi.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.mobilAudit = function () {
    const W = document.documentElement.clientWidth;
    const nom = el => {
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return (el.tagName.toLowerCase() + id + cls).slice(0, 60);
    };
    const yopiqDetailsIchida = el => {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (p.tagName === 'DETAILS' && !p.open) return true;
      return false;
    };
    const korinadi = el => {
      if (yopiqDetailsIchida(el)) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const yopishgan = el => {
      for (let p = el; p; p = p.parentElement) {
        const pos = getComputedStyle(p).position;
        if (pos === 'sticky' || pos === 'fixed' || pos === 'absolute') return true;
      }
      return false;
    };
    const hammasi = [...document.querySelectorAll('body *')].filter(korinadi);

    const toshgan = [];
    for (const el of hammasi) {
      const r = el.getBoundingClientRect();
      if (r.right > W + 1.5 || r.left < -1.5) {
        const p = el.parentElement, pr = p ? p.getBoundingClientRect() : null;
        if (pr && (pr.right > W + 1.5 || pr.left < -1.5)) continue;
        // O'zi yoki ota-onasi gorizontal aylanadigan bo'lsa (masalan .table-wrap) — muammo emas
        let aylanadi = false;
        for (let p = el; p && p !== document.body; p = p.parentElement)
          if (/auto|scroll/.test(getComputedStyle(p).overflowX)) { aylanadi = true; break; }
        if (aylanadi) continue;
        toshgan.push({ el: nom(el), chap: Math.round(r.left), ong: Math.round(r.right) });
      }
    }

    const matnli = hammasi.filter(el => el.children.length === 0 && (el.textContent || '').trim().length > 1);
    const ustmaUst = [];
    for (let i = 0; i < matnli.length; i++) for (let j = i + 1; j < matnli.length; j++) {
      const a = matnli[i], b = matnli[j];
      if (a.contains(b) || b.contains(a)) continue;
      // Yopishqoq header / ochiladigan oyna kontent ustiga tushishi normal
      if (yopishgan(a) || yopishgan(b)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const k = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)) *
                Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      if (k < 40) continue;
      const kich = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (k / kich > 0.25) ustmaUst.push({ a: nom(a), b: nom(b), foiz: Math.round(k / kich * 100),
        matnA: a.textContent.trim().slice(0, 20), matnB: b.textContent.trim().slice(0, 20) });
    }

    const kichikTugma = [];
    for (const el of hammasi) {
      if (!/^(a|button|summary|input|select|textarea)$/i.test(el.tagName)) continue;
      if (el.type === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.height < 32 || r.width < 28)
        kichikTugma.push({ el: nom(el), olcham: Math.round(r.width) + 'x' + Math.round(r.height),
          matn: (el.textContent || el.value || '').trim().slice(0, 18) });
    }

    const kesilgan = [];
    for (const el of matnli) {
      const s = getComputedStyle(el);
      if (s.overflow === 'visible') continue;
      if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none') continue;
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)
        kesilgan.push({ el: nom(el), matn: el.textContent.trim().slice(0, 30) });
    }

    return { ekran: W, gorizontalScroll: document.documentElement.scrollWidth > W + 1,
      toshgan, ustmaUst, kichikTugma, kesilgan,
      jami: { toshgan: toshgan.length, ustmaUst: ustmaUst.length,
              kichikTugma: kichikTugma.length, kesilgan: kesilgan.length } };
  };
}

// ============ Telefon uchun pastki navigatsiya ============
// Chapdagi vertikal menyu tor ekranda ko'p joy egallaydi va chiroyli chiqmaydi.
// Shuning uchun telefonda u yashiriladi va o'rniga ekran pastida doimiy panel turadi:
// 4 ta asosiy bo'lim (data-mobil bilan belgilangan) + "Yana" tugmasi.
function mobilNavQur() {
  const tabs = document.querySelector('.shell > .tabs');
  if (!tabs || document.getElementById('mnav')) return;

  const hammasi = [...tabs.querySelectorAll('.tab')];
  const asosiy = hammasi.filter(t => t.dataset.mobil);
  const qolgan = hammasi.filter(t => !t.dataset.mobil);
  if (!asosiy.length) return;

  const ikonka = t => { const s = t.querySelector('svg'); return s ? s.outerHTML : ''; };
  const nom = t => (t.textContent || '').trim();

  const nav = document.createElement('nav');
  nav.id = 'mnav';
  nav.className = 'mnav';
  nav.setAttribute('aria-label', "Bo'limlar");
  nav.innerHTML =
    asosiy.map(t => `
      <button class="mnav-item" data-mnav="${t.dataset.tab}" onclick="switchTab('${t.dataset.tab}')">
        <span class="ic">${ikonka(t)}<i class="mnav-dot" data-dot="${t.dataset.tab}"></i></span>
        <span class="lb">${esc(t.dataset.mobil)}</span>
      </button>`).join('') +
    `<button class="mnav-item" id="mnavYana" onclick="mobilVaraqOch()">
       <span class="ic"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
         <i class="mnav-dot" data-dot="yana"></i></span>
       <span class="lb">Yana</span>
     </button>`;
  document.body.appendChild(nav);

  // "Yana" varag'i — qolgan bo'limlar
  const varaq = document.createElement('div');
  varaq.id = 'mvaraq';
  varaq.className = 'mvaraq';
  varaq.innerHTML = `
    <div class="mvaraq-fon" onclick="mobilVaraqYop()"></div>
    <div class="mvaraq-panel">
      <div class="mvaraq-tut"></div>
      <div class="mvaraq-grid">
        ${qolgan.map(t => `
          <button class="mvaraq-item" data-mnav="${t.dataset.tab}"
                  onclick="switchTab('${t.dataset.tab}'); mobilVaraqYop();">
            <span class="ic">${ikonka(t)}</span>
            <span>${esc(nom(t))}</span>
          </button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(varaq);

  document.body.classList.add('mnav-bor');

  // switchTab har chaqirilganda pastki panel ham yangilansin
  if (typeof window.switchTab === 'function' && !window.switchTab._mnav) {
    const eski = window.switchTab;
    const yangi = function (n) {
      eski.apply(this, arguments);
      mobilNavSync(n);
      // Bo'lim yuklangach belgilar (o'qilmagan xabar, vazifa soni) to'ladi
      setTimeout(mobilNavBelgi, 700);
    };
    yangi._mnav = true;
    window.switchTab = yangi;
  }
  mobilNavSync((document.querySelector('.tab.active') || {}).dataset?.tab);
  mobilNavBelgi();
  // Belgilar sahifa ochilgach ham, keyin ham fon so'rovlari bilan to'ladi
  [900, 2500, 5000].forEach(ms => setTimeout(mobilNavBelgi, ms));
  setInterval(mobilNavBelgi, 30000);
}

// Faol bo'limni belgilaydi. Bo'lim "Yana" ichida bo'lsa — "Yana" yonadi.
function mobilNavSync(name) {
  const nav = document.getElementById('mnav');
  if (!nav) return;
  let topildi = false;
  nav.querySelectorAll('.mnav-item[data-mnav]').forEach(b => {
    const on = b.dataset.mnav === name;
    b.classList.toggle('on', on);
    if (on) topildi = true;
  });
  const yana = document.getElementById('mnavYana');
  if (yana) yana.classList.toggle('on', !topildi);
  document.querySelectorAll('.mvaraq-item').forEach(b =>
    b.classList.toggle('on', b.dataset.mnav === name));
}

// Chapdagi menyudagi belgilarni (o'qilmagan xabar, vazifa soni) pastki panelga ko'chiradi
function mobilNavBelgi() {
  const tabs = document.querySelector('.shell > .tabs');
  const nav = document.getElementById('mnav');
  if (!tabs || !nav) return;
  let yashirin = 0;
  tabs.querySelectorAll('.tab').forEach(t => {
    // Faqat haqiqiy ogohlantirish (.dot) belgilanadi. "Talabalar (212)" kabi
    // oddiy sanoqlar qizil belgi emas — ular shunchaki ma'lumot.
    const dot = t.querySelector('.dot');
    const matn = dot ? (dot.textContent || '').replace(/[()\s]/g, '') : '';
    const bor = /^\d+$/.test(matn) && matn !== '0';
    const nuqta = nav.querySelector(`.mnav-dot[data-dot="${t.dataset.tab}"]`);
    if (nuqta) { nuqta.textContent = bor ? matn : ''; nuqta.classList.toggle('bor', bor); }
    else if (bor && !t.dataset.mobil) yashirin += parseInt(matn, 10);
  });
  const y = nav.querySelector('.mnav-dot[data-dot="yana"]');
  if (y) { y.textContent = ''; y.classList.toggle('bor', yashirin > 0); }
}

function mobilVaraqOch() {
  const v = document.getElementById('mvaraq');
  if (v) { v.classList.add('open'); document.body.classList.add('mvaraq-ochiq');
           document.body.style.overflow = 'hidden'; }
}
function mobilVaraqYop() {
  const v = document.getElementById('mvaraq');
  if (v) { v.classList.remove('open'); document.body.classList.remove('mvaraq-ochiq');
           document.body.style.overflow = ''; }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') mobilVaraqYop(); });
