// ============================================================
//  Kitoblardan ajratilgan mashqlarni kurslarga yuklash (API orqali)
//
//  Lokal:    node tools/load-courses.js
//  Onlayn:   node tools/load-courses.js https://shokirov-academy.vercel.app admin@shokirov.uz admin123
//
//  Mavzular bittalab yuboriladi — serverless vaqt chegarasiga tushmasligi uchun.
// ============================================================
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.argv[3] || 'admin@shokirov.uz';
const PASS = process.argv[4] || 'admin123';

const OUT = path.join(__dirname, 'out');
const load = f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

// Qaysi kursga nima yuklanadi
const PLAN = [
  {
    slug: 'algebra-oq', book: 'oq-toplam.pdf', data: 'oq-toplam.json',
    filter: t => t.chapter <= 2, nom: 'Algebra (1–2-boblar)'
  },
  {
    slug: 'geometriya-oq', book: 'oq-toplam.pdf', data: 'oq-toplam.json',
    filter: t => t.chapter >= 3, nom: 'Geometriya (3–4-boblar)'
  },
  {
    slug: 'dtm', book: 'dtm.pdf', data: 'dtm.json',
    filter: () => true, nom: 'DTM (to\'liq)'
  }
];

let TOKEN = null;
async function api(method, p, body) {
  const H = { 'Content-Type': 'application/json' };
  if (TOKEN) H.Authorization = 'Bearer ' + TOKEN;
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return d;
}

(async () => {
  console.log('Server :', BASE);
  const auth = await api('POST', '/api/auth/login', { email: EMAIL, password: PASS });
  TOKEN = auth.token;
  if (auth.user.role !== 'teacher') throw new Error("Bu akkaunt o'qituvchi emas");
  console.log('Kirildi:', auth.user.email, '\n');

  const courses = await api('GET', '/api/courses');

  for (const p of PLAN) {
    const course = courses.find(c => c.slug === p.slug);
    if (!course) { console.log('⚠️  Kurs topilmadi:', p.slug); continue; }

    const all = load(p.data).topics.filter(p.filter);
    const jami = all.reduce((s, t) => s + t.exercises.length, 0);
    console.log(`── ${course.title}  ←  ${p.nom}`);
    console.log(`   ${all.length} mavzu, ${jami} mashq`);

    // Kitob faylini biriktirish
    await api('PATCH', '/api/courses/' + course.id, { book_file: p.book });

    let done = 0, ex = 0;
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      const r = await api('POST', '/api/import', {
        course_id: course.id,
        replace: i === 0,                      // birinchi mavzuda eskisi tozalanadi
        topics: [{ title: `${t.code} ${t.title}`, page_from: t.page_from, exercises: t.exercises }]
      });
      done++; ex += r.exercises;
      process.stdout.write(`\r   yuklandi: ${done}/${all.length} mavzu, ${ex} mashq   `);
    }
    console.log(`\n   ✅ tayyor\n`);
  }

  console.log('Yakuniy holat:');
  for (const p of PLAN) {
    const c = (await api('GET', '/api/courses')).find(x => x.slug === p.slug);
    const d = await api('GET', '/api/courses/' + c.id + '/topics');
    const jami = d.topics.reduce((s, t) => s + t.total, 0);
    console.log(`  ${c.title.padEnd(34)} ${String(d.topics.length).padStart(2)} mavzu, ${String(jami).padStart(5)} mashq`);
  }
})().catch(e => { console.error('\nXATO:', e.message); process.exit(1); });
