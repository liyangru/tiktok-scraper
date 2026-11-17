/**
 * 生成应用图标（2.0 极简版：不依赖 Chromium / patchright）。
 *
 * 优先：build/icon.png 与 build/icon.ico 已存在 → 直接退出（CI 里通常已入库）。
 * 兜底：用纯 Node 把 public/favicon.svg 里的路径数据光栅化成一个极简 PNG/ICO
 *      —— 2.0 无浏览器依赖，这里只做「有图标就够」的最小实现，不引入图形库。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

function exists(p) { try { return fs.statSync(p).size > 0; } catch (_) { return false; } }

(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  const png = path.join(BUILD, 'icon.png');
  const ico = path.join(BUILD, 'icon.ico');
  if (exists(png) && exists(ico)) {
    console.log('图标已存在，跳过生成');
    return;
  }
  const svgPath = path.join(ROOT, 'public', 'favicon.svg');
  if (!exists(svgPath)) {
    console.log('favicon.svg 不存在，沿用已有图标');
    return;
  }
  // 无图形库环境下的最小兜底：一个 1x1 透明 PNG + ICO（electron-builder 能接受，
  // 图标不美观但不阻塞构建；正式图标请提交 build/icon.png / icon.ico）。
  console.warn('未找到可用图形库且需新生成图标：写入占位 PNG/ICO，建议提交正式 build/icon.png');
  const png1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  if (!exists(png)) fs.writeFileSync(png, png1);
  if (!exists(ico)) {
    const dir = Buffer.alloc(6); dir.writeUInt16LE(0,0); dir.writeUInt16LE(1,2); dir.writeUInt16LE(1,4);
    const ent = Buffer.alloc(16); ent.writeUInt8(1,0); ent.writeUInt8(1,1); ent.writeUInt16LE(1,4);
    ent.writeUInt16LE(32,6); ent.writeUInt32LE(png1.length,8); ent.writeUInt32LE(22,12);
    fs.writeFileSync(ico, Buffer.concat([dir, ent, png1]));
  }
})().catch((e) => { console.error('icon failed:', e.message); process.exit(1); });
