# Shokirov Math Academy

Matematika o'quv markazi uchun **landing page + ariza tizimi + o'qituvchi paneli + talaba kabineti**.

- **Frontend:** oddiy HTML/CSS/JS (dark/light rejim, UZ/EN til)
- **Backend:** Node.js + Express — Vercel serverless funksiyasi sifatida
- **Baza:** Postgres (Vercel Postgres / Neon)

---

## Fayllar

| Fayl | Vazifasi |
|------|----------|
| `index.html` | Landing: kurslar, narx, **Ariza berish** formasi, xarita |
| `login.html` | Kirish (Talaba / O'qituvchi / Direktor) |
| `admin.html` | **O'qituvchi paneli** — dashboard, davomat, to'lovlar, arizalar, talabalar, kurslar, baho/feedback/vazifa, profil |
| `student.html` | **Talaba kabineti** — dashboard, kurslar va mashqlar, reyting, davomat, to'lovlar, baholar, profil |
| `director.html` | **Direktor paneli** — to'lovlar nazorati va moliyaviy statistika |
| `tools/` | Kitob PDF'idan mavzu va mashqlarni ajratib olish/yuklash |
| `api/index.js` | Barcha API yo'llari (Express) |
| `api/_db.js` | Postgres ulanishi, jadvallar, o'qituvchi seed |
| `server/local.js` | Lokal ishga tushirish (Vercelda ishlatilmaydi) |
| `assets/` | CSS, JS, logo |
| `vercel.json` | Vercel yo'naltirishlari |

---

## 🚀 Vercelga deploy qilish

### 1-qadam — Loyihani Vercelga yuklash

Terminalda loyiha papkasida:

```bash
npx vercel
```

Savollarga javob bering (birinchi marta Vercel akkauntingizga kirishni so'raydi):
- *Set up and deploy?* → **Y**
- *Which scope?* → akkauntingizni tanlang
- *Link to existing project?* → **N**
- *Project name?* → `shokirov-math-academy` (yoki xohlagan nom)
- *In which directory is your code located?* → **./** (Enter)
- *Want to modify these settings?* → **N**

### 2-qadam — Ma'lumotlar bazasini ulash (eng muhim)

1. [vercel.com/dashboard](https://vercel.com/dashboard) → loyihangizni oching
2. Yuqoridagi **Storage** yorlig'i → **Create Database**
3. **Neon** (Postgres) ni tanlang → **Continue** → **Create**
4. **Connect** bosing — kalitlar loyihaga **avtomatik** qo'shiladi

> Hech qanday kalit nusxalash shart emas — Vercel `DATABASE_URL` ni o'zi qo'shadi.
> Jadvallar birinchi so'rovda avtomatik yaratiladi.

### 3-qadam — Maxfiy sozlamalar

Loyiha → **Settings** → **Environment Variables** → quyidagilarni qo'shing:

| Nomi | Qiymati |
|------|---------|
| `JWT_SECRET` | uzun tasodifiy satr (masalan 40+ belgi) |
| `TEACHER_EMAIL` | o'qituvchi emaili, masalan `manuchehr@shokirov.uz` |
| `TEACHER_PASSWORD` | kuchli parol |
| `DIRECTOR_EMAIL` | direktor emaili |
| `DIRECTOR_PASSWORD` | kuchli parol |

> ⚠️ Bularni **bazani ulagandan keyin, lekin saytga birinchi marta kirishdan oldin** qo'ying — o'qituvchi akkaunti shu qiymatlar bilan bir marta yaratiladi.

### 4-qadam — Qayta deploy

```bash
npx vercel --prod
```

Tayyor! Sayt manzili terminalda chiqadi (masalan `https://shokirov-math-academy.vercel.app`).

### 5-qadam — Tekshirish

- `https://SIZNING-SAYT.vercel.app/api/health` → `{"ok":true,"users":1}` chiqishi kerak
- Landing ochiladi, ariza yuboriladi
- `login.html` → O'qituvchi → yuqoridagi email/parol bilan kiradi

---

## Ishlash tartibi

1. **Mehmon** → saytga kiradi → kurslar/narxni ko'radi → **Ariza berish** formasini to'ldiradi
2. Ariza **o'qituvchi paneliga** (Arizalar) tushadi
3. **O'qituvchi** → arizani ko'rib **"Qabul + login"** tugmasini bosadi → talabaga **login (email) va parol** yaratib beradi
4. O'qituvchi bu login/parolni talabaga aytadi (telefon, Telegram va h.k.)
5. **Talaba** → o'sha login/parol bilan kiradi → o'z kabinetini ko'radi
6. O'qituvchi **baho / feedback / vazifa** beradi; talaba ularni ko'radi va vazifani "Bajardim" deb belgilaydi
7. Ikkalasi ham **Profil** bo'limida rasm, ism, telefon va parolini o'zgartira oladi

> Talabalar **o'zi ro'yxatdan o'tmaydi** — akkauntni faqat o'qituvchi yaratadi.

---

## Rollar va imkoniyatlar

| | Talaba | O'qituvchi | Direktor |
|---|:---:|:---:|:---:|
| Kurslar va mashqlarni yechish | ✅ | — | — |
| Reyting (musobaqa) | ✅ ko'radi | ✅ ko'radi | — |
| Davomat | ✅ ko'radi | ✅ belgilaydi | — |
| To'lovlar | ✅ o'zinikini ko'radi | ✅ belgilaydi | ✅ nazorat qiladi |
| Baho / feedback / vazifa | ✅ ko'radi | ✅ beradi | — |
| Arizalar, talaba yaratish | — | ✅ | — |
| Moliyaviy statistika | — | ✅ qisman | ✅ to'liq |

---

## Kurslar va kitoblar

Kitob PDF'lari `assets/books/` papkasida.

**1-qadam — PDF'dan ajratib olish** (natija: `tools/out/<nom>.json`):

```bash
node tools/extract-book.js oq-toplam.pdf
```

**2-qadam — kurslarga yuklash** (API orqali, lokal yoki onlayn):

```bash
node tools/load-courses.js
```

```bash
node tools/load-courses.js https://shokirov-academy.vercel.app admin@shokirov.uz PAROL
```

### Yuklangan mashqlar

| Kurs | Kitob | Mavzu | Mashq |
|---|---|---:|---:|
| Algebra — Oq to'plam | `oq-toplam.pdf` (1–2-boblar) | 17 | 4 252 |
| Geometriya — Oq to'plam | `oq-toplam.pdf` (3–4-boblar) | 14 | 1 401 |
| Abituriyentlar — DTM | `dtm.pdf` (to'liq) | 31 | 5 653 |

Mashqlarning ~98 %ida to'g'ri javob bor — talaba A–E variantini tanlashi bilan **avtomatik tekshiriladi**.

> `tools/load-courses.js` dagi `PLAN` massivini tahrirlab, qaysi bob qaysi kursga tushishini o'zgartirsa bo'ladi.

> Skanerlangan (rasm ko'rinishidagi) kitoblardan matn ajratib bo'lmaydi — ular faqat o'qish uchun ochiladi (`master.pdf` shunday), mashqlarni o'qituvchi qo'lda qo'shadi.

> Skanerlangan (rasm ko'rinishidagi) kitoblardan matn ajratib bo'lmaydi — ular faqat o'qish uchun ochiladi, mashqlarni o'qituvchi qo'lda qo'shadi.

---

## Lokal ishlab chiqish (ixtiyoriy)

Lokalda ham Postgres kerak. Eng oson yo'l — Vercel yaratgan Neon bazasiga ulanish:

1. Vercel → Storage → bazangiz → **.env.local** tugmasi → `DATABASE_URL` ni nusxalang
2. Loyiha ildizida `.env` fayl yarating (`.env.example` dan nusxa oling) va qiymatlarni yozing
3. Ishga tushiring:

```bash
npm install
npm run dev
```

Brauzerda: `http://localhost:3000`

---

## Xavfsizlik eslatmalari

- `JWT_SECRET` ni albatta o'zgartiring — standart qiymat faqat ishlab chiqish uchun
- O'qituvchi paroli (`TEACHER_PASSWORD`) kuchli bo'lsin; keyin **Profil** bo'limidan ham o'zgartirsa bo'ladi
- Talaba boshqa talabaning ma'lumotini ko'ra olmaydi (serverda tekshiriladi)
- Talaba o'z emailini (login) o'zgartira olmaydi — faqat o'qituvchi o'zgartira oladi

---

Crafted by **UzLeeder** · [uzleeder.netlify.app](https://uzleeder.netlify.app)
