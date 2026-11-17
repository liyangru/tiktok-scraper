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
      // 生产：模块包与索引同仓（raw.githubusercontent），与 lib/modules.js 的远端索引地址配套
      : `https://raw.githubusercontent.com/${REPO}/master/modules/${name}`;

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

  // 再写一份「相对路径」索引到 modules-dist/，随 exe 的 extraResources 一起分发。
  // ⚠️ 生产索引的 url 是 raw.githubusercontent.com 绝对地址，在离线/无网机器上装不了；
  //    这份把 url 换成纯文件名，lib/modules.js 会按索引所在目录解析成绝对路径。
  const distIndex = { generatedAt: index.generatedAt, tag: TAG, modules: modules.map((m) => ({ ...m, url: m.url.split('/').pop() })) };
  fs.writeFileSync(path.join(DIST, 'index.json'), JSON.stringify(distIndex, null, 2) + '\n');

  // ⚠️ 清掉不再被索引引用的旧版本包。
  // 不清理的话 modules-dist/ 会一直堆历史版本，而 extraResources 是整目录打进安装包的
  // —— 实测 1.1.5 的 resources/modules-dist 里混着 ai-analyst-1.0.0 / seller-import-1.2.0
  // / tiktok-login-1.1.0 等早就没人引用的死文件。
  const keep = new Set(modules.map((m) => `${m.id}-${m.version}.tar.gz`));
  const removed = [];
  for (const f of fs.readdirSync(DIST)) {
    if (!f.endsWith('.tar.gz') || keep.has(f)) continue;
    try {
      fs.rmSync(path.join(DIST, f), { force: true });
      removed.push(f);
    } catch (_) {}
  }

  console.log(`\n索引写入: ${target}`);
  console.log(`内置索引写入: ${path.join(DIST, 'index.json')}（相对路径，随 exe 分发）`);
  console.log(`模块数: ${modules.length}${LOCAL ? '（本地模式）' : `（tag ${TAG}）`}`);
  if (removed.length) console.log(`清理旧包 ${removed.length} 个: ${removed.join(', ')}`);
})().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
