#!/usr/bin/env node
/**
 * 生成独立插件目录 plugin/（Claude Code / Claude 桌面应用安装的就是它）
 *
 * 插件不含 Electron、不含 Patchright、不需要 npm install：
 *   抓取由 Claude 自带的浏览器执行 browser/collect.js，插件只做统计、对比、导出。
 * 代码从仓库源文件复制（同一套统计口径），改了源文件后运行：npm run build:plugin
 * test/plugin.test.js 会检查 plugin/ 是否和源文件一致。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'plugin');
const pkg = require(path.join(ROOT, 'package.json'));

// 源文件 → 插件内同样的相对路径（保持 require 路径不变）
const FILES = [
  'mcp/browser-server.js',
  'lib/jobs.js',
  'lib/report.js',
  'lib/report-lite.js',
  'lib/xlsx-lite.js',
  'lib/browser-ingest.js',
  'public/shared/period.js',
  'public/shared/metrics.js',
  'browser/collect.js',
  'skills/tiktok-analytics/SKILL.md',
];

function write(rel, data) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const rel of FILES) write(rel, fs.readFileSync(path.join(ROOT, rel)));
  write(
    '.claude-plugin/plugin.json',
    JSON.stringify(
      {
        name: 'tiktok-scraper',
        version: pkg.version,
        description: '用 Claude 自带的浏览器抓取 TikTok 账号视频数据：周期对比（上周 / 上月同期）、挂车 vs 非挂车、最佳发布时段、导出 Excel。独立运行，不用装应用。',
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
  write(
    '.mcp.json',
    JSON.stringify({ mcpServers: { 'tiktok-scraper': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/browser-server.js'] } } }, null, 2) + '\n'
  );
  write(
    'README.md',
    `# TikTok Scraper 插件 v${pkg.version}

在 Claude 里直接抓取和分析 TikTok 账号数据，不用打开桌面应用，也不用装浏览器或依赖。

- 抓取：Claude 用自带的浏览器（内置浏览器优先，其次 Claude in Chrome）打开 TikTok 主页采集视频数据
- 分析：本期 vs 上周 / 上月同期 / 上一周期、挂车 vs 非挂车（条均 / 去掉最高最低）、最佳发布时段、TOP 视频
- 导出：Excel（汇总对比、账号、视频明细、挂车对比、发布时段）/ CSV
- 历史：电脑上装过桌面应用时和应用共用历史任务

需要：Node.js 18+（Claude Code 自带环境即可）。

使用：对 Claude 说「抓 @账号 本月数据，和上月同期比」。

本目录由 \`npm run build:plugin\` 从仓库源文件生成，不要直接修改。
`
  );
  return FILES.length;
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
  } catch (_) {
    diff.push('.claude-plugin/plugin.json');
  }
  return diff;
}

module.exports = { build, check, FILES };
if (require.main === module) {
  const n = build();
  console.log(`✓ plugin/ 已生成（${n} 个源文件）`);
}
