// ============================================================
//  tools/out/dtm.json → bazaga yuklash
//  Ishlatish:  node tools/import-dtm.js
// ============================================================
const fs = require('fs');
const path = require('path');

// .env (bo'lsa) — Postgres manzili uchun
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#') && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) {}
})();

const db = require('../api/_db.js');

const COURSE_SLUG = process.argv[2] || 'dtm';
const DATA = path.join(__dirname, 'out', 'dtm.json');

(async () => {
  if (!fs.existsSync(DATA)) {
    console.error('Fayl topilmadi:', DATA, '\nAvval: node tools/extract-dtm.js');
    process.exit(1);
  }
  await db.ready();

  const course = await db.get('SELECT * FROM courses WHERE slug=?', [COURSE_SLUG]);
  if (!course) { console.error('Kurs topilmadi:', COURSE_SLUG); process.exit(1); }
  console.log('Kurs:', course.title, '(id=' + course.id + ')');

  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

  // Eski tarkibni tozalash
  await db.run('DELETE FROM topics WHERE course_id=?', [course.id]);
  console.log('Eski mavzular tozalandi.');

  let nT = 0, nE = 0;
  for (let i = 0; i < data.topics.length; i++) {
    const t = data.topics[i];
    const row = await db.get(
      'INSERT INTO topics (course_id,title,page_from,sort) VALUES (?,?,?,?) RETURNING id',
      [course.id, `${t.code} ${t.title}`, t.page_from || null, i]);
    nT++;

    // Mashqlarni to'plamlab qo'shish (tezroq)
    const list = t.exercises;
    const BATCH = 100;
    for (let b = 0; b < list.length; b += BATCH) {
      const chunk = list.slice(b, b + BATCH);
      const cols = [];
      const vals = [];
      chunk.forEach((e, k) => {
        const base = k * 8;
        cols.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
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
         VALUES ${cols.join(',')}`, vals);
      nE += chunk.length;
    }
    process.stdout.write(`\r  ${nT}/${data.topics.length} mavzu, ${nE} mashq…`);
  }

  console.log(`\n\n✅ Yuklandi: ${nT} mavzu, ${nE} mashq`);
  const withAns = await db.get(
    `SELECT count(*)::int AS n FROM exercises e JOIN topics t ON t.id=e.topic_id
     WHERE t.course_id=? AND e.answer_letter IS NOT NULL`, [course.id]);
  console.log(`   Javobi bor: ${withAns.n}`);
  process.exit(0);
})().catch(e => { console.error('\nXATO:', e.message); process.exit(1); });
