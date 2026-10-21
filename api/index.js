// ============================================================
//  Shokirov Math Academy — API (Express, Vercel serverless)
//  Baza: Postgres (Vercel Postgres / Neon)
// ============================================================
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./_db');

const JWT_SECRET = process.env.JWT_SECRET || 'shokirov-math-academy-dev-secret-change-me';

const app = express();
app.set('trust proxy', 1);          // Vercel proxy ortida — haqiqiy IP uchun
app.use(cors());
app.use(express.json({ limit: '3mb' }));

// ---------- Xavfsizlik sarlavhalari (helmet o'rniga, paketsiz) ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// ---------- Rate limiting (xotirada; serverless uchun yetarli) ----------
const _hits = new Map();
setInterval(() => {                      // eskirgan yozuvlarni tozalash
  const now = Date.now();
  for (const [k, v] of _hits) if (now > v.reset) _hits.delete(k);
}, 60000).unref?.();

function rateLimit({ windowMs, max, nom }) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.ip || req.socket?.remoteAddress || 'nomalum';
    const key = nom + ':' + ip;
    const now = Date.now();
    let v = _hits.get(key);
    if (!v || now > v.reset) { v = { n: 0, reset: now + windowMs }; _hits.set(key, v); }
    v.n++;
    const qolgan = Math.max(0, max - v.n);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', qolgan);
    if (v.n > max) {
      const sek = Math.ceil((v.reset - now) / 1000);
      res.setHeader('Retry-After', sek);
      return res.status(429).json({ error: `Juda ko'p urinish. ${sek} soniyadan keyin qayta urinib ko'ring.` });
    }
    next();
  };
}

// Login: 15 daqiqada 10 urinish (parol tanlashdan himoya)
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, nom: 'login' });
// Ariza: 1 soatda 5 ta (spam'dan himoya)
const arizaLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, nom: 'ariza' });
// Umumiy yozish amallari
const yozLimit = rateLimit({ windowMs: 60 * 1000, max: 60, nom: 'yoz' });

// Diagnostika — baza ishlamasa ham javob beradi (router'dan OLDIN turadi)
app.get(['/api/diag', '/diag'], async (req, res) => {
  try { res.json(await db.diag()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Barcha yo'llar shu router'da. Pastda u ham "/api", ham "/" ga ulanadi —
// shunda Vercel prefiksni saqlasa ham, olib tashlasa ham ishlaydi.
const r = express.Router();

// Har bir so'rovdan oldin jadvallar tayyorligiga ishonch hosil qilish
r.use(async (req, res, next) => {
  try { await db.ready(); next(); }
  catch (e) {
    console.error('DB init error:', e);
    const d = await db.diag().catch(() => ({}));
    const sabab = (d.rejim === 'yoq')
      ? "Ma'lumotlar bazasi ulanmagan (DATABASE_URL yo'q). Vercel: Storage → Create Database → Neon → Connect, so'ng qayta deploy qiling."
      : 'Bazaga ulanib bo\'lmadi: ' + (e.message || '');
    res.status(500).json({ error: sabab, diag: '/api/diag manzilini oching' });
  }
});

// async handler'larni o'rash (xatolarni ushlash uchun)
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Server xatosi: ' + (err.message || '') });
});

// -------- Yordamchilar --------
function sign(u) { return jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '30d' }); }
function pub(u) {
  return { id: u.id, email: u.email, role: u.role, full_name: u.full_name, first_name: u.first_name || null, middle_name: u.middle_name || null, last_name: u.last_name || null, birth_date: u.birth_date || null, phone: u.phone, avatar: u.avatar || null, created_at: u.created_at };
}

function auth(req, res, next) {
  const hh = req.headers.authorization || '';
  const t = hh.startsWith('Bearer ') ? hh.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Avtorizatsiya kerak' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Sessiya tugagan, qayta kiring' }); }
}
function teacherOnly(req, res, next) {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Faqat o\'qituvchi uchun' });
  next();
}
// O'qituvchi yoki direktor (to'lovlar va umumiy nazorat)
function staffOnly(req, res, next) {
  if (req.user.role !== 'teacher' && req.user.role !== 'director')
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  next();
}
const MONTH = () => new Date().toISOString().slice(0, 7);   // "2026-07"
// Talaba faqat o'zini, o'qituvchi ?student_id bo'yicha ko'radi
function targetStudent(req) {
  if (req.user.role !== 'teacher') return req.user.id;
  const id = parseInt(req.query.student_id, 10);
  return Number.isFinite(id) ? id : null;
}

// Bildirishnoma yozadi. Asosiy amalni to'xtatib qo'ymasligi uchun xatoni yutadi.
async function bildir(userId, kind, title, body, tab) {
  if (!userId) return;
  try {
    await db.run('INSERT INTO notifications (user_id, kind, title, body, tab) VALUES (?,?,?,?,?)',
      [userId, kind, String(title).slice(0, 120), body ? String(body).slice(0, 300) : null, tab || null]);
  } catch (e) {
    console.error('[bildirishnoma] yozilmadi:', e.message);
  }
}

// Barcha o'qituvchi va direktorlarga
async function bildirXodimlar(kind, title, body, tab) {
  const xs = await db.all("SELECT id FROM users WHERE role IN ('teacher','director')");
  for (const x of xs) await bildir(x.id, kind, title, body, tab);
}

// Barcha talabalarga (bitta so'rov bilan)
async function bildirTalabalar(kind, title, body, tab) {
  try {
    await db.run(
      `INSERT INTO notifications (user_id, kind, title, body, tab)
       SELECT id, ?, ?, ?, ? FROM users WHERE role = 'student'`,
      [kind, String(title).slice(0, 120), body ? String(body).slice(0, 300) : null, tab || null]);
  } catch (e) {
    console.error('[bildirishnoma] ommaviy yozilmadi:', e.message);
  }
}

// ================= AUTH =================
// Ommaviy ro'yxatdan o'tish YO'Q — talaba akkauntini o'qituvchi yaratadi.

r.post('/auth/login', loginLimit, h(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE email=?', [String(email || '').toLowerCase().trim()]);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Email yoki parol xato' });
  res.json({ token: sign(u), user: pub(u) });
}));

// ---- Parolni tiklash: talaba so'rov qoldiradi, o'qituvchi yangi parol beradi ----
r.post('/auth/forgot', loginLimit, h(async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const u = await db.get('SELECT id, role FROM users WHERE email=?', [email]);
  // Xavfsizlik: akkaunt bor-yo'qligini oshkor qilmaymiz — javob doim bir xil
  if (u && u.role === 'student') {
    const bor = await db.get("SELECT id FROM password_resets WHERE user_id=? AND status='new'", [u.id]);
    if (!bor) {
      await db.run('INSERT INTO password_resets (user_id, note) VALUES (?,?)',
        [u.id, String((req.body && req.body.note) || '').slice(0, 300) || null]);
      await bildirXodimlar('reset', "Parol tiklash so'rovi",
        u.full_name || u.email, 'dash');
    }
  }
  res.json({ ok: true, xabar: "So'rovingiz qabul qilindi. O'qituvchi tez orada siz bilan bog'lanadi." });
}));

// O'qituvchi: tiklash so'rovlari ro'yxati
r.get('/auth/resets', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all(`
    SELECT pr.id, pr.status, pr.note, pr.created_at, pr.handled_at, pr.new_password,
           u.id AS student_id, u.full_name, u.email, u.phone
    FROM password_resets pr JOIN users u ON u.id = pr.user_id
    ORDER BY (pr.status='new') DESC, pr.created_at DESC LIMIT 100`));
}));

// O'qituvchi so'rovni hal qiladi: yangi parol beradi yoki rad etadi
r.patch('/auth/resets/:id', auth, teacherOnly, h(async (req, res) => {
  const pr = await db.get('SELECT * FROM password_resets WHERE id=?', [req.params.id]);
  if (!pr) return res.status(404).json({ error: 'So\'rov topilmadi' });
  const { action, password } = req.body || {};

  if (action === 'reject') {
    await db.run("UPDATE password_resets SET status='rejected', handled_by=?, handled_at=now() WHERE id=?",
      [req.user.id, pr.id]);
    return res.json({ ok: true });
  }
  const yangi = String(password || '').trim();
  if (yangi.length < 4) return res.status(400).json({ error: 'Parol juda qisqa' });
  await db.run('UPDATE users SET password_hash=? WHERE id=?', [bcrypt.hashSync(yangi, 10), pr.user_id]);
  await db.run("UPDATE password_resets SET status='done', new_password=?, handled_by=?, handled_at=now() WHERE id=?",
    [yangi, req.user.id, pr.id]);
  res.json({ ok: true, password: yangi });
}));

r.get('/me', auth, h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'Topilmadi' });
  res.json({ user: pub(u) });
}));

// O'z profilini tahrirlash (ism, telefon, rasm, parol; email — faqat o'qituvchi)
r.patch('/profile', auth, h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!u) return res.status(404).json({ error: 'Topilmadi' });
  const { full_name, phone, avatar, password, email } = req.body || {};
  const newName = full_name != null ? full_name : u.full_name;
  const newPhone = phone != null ? phone : u.phone;
  const newAvatar = avatar !== undefined ? avatar : u.avatar;   // null yuborilsa — o'chiriladi

  let newEmail = u.email;
  if (email && u.role === 'teacher') {
    const e = String(email).toLowerCase().trim();
    if (e !== u.email) {
      const busy = await db.get('SELECT id FROM users WHERE email=? AND id<>?', [e, u.id]);
      if (busy) return res.status(409).json({ error: 'Bu email allaqachon band' });
      newEmail = e;
    }
  }

  let hash = u.password_hash;
  if (password) {
    if (String(password).length < 4) return res.status(400).json({ error: 'Parol juda qisqa' });
    hash = bcrypt.hashSync(String(password), 10);
  }
  await db.run('UPDATE users SET full_name=?, phone=?, avatar=?, password_hash=?, email=? WHERE id=?',
    [newName, newPhone, newAvatar, hash, newEmail, u.id]);
  const updated = await db.get('SELECT * FROM users WHERE id=?', [u.id]);
  res.json({ user: pub(updated) });
}));

// ================= APPLICATIONS (arizalar) =================
r.post('/applications', arizaLimit, h(async (req, res) => {
  const { first_name, middle_name, last_name, birth_date, phone, parent_name, grade, message } = req.body || {};
  const full = [last_name, first_name, middle_name].filter(Boolean).join(' ').trim()
    || (req.body && req.body.full_name) || '';
  if (!first_name || !last_name) return res.status(400).json({ error: 'Ism va familiya kerak' });
  if (!phone) return res.status(400).json({ error: 'Telefon raqam kerak' });
  await db.run(
    `INSERT INTO applications (full_name, first_name, middle_name, last_name, birth_date, phone, parent_name, grade, message)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [full, first_name, middle_name || null, last_name, birth_date || null,
     phone, parent_name || null, grade || null, message || null]);
  await bildirXodimlar('application', 'Yangi ariza', `${full} · ${phone}`, 'apps');
  res.status(201).json({ ok: true });
}));

r.get('/applications', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM applications ORDER BY created_at DESC'));
}));

r.patch('/applications/:id', auth, teacherOnly, h(async (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Noto\'g\'ri holat' });
  await db.run('UPDATE applications SET status=? WHERE id=?', [status, req.params.id]);
  res.json({ ok: true });
}));

r.delete('/applications/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM applications WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ================= STUDENTS =================
r.get('/students', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all("SELECT id, full_name, first_name, middle_name, last_name, birth_date, phone, email, avatar, landing_ok, created_at FROM users WHERE role='student' ORDER BY full_name"));
}));

// O'qituvchi talaba akkauntini yaratadi (login + parol beradi)
r.post('/students', auth, teacherOnly, h(async (req, res) => {
  const { full_name, first_name, middle_name, last_name, birth_date, phone, email, password, application_id } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email va parol kerak' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Parol juda qisqa' });
  const e = String(email).toLowerCase().trim();
  const busy = await db.get('SELECT id FROM users WHERE email=?', [e]);
  if (busy) return res.status(409).json({ error: 'Bu email allaqachon band' });
  const hash = bcrypt.hashSync(String(password), 10);
  const full = full_name || [last_name, first_name, middle_name].filter(Boolean).join(' ').trim() || null;
  const created = await db.get(
    `INSERT INTO users (email,password_hash,role,full_name,first_name,middle_name,last_name,birth_date,phone)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    [e, hash, 'student', full, first_name || null, middle_name || null, last_name || null, birth_date || null, phone || null]);
  if (application_id) await db.run('UPDATE applications SET status=? WHERE id=?', ['accepted', application_id]);
  res.status(201).json({ ok: true, id: created.id });
}));

// ================= GRADES =================
// Talabani o'chirish. Unga bog'liq hamma narsa (baho, davomat, to'lov,
// vazifa, sertifikat, xabar) baza sxemasidagi ON DELETE CASCADE bilan ketadi.
r.delete('/students/:id', auth, teacherOnly, h(async (req, res) => {
  const u = await db.get("SELECT id, full_name, role FROM users WHERE id=?", [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Talaba topilmadi' });
  if (u.role !== 'student') return res.status(403).json({ error: 'Faqat talaba akkauntini o\'chirish mumkin' });
  await db.run('DELETE FROM users WHERE id=?', [u.id]);
  res.json({ ok: true, ochirildi: u.full_name });
}));

r.get('/grades', auth, h(async (req, res) => {
  const sid = targetStudent(req);
  if (!sid) return res.json([]);
  res.json(await db.all('SELECT * FROM grades WHERE student_id=? ORDER BY created_at DESC', [sid]));
}));

r.post('/grades', auth, teacherOnly, h(async (req, res) => {
  const { student_id, topic, score, max_score, note } = req.body || {};
  if (!student_id || !topic || score == null) return res.status(400).json({ error: 'Ma\'lumot to\'liq emas' });
  await db.run('INSERT INTO grades (student_id,topic,score,max_score,note) VALUES (?,?,?,?,?)',
    [student_id, topic, score, max_score || 100, note || null]);
  await bildir(student_id, 'grade', 'Yangi baho qo\'yildi',
    `${topic}: ${score}/${max_score || 100}`, 'grades');
  res.status(201).json({ ok: true });
}));

r.delete('/grades/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM grades WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ================= FEEDBACK =================
r.get('/feedback', auth, h(async (req, res) => {
  const sid = targetStudent(req);
  if (!sid) return res.json([]);
  res.json(await db.all('SELECT * FROM feedback WHERE student_id=? ORDER BY created_at DESC', [sid]));
}));

r.post('/feedback', auth, teacherOnly, h(async (req, res) => {
  const { student_id, message } = req.body || {};
  if (!student_id || !message) return res.status(400).json({ error: 'Ma\'lumot to\'liq emas' });
  await db.run('INSERT INTO feedback (student_id,message) VALUES (?,?)', [student_id, message]);
  await bildir(student_id, 'feedback', 'O\'qituvchidan yangi izoh', message, 'feedback');
  res.status(201).json({ ok: true });
}));

r.delete('/feedback/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM feedback WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ================= ASSIGNMENTS (vazifalar) =================
r.get('/assignments', auth, h(async (req, res) => {
  const sid = targetStudent(req);
  if (!sid) return res.json([]);
  res.json(await db.all(`
    SELECT a.*, w.id AS work_id, w.status AS work_status, w.score AS work_score,
           w.teacher_note, w.answer AS work_answer, w.image AS work_image,
           w.submitted_at, w.graded_at
    FROM assignments a
    LEFT JOIN assignment_work w ON w.assignment_id = a.id AND w.student_id = a.student_id
    WHERE a.student_id = ? ORDER BY a.created_at DESC`, [sid]));
}));

r.post('/assignments', auth, teacherOnly, h(async (req, res) => {
  const { student_id, title, description, due_date } = req.body || {};
  if (!student_id || !title) return res.status(400).json({ error: 'Ma\'lumot to\'liq emas' });
  await db.run('INSERT INTO assignments (student_id,title,description,due_date) VALUES (?,?,?,?)',
    [student_id, title, description || null, due_date || null]);
  await bildir(student_id, 'assignment', 'Yangi uyga vazifa',
    title + (due_date ? ` · muddat ${due_date}` : ''), 'tasks');
  res.status(201).json({ ok: true });
}));

// ---- Vazifa topshirish (talaba) va baholash (o'qituvchi) ----
const WORK_UZ = { submitted: 'Tekshirilmoqda', accepted: 'Qabul qilindi', rework: 'Qayta ishlash' };

// Talaba vazifaga javob topshiradi (qayta topshirsa — yangilanadi)
r.post('/assignments/:id/work', auth, yozLimit, h(async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Faqat talaba topshiradi' });
  const a = await db.get('SELECT * FROM assignments WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Vazifa topilmadi' });
  if (a.student_id !== req.user.id) return res.status(403).json({ error: 'Bu sizning vazifangiz emas' });

  const answer = String((req.body && req.body.answer) || '').trim();
  const image = (req.body && req.body.image) || null;
  if (!answer && !image) return res.status(400).json({ error: 'Javob yoki rasm yuboring' });
  if (answer.length > 5000) return res.status(400).json({ error: 'Javob juda uzun' });

  await db.run(
    `INSERT INTO assignment_work (assignment_id, student_id, answer, image, status, submitted_at)
     VALUES (?,?,?,?, 'submitted', now())
     ON CONFLICT (assignment_id, student_id) DO UPDATE
     SET answer = EXCLUDED.answer, image = EXCLUDED.image, status = 'submitted',
         submitted_at = now(), score = NULL, teacher_note = NULL, graded_at = NULL`,
    [a.id, req.user.id, answer || null, image]);
  await db.run('UPDATE assignments SET done = true WHERE id=?', [a.id]);
  // JWT ichida ism yo'q — bazadan olamiz
  const me = await db.get('SELECT full_name FROM users WHERE id=?', [req.user.id]);
  await bildirXodimlar('work', 'Vazifa topshirildi',
    `${(me && me.full_name) || 'Talaba'} — ${a.title}`, 'work');
  res.status(201).json({ ok: true });
}));

// Vazifa + topshiriq (talaba o'zinikini, o'qituvchi ?student_id bo'yicha)
r.get('/assignments/:id/work', auth, h(async (req, res) => {
  const a = await db.get('SELECT * FROM assignments WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Topilmadi' });
  if (req.user.role !== 'teacher' && a.student_id !== req.user.id)
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const w = await db.get('SELECT * FROM assignment_work WHERE assignment_id=? AND student_id=?',
    [a.id, a.student_id]);
  res.json({ assignment: a, work: w || null });
}));

// O'qituvchi: tekshirish kutayotgan topshiriqlar
r.get('/works/pending', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all(`
    SELECT w.*, a.title, a.due_date, u.full_name AS student_name
    FROM assignment_work w
    JOIN assignments a ON a.id = w.assignment_id
    JOIN users u ON u.id = w.student_id
    WHERE w.status = 'submitted'
    ORDER BY w.submitted_at LIMIT 100`));
}));

// O'qituvchi baholaydi
r.patch('/works/:id', auth, teacherOnly, h(async (req, res) => {
  const w = await db.get('SELECT * FROM assignment_work WHERE id=?', [req.params.id]);
  if (!w) return res.status(404).json({ error: 'Topilmadi' });
  const { status, score, teacher_note } = req.body || {};
  if (status && !['submitted', 'accepted', 'rework'].includes(status))
    return res.status(400).json({ error: 'Noto\'g\'ri holat' });
  await db.run(
    `UPDATE assignment_work SET status=?, score=?, teacher_note=?, graded_at=now(), graded_by=? WHERE id=?`,
    [status || 'accepted',
     score != null && score !== '' ? score : null,
     teacher_note || null, req.user.id, w.id]);
  // Qayta ishlash so'ralsa — vazifa yana bajarilmagan bo'ladi
  if (status === 'rework') await db.run('UPDATE assignments SET done=false WHERE id=?', [w.assignment_id]);

  const a = await db.get('SELECT title FROM assignments WHERE id=?', [w.assignment_id]);
  await bildir(w.student_id, 'work',
    status === 'rework' ? 'Vazifa qayta ishlashga qaytarildi' : 'Vazifangiz qabul qilindi',
    `${a ? a.title : 'Vazifa'}${score != null && score !== '' ? ` · ${score} ball` : ''}${teacher_note ? ' · ' + teacher_note : ''}`,
    'tasks');
  res.json({ ok: true });
}));

// Done belgilash — talaba o'zinikini, o'qituvchi barchasini
r.patch('/assignments/:id', auth, h(async (req, res) => {
  const a = await db.get('SELECT * FROM assignments WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Topilmadi' });
  if (req.user.role !== 'teacher' && a.student_id !== req.user.id)
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  await db.run('UPDATE assignments SET done=? WHERE id=?', [!!(req.body && req.body.done), req.params.id]);
  res.json({ ok: true });
}));

r.delete('/assignments/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM assignments WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ================= KURSLAR =================
// Kitob fayli haqiqatan mavjudligini tekshirish (buzuq havola bo'lmasligi uchun)
const BOOKS_DIR = path.join(__dirname, '..', 'assets', 'books');
function withBook(c) {
  if (!c) return c;
  let exists = false;
  try { exists = !!c.book_file && require('fs').existsSync(path.join(BOOKS_DIR, c.book_file)); } catch (e) {}
  return { ...c, book_exists: exists };
}

r.get('/courses', h(async (req, res) => {
  const list = await db.all('SELECT * FROM courses ORDER BY sort, id');
  res.json(list.map(withBook));
}));

r.patch('/courses/:id', auth, teacherOnly, h(async (req, res) => {
  const c = await db.get('SELECT * FROM courses WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Kurs topilmadi' });
  const { title, duration, description, book_file } = req.body || {};
  await db.run('UPDATE courses SET title=?, duration=?, description=?, book_file=? WHERE id=?',
    [title != null ? title : c.title, duration != null ? duration : c.duration,
     description != null ? description : c.description,
     book_file !== undefined ? book_file : c.book_file, c.id]);
  res.json({ ok: true });
}));

// ================= BIRIKTIRISH (enrollments) =================
r.get('/enrollments', auth, h(async (req, res) => {
  const sid = targetStudent(req);
  if (!sid) return res.json([]);
  res.json(await db.all(
    `SELECT e.id, e.course_id, c.slug, c.title, c.duration, c.book_file
     FROM enrollments e JOIN courses c ON c.id = e.course_id
     WHERE e.student_id=? ORDER BY c.sort`, [sid]));
}));

r.post('/enrollments', auth, teacherOnly, h(async (req, res) => {
  const { student_id, course_id } = req.body || {};
  if (!student_id || !course_id) return res.status(400).json({ error: 'Ma\'lumot to\'liq emas' });
  await db.run('INSERT INTO enrollments (student_id,course_id) VALUES (?,?) ON CONFLICT DO NOTHING', [student_id, course_id]);
  res.status(201).json({ ok: true });
}));

r.delete('/enrollments/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM enrollments WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));
// Yengil ro'yxat: mavzular + har birida nechta mashq va nechtasi bajarilgan
r.get('/courses/:id/topics', auth, h(async (req, res) => {
  const courseId = parseInt(req.params.id, 10);
  const isTeacher = req.user.role === 'teacher';
  const studentId = isTeacher ? (parseInt(req.query.student_id, 10) || null) : req.user.id;

  if (!isTeacher) {
    const ok = await db.get('SELECT id FROM enrollments WHERE student_id=? AND course_id=?', [req.user.id, courseId]);
    if (!ok) return res.status(403).json({ error: 'Bu kursga biriktirilmagansiz' });
  }

  const course = await db.get('SELECT * FROM courses WHERE id=?', [courseId]);
  if (!course) return res.status(404).json({ error: 'Kurs topilmadi' });

  const rows = await db.all(
    `SELECT t.id, t.title, t.page_from, t.sort,
            (SELECT count(*)::int FROM exercises e WHERE e.topic_id = t.id) AS total,
            COALESCE((SELECT count(*)::int FROM submissions s JOIN exercises e2 ON e2.id = s.exercise_id
                      WHERE e2.topic_id = t.id AND s.student_id = ?), 0) AS submitted,
            COALESCE((SELECT count(*)::int FROM submissions s JOIN exercises e3 ON e3.id = s.exercise_id
                      WHERE e3.topic_id = t.id AND s.student_id = ? AND s.is_correct = true), 0) AS correct
     FROM topics t WHERE t.course_id = ? ORDER BY t.sort, t.id`,
    [studentId, studentId, courseId]);

  res.json({ course: withBook(course), topics: rows });
}));

// Bitta mavzu mashqlari (talabaning javoblari bilan)
r.get('/topics/:id/exercises', auth, h(async (req, res) => {
  const topicId = parseInt(req.params.id, 10);
  const t = await db.get('SELECT * FROM topics WHERE id=?', [topicId]);
  if (!t) return res.status(404).json({ error: 'Mavzu topilmadi' });

  const isTeacher = req.user.role === 'teacher';
  if (!isTeacher) {
    const ok = await db.get('SELECT id FROM enrollments WHERE student_id=? AND course_id=?', [req.user.id, t.course_id]);
    if (!ok) return res.status(403).json({ error: 'Bu kursga biriktirilmagansiz' });
  }
  const studentId = isTeacher ? (parseInt(req.query.student_id, 10) || null) : req.user.id;

  const list = await db.all('SELECT * FROM exercises WHERE topic_id=? ORDER BY sort, id', [topicId]);
  let subs = [];
  if (studentId) {
    subs = await db.all(
      `SELECT s.* FROM submissions s JOIN exercises e ON e.id = s.exercise_id
       WHERE e.topic_id=? AND s.student_id=?`, [topicId, studentId]);
  }
  const byEx = {}; subs.forEach(s => { byEx[s.exercise_id] = s; });

  res.json({
    topic: t,
    exercises: list.map(e => ({
      id: e.id, number: e.number, prompt: e.prompt, page: e.page, ref: e.ref,
      options: e.options || null,
      has_answer: !!(e.correct_answer || e.answer_letter),
      correct_answer: (isTeacher || byEx[e.id]) ? e.correct_answer : undefined,
      answer_letter: (isTeacher || byEx[e.id]) ? e.answer_letter : undefined,
      submission: byEx[e.id] || null
    }))
  });
}));

// ---- Mavzu / mashq boshqaruvi (o'qituvchi) ----
r.post('/topics', auth, teacherOnly, h(async (req, res) => {
  const { course_id, title, page_from, page_to, sort } = req.body || {};
  if (!course_id || !title) return res.status(400).json({ error: 'Kurs va mavzu nomi kerak' });
  const t = await db.get('INSERT INTO topics (course_id,title,page_from,page_to,sort) VALUES (?,?,?,?,?) RETURNING id',
    [course_id, title, page_from || null, page_to || null, sort || 0]);
  res.status(201).json({ ok: true, id: t.id });
}));

r.patch('/topics/:id', auth, teacherOnly, h(async (req, res) => {
  const t = await db.get('SELECT * FROM topics WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Topilmadi' });
  const { title, page_from, page_to, sort } = req.body || {};
  await db.run('UPDATE topics SET title=?, page_from=?, page_to=?, sort=? WHERE id=?',
    [title != null ? title : t.title, page_from !== undefined ? page_from : t.page_from,
     page_to !== undefined ? page_to : t.page_to, sort != null ? sort : t.sort, t.id]);
  res.json({ ok: true });
}));

r.delete('/topics/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM topics WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

r.post('/exercises', auth, teacherOnly, h(async (req, res) => {
  const { topic_id, number, prompt, correct_answer, page, sort } = req.body || {};
  if (!topic_id) return res.status(400).json({ error: 'Mavzu kerak' });
  const e = await db.get('INSERT INTO exercises (topic_id,number,prompt,correct_answer,page,sort) VALUES (?,?,?,?,?,?) RETURNING id',
    [topic_id, number || null, prompt || null, correct_answer || null, page || null, sort || 0]);
  res.status(201).json({ ok: true, id: e.id });
}));

r.patch('/exercises/:id', auth, teacherOnly, h(async (req, res) => {
  const e = await db.get('SELECT * FROM exercises WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Topilmadi' });
  const { number, prompt, correct_answer, page, sort } = req.body || {};
  await db.run('UPDATE exercises SET number=?, prompt=?, correct_answer=?, page=?, sort=? WHERE id=?',
    [number !== undefined ? number : e.number, prompt !== undefined ? prompt : e.prompt,
     correct_answer !== undefined ? correct_answer : e.correct_answer,
     page !== undefined ? page : e.page, sort != null ? sort : e.sort, e.id]);
  res.json({ ok: true });
}));

r.delete('/exercises/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM exercises WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// Ommaviy import — kitobdan mavzu va mashqlarni birdaniga yuklash
// { course_id, replace: true, topics: [{ title, page_from, page_to,
//   exercises: [{ number, prompt, correct_answer, page }] }] }
r.post('/import', auth, teacherOnly, h(async (req, res) => {
  const { course_id, topics, replace } = req.body || {};
  if (!course_id || !Array.isArray(topics)) return res.status(400).json({ error: 'course_id va topics kerak' });
  if (replace) await db.run('DELETE FROM topics WHERE course_id=?', [course_id]);
  let nT = 0, nE = 0;
  const startSort = replace ? 0 : (await db.get('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM topics WHERE course_id=?', [course_id])).n;

  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const row = await db.get('INSERT INTO topics (course_id,title,page_from,page_to,sort) VALUES (?,?,?,?,?) RETURNING id',
      [course_id, t.title || ('Mavzu ' + (i + 1)), t.page_from || null, t.page_to || null, startSort + i]);
    nT++;

    // Mashqlarni to'plamlab qo'shamiz (bittalab emas) — aks holda sekin va timeout bo'ladi
    const list = Array.isArray(t.exercises) ? t.exercises : [];
    const COLS = 8, BATCH = 100;
    for (let b = 0; b < list.length; b += BATCH) {
      const chunk = list.slice(b, b + BATCH);
      const ph = [], vals = [];
      chunk.forEach((e, k) => {
        const o = k * COLS;
        ph.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`);
        vals.push(
          row.id,
          e.number || String(b + k + 1),
          e.prompt || null,
          e.correct_answer || null,
          e.options ? JSON.stringify(e.options) : null,
          e.answer_letter || null,
          e.ref || null,
          e.page || null
        );
      });
      await db.pool.query(
        `INSERT INTO exercises (topic_id,number,prompt,correct_answer,options,answer_letter,ref,page)
         VALUES ${ph.join(',')}`, vals);
      nE += chunk.length;
    }
  }
  res.status(201).json({ ok: true, topics: nT, exercises: nE });
}));

// ================= JAVOBLAR (submissions) =================
// Javobni solishtirish uchun normallashtirish
function normAnswer(s) {
  return String(s == null ? '' : s)
    .toLowerCase().trim()
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/[−–—]/g, '-');
}

// Talaba javob yuboradi (qayta yuborsa — yangilanadi)
r.post('/submissions', auth, yozLimit, h(async (req, res) => {
  const { exercise_id, answer, answer_letter } = req.body || {};
  if (!exercise_id) return res.status(400).json({ error: 'Mashq tanlanmagan' });

  const ex = await db.get(
    `SELECT e.*, t.course_id FROM exercises e JOIN topics t ON t.id = e.topic_id WHERE e.id=?`, [exercise_id]);
  if (!ex) return res.status(404).json({ error: 'Mashq topilmadi' });

  const studentId = req.user.role === 'teacher' ? parseInt(req.body.student_id, 10) : req.user.id;
  if (!studentId) return res.status(400).json({ error: 'Talaba aniqlanmadi' });

  if (req.user.role !== 'teacher') {
    const ok = await db.get('SELECT id FROM enrollments WHERE student_id=? AND course_id=?', [studentId, ex.course_id]);
    if (!ok) return res.status(403).json({ error: 'Bu kursga biriktirilmagansiz' });
  }

  // Avtomatik tekshirish: test bo'lsa — harf bo'yicha, aks holda — matn bo'yicha
  let isCorrect = null, checkedBy = null;
  const letter = answer_letter ? String(answer_letter).trim().toUpperCase() : null;
  if (ex.answer_letter && letter) {
    isCorrect = letter === String(ex.answer_letter).trim().toUpperCase();
    checkedBy = 'auto';
  } else if (ex.correct_answer && answer != null && answer !== '') {
    isCorrect = normAnswer(answer) === normAnswer(ex.correct_answer);
    checkedBy = 'auto';
  }

  await db.run(
    `INSERT INTO submissions (exercise_id, student_id, answer, answer_letter, is_correct, checked_by, updated_at)
     VALUES (?,?,?,?,?,?, now())
     ON CONFLICT (exercise_id, student_id) DO UPDATE
     SET answer = EXCLUDED.answer, answer_letter = EXCLUDED.answer_letter,
         is_correct = EXCLUDED.is_correct, checked_by = EXCLUDED.checked_by,
         teacher_note = NULL, updated_at = now()`,
    [exercise_id, studentId, answer || null, letter, isCorrect, checkedBy]);

  res.status(201).json({
    ok: true, is_correct: isCorrect, checked_by: checkedBy,
    correct_letter: ex.answer_letter || null, correct_answer: ex.correct_answer || null
  });
}));

// O'qituvchi tekshirish ro'yxati (yangi/tekshirilmagan javoblar)
r.get('/submissions', auth, teacherOnly, h(async (req, res) => {
  const onlyPending = String(req.query.pending || '') === '1';
  const sid = parseInt(req.query.student_id, 10);
  const where = [];
  const params = [];
  if (onlyPending) where.push('s.is_correct IS NULL');
  if (sid) { where.push('s.student_id=?'); params.push(sid); }
  const sql =
    `SELECT s.*, e.number, e.prompt, e.correct_answer, e.page,
            t.title AS topic_title, c.title AS course_title, c.id AS course_id,
            u.full_name AS student_name
     FROM submissions s
     JOIN exercises e ON e.id = s.exercise_id
     JOIN topics t ON t.id = e.topic_id
     JOIN courses c ON c.id = t.course_id
     JOIN users u ON u.id = s.student_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.updated_at DESC LIMIT 200`;
  res.json(await db.all(sql, params));
}));

// O'qituvchi javobni baholaydi / izoh yozadi
r.patch('/submissions/:id', auth, teacherOnly, h(async (req, res) => {
  const s = await db.get('SELECT * FROM submissions WHERE id=?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Topilmadi' });
  const { is_correct, teacher_note } = req.body || {};
  await db.run('UPDATE submissions SET is_correct=?, teacher_note=?, checked_by=?, updated_at=now() WHERE id=?',
    [is_correct === undefined ? s.is_correct : !!is_correct,
     teacher_note !== undefined ? teacher_note : s.teacher_note, 'teacher', s.id]);
  res.json({ ok: true });
}));

// Talabaning kurslar bo'yicha jarayoni
r.get('/progress', auth, h(async (req, res) => {
  const sid = targetStudent(req);
  if (!sid) return res.json([]);
  res.json(await db.all(
    `SELECT c.id AS course_id, c.title, c.slug, c.book_file, c.duration,
            (SELECT count(*)::int FROM exercises e JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id) AS total,
            (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
              JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=?) AS submitted,
            (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
              JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=? AND s.is_correct = true) AS correct
     FROM courses c
     JOIN enrollments en ON en.course_id = c.id AND en.student_id = ?
     ORDER BY c.sort`, [sid, sid, sid]));
}));

// ================= TO'LOVLAR =================
// Talaba — faqat o'zinikini; o'qituvchi/direktor — hammasini
r.get('/payments', auth, h(async (req, res) => {
  const isStaff = req.user.role === 'teacher' || req.user.role === 'director';
  const sid = isStaff ? (parseInt(req.query.student_id, 10) || null) : req.user.id;
  const period = req.query.period || null;
  const where = [], params = [];
  if (sid) { where.push('p.student_id=?'); params.push(sid); }
  if (period) { where.push('p.period=?'); params.push(period); }
  res.json(await db.all(
    `SELECT p.*, u.full_name AS student_name, u.phone
     FROM payments p JOIN users u ON u.id = p.student_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.period DESC, u.full_name`, params));
}));

// To'lovni belgilash / yangilash (o'qituvchi yoki direktor)
r.post('/payments', auth, staffOnly, h(async (req, res) => {
  const { student_id, period, amount, status, paid_at, method, note } = req.body || {};
  if (!student_id || !period) return res.status(400).json({ error: 'Talaba va davr kerak' });
  if (status && !['paid', 'unpaid', 'partial'].includes(status))
    return res.status(400).json({ error: 'Noto\'g\'ri holat' });
  await db.run(
    `INSERT INTO payments (student_id, period, amount, status, paid_at, method, note, marked_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?, now())
     ON CONFLICT (student_id, period) DO UPDATE
     SET amount = EXCLUDED.amount, status = EXCLUDED.status, paid_at = EXCLUDED.paid_at,
         method = EXCLUDED.method, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, updated_at = now()`,
    [student_id, period, amount || 0, status || 'unpaid',
     (status === 'paid' || status === 'partial') ? (paid_at || new Date().toISOString().slice(0, 10)) : null,
     method || null, note || null, req.user.id]);
  if (status === 'paid' || status === 'partial')
    await bildir(student_id, 'payment', 'To\'lovingiz qayd etildi',
      `${period} · ${Number(amount || 0).toLocaleString('uz-UZ')} so'm`, 'pay');
  res.status(201).json({ ok: true });
}));

// Oy bo'yicha to'lov holati: har bir talaba uchun bitta qator
r.get('/payments/month', auth, staffOnly, h(async (req, res) => {
  const period = req.query.period || MONTH();
  res.json({
    period,
    rows: await db.all(
      `SELECT u.id AS student_id, u.full_name, u.phone,
              COALESCE(p.status,'unpaid') AS status,
              COALESCE(p.amount,0) AS amount,
              p.paid_at, p.method, p.note, p.id AS payment_id
       FROM users u
       LEFT JOIN payments p ON p.student_id = u.id AND p.period = ?
       WHERE u.role='student'
       ORDER BY (COALESCE(p.status,'unpaid')='paid'), u.full_name`, [period])
  });
}));

// ================= DAVOMAT =================
r.get('/attendance', auth, h(async (req, res) => {
  const isStaff = req.user.role === 'teacher' || req.user.role === 'director';
  const sid = isStaff ? (parseInt(req.query.student_id, 10) || null) : req.user.id;
  const from = req.query.from || null, to = req.query.to || null;
  const where = [], params = [];
  if (sid) { where.push('a.student_id=?'); params.push(sid); }
  if (from) { where.push('a.day >= ?'); params.push(from); }
  if (to) { where.push('a.day <= ?'); params.push(to); }
  res.json(await db.all(
    `SELECT a.*, u.full_name AS student_name FROM attendance a
     JOIN users u ON u.id = a.student_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.day DESC LIMIT 500`, params));
}));

// Bir kunlik davomat: barcha talabalar + o'sha kundagi holati
r.get('/attendance/day', auth, teacherOnly, h(async (req, res) => {
  const day = req.query.day || new Date().toISOString().slice(0, 10);
  res.json({
    day,
    rows: await db.all(
      `SELECT u.id AS student_id, u.full_name, u.phone, a.status, a.note, a.id AS att_id
       FROM users u LEFT JOIN attendance a ON a.student_id = u.id AND a.day = ?
       WHERE u.role='student' ORDER BY u.full_name`, [day])
  });
}));

r.post('/attendance', auth, teacherOnly, h(async (req, res) => {
  const { student_id, day, status, note } = req.body || {};
  if (!student_id || !day) return res.status(400).json({ error: 'Talaba va sana kerak' });
  if (!['present', 'absent', 'late', 'excused'].includes(status || 'present'))
    return res.status(400).json({ error: 'Noto\'g\'ri holat' });
  await db.run(
    `INSERT INTO attendance (student_id, day, status, note, marked_by) VALUES (?,?,?,?,?)
     ON CONFLICT (student_id, day) DO UPDATE
     SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by`,
    [student_id, day, status || 'present', note || null, req.user.id]);
  res.status(201).json({ ok: true });
}));

r.delete('/attendance/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM attendance WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ================= REYTING (kurs bo'yicha musobaqa) =================
r.get('/rating', auth, h(async (req, res) => {
  const courseId = parseInt(req.query.course_id, 10) || null;
  const params = [];
  let joinFilter = '';
  if (courseId) { joinFilter = 'AND t.course_id = ?'; params.push(courseId); }

  const rows = await db.all(
    `SELECT u.id, u.full_name, u.avatar,
            COALESCE(SUM(CASE WHEN s.is_correct THEN 1 ELSE 0 END),0)::int AS correct,
            COUNT(s.id)::int AS attempted
     FROM users u
     LEFT JOIN submissions s ON s.student_id = u.id
     LEFT JOIN exercises e ON e.id = s.exercise_id
     LEFT JOIN topics t ON t.id = e.topic_id ${joinFilter}
     WHERE u.role = 'student'
     GROUP BY u.id, u.full_name, u.avatar
     ORDER BY correct DESC, attempted ASC, u.full_name`, params);

  let rank = 0, prev = null, shown = 0;
  const list = rows.map(x => {
    shown++;
    if (x.correct !== prev) { rank = shown; prev = x.correct; }
    return {
      ...x,
      accuracy: x.attempted ? Math.round(x.correct / x.attempted * 100) : 0,
      rank,
      me: x.id === req.user.id
    };
  });
  res.json(list);
}));

// ================= DASHBOARD'LAR =================
// Talaba: o'z ko'rsatkichlari
r.get('/dashboard/student', auth, h(async (req, res) => {
  const id = req.user.role === 'student' ? req.user.id : parseInt(req.query.student_id, 10);
  if (!id) return res.status(400).json({ error: 'Talaba aniqlanmadi' });

  const [ex, att, pay, grades] = await Promise.all([
    db.get(`SELECT COUNT(*)::int AS attempted,
                   COALESCE(SUM(CASE WHEN is_correct THEN 1 ELSE 0 END),0)::int AS correct
            FROM submissions WHERE student_id=?`, [id]),
    db.get(`SELECT COUNT(*)::int AS total,
                   COALESCE(SUM(CASE WHEN status='present' THEN 1 ELSE 0 END),0)::int AS present,
                   COALESCE(SUM(CASE WHEN status='absent'  THEN 1 ELSE 0 END),0)::int AS absent,
                   COALESCE(SUM(CASE WHEN status='late'    THEN 1 ELSE 0 END),0)::int AS late
            FROM attendance WHERE student_id=?`, [id]),
    db.get(`SELECT COUNT(*)::int AS months,
                   COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0)::int AS paid,
                   COALESCE(SUM(CASE WHEN status<>'paid' THEN 1 ELSE 0 END),0)::int AS debt
            FROM payments WHERE student_id=?`, [id]),
    db.get(`SELECT COUNT(*)::int AS n, COALESCE(AVG(score / NULLIF(max_score,0) * 100),0) AS avg
            FROM grades WHERE student_id=?`, [id])
  ]);

  const thisMonth = await db.get('SELECT * FROM payments WHERE student_id=? AND period=?', [id, MONTH()]);
  const totalEx = await db.get(
    `SELECT COUNT(*)::int AS n FROM exercises e JOIN topics t ON t.id=e.topic_id
     JOIN enrollments en ON en.course_id = t.course_id AND en.student_id = ?`, [id]);

  res.json({
    exercises: { ...ex, total: totalEx ? totalEx.n : 0, accuracy: ex.attempted ? Math.round(ex.correct / ex.attempted * 100) : 0 },
    attendance: { ...att, rate: att.total ? Math.round(att.present / att.total * 100) : 0 },
    payments: { ...pay, this_month: thisMonth ? thisMonth.status : 'unpaid', period: MONTH() },
    grades: { count: grades.n, avg: Math.round(Number(grades.avg) * 10) / 10 }
  });
}));

// O'qituvchi: barcha talabalar bo'yicha umumiy ko'rinish
r.get('/dashboard/teacher', auth, staffOnly, h(async (req, res) => {
  const period = req.query.period || MONTH();
  const students = await db.all(
    `SELECT u.id, u.full_name, u.phone, u.avatar,
            COALESCE(sub.attempted,0)::int AS attempted,
            COALESCE(sub.correct,0)::int   AS correct,
            COALESCE(att.total,0)::int     AS att_total,
            COALESCE(att.present,0)::int   AS att_present,
            COALESCE(p.status,'unpaid')    AS pay_status,
            sub.last_activity
     FROM users u
     LEFT JOIN (SELECT student_id, COUNT(*) AS attempted,
                       SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS correct,
                       MAX(updated_at) AS last_activity
                FROM submissions GROUP BY student_id) sub ON sub.student_id = u.id
     LEFT JOIN (SELECT student_id, COUNT(*) AS total,
                       SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present
                FROM attendance GROUP BY student_id) att ON att.student_id = u.id
     LEFT JOIN payments p ON p.student_id = u.id AND p.period = ?
     WHERE u.role='student'
     ORDER BY correct DESC, u.full_name`, [period]);

  const totals = {
    students: students.length,
    paid: students.filter(s => s.pay_status === 'paid').length,
    unpaid: students.filter(s => s.pay_status !== 'paid').length,
    active: students.filter(s => s.attempted > 0).length,
    inactive: students.filter(s => !s.attempted).length,
    new_apps: (await db.get("SELECT COUNT(*)::int AS n FROM applications WHERE status='new'")).n
  };
  res.json({ period, totals, students });
}));

// Direktor: to'lovlar va moliyaviy ko'rinish
r.get('/dashboard/director', auth, staffOnly, h(async (req, res) => {
  const period = req.query.period || MONTH();
  const [m, students, byMonth] = await Promise.all([
    db.get(`SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS yigilgan,
                   COUNT(*)::int AS yozuvlar,
                   COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0)::int AS tolagan
            FROM payments WHERE period=?`, [period]),
    db.get("SELECT COUNT(*)::int AS n FROM users WHERE role='student'"),
    db.all(`SELECT period,
                   COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS summa,
                   COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0)::int AS tolagan,
                   COUNT(*)::int AS jami
            FROM payments GROUP BY period ORDER BY period DESC LIMIT 12`)
  ]);
  res.json({
    period,
    jami_talaba: students.n,
    tolagan: m.tolagan,
    tolamagan: students.n - m.tolagan,
    yigilgan: Number(m.yigilgan) || 0,
    oylar: byMonth
  });
}));

// ================= CHAT (talaba ↔ o'qituvchi) =================
// Suhbat egasini aniqlash: talaba — o'zi; o'qituvchi — ?student_id
function threadId(req) {
  if (req.user.role === 'student') return req.user.id;
  const id = parseInt(req.query.student_id || (req.body && req.body.student_id), 10);
  return Number.isFinite(id) ? id : null;
}

// Suhbat xabarlari (after= bilan faqat yangilarini olish mumkin)
r.get('/messages', auth, h(async (req, res) => {
  if (req.user.role === 'director') return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const sid = threadId(req);
  if (!sid) return res.status(400).json({ error: 'Talaba tanlanmagan' });

  const after = parseInt(req.query.after, 10);
  const params = [sid];
  let sql = `SELECT m.id, m.sender_role, m.body, m.created_at, m.read_at,
                    u.full_name AS sender_name
             FROM messages m JOIN users u ON u.id = m.sender_id
             WHERE m.student_id = ?`;
  if (Number.isFinite(after)) { sql += ' AND m.id > ?'; params.push(after); }
  sql += ' ORDER BY m.id LIMIT 300';

  const rows = await db.all(sql, params);

  // Qarshi tomon yozganlarini o'qilgan deb belgilaymiz
  const qarshi = req.user.role === 'student' ? 'teacher' : 'student';
  await db.run(
    'UPDATE messages SET read_at = now() WHERE student_id=? AND sender_role=? AND read_at IS NULL',
    [sid, qarshi]);

  res.json(rows);
}));

// Xabar yuborish
r.post('/messages', auth, yozLimit, h(async (req, res) => {
  if (req.user.role === 'director') return res.status(403).json({ error: 'Ruxsat yo\'q' });
  const sid = threadId(req);
  if (!sid) return res.status(400).json({ error: 'Talaba tanlanmagan' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Xabar bo\'sh' });
  if (body.length > 2000) return res.status(400).json({ error: 'Xabar juda uzun (2000 belgidan ko\'p)' });

  // O'qituvchi faqat mavjud talabaga yoza oladi
  if (req.user.role === 'teacher') {
    const bor = await db.get("SELECT id FROM users WHERE id=? AND role='student'", [sid]);
    if (!bor) return res.status(404).json({ error: 'Talaba topilmadi' });
  }

  const row = await db.get(
    `INSERT INTO messages (student_id, sender_id, sender_role, body)
     VALUES (?,?,?,?) RETURNING id, created_at`,
    [sid, req.user.id, req.user.role, body]);
  res.status(201).json({ ok: true, id: row.id, created_at: row.created_at });
}));

// O'qituvchi: barcha suhbatlar ro'yxati (oxirgi xabar + o'qilmaganlar soni)
r.get('/messages/threads', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all(`
    SELECT u.id AS student_id, u.full_name, u.avatar,
           last.body AS last_body, last.created_at AS last_at, last.sender_role AS last_role,
           COALESCE(unread.n, 0)::int AS unread
    FROM users u
    LEFT JOIN LATERAL (
      SELECT m.body, m.created_at, m.sender_role FROM messages m
      WHERE m.student_id = u.id ORDER BY m.id DESC LIMIT 1
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM messages m
      WHERE m.student_id = u.id AND m.sender_role = 'student' AND m.read_at IS NULL
    ) unread ON true
    WHERE u.role = 'student'
    ORDER BY (unread.n > 0) DESC, last.created_at DESC NULLS LAST, u.full_name`));
}));

// O'qilmagan xabarlar soni (belgi uchun)
r.get('/messages/unread', auth, h(async (req, res) => {
  if (req.user.role === 'student') {
    const x = await db.get(
      "SELECT count(*)::int AS n FROM messages WHERE student_id=? AND sender_role='teacher' AND read_at IS NULL",
      [req.user.id]);
    return res.json({ unread: x.n });
  }
  if (req.user.role === 'teacher') {
    const x = await db.get(
      "SELECT count(*)::int AS n FROM messages WHERE sender_role='student' AND read_at IS NULL");
    return res.json({ unread: x.n });
  }
  res.json({ unread: 0 });
}));

// ================= SERTIFIKATLAR =================
// Kurs tugash sanasi = biriktirilgan kun + kurs davomiyligi (kunlarda)
const CERT_SQL = `
  SELECT c.id AS course_id, c.title, c.duration, COALESCE(c.duration_days,60) AS kunlar,
         en.created_at::date AS boshlangan,
         (en.created_at::date + COALESCE(c.duration_days,60)) AS tugaydi,
         ((en.created_at::date + COALESCE(c.duration_days,60)) - CURRENT_DATE) AS qolgan_kun,
         (SELECT count(*)::int FROM exercises e JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id) AS jami_mashq,
         (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
           JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=en.student_id) AS bajarilgan,
         (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
           JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=en.student_id AND s.is_correct) AS togri,
         cert.id AS cert_id, cert.number, cert.issued_at, cert.score
  FROM enrollments en
  JOIN courses c ON c.id = en.course_id
  LEFT JOIN certificates cert ON cert.student_id = en.student_id AND cert.course_id = c.id
  WHERE en.student_id = ?
  ORDER BY c.sort`;

function certHolat(row) {
  const qolgan = Number(row.qolgan_kun);
  if (row.number) return { holat: 'olingan', qolgan_kun: 0 };
  if (qolgan > 0) return { holat: 'davom_etmoqda', qolgan_kun: qolgan };
  return { holat: 'tayyor', qolgan_kun: 0 };          // muddat tugagan, o'qituvchi tasdiqlashi kerak
}

// Talabaning sertifikatlari va jarayoni
r.get('/certificates', auth, h(async (req, res) => {
  const isStaff = req.user.role === 'teacher' || req.user.role === 'director';
  const sid = isStaff ? (parseInt(req.query.student_id, 10) || null) : req.user.id;
  if (!sid) return res.json([]);
  const rows = await db.all(CERT_SQL, [sid]);
  res.json(rows.map(x => ({
    ...x,
    ...certHolat(x),
    aniqlik: x.bajarilgan ? Math.round(x.togri / x.bajarilgan * 100) : 0
  })));
}));

// O'qituvchi: sertifikat berish vaqti kelgan talabalar
r.get('/certificates/pending', auth, teacherOnly, h(async (req, res) => {
  const rows = await db.all(`
    SELECT u.id AS student_id, u.full_name, u.phone,
           c.id AS course_id, c.title AS course_title,
           en.created_at::date AS boshlangan,
           (en.created_at::date + COALESCE(c.duration_days,60)) AS tugaydi,
           ((en.created_at::date + COALESCE(c.duration_days,60)) - CURRENT_DATE) AS qolgan_kun,
           (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
             JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=u.id) AS bajarilgan,
           (SELECT count(*)::int FROM submissions s JOIN exercises e ON e.id=s.exercise_id
             JOIN topics t ON t.id=e.topic_id WHERE t.course_id=c.id AND s.student_id=u.id AND s.is_correct) AS togri
    FROM enrollments en
    JOIN users u ON u.id = en.student_id
    JOIN courses c ON c.id = en.course_id
    LEFT JOIN certificates cert ON cert.student_id = u.id AND cert.course_id = c.id
    WHERE cert.id IS NULL AND u.role = 'student'
    ORDER BY qolgan_kun, u.full_name`);
  res.json(rows.map(x => ({ ...x, aniqlik: x.bajarilgan ? Math.round(x.togri / x.bajarilgan * 100) : 0 })));
}));

// O'qituvchi sertifikat beradi (raqamini o'zi yozadi)
r.post('/certificates', auth, teacherOnly, h(async (req, res) => {
  const { student_id, course_id, number, issued_at, score, note } = req.body || {};
  if (!student_id || !course_id || !number) return res.status(400).json({ error: 'Talaba, kurs va raqam kerak' });
  const raqam = String(number).trim();
  if (raqam.length < 3) return res.status(400).json({ error: 'Raqam juda qisqa' });

  const band = await db.get('SELECT id FROM certificates WHERE number=?', [raqam]);
  if (band) return res.status(409).json({ error: 'Bu raqam allaqachon ishlatilgan' });
  const bor = await db.get('SELECT id FROM certificates WHERE student_id=? AND course_id=?', [student_id, course_id]);
  if (bor) return res.status(409).json({ error: 'Bu talabaga bu kurs uchun sertifikat berilgan' });

  const row = await db.get(
    `INSERT INTO certificates (student_id, course_id, number, issued_at, score, note, issued_by)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [student_id, course_id, raqam, issued_at || new Date().toISOString().slice(0, 10),
     score != null ? score : null, note || null, req.user.id]);
  await bildir(student_id, 'cert', 'Sertifikatingiz tayyor!',
    `Raqam: ${raqam}`, 'cert');
  res.status(201).json({ ok: true, id: row.id, number: raqam });
}));

r.delete('/certificates/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM certificates WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- OMMAVIY: sertifikatni raqam bo'yicha tekshirish (QR shu yerga olib keladi) ----
r.get('/verify/:number', h(async (req, res) => {
  const row = await db.get(`
    SELECT cert.number, cert.issued_at, cert.score,
           u.full_name AS student_name,
           c.title AS course_title, c.duration
    FROM certificates cert
    JOIN users u ON u.id = cert.student_id
    JOIN courses c ON c.id = cert.course_id
    WHERE lower(cert.number) = lower(?)`, [String(req.params.number).trim()]);
  if (!row) return res.status(404).json({ haqiqiy: false, error: 'Bunday sertifikat topilmadi' });
  res.json({ haqiqiy: true, ...row });
}));

// QR rasm (PNG) — sertifikat raqami uchun
r.get('/qr/:number', h(async (req, res) => {
  const QRCode = require('qrcode');
  const base = (process.env.PUBLIC_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host || '')))
    .replace(/\/+$/, '');
  const url = base + '/verify.html?n=' + encodeURIComponent(req.params.number);
  // Yuqori aniqlik + 'H' xato tuzatish darajasi → chop etilganda ham yaxshi skanerlanadi
  const png = await QRCode.toBuffer(url, {
    type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#ffffff' }
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(png);
}));

// ==================== IMTIHONLAR ====================
const HARFLAR = ['A', 'B', 'C', 'D', 'E'];

// Imtihon topshirish mumkinmi (vaqt oynasi bo'yicha)
function imtihonHolati(e) {
  const hozir = Date.now();
  if (!e.published) return 'draft';
  if (e.opens_at && hozir < new Date(e.opens_at).getTime()) return 'soon';
  if (e.closes_at && hozir > new Date(e.closes_at).getTime()) return 'closed';
  return 'open';
}

r.get('/exams', auth, h(async (req, res) => {
  if (req.user.role === 'student') {
    const rows = await db.all(`
      SELECT e.id, e.title, e.description, e.course_id, e.duration_min,
             e.opens_at, e.closes_at, e.published, c.title AS course_name,
             (SELECT count(*)::int FROM exam_questions q WHERE q.exam_id = e.id) AS savollar,
             a.id AS attempt_id, a.submitted_at, a.score, a.max_score
      FROM exams e
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN exam_attempts a ON a.exam_id = e.id AND a.student_id = ?
      WHERE e.published = true
        AND (e.course_id IS NULL OR EXISTS (
              SELECT 1 FROM enrollments en WHERE en.student_id = ? AND en.course_id = e.course_id))
      ORDER BY e.opens_at NULLS LAST, e.id DESC`, [req.user.id, req.user.id]);
    return res.json(rows.map(e => ({ ...e, holat: imtihonHolati(e) })));
  }
  const rows = await db.all(`
    SELECT e.*, c.title AS course_name,
           (SELECT count(*)::int FROM exam_questions q WHERE q.exam_id = e.id) AS savollar,
           (SELECT count(*)::int FROM exam_attempts a WHERE a.exam_id = e.id AND a.submitted_at IS NOT NULL) AS topshirganlar
    FROM exams e LEFT JOIN courses c ON c.id = e.course_id
    ORDER BY e.id DESC`);
  res.json(rows.map(e => ({ ...e, holat: imtihonHolati(e) })));
}));

r.post('/exams', auth, teacherOnly, yozLimit, h(async (req, res) => {
  const { title, description, course_id, duration_min, opens_at, closes_at } = req.body || {};
  const t = (title || '').trim();
  if (!t) return res.status(400).json({ error: 'Sarlavha kerak' });
  if (t.length > 120) return res.status(400).json({ error: 'Sarlavha juda uzun' });
  const dm = duration_min == null || duration_min === '' ? null : parseInt(duration_min, 10);
  if (dm != null && (!Number.isFinite(dm) || dm < 1 || dm > 600))
    return res.status(400).json({ error: 'Davomiylik 1–600 daqiqa orasida bo\'lsin' });
  if (opens_at && closes_at && new Date(closes_at) <= new Date(opens_at))
    return res.status(400).json({ error: 'Tugash vaqti boshlanishdan keyin bo\'lsin' });

  const row = await db.get(
    `INSERT INTO exams (title, description, course_id, duration_min, opens_at, closes_at, created_by)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [t, (description || '').trim().slice(0, 600) || null, course_id || null, dm,
     opens_at || null, closes_at || null, req.user.id]);
  res.status(201).json({ ok: true, id: row.id });
}));

r.patch('/exams/:id', auth, teacherOnly, h(async (req, res) => {
  const { published } = req.body || {};
  if (typeof published !== 'boolean') return res.status(400).json({ error: 'published kerak' });
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });
  if (published) {
    const q = await db.get('SELECT count(*)::int AS n FROM exam_questions WHERE exam_id=?', [e.id]);
    if (!q.n) return res.status(400).json({ error: 'Savolsiz imtihonni e\'lon qilib bo\'lmaydi' });
  }
  await db.run('UPDATE exams SET published=? WHERE id=?', [published, e.id]);
  if (published) await bildirTalabalar('event', 'Yangi imtihon: ' + e.title,
    e.duration_min ? e.duration_min + ' daqiqa' : null, 'exams');
  res.json({ ok: true });
}));

r.delete('/exams/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM exams WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// Imtihon savollari. Talabaga to'g'ri javob KO'RSATILMAYDI (topshirmagunicha).
r.get('/exams/:id', auth, h(async (req, res) => {
  const e = await db.get(
    'SELECT e.*, c.title AS course_name FROM exams e LEFT JOIN courses c ON c.id = e.course_id WHERE e.id=?',
    [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });
  const oqituvchi = req.user.role !== 'student';

  const savollar = await db.all(
    'SELECT id, prompt, options, score, sort, answer_letter FROM exam_questions WHERE exam_id=? ORDER BY sort, id',
    [e.id]);

  if (oqituvchi) return res.json({ exam: { ...e, holat: imtihonHolati(e) }, questions: savollar });

  if (!e.published) return res.status(403).json({ error: 'Bu imtihon hali e\'lon qilinmagan' });
  const urinish = await db.get('SELECT * FROM exam_attempts WHERE exam_id=? AND student_id=?',
    [e.id, req.user.id]);
  // Topshirib bo'lgan bo'lsa — javoblarni ham ko'rsatamiz (xatosini ko'rsin)
  const tugatgan = urinish && urinish.submitted_at;
  let javoblar = [];
  if (tugatgan) javoblar = await db.all('SELECT * FROM exam_answers WHERE attempt_id=?', [urinish.id]);

  res.json({
    exam: { ...e, holat: imtihonHolati(e) },
    attempt: urinish || null,
    questions: savollar.map(q => {
      const j = javoblar.find(x => x.question_id === q.id);
      return {
        id: q.id, prompt: q.prompt, options: q.options, score: q.score, sort: q.sort,
        ...(tugatgan ? { answer_letter: q.answer_letter, javobim: j ? j.answer_letter : null,
                         togri: j ? j.is_correct : null } : {})
      };
    })
  });
}));

r.post('/exams/:id/questions', auth, teacherOnly, yozLimit, h(async (req, res) => {
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });
  const { prompt, options, answer_letter, score } = req.body || {};
  const p = (prompt || '').trim();
  if (!p) return res.status(400).json({ error: 'Savol matni kerak' });
  if (p.length > 2000) return res.status(400).json({ error: 'Savol juda uzun' });
  const L = String(answer_letter || '').toUpperCase();
  if (!HARFLAR.includes(L)) return res.status(400).json({ error: 'To\'g\'ri javob A–E orasida bo\'lsin' });
  if (options && typeof options !== 'object') return res.status(400).json({ error: 'Variantlar noto\'g\'ri' });
  if (options && !options[L]) return res.status(400).json({ error: `"${L}" varianti yozilmagan` });
  const s = score == null || score === '' ? 1 : parseFloat(score);
  if (!Number.isFinite(s) || s <= 0 || s > 100) return res.status(400).json({ error: 'Ball 0 dan katta bo\'lsin' });

  const oxirgi = await db.get('SELECT COALESCE(max(sort),0)::int AS n FROM exam_questions WHERE exam_id=?', [e.id]);
  const row = await db.get(
    `INSERT INTO exam_questions (exam_id, prompt, options, answer_letter, score, sort)
     VALUES (?,?,?,?,?,?) RETURNING id`,
    [e.id, p, options ? JSON.stringify(options) : null, L, s, oxirgi.n + 1]);
  res.status(201).json({ ok: true, id: row.id });
}));

// Kitobdagi mashqlardan tasodifiy savollar tortib olish —
// 11 000 dan ortiq tayyor mashq bor, ularni qo'lda qayta yozish shart emas.
r.post('/exams/:id/fill', auth, teacherOnly, h(async (req, res) => {
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });
  const n = Math.min(Math.max(parseInt(req.body && req.body.count, 10) || 10, 1), 50);
  const topicId = parseInt(req.body && req.body.topic_id, 10) || null;
  const courseId = parseInt(req.body && req.body.course_id, 10) || e.course_id || null;

  const w = ["x.answer_letter IS NOT NULL", "x.options IS NOT NULL"];
  const p = [];
  if (topicId) { w.push('x.topic_id = ?'); p.push(topicId); }
  else if (courseId) { w.push('t.course_id = ?'); p.push(courseId); }
  p.push(e.id, n);

  const mashqlar = await db.all(`
    SELECT x.id, x.prompt, x.options, x.answer_letter
    FROM exercises x JOIN topics t ON t.id = x.topic_id
    WHERE ${w.join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM exam_questions q WHERE q.exam_id = ? AND q.exercise_id = x.id)
    ORDER BY random() LIMIT ?`, p);

  if (!mashqlar.length)
    return res.status(400).json({ error: 'Bu bo\'limda variantli mashq topilmadi' });

  let sort = (await db.get('SELECT COALESCE(max(sort),0)::int AS n FROM exam_questions WHERE exam_id=?', [e.id])).n;
  for (const m of mashqlar) {
    sort++;
    await db.run(
      `INSERT INTO exam_questions (exam_id, prompt, options, answer_letter, score, sort, exercise_id)
       VALUES (?,?,?,?,1,?,?)`,
      [e.id, m.prompt, typeof m.options === 'string' ? m.options : JSON.stringify(m.options),
       m.answer_letter, sort, m.id]);
  }
  res.status(201).json({ ok: true, qoshildi: mashqlar.length });
}));

r.delete('/exam-questions/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM exam_questions WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// Talaba imtihonni boshlaydi
r.post('/exams/:id/start', auth, h(async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Faqat talaba topshiradi' });
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });

  const holat = imtihonHolati(e);
  if (holat === 'draft') return res.status(403).json({ error: 'Bu imtihon hali e\'lon qilinmagan' });
  if (holat === 'soon') return res.status(403).json({ error: 'Imtihon hali boshlanmagan' });
  if (holat === 'closed') return res.status(403).json({ error: 'Imtihon muddati tugagan' });

  if (e.course_id) {
    const bor = await db.get('SELECT id FROM enrollments WHERE student_id=? AND course_id=?',
      [req.user.id, e.course_id]);
    if (!bor) return res.status(403).json({ error: 'Siz bu kursga biriktirilmagansiz' });
  }

  const eski = await db.get('SELECT * FROM exam_attempts WHERE exam_id=? AND student_id=?', [e.id, req.user.id]);
  if (eski && eski.submitted_at) return res.status(409).json({ error: 'Siz bu imtihonni allaqachon topshirgansiz' });
  if (eski) return res.json({ ok: true, attempt_id: eski.id, started_at: eski.started_at });

  const row = await db.get(
    'INSERT INTO exam_attempts (exam_id, student_id) VALUES (?,?) RETURNING id, started_at', [e.id, req.user.id]);
  res.status(201).json({ ok: true, attempt_id: row.id, started_at: row.started_at });
}));

// Talaba javoblarni topshiradi — avtomatik tekshiriladi
r.post('/exams/:id/submit', auth, yozLimit, h(async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Faqat talaba topshiradi' });
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });

  const urinish = await db.get('SELECT * FROM exam_attempts WHERE exam_id=? AND student_id=?', [e.id, req.user.id]);
  if (!urinish) return res.status(400).json({ error: 'Avval imtihonni boshlang' });
  if (urinish.submitted_at) return res.status(409).json({ error: 'Allaqachon topshirilgan' });

  // Vaqt tugaganini serverda tekshiramiz — brauzerdagi taymerga ishonib bo'lmaydi
  if (e.duration_min) {
    const otgan = (Date.now() - new Date(urinish.started_at).getTime()) / 60000;
    if (otgan > e.duration_min + 1)
      return res.status(403).json({ error: 'Vaqt tugagan — javoblar qabul qilinmadi' });
  }

  const javoblar = (req.body && req.body.answers) || {};
  if (typeof javoblar !== 'object') return res.status(400).json({ error: 'Javoblar noto\'g\'ri' });

  const savollar = await db.all('SELECT * FROM exam_questions WHERE exam_id=?', [e.id]);
  let ball = 0, jami = 0;
  for (const q of savollar) {
    jami += Number(q.score);
    const L = String(javoblar[q.id] || '').toUpperCase();
    const togri = HARFLAR.includes(L) && L === q.answer_letter;
    if (togri) ball += Number(q.score);
    await db.run(
      `INSERT INTO exam_answers (attempt_id, question_id, answer_letter, is_correct) VALUES (?,?,?,?)
       ON CONFLICT (attempt_id, question_id) DO UPDATE
       SET answer_letter = EXCLUDED.answer_letter, is_correct = EXCLUDED.is_correct`,
      [urinish.id, q.id, HARFLAR.includes(L) ? L : null, togri]);
  }
  await db.run('UPDATE exam_attempts SET submitted_at=now(), score=?, max_score=? WHERE id=?',
    [ball, jami, urinish.id]);

  const foiz = jami ? Math.round(ball / jami * 100) : 0;
  await bildirXodimlar('exam', 'Imtihon topshirildi',
    `${e.title} — ${ball}/${jami} (${foiz}%)`, 'exams');
  res.json({ ok: true, score: ball, max_score: jami, foiz });
}));

// Natijalar: o'qituvchi hammasini, talaba faqat o'zinikini ko'radi
r.get('/exams/:id/results', auth, h(async (req, res) => {
  const e = await db.get('SELECT * FROM exams WHERE id=?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Imtihon topilmadi' });

  const rows = await db.all(`
    SELECT a.id, a.student_id, a.score, a.max_score, a.started_at, a.submitted_at, u.full_name, u.avatar
    FROM exam_attempts a JOIN users u ON u.id = a.student_id
    WHERE a.exam_id = ? AND a.submitted_at IS NOT NULL
    ORDER BY a.score DESC, a.submitted_at ASC`, [e.id]);

  let orin = 0, oldingi = null;
  const royxat = rows.map((x, i) => {
    if (Number(x.score) !== oldingi) { orin = i + 1; oldingi = Number(x.score); }
    return { ...x, rank: orin,
             foiz: Number(x.max_score) ? Math.round(x.score / x.max_score * 100) : 0 };
  });

  if (req.user.role === 'student')
    return res.json({ exam: e, results: royxat.filter(x => x.student_id === req.user.id),
                      jami_topshirgan: royxat.length });
  res.json({ exam: e, results: royxat, jami_topshirgan: royxat.length });
}));

// ==================== LANDING UCHUN OCHIQ MA'LUMOT ====================
// Landing sahifadagi "Natijalar" raqamlari — o'ylab topilgan emas, bazadan.
r.get('/stats', h(async (req, res) => {
  const [t, k, m, mv, s, y] = await Promise.all([
    db.get("SELECT count(*)::int AS n FROM users WHERE role = 'student'"),
    db.get('SELECT count(*)::int AS n FROM courses'),
    db.get('SELECT count(*)::int AS n FROM exercises'),
    db.get('SELECT count(*)::int AS n FROM topics'),
    db.get('SELECT count(*)::int AS n FROM certificates'),
    db.get('SELECT count(*)::int AS n FROM submissions WHERE is_correct = true')
  ]);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    talabalar: t.n, kurslar: k.n, mashqlar: m.n, mavzular: mv.n,
    sertifikatlar: s.n, togri_yechilgan: y.n
  });
}));

// Bosh sahifadagi "eng yaxshi o'quvchilar" — haqiqiy natijalar bo'yicha.
// Faqat mashq yechgan va o'qituvchi yashirmagan talabalar chiqadi.
r.get('/top', h(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 12);
  const rows = await db.all(
    `SELECT u.full_name, u.avatar,
            SUM(CASE WHEN s.is_correct THEN 1 ELSE 0 END)::int AS correct,
            COUNT(s.id)::int AS attempted
     FROM users u
     JOIN submissions s ON s.student_id = u.id
     WHERE u.role = 'student' AND u.landing_ok = true
     GROUP BY u.id, u.full_name, u.avatar
     HAVING SUM(CASE WHEN s.is_correct THEN 1 ELSE 0 END) > 0
     ORDER BY correct DESC, attempted ASC, u.full_name
     LIMIT ?`, [n]);

  let orin = 0, oldingi = null;
  // Qisqa kesh: dars paytida kimdir oldinga o'tsa, bosh sahifa deyarli darhol ko'rsatsin
  res.set('Cache-Control', 'public, max-age=15');
  res.json(rows.map((x, i) => {
    if (x.correct !== oldingi) { orin = i + 1; oldingi = x.correct; }
    return {
      full_name: x.full_name, avatar: x.avatar, correct: x.correct,
      accuracy: x.attempted ? Math.round(x.correct / x.attempted * 100) : 0,
      rank: orin
    };
  }));
}));

// O'qituvchi: talabani bosh sahifadagi ro'yxatdan yashirish / qaytarish
r.patch('/students/:id/landing', auth, teacherOnly, h(async (req, res) => {
  const { landing_ok } = req.body || {};
  if (typeof landing_ok !== 'boolean') return res.status(400).json({ error: 'landing_ok kerak' });
  await db.run("UPDATE users SET landing_ok = ? WHERE id = ? AND role = 'student'",
    [landing_ok, req.params.id]);
  res.json({ ok: true });
}));

// Talaba fikrlari — landing'da faqat e'lon qilinganlari ko'rinadi
r.get('/testimonials', h(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(await db.all(
    'SELECT id, name, role, text, avatar FROM testimonials WHERE published = true ORDER BY sort, id DESC'));
}));

// O'qituvchi uchun — e'lon qilinmaganlari bilan birga
r.get('/testimonials/all', auth, teacherOnly, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM testimonials ORDER BY sort, id DESC'));
}));

r.post('/testimonials', auth, teacherOnly, yozLimit, h(async (req, res) => {
  const { name, role, text, avatar, sort } = req.body || {};
  const n = (name || '').trim(), t = (text || '').trim();
  if (!n) return res.status(400).json({ error: 'Ism kerak' });
  if (!t) return res.status(400).json({ error: 'Fikr matni kerak' });
  if (n.length > 80) return res.status(400).json({ error: 'Ism juda uzun' });
  if (t.length > 600) return res.status(400).json({ error: 'Fikr juda uzun (600 belgigacha)' });
  if (avatar && (typeof avatar !== 'string' || avatar.length > 200000))
    return res.status(400).json({ error: 'Rasm juda katta' });

  const row = await db.get(
    `INSERT INTO testimonials (name, role, text, avatar, sort) VALUES (?,?,?,?,?) RETURNING id`,
    [n, (role || '').trim().slice(0, 60) || null, t, avatar || null, parseInt(sort, 10) || 0]);
  res.status(201).json({ ok: true, id: row.id });
}));

r.patch('/testimonials/:id', auth, teacherOnly, h(async (req, res) => {
  const { published } = req.body || {};
  if (typeof published !== 'boolean') return res.status(400).json({ error: 'published kerak' });
  await db.run('UPDATE testimonials SET published = ? WHERE id = ?', [published, req.params.id]);
  res.json({ ok: true });
}));

r.delete('/testimonials/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM testimonials WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== HISOBOTLARNI EKSPORT QILISH ====================
// CSV katakchasi: qo'shtirnoq ichiga olinadi, ichkilari ikkilantiriladi.
function csvKatak(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

// Excel ";" ni ustun ajratgichi deb tanishi uchun "sep=;" sarlavhasi,
// o'zbekcha harflar buzilmasligi uchun UTF-8 BOM qo'shiladi.
function csvJavob(res, nom, ustunlar, qatorlar) {
  const sarlavha = ustunlar.map(c => csvKatak(c.nom)).join(';');
  const tanasi = qatorlar.map(r => ustunlar.map(c => csvKatak(c.qiymat(r))).join(';'));
  const matn = '﻿' + 'sep=;\r\n' + [sarlavha, ...tanasi].join('\r\n') + '\r\n';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nom}"`);
  res.send(matn);
}

const HOLAT_UZ = { present: 'Keldi', absent: 'Kelmadi', late: 'Kechikdi', excused: 'Sababli' };
const TOLOV_UZ = { paid: "To'landi", unpaid: "To'lanmagan", partial: 'Qisman' };

r.get('/export/students.csv', auth, staffOnly, h(async (req, res) => {
  const rows = await db.all(`
    SELECT u.id, u.full_name, u.email, u.phone, u.birth_date, u.created_at,
           (SELECT count(*)::int FROM enrollments e WHERE e.student_id = u.id) AS kurslar,
           (SELECT round(avg(g.score * 100.0 / NULLIF(g.max_score,0))) FROM grades g WHERE g.student_id = u.id) AS ortacha
    FROM users u WHERE u.role = 'student' ORDER BY u.full_name`);
  csvJavob(res, 'talabalar.csv', [
    { nom: 'ID',            qiymat: r => r.id },
    { nom: 'F.I.Sh.',       qiymat: r => r.full_name },
    { nom: 'Email',         qiymat: r => r.email },
    { nom: 'Telefon',       qiymat: r => r.phone },
    { nom: "Tug'ilgan sana",qiymat: r => sanaOnly(r.birth_date) },
    { nom: 'Kurslar soni',  qiymat: r => r.kurslar },
    { nom: "O'rtacha baho", qiymat: r => r.ortacha == null ? '' : r.ortacha + '%' },
    { nom: "Ro'yxatga olingan", qiymat: r => sanaOnly(r.created_at) }
  ], rows);
}));

r.get('/export/payments.csv', auth, staffOnly, h(async (req, res) => {
  const p = [];
  let w = '';
  if (/^\d{4}-\d{2}$/.test(req.query.period || '')) { w = 'WHERE p.period = ?'; p.push(req.query.period); }
  const rows = await db.all(`
    SELECT p.*, u.full_name, u.phone, m.full_name AS belgiladi
    FROM payments p
    JOIN users u ON u.id = p.student_id
    LEFT JOIN users m ON m.id = p.marked_by
    ${w} ORDER BY p.period DESC, u.full_name`, p);
  csvJavob(res, `tolovlar${req.query.period ? '-' + req.query.period : ''}.csv`, [
    { nom: 'Davr',      qiymat: r => r.period },
    { nom: 'Talaba',    qiymat: r => r.full_name },
    { nom: 'Telefon',   qiymat: r => r.phone },
    { nom: 'Summa',     qiymat: r => r.amount == null ? '' : Number(r.amount) },
    { nom: 'Holat',     qiymat: r => TOLOV_UZ[r.status] || r.status },
    { nom: "To'langan sana", qiymat: r => sanaOnly(r.paid_at) },
    { nom: 'Usul',      qiymat: r => r.method },
    { nom: 'Izoh',      qiymat: r => r.note },
    { nom: 'Belgiladi', qiymat: r => r.belgiladi }
  ], rows);
}));

r.get('/export/attendance.csv', auth, staffOnly, h(async (req, res) => {
  const p = [], w = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { w.push('a.day >= ?'); p.push(req.query.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || ''))   { w.push('a.day <= ?'); p.push(req.query.to); }
  const rows = await db.all(`
    SELECT a.*, u.full_name FROM attendance a
    JOIN users u ON u.id = a.student_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY a.day DESC, u.full_name`, p);
  csvJavob(res, 'davomat.csv', [
    { nom: 'Sana',   qiymat: r => sanaOnly(r.day) },
    { nom: 'Talaba', qiymat: r => r.full_name },
    { nom: 'Holat',  qiymat: r => HOLAT_UZ[r.status] || r.status },
    { nom: 'Izoh',   qiymat: r => r.note }
  ], rows);
}));

r.get('/export/grades.csv', auth, staffOnly, h(async (req, res) => {
  const rows = await db.all(`
    SELECT g.*, u.full_name FROM grades g
    JOIN users u ON u.id = g.student_id ORDER BY g.created_at DESC`);
  csvJavob(res, 'baholar.csv', [
    { nom: 'Sana',      qiymat: r => sanaOnly(r.created_at) },
    { nom: 'Talaba',    qiymat: r => r.full_name },
    { nom: 'Mavzu',     qiymat: r => r.topic },
    { nom: 'Ball',      qiymat: r => Number(r.score) },
    { nom: 'Maksimal',  qiymat: r => Number(r.max_score) },
    { nom: 'Foiz',      qiymat: r => r.max_score ? Math.round(r.score * 100 / r.max_score) + '%' : '' },
    { nom: 'Izoh',      qiymat: r => r.note }
  ], rows);
}));

// DATE/TIMESTAMP ustunlari drayverdan Date obyekti bo'lib keladi —
// String(Date) esa "Wed May 14 2008..." beradi. Har doim YYYY-MM-DD qaytaramiz.
function sanaOnly(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return isNaN(d) ? '' :
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// ==================== BILDIRISHNOMALAR ====================
r.get('/notifications', auth, h(async (req, res) => {
  res.json(await db.all(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40', [req.user.id]));
}));

r.get('/notifications/count', auth, h(async (req, res) => {
  const row = await db.get(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND seen = false', [req.user.id]);
  res.json({ n: row ? row.n : 0 });
}));

// Bittasini yoki (id berilmasa) hammasini o'qilgan deb belgilash
r.post('/notifications/seen', auth, h(async (req, res) => {
  const { id } = req.body || {};
  if (id) await db.run('UPDATE notifications SET seen = true WHERE id = ? AND user_id = ?', [id, req.user.id]);
  else    await db.run('UPDATE notifications SET seen = true WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

r.delete('/notifications', auth, h(async (req, res) => {
  await db.run('DELETE FROM notifications WHERE user_id = ? AND seen = true', [req.user.id]);
  res.json({ ok: true });
}));

// ==================== DARS JADVALI ====================
const KUNLAR = ['', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
const VAQT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Hamma ko'radi (landing sahifada ham ishlatiladi)
r.get('/schedule', h(async (req, res) => {
  res.json(await db.all(`
    SELECT s.*, c.title AS course_name, c.slug AS course_slug
    FROM schedule s LEFT JOIN courses c ON c.id = s.course_id
    WHERE s.active = true
    ORDER BY s.weekday, s.start_time`));
}));

r.post('/schedule', auth, teacherOnly, h(async (req, res) => {
  const { course_id, weekday, start_time, end_time, room, note } = req.body || {};
  const wd = parseInt(weekday, 10);
  if (!(wd >= 1 && wd <= 7)) return res.status(400).json({ error: 'Hafta kuni 1–7 orasida bo\'lsin' });
  if (!VAQT_RE.test(start_time || '')) return res.status(400).json({ error: 'Boshlanish vaqti SS:DD ko\'rinishida bo\'lsin' });
  if (end_time && !VAQT_RE.test(end_time)) return res.status(400).json({ error: 'Tugash vaqti SS:DD ko\'rinishida bo\'lsin' });
  if (end_time && end_time <= start_time) return res.status(400).json({ error: 'Tugash vaqti boshlanishdan keyin bo\'lsin' });

  const row = await db.get(
    `INSERT INTO schedule (course_id, weekday, start_time, end_time, room, note)
     VALUES (?,?,?,?,?,?) RETURNING id`,
    [course_id || null, wd, start_time, end_time || null, (room || '').trim() || null, (note || '').trim() || null]);
  res.status(201).json({ ok: true, id: row.id });
}));

r.delete('/schedule/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM schedule WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== KALENDAR HODISALARI ====================
const KIND_UZ = { lesson: 'Dars', exam: 'Imtihon', holiday: 'Dam olish', event: 'Tadbir' };
const SANA_RE = /^\d{4}-\d{2}-\d{2}$/;

r.get('/events', h(async (req, res) => {
  // ?from=2026-08-01&to=2026-08-31  yoki  ?period=2026-08
  let { from, to, period } = req.query;
  if (period && SANA_RE.test(period + '-01')) {
    from = period + '-01';
    const [y, m] = period.split('-').map(Number);
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  const w = [], p = [];
  if (SANA_RE.test(from || '')) { w.push('COALESCE(e.end_day, e.day) >= ?'); p.push(from); }
  if (SANA_RE.test(to || ''))   { w.push('e.day <= ?'); p.push(to); }
  res.json(await db.all(`
    SELECT e.id, e.title, e.kind, e.start_time, e.description, e.course_id,
           to_char(e.day, 'YYYY-MM-DD') AS day,
           to_char(e.end_day, 'YYYY-MM-DD') AS end_day,
           c.title AS course_name
    FROM events e LEFT JOIN courses c ON c.id = e.course_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY e.day, e.start_time NULLS FIRST`, p));
}));

r.post('/events', auth, teacherOnly, yozLimit, h(async (req, res) => {
  const { title, kind, day, end_day, start_time, description, course_id } = req.body || {};
  const t = (title || '').trim();
  if (!t) return res.status(400).json({ error: 'Sarlavha kerak' });
  if (t.length > 120) return res.status(400).json({ error: 'Sarlavha juda uzun' });
  if (!SANA_RE.test(day || '')) return res.status(400).json({ error: 'Sana YYYY-MM-DD ko\'rinishida bo\'lsin' });
  if (end_day && !SANA_RE.test(end_day)) return res.status(400).json({ error: 'Tugash sanasi noto\'g\'ri' });
  if (end_day && end_day < day) return res.status(400).json({ error: 'Tugash sanasi boshlanishdan oldin bo\'la olmaydi' });
  if (start_time && !VAQT_RE.test(start_time)) return res.status(400).json({ error: 'Vaqt SS:DD ko\'rinishida bo\'lsin' });
  const k = KIND_UZ[kind] ? kind : 'event';

  const row = await db.get(
    `INSERT INTO events (title, kind, day, end_day, start_time, description, course_id, created_by)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
    [t, k, day, end_day || null, start_time || null,
     (description || '').trim().slice(0, 600) || null, course_id || null, req.user.id]);
  await bildirTalabalar('event', `${KIND_UZ[k]}: ${t}`,
    `${day}${end_day ? ' — ' + end_day : ''}${start_time ? ' · ' + start_time : ''}`, 'cal');
  res.status(201).json({ ok: true, id: row.id });
}));

r.delete('/events/:id', auth, teacherOnly, h(async (req, res) => {
  await db.run('DELETE FROM events WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Keyingi dars + yaqin hodisalar (dashboard uchun)
r.get('/agenda', auth, h(async (req, res) => {
  const bugun = new Date().toISOString().slice(0, 10);
  const [jadval, hodisalar] = await Promise.all([
    db.all(`SELECT s.*, c.title AS course_name FROM schedule s
            LEFT JOIN courses c ON c.id = s.course_id
            WHERE s.active = true ORDER BY s.weekday, s.start_time`),
    db.all(`SELECT e.id, e.title, e.kind, e.start_time, e.description, e.course_id,
           to_char(e.day, 'YYYY-MM-DD') AS day,
           to_char(e.end_day, 'YYYY-MM-DD') AS end_day,
           c.title AS course_name FROM events e
            LEFT JOIN courses c ON c.id = e.course_id
            WHERE COALESCE(e.end_day, e.day) >= ?
            ORDER BY e.day, e.start_time NULLS FIRST LIMIT 6`, [bugun])
  ]);

  // Bugundan boshlab eng yaqin darsni topamiz
  const hozir = new Date();
  const jsKun = hozir.getDay();                    // 0=yakshanba
  const bugunKun = jsKun === 0 ? 7 : jsKun;        // 1=dushanba … 7=yakshanba
  const soat = hozir.toTimeString().slice(0, 5);
  let keyingi = null, engYaqin = Infinity;
  for (const d of jadval) {
    let kunFarq = (d.weekday - bugunKun + 7) % 7;
    if (kunFarq === 0 && d.start_time <= soat) kunFarq = 7;
    const [hh, mm] = d.start_time.split(':').map(Number);
    const daqiqa = kunFarq * 1440 + hh * 60 + mm;
    if (daqiqa < engYaqin) { engYaqin = daqiqa; keyingi = { ...d, kun_farq: kunFarq }; }
  }
  res.json({ keyingi_dars: keyingi, hodisalar, jadval });
}));

// Sog'liq tekshiruvi
r.get('/health', h(async (req, res) => {
  const row = await db.get('SELECT count(*)::int AS n FROM users');
  res.json({ ok: true, users: row ? row.n : 0 });
}));

// ---- Router'ni ulash ----
// "/api/..." — odatiy holat (lokal va Vercel).
// "/..."     — zaxira: agar Vercel yo'naltirishda "/api" prefiksini olib tashlasa.
app.use('/api', r);

// ---- Lokal ishlatishda statik sayt (Vercelda fayllarni Vercel o'zi beradi) ----
app.use(express.static(path.join(__dirname, '..')));

// Vercelda prefiks olib tashlangan bo'lsa — oxirgi zaxira sifatida
if (process.env.VERCEL) app.use(r);

module.exports = app;
