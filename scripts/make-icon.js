/**
 * 生成应用图标：把 public/favicon.svg 渲染成 256×256 PNG，再打包成 build/icon.ico。
 * 用自带/系统 Chromium 渲染（无需额外图形库）。
 */
const pw = require('patchright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'), 'utf8');
  const b = await pw.chromium.launch({ headless: true, executablePath: CHROME });
  async function render(size) {
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const svgSized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await p.setContent(`<!doctype html><html><body style="margin:0">${svgSized}</body></html>`);
    const buf = await p.screenshot({ omitBackground: true });
    await p.close();
    return buf;
  }
  const png = await render(256); // 用于 .ico
  const png1024 = await render(1024); // 用于 macOS .icns
  await b.close();

  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png1024);

  // PNG -> ICO（单张 256×256，内嵌 PNG）
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(1, 4); // count
  const ent = Buffer.alloc(16);
  ent.writeUInt8(0, 0); // width 0 = 256
  ent.writeUInt8(0, 1); // height 0 = 256
  ent.writeUInt8(0, 2); // palette
  ent.writeUInt8(0, 3); // reserved
  ent.writeUInt16LE(1, 4); // planes
  ent.writeUInt16LE(32, 6); // bpp
  ent.writeUInt32LE(png.length, 8);
  ent.writeUInt32LE(22, 12); // offset
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), Buffer.concat([dir, ent, png]));

  console.log('icon.png', png.length, 'B; icon.ico', 22 + png.length, 'B');
})().catch((e) => {
  console.error('icon failed:', e.message);
  process.exit(1);
});
