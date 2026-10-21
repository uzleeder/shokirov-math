// ============================================================
//  Ijtimoiy tarmoqlar uchun OG rasm (1200×630 PNG) yaratish
//  Ishlatish: node tools/make-og.js  →  assets/og.png
// ============================================================
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 1200, H = 630;
const png = new PNG({ width: W, height: H });

const px = (x, y, r, g, b, a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (W * (y | 0) + (x | 0)) << 2;
  const d = png.data;
  d[i]     = Math.round(d[i]     * (1 - a) + r * a);
  d[i + 1] = Math.round(d[i + 1] * (1 - a) + g * a);
  d[i + 2] = Math.round(d[i + 2] * (1 - a) + b * a);
  d[i + 3] = 255;
};

// ---- Fon: diagonal gradient (to'q ko'k) + yumshoq yorug'lik ----
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = (x / W * 0.55 + y / H * 0.45);
    let r = Math.round(10 + t * 12);
    let g = Math.round(16 + t * 24);
    let b = Math.round(36 + t * 56);
    // yuqori chapdan cyan nur
    const d1 = Math.hypot(x - 180, y - 90) / 620;
    const k1 = Math.max(0, 1 - d1) ** 2 * 0.55;
    r += Math.round(34 * k1); g += Math.round(150 * k1); b += Math.round(170 * k1);
    // pastki o'ngdan binafsha nur
    const d2 = Math.hypot(x - 1050, y - 560) / 640;
    const k2 = Math.max(0, 1 - d2) ** 2 * 0.5;
    r += Math.round(90 * k2); g += Math.round(60 * k2); b += Math.round(160 * k2);
    px(x, y, Math.min(255, r), Math.min(255, g), Math.min(255, b));
  }
}

// ---- Yumaloq burchakli to'rtburchak ----
function roundRect(x0, y0, w, hgt, rad, paint) {
  for (let y = y0; y < y0 + hgt; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.max(x0 + rad - x, 0, x - (x0 + w - rad - 1));
      const dy = Math.max(y0 + rad - y, 0, y - (y0 + hgt - rad - 1));
      const dist = Math.hypot(dx, dy);
      if (dist <= rad) {
        const a = Math.min(1, rad - dist + 1);          // qirralarni yumshatish
        paint(x, y, (x - x0) / w, (y - y0) / hgt, a);
      }
    }
  }
}

// ---- Qalin chiziq (Σ shtrixlari uchun) ----
function line(x1, y1, x2, y2, wdt, r, g, b) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
    for (let oy = -wdt; oy <= wdt; oy++) {
      for (let ox = -wdt; ox <= wdt; ox++) {
        const d = Math.hypot(ox, oy);
        if (d <= wdt) px(cx + ox, cy + oy, r, g, b, Math.min(1, wdt - d + 1));
      }
    }
  }
}

// ---- Logo plitasi (gradient) ----
const LX = 92, LY = 232, LS = 168;
roundRect(LX, LY, LS, LS, 44, (x, y, u, v, a) => {
  const t = (u + v) / 2;
  px(x, y,
    Math.round(34 + (167 - 34) * t),
    Math.round(211 + (139 - 211) * t),
    Math.round(238 + (250 - 238) * t), a);
});

// Σ belgisi (to'q ko'k) — plita ichida
const cx = LX + LS / 2, cy = LY + LS / 2, s = LS * 0.30;
const ink = [8, 19, 46];
line(cx + s, cy - s, cx - s * 0.75, cy - s, 7, ...ink);       // yuqori
line(cx - s * 0.75, cy - s, cx + s * 0.1, cy, 7, ...ink);     // yuqori qiya
line(cx + s * 0.1, cy, cx - s * 0.75, cy + s, 7, ...ink);     // pastki qiya
line(cx - s * 0.75, cy + s, cx + s, cy + s, 7, ...ink);       // pastki

// ---- Pastki chiziq (brend gradient) ----
for (let x = 0; x < W; x++) {
  const t = x / W;
  const r = Math.round(34 + (167 - 34) * t);
  const g = Math.round(211 + (139 - 211) * t);
  const b = Math.round(238 + (250 - 238) * t);
  for (let y = H - 10; y < H; y++) px(x, y, r, g, b);
}

fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
const out = path.join(__dirname, '..', 'assets', 'og.png');
png.pack().pipe(fs.createWriteStream(out)).on('finish', () => {
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`✅ ${out}  (${W}×${H}, ${kb} KB)`);
  console.log('   Eslatma: matn SVG qatlamida — assets/og.svg ni ham ko\'ring.');
});
