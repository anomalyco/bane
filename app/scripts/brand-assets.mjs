// Builds the brand files in public/ from the outlined SVGs in public/brand/ (docs/brand.md): favicon.svg, favicon.ico (16,
// 32 and 48 px), apple-touch-icon.png, the manifest icons (192, 512 and a maskable 512) and the 1200 × 630 link-preview card
// og.png. Run from app/ after changing the mark: node scripts/brand-assets.mjs (BRAND_CHROME=<path> to pick Chrome).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const svg = name => readFileSync(join(publicDir, 'brand', name), 'utf8');
const inline = name => svg(name).replace(/ width="[^"]*" height="[^"]*"/, ' width="100%" height="100%"');
const font = name => `data:font/woff2;base64,${readFileSync(join(publicDir, 'fonts', name)).toString('base64')}`;
const canvas = '#FAFAFA', text = '#161616', muted = '#5C5C5C';

// The mark on a square: `scale` is its share of the side (the maskable icon keeps it inside the central safe circle).
const tile = (size, scale, background) => `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${background}">
  <div style="width:${size * scale}px;height:${size * scale}px">${inline('bane-mark.svg')}</div></body>`;
const card = `<style>
  @font-face { font-family: 'OpenTUI Mono'; src: url('${font('opentui-regular.woff2')}') format('woff2'); }
  @font-face { font-family: Inter; src: url('${font('inter-latin.woff2')}') format('woff2'); font-weight: 100 900; }
  body { margin: 0; width: 1200px; height: 630px; background: ${canvas}; color: ${text}; box-sizing: border-box; padding: 96px 104px; display: flex; flex-direction: column; justify-content: space-between; -webkit-font-smoothing: antialiased; }
  h1 { margin: 0; font: 400 72px/1.1 'OpenTUI Mono', monospace; letter-spacing: -.02em; max-width: 21ch; text-wrap: balance; }
  p { margin: 20px 0 0; font: 440 28px/1.3 Inter, sans-serif; color: ${muted}; }
</style><body><div style="height:72px">${svg('bane-lockup-light.svg').replace(/ width="[^"]*" height="[^"]*"/, ' height="72"')}</div>
  <div><h1>Email infrastructure done right.</h1><p>One API on Amazon SES.</p></div></body>`;

// ICO with PNG entries (read by every current browser and Windows since Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(p => p.data)]);
}

const browser = await chromium.launch({ executablePath: process.env.BRAND_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const shot = async (html, width, height, omitBackground = false) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html); await page.evaluate(() => document.fonts.ready);
    const data = await page.screenshot({ omitBackground }); await page.close(); return data;
  };
  // Favicon sizes snap the mark's four inner squares to whole pixels, so the frame and rings stay crisp at 16 px.
  const snap = (mark, size) => mark.replace(/M(\d+(?:\.\d+)?) \1L(\d+(?:\.\d+)?) \1L\2 \2L\1 \2Z/g, (_, a) => {
    const i = Math.round(Number(a) * size / 100) * 100 / size, o = 100 - i;
    return `M${i} ${i}L${o} ${i}L${o} ${o}L${i} ${o}Z`;
  });
  // favicon.svg: the mark on the 16 px grid (also whole pixels at 32), switching colour with the system theme if the
  // brand's dark colour differs.
  const d = snap(svg('bane-mark.svg'), 16).match(/ d="([^"]+)"/)[1], dark = svg('bane-mark-dark.svg').match(/fill="([^"]+)"/)[1], light = svg('bane-mark.svg').match(/fill="([^"]+)"/)[1];
  writeFileSync(join(publicDir, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <style>path { fill: ${light}; }${dark === light ? '' : ` @media (prefers-color-scheme: dark) { path { fill: ${dark}; } }`}</style>\n  <path fill-rule="evenodd" d="${d}"/>\n</svg>\n`);
  const favicon = async size => ({ size, data: await shot(`<body style="margin:0;background:transparent">${snap(inline('bane-mark.svg'), size).replace('<svg', `<svg style="display:block;width:${size}px;height:${size}px"`)}</body>`, size, size, true) });
  writeFileSync(join(publicDir, 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(favicon))));
  writeFileSync(join(publicDir, 'apple-touch-icon.png'), await shot(tile(180, 0.6, canvas), 180, 180));
  writeFileSync(join(publicDir, 'icon-192.png'), await shot(tile(192, 0.6, canvas), 192, 192));
  writeFileSync(join(publicDir, 'icon-512.png'), await shot(tile(512, 0.6, canvas), 512, 512));
  writeFileSync(join(publicDir, 'icon-maskable-512.png'), await shot(tile(512, 0.5, canvas), 512, 512));
  writeFileSync(join(publicDir, 'og.png'), await shot(card, 1200, 630));
} finally { await browser.close(); }
