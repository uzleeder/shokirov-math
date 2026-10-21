// ============================================================
//  PDF sahifasini joylashuvini hisobga olib matnga o'giradi.
//
//  Oddiy matn ajratgichlar kasrni buzadi: surat va maxraj alohida
//  qatorlarga tushib, "4 2/3" o'rniga "4 2" va keyingi qatorda "3"
//  bo'lib qoladi. Bu yerda har bir bo'lakning koordinatasi bor,
//  shuning uchun ustma-ust turgan son juftini kasr deb tanib olamiz.
//
//  Kitob ikki ustunli — chap va o'ng ustun alohida o'qiladi.
// ============================================================

// Bo'lakning "asosiy" (matn) balandligi. Undan kichigi — daraja,
// indeks yoki kasr qismi bo'lishi mumkin.
const ASOSIY_H = 9;          // 10 ga yaqin — asosiy matn
const KICHIK_H = 8.5;        // undan pasti kichik yozuv

// Surat bilan maxraj orasidagi ruxsat etilgan masofa
const KASR_MIN_GAP = 3;
const KASR_MAX_GAP = 14;
// Ular bir xil x da turishi kerak (chapdan tekislangan)
const KASR_X_TOL = 2.5;

// Bir qatorga tegishli deb hisoblanadigan y farqi
const QATOR_TOL = 2.2;

export function itemsToLines(items, opts = {}) {
  const ustunChegara = opts.ustunChegara || null;

  const bolaklar = items
    .filter(i => (i.str || '').trim() !== '')
    .map(i => ({
      s: i.str,
      x: i.transform[4],
      y: i.transform[5],
      w: i.width || 0,
      h: i.height || 0
    }));
  if (!bolaklar.length) return [];

  // ---- Ustunlarga bo'lish ----
  const guruhlar = ustunChegara
    ? [bolaklar.filter(b => b.x < ustunChegara), bolaklar.filter(b => b.x >= ustunChegara)]
    : [bolaklar];

  const qatorlar = [];
  for (const g of guruhlar) {
    if (!g.length) continue;
    qatorlar.push(...ustunQatorlari(g));
  }
  return qatorlar;
}

function ustunQatorlari(bolaklar) {
  // ---- Kasrlarni topish: bir xil x da, biri tepada biri pastda ----
  const kichiklar = bolaklar.filter(b => b.h < KICHIK_H);
  const ishlatilgan = new Set();
  const kasrlar = [];

  for (const yuqori of kichiklar) {
    if (ishlatilgan.has(yuqori)) continue;
    // Shu x da, pastroqda turgan eng yaqin kichik bo'lakni izlaymiz
    let past = null, engYaqin = Infinity;
    for (const p of kichiklar) {
      if (p === yuqori || ishlatilgan.has(p)) continue;
      if (Math.abs(p.x - yuqori.x) > KASR_X_TOL) continue;
      const gap = yuqori.y - p.y;
      if (gap < KASR_MIN_GAP || gap > KASR_MAX_GAP) continue;
      if (gap < engYaqin) { engYaqin = gap; past = p; }
    }
    if (!past) continue;                       // juftsiz — bu daraja yoki indeks

    ishlatilgan.add(yuqori); ishlatilgan.add(past);
    kasrlar.push({
      x: Math.min(yuqori.x, past.x),
      y: (yuqori.y + past.y) / 2,             // kasr o'rtasi — asosiy qator balandligi
      w: Math.max(yuqori.w, past.w),
      h: ASOSIY_H,
      s: kasrMatni(yuqori.s.trim(), past.s.trim()),
      kasr: true
    });
  }

  // Kasrga aylangan bo'laklarni chiqarib tashlaymiz
  const qolgan = bolaklar.filter(b => !ishlatilgan.has(b));
  const hammasi = [...qolgan, ...kasrlar];

  // ---- Qatorlarga guruhlash ----
  hammasi.sort((a, b) => b.y - a.y || a.x - b.x);
  const qatorlar = [];
  let joriy = null;
  for (const b of hammasi) {
    if (!joriy || Math.abs(b.y - joriy.y) > QATOR_TOL) {
      joriy = { y: b.y, bolaklar: [b] };
      qatorlar.push(joriy);
    } else {
      joriy.bolaklar.push(b);
      joriy.y = (joriy.y * (joriy.bolaklar.length - 1) + b.y) / joriy.bolaklar.length;
    }
  }

  return qatorlar.map(q => {
    q.bolaklar.sort((a, b) => a.x - b.x);
    let s = '';
    let oxirgiOng = null;
    for (const b of q.bolaklar) {
      // Bo'laklar orasida sezilarli bo'shliq bo'lsa — probel qo'yamiz
      if (oxirgiOng !== null && b.x - oxirgiOng > 1.2 && !/\s$/.test(s) && !/^\s/.test(b.s)) s += ' ';
      s += b.s;
      oxirgiOng = b.x + b.w;
    }
    return s.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

// Kasrni matn ko'rinishida yozish.
// Surat yoki maxraj murakkab bo'lsa qavsga olamiz: (a+b)/2
function kasrMatni(surat, maxraj) {
  const oddiy = t => /^[0-9a-zA-Zπ]+$/.test(t);
  const s = oddiy(surat) ? surat : `(${surat})`;
  const m = oddiy(maxraj) ? maxraj : `(${maxraj})`;
  return `${s}/${m}`;
}
