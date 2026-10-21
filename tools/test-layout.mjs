// Yangi joylashuv-asosli ajratgichni sinash: bir necha betni chiqaradi.
import fs from 'node:fs';
import { itemsToLines } from './pdf-layout.mjs';

const PDF = process.env.KITOB ||
  'C:/Users/Mekhr/AppData/Local/Packages/38833FF26BA1D.UnigramPreview_g9c9v27vpyspw/LocalState/0/documents/matematika_abituriyentlar_uchun_mavzulashtirilgan_testlar_to_pla.pdf';
const BETLAR = (process.argv[2] || '2').split(',').map(Number);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)) }).promise;

for (const n of BETLAR) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const qatorlar = itemsToLines(tc.items, { ustunChegara: vp.width / 2 });
  console.log(`\n=== ${n}-bet (kenglik ${vp.width.toFixed(0)}) ===`);
  qatorlar.forEach(q => console.log('  ' + q));
}
await doc.destroy();
