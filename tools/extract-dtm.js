// ============================================================
//  dtm.pdf dan mavzular, mashqlar va javoblarni ajratib olish
//  Ishlatish:  node tools/extract-dtm.js
//  Natija:     tools/out/dtm.json
// ============================================================
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const PDF = path.join(__dirname, '..', 'assets', 'books', 'dtm.pdf');
const OUT_DIR = path.join(__dirname, 'out');
const OUT = path.join(OUT_DIR, 'dtm.json');

// ---------- 1) Javoblar kalitini o'qish ----------
// Format:
//   1996 yil - Matematika
//   1-axborotnoma
//   0 1 2 3 4 5 6 7 8 9     <- sarlavha (o'tkazib yuboriladi)
//   0   E B D B ...          <- 0-qator = 1..9-savollar
//   1 B C B B ...            <- 1-qator = 10..19-savollar
function parseAnswerKey(lines, startIdx) {
  const key = {};                    // "1996-1-5" -> "E"
  let year = null, bulletin = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let m = line.match(/^(\d{4})\s*yil/);
    if (m) { year = parseInt(m[1], 10); continue; }

    m = line.match(/^(\d+)\s*-\s*axborotnoma/);
    if (m) { bulletin = parseInt(m[1], 10); continue; }

    // Sarlavha qatori: 0 1 2 3 4 5 6 7 8 9
    if (/^0(\s+[1-9])+\s*$/.test(line)) continue;

    // Ma'lumot qatori: raqam + A-E harflari
    m = line.match(/^(\d)\s+([A-E](\s+[A-E])*)\s*$/);
    if (m && year && bulletin) {
      const row = parseInt(m[1], 10);
      const letters = m[2].split(/\s+/);
      // 0-qatorda 0-savol yo'q → harflar 1-ustundan boshlanadi
      const startCol = row === 0 ? 1 : 0;
      letters.forEach((L, k) => {
        const q = row * 10 + startCol + k;
        key[`${year}-${bulletin}-${q}`] = L;
      });
    }
  }
  return key;
}

// ---------- 2) Mavzular va mashqlarni o'qish ----------
function parseBody(lines, endIdx) {
  const topics = [];
  let cur = null;
  let page = null;
  let pending = null;                 // yig'ilayotgan mashq

  const pushPending = () => {
    if (!pending || !cur) { pending = null; return; }
    const text = pending.lines.join('\n').trim();
    // Variantlarni ajratish:  A) ... B) ... C) ... D) ... E) ...
    const optIdx = text.search(/\bA\s*\)/);
    let prompt = text, options = null;
    if (optIdx > 0) {
      prompt = text.slice(0, optIdx).trim();
      const optRaw = text.slice(optIdx);
      const parts = optRaw.split(/\b(?=[A-E]\s*\))/).map(s => s.trim()).filter(Boolean);
      options = {};
      for (const p of parts) {
        const mm = p.match(/^([A-E])\s*\)\s*([\s\S]*)$/);
        if (mm) options[mm[1]] = mm[2].replace(/\s+/g, ' ').trim();
      }
      if (Object.keys(options).length < 2) options = null;
    }
    prompt = prompt.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (prompt) {
      cur.exercises.push({
        number: pending.num,
        code: pending.code,
        prompt,
        options,
        page: pending.page
      });
    }
    pending = null;
  };

  for (let i = 0; i < endIdx; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Bet raqami belgisi:  -- 12 of 307 --
    let m = line.match(/^--\s*(\d+)\s*of\s*\d+\s*--$/);
    if (m) { page = parseInt(m[1], 10); continue; }

    // Mavzu sarlavhasi:  1.1 Natural va butun sonlar
    m = line.match(/^(\d+)\.(\d+)\s+(.{3,80})$/);
    if (m && !/^\d+\.\d+\.\d+/.test(line)) {
      pushPending();
      let title = m[3].trim().replace(/\s+/g, ' ');
      // Tire bilan uzilgan sarlavhani keyingi qator bilan birlashtirish
      // ("... tengsizlik-" + "lar." → "... tengsizliklar.")
      let k = i;
      while (/[-‐‑’]$/.test(title) && k + 1 < endIdx) {
        const next = (lines[++k] || '').trim();
        if (!next || /^\d/.test(next)) break;
        title = title.replace(/[-‐‑]$/, '') + next.replace(/\s+/g, ' ');
      }
      cur = {
        code: `${m[1]}.${m[2]}`,
        chapter: parseInt(m[1], 10),
        title: title.replace(/\.$/, '').trim(),
        page_from: page,
        exercises: []
      };
      topics.push(cur);
      continue;
    }

    // Mashq boshlanishi:  12. (96-1-1) Matn...
    m = line.match(/^(\d{1,4})\.\s*\((\d{2})-(\d{1,2})-(\d{1,3})\)\s*(.*)$/);
    if (m) {
      pushPending();
      if (!cur) continue;
      const yy = parseInt(m[2], 10);
      pending = {
        num: m[1],
        code: { year: yy >= 90 ? 1900 + yy : 2000 + yy, bulletin: parseInt(m[3], 10), q: parseInt(m[4], 10) },
        page,
        lines: [m[5]]
      };
      continue;
    }

    // Ishlangan misol yoki yechim — mashq emas, to'xtatamiz
    if (/^(Yechish|Javob)\s*:/.test(line)) { pushPending(); continue; }

    if (pending) pending.lines.push(line);
  }
  pushPending();
  return topics;
}

(async () => {
  console.log('PDF o\'qilyapti…');
  const parser = new PDFParse({ data: fs.readFileSync(PDF) });
  const doc = await parser.getText();
  await parser.destroy();

  const lines = doc.text.split('\n');

  // Javoblar bo'limi qayerdan boshlanadi
  let keyStart = lines.findIndex(l => /^\d{4}\s*yil\s*-\s*Matematika/.test(l.trim()));
  if (keyStart < 0) keyStart = lines.length;
  console.log(`Javoblar bo'limi: ${keyStart}-qatordan boshlanadi`);

  const key = parseAnswerKey(lines, keyStart);
  console.log(`Javoblar kaliti: ${Object.keys(key).length} ta javob topildi`);

  const topics = parseBody(lines, keyStart);
  console.log(`Mavzular: ${topics.length} ta`);

  // Javoblarni mashqlarga bog'lash
  let total = 0, withAnswer = 0, withOptions = 0;
  for (const t of topics) {
    for (const e of t.exercises) {
      total++;
      const k = `${e.code.year}-${e.code.bulletin}-${e.code.q}`;
      const letter = key[k];
      if (letter) { e.answer_letter = letter; withAnswer++; }
      if (e.options) {
        withOptions++;
        if (letter && e.options[letter]) e.correct_answer = e.options[letter];
      }
      e.ref = `${String(e.code.year).slice(2)}-${e.code.bulletin}-${e.code.q}`;
      delete e.code;
    }
  }

  const empty = topics.filter(t => t.exercises.length === 0).length;
  console.log(`\nMashqlar     : ${total}`);
  console.log(`Variantli    : ${withOptions} (${(withOptions / total * 100).toFixed(1)}%)`);
  console.log(`Javobi bor   : ${withAnswer} (${(withAnswer / total * 100).toFixed(1)}%)`);
  console.log(`Bo'sh mavzu  : ${empty}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ course: 'dtm', topics }, null, 1));
  console.log(`\n✅ Saqlandi: ${OUT}`);

  console.log('\n--- Namuna (birinchi mavzu, birinchi 2 mashq) ---');
  const t0 = topics.find(t => t.exercises.length);
  console.log(t0.code, t0.title, `(${t0.exercises.length} mashq)`);
  t0.exercises.slice(0, 2).forEach(e => {
    console.log(`\n  ${e.number}. [${e.ref}] ${e.prompt.slice(0, 90)}`);
    if (e.options) console.log('     variantlar:', JSON.stringify(e.options));
    console.log('     javob:', e.answer_letter, '→', e.correct_answer);
  });
})();
