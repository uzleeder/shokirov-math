// Betlardagi x-taqsimotni ko'rib, ustun chegarasi qayerdaligini aniqlaydi.
import fs from 'node:fs';
const PDF = process.env.KITOB;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)) }).promise;

for (const n of [2, 5, 40, 150, 300]) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const xs = tc.items.filter(i => (i.str || '').trim()).map(i => i.transform[4]).sort((a, b) => a - b);
  if (!xs.length) { console.log(`${n}-bet: bo'sh`); continue; }

  // Eng katta bo'shliqni topamiz (sahifaning 30–70% oralig'ida)
  let engKatta = 0, chegara = null;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    const orta = (xs[i] + xs[i - 1]) / 2;
    if (orta < vp.width * 0.3 || orta > vp.width * 0.7) continue;
    if (gap > engKatta) { engKatta = gap; chegara = orta; }
  }
  console.log(`${String(n).padStart(3)}-bet  kenglik=${vp.width.toFixed(0)}  x: ${xs[0].toFixed(0)}…${xs[xs.length-1].toFixed(0)}  ` +
    `eng katta bo'shliq=${engKatta.toFixed(1)} @ x=${chegara ? chegara.toFixed(1) : '—'}`);
}
await doc.destroy();
