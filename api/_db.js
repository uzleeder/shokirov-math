// ============================================================
//  Ma'lumotlar bazasi — Postgres (Vercel Postgres / Neon)
//  Serverless uchun: pool modul darajasida (iliq chaqiruvlarda qayta ishlatiladi)
// ============================================================
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

// Ma'lum nomlar (Vercel Postgres / Neon / Supabase standart nomlari)
const VAR_NAMES = [
  'POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', 'STORAGE_URL'
];

// Postgres manzilini topish: avval ma'lum nomlar, so'ng ISTALGAN
// "postgres://" bilan boshlanuvchi o'zgaruvchi (prefiks qanday bo'lishidan qat'i nazar).
function findConn() {
  const isPg = v => typeof v === 'string' && /^postgres(ql)?:\/\//.test(v);
  for (const n of VAR_NAMES) if (isPg(process.env[n])) return { name: n, url: process.env[n] };
  // Zaxira: barcha env o'zgaruvchilarni skanerlash (pooler'li variantni afzal ko'ramiz)
  const found = Object.keys(process.env).filter(n => isPg(process.env[n]));
  const preferred = found.find(n => !/UNPOOLED|NON_POOLING/.test(n)) || found[0];
  return preferred ? { name: preferred, url: process.env[preferred] } : { name: null, url: '' };
}

const _c = findConn();
const FOUND_VAR = _c.name;
const CONN = _c.url;

const isLocalHost = /localhost|127\.0\.0\.1/.test(CONN);

// ---------- Ulanish: haqiqiy Postgres yoki (lokalda) PGlite ----------
// DATABASE_URL bo'lsa — Postgres (Neon / Supabase / Vercel).
// Bo'lmasa va Vercelda emas — PGlite (Postgres'ning WASM versiyasi, faylga saqlaydi).
// Shu tufayli lokalda hech narsa o'rnatmasdan ishlab chiqish mumkin.
let pool;
let MODE;

if (CONN) {
  MODE = 'postgres';
  pool = new Pool({
    connectionString: CONN,
    ssl: isLocalHost ? false : { rejectUnauthorized: false },
    max: 3,                       // serverless — kam ulanish
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
} else if (process.env.VERCEL) {
  MODE = 'yoq';
  console.error('\n[XATO] Ma\'lumotlar bazasi manzili topilmadi.');
  console.error('Vercel: Storage → Create Database → Neon → Connect, so\'ng qayta deploy qiling.\n');
  pool = { query: async () => { throw new Error('Ma\'lumotlar bazasi ulanmagan (DATABASE_URL yo\'q)'); } };
} else {
  MODE = 'pglite';
  const dataDir = path.join(__dirname, '..', '.data', 'pg');
  let dbPromise = null;
  const getDb = () => {
    if (!dbPromise) {
      require('fs').mkdirSync(dataDir, { recursive: true });
      // Diqqat: o'zgaruvchi orqali require — shunda Vercel bu ~30MB WASM paketni
      // serverless funksiyaga qo'shmaydi (u faqat lokalda kerak).
      const pgliteModule = '@electric-sql/pglite';
      const { PGlite } = require(pgliteModule);
      dbPromise = PGlite.create({ dataDir });
      console.log('[db] Lokal rejim: PGlite →', dataDir);
    }
    return dbPromise;
  };
  // pg.Pool bilan bir xil interfeys
  pool = {
    query: async (text, params) => {
      const d = await getDb();
      if (!params || params.length === 0) {
        // Bir nechta buyruq bo'lsa (CREATE TABLE ...; ...) — exec
        if (/;\s*\S/.test(text.trim().replace(/;\s*$/, ''))) {
          await d.exec(text);
          return { rows: [], rowCount: 0 };
        }
      }
      const res = await d.query(text, params || []);
      return { rows: res.rows || [], rowCount: (res.rows || []).length };
    }
  };
}

// `?` belgilarini Postgres uslubidagi $1, $2 ga aylantiradi
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function run(sql, params) { return pool.query(toPg(sql), params || []); }
async function get(sql, params) { const r = await pool.query(toPg(sql), params || []); return r.rows[0] || null; }
async function all(sql, params) { const r = await pool.query(toPg(sql), params || []); return r.rows; }

// ---------- Jadvallarni yaratish (bir marta, keshlanadi) ----------
let initPromise = null;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'student',
      full_name     TEXT,
      first_name    TEXT,
      middle_name   TEXT,
      last_name     TEXT,
      birth_date    DATE,
      phone         TEXT,
      avatar        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id          SERIAL PRIMARY KEY,
      full_name   TEXT NOT NULL,
      first_name  TEXT,
      middle_name TEXT,
      last_name   TEXT,
      birth_date  DATE,
      phone       TEXT NOT NULL,
      parent_name TEXT,
      grade       TEXT,
      message     TEXT,
      status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','rejected')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ============ TO'LOVLAR (oylik, umumiy) ============
    CREATE TABLE IF NOT EXISTS payments (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period     TEXT NOT NULL,                 -- "2026-07"
      amount     NUMERIC NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','unpaid','partial')),
      paid_at    DATE,
      method     TEXT,                          -- naqd / karta / o'tkazma
      note       TEXT,
      marked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, period)
    );

    -- ============ DAVOMAT ============
    CREATE TABLE IF NOT EXISTS attendance (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day        DATE NOT NULL,
      status     TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','late','excused')),
      note       TEXT,
      marked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, day)
    );

    CREATE TABLE IF NOT EXISTS grades (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic      TEXT NOT NULL,
      score      REAL NOT NULL,
      max_score  REAL NOT NULL DEFAULT 100,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id          SERIAL PRIMARY KEY,
      student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT,
      due_date    DATE,
      done        BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ============ KURSLAR / KITOBLAR / MASHQLAR ============
    CREATE TABLE IF NOT EXISTS courses (
      id          SERIAL PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      title       TEXT NOT NULL,
      duration    TEXT,
      description TEXT,
      book_file   TEXT,                -- assets/books/... ichidagi PDF nomi
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Talaba qaysi kurslarga biriktirilgan
    CREATE TABLE IF NOT EXISTS enrollments (
      id         SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, course_id)
    );

    -- Kitobdagi mavzular (boblar)
    CREATE TABLE IF NOT EXISTS topics (
      id        SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title     TEXT NOT NULL,
      page_from INTEGER,
      page_to   INTEGER,
      sort      INTEGER NOT NULL DEFAULT 0
    );

    -- Mashqlar (misollar)
    CREATE TABLE IF NOT EXISTS exercises (
      id             SERIAL PRIMARY KEY,
      topic_id       INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      number         TEXT,             -- masalan "12" yoki "3.5"
      prompt         TEXT,             -- masala matni (bo'lmasa kitobga havola)
      correct_answer TEXT,             -- bo'lsa — avtomatik tekshiriladi
      options        JSONB,            -- {"A":"...","B":"..."} — test bo'lsa
      answer_letter  TEXT,             -- test javobi: "A".."E"
      ref            TEXT,             -- manba kodi, masalan "96-1-1"
      page           INTEGER,
      sort           INTEGER NOT NULL DEFAULT 0
    );

    -- Talaba javoblari
    CREATE TABLE IF NOT EXISTS submissions (
      id          SERIAL PRIMARY KEY,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer        TEXT,
      answer_letter TEXT,              -- test bo'lsa: tanlangan harf
      is_correct  BOOLEAN,             -- NULL = hali tekshirilmagan
      checked_by  TEXT,                -- 'auto' | 'teacher'
      teacher_note TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (exercise_id, student_id)
    );

    -- ============ SERTIFIKATLAR ============
    CREATE TABLE IF NOT EXISTS certificates (
      id          SERIAL PRIMARY KEY,
      student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      number      TEXT UNIQUE NOT NULL,          -- o'qituvchi yozadi, masalan "SMA-2026-014"
      issued_at   DATE NOT NULL DEFAULT CURRENT_DATE,
      score       NUMERIC,                        -- kurs bo'yicha natija (%)
      note        TEXT,
      issued_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, course_id)
    );

    -- ============ IMTIHONLAR ============
    CREATE TABLE IF NOT EXISTS exams (
      id           SERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      course_id    INTEGER REFERENCES courses(id) ON DELETE CASCADE,
      duration_min INTEGER,                -- NULL = vaqt cheklovi yo'q
      opens_at     TIMESTAMPTZ,            -- shu vaqtdan oldin boshlab bo'lmaydi
      closes_at    TIMESTAMPTZ,            -- shu vaqtdan keyin boshlab bo'lmaydi
      published    BOOLEAN NOT NULL DEFAULT false,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS exam_questions (
      id            SERIAL PRIMARY KEY,
      exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      prompt        TEXT NOT NULL,
      options       JSONB,                 -- {"A":"...","B":"..."}
      answer_letter TEXT NOT NULL,
      score         NUMERIC NOT NULL DEFAULT 1,
      sort          INTEGER NOT NULL DEFAULT 0,
      exercise_id   INTEGER REFERENCES exercises(id) ON DELETE SET NULL  -- kitobdan olingan bo'lsa
    );
    CREATE INDEX IF NOT EXISTS idx_eq_exam ON exam_questions(exam_id, sort);

    -- Har bir talaba bitta imtihonni bir marta topshiradi
    CREATE TABLE IF NOT EXISTS exam_attempts (
      id           SERIAL PRIMARY KEY,
      exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at TIMESTAMPTZ,
      score        NUMERIC,
      max_score    NUMERIC,
      UNIQUE (exam_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS exam_answers (
      id            SERIAL PRIMARY KEY,
      attempt_id    INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
      question_id   INTEGER NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
      answer_letter TEXT,
      is_correct    BOOLEAN,
      UNIQUE (attempt_id, question_id)
    );

    -- ============ TALABA FIKRLARI (landing sahifada) ============
    -- Ustoz o'zi kiritadi; bo'sh bo'lsa landing'da bo'lim ko'rinmaydi.
    CREATE TABLE IF NOT EXISTS testimonials (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT,                 -- "11-sinf o'quvchisi", "Ota-ona"
      text       TEXT NOT NULL,
      avatar     TEXT,
      published  BOOLEAN NOT NULL DEFAULT true,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ============ BILDIRISHNOMALAR ============
    CREATE TABLE IF NOT EXISTS notifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,        -- grade | feedback | assignment | work | payment | event | cert | reset
      title      TEXT NOT NULL,
      body       TEXT,
      tab        TEXT,                 -- bosilganda ochiladigan bo'lim
      seen       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, seen, created_at DESC);

    -- ============ DARS JADVALI (haftalik takrorlanuvchi) ============
    CREATE TABLE IF NOT EXISTS schedule (
      id         SERIAL PRIMARY KEY,
      course_id  INTEGER REFERENCES courses(id) ON DELETE CASCADE,  -- NULL = umumiy
      weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1=dushanba … 7=yakshanba
      start_time TEXT NOT NULL,           -- "15:00"
      end_time   TEXT,                     -- "16:30"
      room       TEXT,
      note       TEXT,
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sched_day ON schedule(weekday, active);

    -- ============ KALENDAR HODISALARI ============
    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'event'
                 CHECK (kind IN ('lesson','exam','holiday','event')),
      day        DATE NOT NULL,
      end_day    DATE,                     -- ko'p kunlik hodisa uchun
      start_time TEXT,
      description TEXT,
      course_id  INTEGER REFERENCES courses(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_event_day ON events(day);

    -- ============ VAZIFA TOPSHIRIQLARI ============
    -- Talaba javobini yozadi/rasm yuklaydi, o'qituvchi baholaydi
    CREATE TABLE IF NOT EXISTS assignment_work (
      id            SERIAL PRIMARY KEY,
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer        TEXT,
      image         TEXT,                -- daftar rasmi (data URL, kichraytirilgan)
      status        TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','accepted','rework')),
      score         NUMERIC,
      teacher_note  TEXT,
      submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      graded_at     TIMESTAMPTZ,
      graded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (assignment_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_student ON assignment_work(student_id);
    CREATE INDEX IF NOT EXISTS idx_work_status ON assignment_work(status, submitted_at);

    -- ============ PAROL TIKLASH SO'ROVLARI ============
    CREATE TABLE IF NOT EXISTS password_resets (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','done','rejected')),
      note        TEXT,
      new_password TEXT,                 -- o'qituvchi bergan yangi parol (bir marta ko'rsatiladi)
      handled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      handled_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_reset_status ON password_resets(status, created_at);

    -- ============ CHAT (talaba ↔ o'qituvchi) ============
    -- student_id = suhbat egasi (har bir talabaning o'qituvchi bilan bitta suhbati)
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('student','teacher')),
      body        TEXT NOT NULL,
      read_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_msg_student ON messages(student_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(student_id, sender_role, read_at);
    CREATE INDEX IF NOT EXISTS idx_cert_student ON certificates(student_id);
    CREATE INDEX IF NOT EXISTS idx_cert_number ON certificates(number);
    CREATE INDEX IF NOT EXISTS idx_topics_course ON topics(course_id);
    CREATE INDEX IF NOT EXISTS idx_ex_topic ON exercises(topic_id);
    CREATE INDEX IF NOT EXISTS idx_sub_student ON submissions(student_id);
    CREATE INDEX IF NOT EXISTS idx_pay_student ON payments(student_id);
    CREATE INDEX IF NOT EXISTS idx_att_student ON attendance(student_id);
    CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(day);
  `);

  // Migratsiya: eski bazalarga yangi ustunlarni qo'shish
  for (const sql of [
    'ALTER TABLE exercises ADD COLUMN IF NOT EXISTS options JSONB',
    'ALTER TABLE exercises ADD COLUMN IF NOT EXISTS answer_letter TEXT',
    'ALTER TABLE exercises ADD COLUMN IF NOT EXISTS ref TEXT',
    'ALTER TABLE submissions ADD COLUMN IF NOT EXISTS answer_letter TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE',
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS first_name TEXT',
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS middle_name TEXT',
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS last_name TEXT',
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS birth_date DATE',
    // Eski CHECK cheklovi 'director' rolini to'sib qo'ymasligi uchun
    'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check',
    // Kurs davomiyligi kunlarda — sertifikat muddatini hisoblash uchun
    'ALTER TABLE courses ADD COLUMN IF NOT EXISTS duration_days INTEGER',
    // Talaba bosh sahifadagi "eng yaxshilar" ro'yxatida ko'rinsinmi
    // (ota-ona qarshi bo'lsa, o'qituvchi o'chirib qo'yadi)
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS landing_ok BOOLEAN NOT NULL DEFAULT true'
  ]) { try { await pool.query(sql); } catch (e) {} }

  // duration matnidan ("3 oy") kunlarni chiqarib qo'yish
  try {
    await pool.query(`
      UPDATE courses SET duration_days = CASE
        WHEN duration ~ '^[0-9]+\\s*oy' THEN (regexp_replace(duration, '[^0-9].*$', '', 'g'))::int * 30
        ELSE 60
      END
      WHERE duration_days IS NULL`);
  } catch (e) {}

  // Kurslarni bir marta to'ldirish (landing sahifadagi 6 ta kurs)
  const anyCourse = await get('SELECT id FROM courses LIMIT 1');
  if (!anyCourse) {
    const seed = [
      ['master', 'Matematika Master', '3 oy', 'Matematikani chuqur va mukammal o\'zlashtirish — kuchli bazadan yuqori darajagacha.', 'master.pdf', 1],
      ['algebra-oq', 'Algebra — Oq to\'plam', '2 oy', '"Oq to\'plam" algebra kitobi asosida algebra mavzularini to\'liq yechish.', 'oq-toplam-algebra.pdf', 2],
      ['geometriya-oq', 'Geometriya — Oq to\'plam', '2 oy', '"Oq to\'plam" geometriya kitobi asosida geometriya masalalarini o\'rganish.', 'oq-toplam-geometriya.pdf', 3],
      ['dtm', 'Abituriyentlar — DTM tayyorlov', '2 oy', 'Oliy ta\'lim muassasalariga kirish (DTM) imtihoniga maxsus tayyorgarlik.', 'dtm.pdf', 4],
      ['geometriya', 'Geometriya', '2 oy', 'Geometriya asoslari, teoremalar va masalalar yechish ko\'nikmalari.', 'geometriya.pdf', 5],
      ['ids', 'Milliy sertifikat — IDS', 'Sertifikat', '"IDS" kitobi asosida milliy sertifikat imtihoniga tayyorgarlik.', 'ids.pdf', 6]
    ];
    for (const c of seed) {
      await run('INSERT INTO courses (slug,title,duration,description,book_file,sort) VALUES (?,?,?,?,?,?) ON CONFLICT (slug) DO NOTHING', c);
    }
    console.log('[setup] 6 ta kurs qo\'shildi');
  }

  // O'qituvchi akkaunti — faqat bitta marta yaratiladi
  const has = await get("SELECT id FROM users WHERE role='teacher'");
  if (!has) {
    const email = (process.env.TEACHER_EMAIL || 'admin@shokirov.uz').toLowerCase().trim();
    const pass = process.env.TEACHER_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(pass, 10);
    await run(
      'INSERT INTO users (email, password_hash, role, full_name) VALUES (?,?,?,?) ON CONFLICT (email) DO NOTHING',
      [email, hash, 'teacher', "Shokirov Manuchehr"]
    );
    console.log("[setup] O'qituvchi akkaunti yaratildi:", email);
  }

  // Direktor (egasi) akkaunti — to'lovlar nazorati uchun
  const hasDir = await get("SELECT id FROM users WHERE role='director'");
  if (!hasDir) {
    const email = (process.env.DIRECTOR_EMAIL || 'director@shokirov.uz').toLowerCase().trim();
    const pass = process.env.DIRECTOR_PASSWORD || 'director123';
    await run(
      'INSERT INTO users (email, password_hash, role, full_name) VALUES (?,?,?,?) ON CONFLICT (email) DO NOTHING',
      [email, bcrypt.hashSync(pass, 10), 'director', 'Direktor']
    );
    console.log('[setup] Direktor akkaunti yaratildi:', email);
  }
}

// Har so'rovdan oldin chaqiriladi; faqat birinchi marta ishlaydi
function ready() {
  if (!initPromise) {
    initPromise = init().catch(err => {
      initPromise = null;   // xato bo'lsa keyingi so'rovda qayta urinsin
      throw err;
    });
  }
  return initPromise;
}

// ---------- Diagnostika (maxfiy ma'lumotni oshkor qilmaydi) ----------
async function diag() {
  const out = {
    rejim: MODE,                       // 'postgres' | 'pglite' | 'yoq'
    ulanish_manzili_topildi: !!CONN,
    qaysi_ozgaruvchi: FOUND_VAR,
    mavjud_ozgaruvchilar: VAR_NAMES.filter(n => process.env[n]),
    jwt_secret_ornatilgan: !!process.env.JWT_SECRET,
    vercel: !!process.env.VERCEL
  };
  if (CONN) {
    try {
      const u = new URL(CONN);
      out.host = u.hostname;
      out.baza_nomi = u.pathname.replace('/', '') || null;
      out.protokol = u.protocol.replace(':', '');
    } catch (e) { out.manzil_formati = 'NOTO\'G\'RI — postgres://... ko\'rinishida bo\'lishi kerak'; }
    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      out.ulanish = 'OK';
      out.javob_vaqti_ms = Date.now() - t0;
    } catch (e) {
      out.ulanish = 'XATO';
      out.xato = e.message;
      out.xato_kodi = e.code || null;
    }
  } else if (MODE === 'pglite') {
    try {
      const t0 = Date.now();
      await pool.query('SELECT 1');
      out.ulanish = 'OK (lokal PGlite)';
      out.javob_vaqti_ms = Date.now() - t0;
    } catch (e) { out.ulanish = 'XATO'; out.xato = e.message; }
  } else {
    out.ulanish = 'MANZIL YO\'Q';
    out.maslahat = 'Vercel: Storage → Create Database → Neon → Connect, so\'ng QAYTA DEPLOY qiling.';
  }
  return out;
}

module.exports = { pool, run, get, all, ready, diag };
