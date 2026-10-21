// ============================================================
//  Lokal ishga tushirish (Vercelda bu fayl ishlatilmaydi)
//  npm run dev  →  http://localhost:3000
// ============================================================
const path = require('path');
const fs = require('fs');

// .env / .env.local faylini o'qish
// (.env.local — `npx vercel env pull` shu faylga yozadi)
(function loadEnv() {
  for (const p of [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '.env')
  ]) {
    try {
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (m && !m[1].startsWith('#')) {
          const val = m[2].replace(/^["']|["']$/g, '');
          if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
      }
    } catch (e) {}
  }
})();

const app = require('../api/index.js');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n  ✅ Server ishlayapti:  http://localhost:${PORT}`);
  console.log(`  Landing:  http://localhost:${PORT}/index.html`);
  console.log(`  Kirish :  http://localhost:${PORT}/login.html\n`);
});
