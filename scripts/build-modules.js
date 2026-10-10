/**
 * 打包 modules-src/* → modules-dist/*.tar.gz，并生成模块索引
 *
 * 用法：
 *   node scripts/build-modules.js                 # 生产索引，url 指向 GitHub Release
 *   node scripts/build-modules.js --local         # 本地索引，url 指向本地文件（开发/测试用）
 *   node scripts/build-modules.js --tag modules-v1
 *
 * 索引写到 modules/index.json（生产）或 modules-dist/index.json（本地）。
 * 生产索引里每个模块带 sha256 —— 应用安装前会校验，不匹配直接拒绝。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'modules-src');
const DIST = path.join(ROOT, 'modules-dist');
const REPO = 'liyangru/tiktok-scraper';

const args = process.argv.slice(2);
const LOCAL = args.includes('--local');
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : 'modules-v1';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('没有 modules-src/ 目录');
    process.exit(1);
  }
  fs.mkdirSync(DIST, { recursive: true });

  const modules = [];
  for (const id of fs.readdirSync(SRC)) {
    const dir = path.join(SRC, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
    const name = `${man.id}-${man.version}.tar.gz`;
    const out = path.join(DIST, name);

    // 打包：只带清单 + 服务端 + 前端，排除任何本地垃圾
    await tar.c(
      {
        gzip: true,
        file: out,
        cwd: SRC,
        // 顶层用模块 id 作为目录，安装器会自动剥掉
        filter: (p) => !/(^|\/)(\.|node_modules|__pycache__)/.test(p),
      },
      [id]
    );

    const size = fs.statSync(out).size;
    const sum = sha256(out);
    const url = LOCAL
      ? out.replace(/\\/g, '/')
      : `https://github.com/${REPO}/releases/download/${TAG}/${name}`;

    modules.push({
      id: man.id,
      name: man.name,
      version: man.version,
      description: man.description || '',
      author: man.author || '',
      requires: man.requires || [],
      size,
      sha256: sum,
      url,
    });
    console.log(`  ${man.id.padEnd(18)} ${man.version}  ${(size / 1024).toFixed(1)} KB  ${sum.slice(0, 12)}…`);
  }

  const index = { generatedAt: new Date().toISOString(), tag: TAG, modules };
  const target = LOCAL ? path.join(DIST, 'index.json') : path.join(ROOT, 'modules', 'index.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(index, null, 2) + '\n');

  console.log(`\n索引写入: ${target}`);
  console.log(`模块数: ${modules.length}${LOCAL ? '（本地模式）' : `（tag ${TAG}）`}`);
})().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
