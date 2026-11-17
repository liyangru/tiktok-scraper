#!/usr/bin/env node
/**
 * 生成 AI 端可安装的版本 —— 和桌面应用同一套抓取引擎（Patchright 浏览器在本机后台抓取），
 * AI 只调用工具、只收精简结果，抓取过程不经过对话，不费 token。
 *
 *   node scripts/build-plugin.js          → plugin/        Claude Code 插件（依赖首次使用时自动安装）
 *   node scripts/build-plugin.js --mcpb   → dist/tiktok-scraper.mcpb  Claude 桌面应用扩展（依赖已打包，双击安装）
 *
 * 代码从仓库源文件复制；改了源文件后重新运行。test/plugin.test.js 会检查 plugin/ 是否和源文件一致。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'plugin');
const pkg = require(path.join(ROOT, 'package.json'));

// 引擎文件：保持仓库里的相对路径（require 不用改）
const FILES = [
  'mcp/server.js',
  'lib/agent.js',
  'lib/runtime.js',
  'lib/jobs.js',
  'lib/scraper.js',
  'lib/browsers.js',
  'lib/report.js',
  'lib/videodb.js',
  'public/shared/period.js',
  'public/shared/metrics.js',
];
// 运行依赖（只要抓取和 Excel，不要 Electron / Express）
const DEPS = ['patchright', 'exceljs'];

const DESCRIPTION = '和桌面应用同一套引擎：在本机后台抓取 TikTok 账号视频数据，周期对比（上周 / 上月同期）、挂车 vs 非挂车、最佳发布时段、导出 Excel。AI 只调用工具，抓取不经过对话。';

const TOOLS = [
  { name: 'start_scrape', description: '抓取一个或多个 TikTok 账号（可带对比期），完成时直接返回分析摘要' },
  { name: 'get_scrape', description: '查询抓取进度；完成后返回分析摘要' },
  { name: 'list_videos', description: '视频明细（排序 / 只看挂车 / 本期或对比期）' },
  { name: 'list_scrapes', description: '历史抓取任务（与桌面应用共用）' },
  { name: 'export_report', description: '导出 Excel / CSV 到下载文件夹' },
  { name: 'stop_scrape', description: '停止抓取，已完成账号的数据保留' },
  { name: 'doctor', description: '检查运行环境；缺浏览器时自动下载' },
];

function copyTree(dst) {
  for (const rel of FILES) {
    const f = path.join(dst, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), f);
  }
  const deps = Object.fromEntries(DEPS.map((d) => [d, pkg.dependencies[d]]));
  fs.writeFileSync(
    path.join(dst, 'package.json'),
    JSON.stringify({ name: 'tiktok-scraper-engine', version: pkg.version, private: true, description: DESCRIPTION, license: 'MIT', dependencies: deps }, null, 2) + '\n'
  );
}

/** Claude Code 插件 */
function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  copyTree(OUT);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tiktok-analytics', 'SKILL.md'), 'utf8');
  fs.mkdirSync(path.join(OUT, 'skills', 'tiktok-analytics'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'skills', 'tiktok-analytics', 'SKILL.md'), skill);
  fs.mkdirSync(path.join(OUT, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: 'tiktok-scraper',
        version: pkg.version,
        description: DESCRIPTION,
        author: { name: 'liyangru', url: 'https://github.com/liyangru' },
        homepage: 'https://github.com/liyangru/tiktok-scraper',
        repository: 'https://github.com/liyangru/tiktok-scraper',
        license: 'MIT',
        keywords: ['tiktok', 'tiktok-shop', 'analytics', 'mcp'],
      },
      null,
      2
    ) + '\n'
  );
  fs.copyFileSync(path.join(ROOT, 'build', 'plugin-icon.png'), path.join(OUT, '.claude-plugin', 'icon.png'));
  fs.writeFileSync(path.join(OUT, '.mcp.json'), JSON.stringify({ mcpServers: { 'tiktok-scraper': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.js'] } } }, null, 2) + '\n');
  fs.writeFileSync(
    path.join(OUT, 'README.md'),
    `# TikTok Scraper 插件 v${pkg.version}

${DESCRIPTION}

- 抓取在本机后台进行（和桌面应用同一套 Patchright 引擎），AI 只收到精简的分析结果
- 首次使用自动安装运行依赖（约 30MB）；装过桌面应用就复用它的浏览器和历史，否则自动下载一次 Chromium
- 需要 Node.js 18+

本目录由 \`npm run build:plugin\` 从仓库源文件生成，不要直接修改。
`
  );
}

/* ---------------- Claude 桌面应用扩展（.mcpb） ---------------- */
function zipDir(dir, file) {
  // 用系统 zip（保留文件权限），没有就用 Python
  fs.rmSync(file, { force: true });
  try {
    execFileSync('zip', ['-qr', '-X', file, '.'], { cwd: dir });
  } catch (_) {
    execFileSync('python3', ['-c', `import shutil;shutil.make_archive(${JSON.stringify(file.replace(/\.mcpb$/, ''))},'zip',${JSON.stringify(dir)})`]);
    fs.renameSync(file.replace(/\.mcpb$/, '.zip'), file);
  }
}

/** 去掉运行用不到的文件：exceljs 的浏览器打包版（21MB）、类型声明、source map、文档 */
function prune(nm) {
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
  rm(path.join(nm, 'exceljs', 'dist'));
  rm(path.join(nm, '@types'));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(map|md|markdown|d\.ts|ts)$/i.test(e.name) && !/\.d\.mts$/.test(e.name)) rm(f);
    }
  };
  walk(nm);
}

function buildMcpb() {
  const stage = path.join(os.tmpdir(), `tt-mcpb-${Date.now()}`);
  copyTree(stage);
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: stage, stdio: 'inherit' });
  prune(path.join(stage, 'node_modules'));
  fs.copyFileSync(path.join(ROOT, 'build', 'plugin-icon.png'), path.join(stage, 'icon.png'));
  const manifest = {
    manifest_version: '0.3',
    name: 'tiktok-scraper',
    display_name: 'TikTok Scraper',
    version: pkg.version,
    description: DESCRIPTION,
    long_description:
      '在 Claude 里说「抓 @账号 本月数据，和上月同期比」，扩展会在你电脑上用和桌面应用相同的引擎后台抓取，' +
      '只把汇总、对比、挂车分析、最佳发布时段和 TOP 视频返回给 Claude，抓取过程不占对话额度。' +
      '装过 TikTok Scraper 桌面应用时会复用它的浏览器和历史任务；没装则首次使用自动下载一次抓取用浏览器（约 170MB）。',
    author: { name: 'liyangru', url: 'https://github.com/liyangru' },
    homepage: 'https://github.com/liyangru/tiktok-scraper',
    repository: { type: 'git', url: 'https://github.com/liyangru/tiktok-scraper' },
    icon: 'icon.png',
    license: 'MIT',
    keywords: ['tiktok', 'tiktok-shop', 'analytics'],
    server: {
      type: 'node',
      entry_point: 'mcp/server.js',
      mcp_config: { command: 'node', args: ['${__dirname}/mcp/server.js'], env: { TT_NO_AUTO_INSTALL: '1' } },
    },
    tools: TOOLS,
    compatibility: { platforms: ['darwin', 'win32'], runtimes: { node: '>=18.0.0' } },
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const file = path.join(ROOT, 'dist', 'tiktok-scraper.mcpb');
  zipDir(stage, file);
  const size = fs.statSync(file).size;
  fs.rmSync(stage, { recursive: true, force: true });
  return { file, size };
}

/** 检查 plugin/ 是否和源文件一致（测试用） */
function check() {
  const diff = [];
  for (const rel of FILES) {
    const a = path.join(ROOT, rel);
    const b = path.join(OUT, rel);
    if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) diff.push(rel);
  }
  try {
    if (require(path.join(OUT, '.claude-plugin', 'plugin.json')).version !== pkg.version) diff.push('.claude-plugin/plugin.json(version)');
    if (require(path.join(OUT, 'package.json')).version !== pkg.version) diff.push('package.json(version)');
  } catch (_) {
    diff.push('.claude-plugin/plugin.json');
  }
  return diff;
}

module.exports = { build, buildMcpb, check, FILES, DEPS };
if (require.main === module) {
  build();
  console.log(`✓ plugin/ 已生成（${FILES.length} 个引擎文件）`);
  if (process.argv.includes('--mcpb')) {
    const r = buildMcpb();
    console.log(`✓ ${path.relative(ROOT, r.file)}（${(r.size / 1048576).toFixed(1)} MB）`);
  }
}
