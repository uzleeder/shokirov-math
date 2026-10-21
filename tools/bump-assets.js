// ============================================================
//  app.css / app.js havolalariga versiya raqamini qo'yadi.
//
//  NIMAGA KERAK: brauzer faylni manzili bo'yicha keshlaydi. Fayl ichi
//  o'zgarsa ham manzil o'zgarmasa, eski nusxa ishlatilaveradi va
//  "yangi HTML + eski JS" holati yuzaga keladi (sahifa buziladi).
//  Versiyani oshirish manzilni o'zgartiradi — brauzer yangisini oladi.
//
//  Ishlatish:  node tools/bump-assets.js
//  Har deploy oldidan chaqiriladi (npm run deploy).
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FAYLLAR = ['index.html', 'login.html', 'student.html', 'admin.html',
                 'director.html', 'verify.html', '404.html'];

// Versiya = app.css va app.js mazmunidan olingan qisqa xesh.
// Fayl o'zgarmasa versiya ham o'zgarmaydi — bekorga qayta yuklanmaydi.
const crypto = require('crypto');
const xesh = crypto.createHash('md5')
  .update(fs.readFileSync(path.join(ROOT, 'assets', 'app.css')))
  .update(fs.readFileSync(path.join(ROOT, 'assets', 'app.js')))
  .digest('hex').slice(0, 8);

let ozgardi = 0;
for (const f of FAYLLAR) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  ⚠️  ' + f + ' topilmadi'); continue; }
  const eski = fs.readFileSync(p, 'utf8');
  const yangi = eski.replace(
    /(href|src)="(\/?assets\/app\.(?:css|js))(\?v=[a-f0-9]+)?"/g,
    (m, attr, yol) => `${attr}="${yol}?v=${xesh}"`);
  if (yangi !== eski) { fs.writeFileSync(p, yangi); ozgardi++; console.log('  ✅ ' + f); }
  else console.log('  ·  ' + f + ' (o\'zgarmadi)');
}
console.log(`\nVersiya: ${xesh}  —  ${ozgardi} ta fayl yangilandi`);
