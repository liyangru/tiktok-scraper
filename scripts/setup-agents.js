#!/usr/bin/env node
/**
 * 把 TikTok Scraper 接入 AI 助手（不用打开桌面应用）
 *
 *   node scripts/setup-agents.js codex            写入 ~/.codex/config.toml，并安装技能
 *   node scripts/setup-agents.js claude-desktop   写入 Claude Desktop 的 MCP 配置
 *   node scripts/setup-agents.js claude-code      用 `claude mcp add` 注册（不想走插件市场时）
 *   node scripts/setup-agents.js all
 *
 * Claude Code 推荐直接用插件市场：/plugin marketplace add liyangru/tiktok-scraper
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp', 'server.js');
const NODE = process.execPath;
const home = os.homedir();
const ok = (m) => console.log(`✓ ${m}`);
const warn = (m) => console.log(`! ${m}`);

function codex() {
  const dir = process.env.CODEX_HOME || path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  let toml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // 去掉旧的同名配置块，再追加新的（路径变了也能更新）
  toml = toml.replace(/\n?\[mcp_servers\.tiktok-scraper\][\s\S]*?(?=\n\[|$)/, '').trimEnd();
  const q = (s) => JSON.stringify(s); // TOML 基本字符串与 JSON 字符串转义兼容
  toml += `${toml ? '\n\n' : ''}[mcp_servers.tiktok-scraper]
command = ${q(NODE)}
args = [${q(SERVER)}]
startup_timeout_sec = 30
tool_timeout_sec = 120
`;
  fs.writeFileSync(file, toml);
  ok(`Codex MCP 已写入 ${file}`);
  // 技能：复制到 ~/.codex/skills（Codex 会自动发现）
  const dst = path.join(dir, 'skills', 'tiktok-analytics-local');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'skills', 'tiktok-analytics-local', 'SKILL.md'), path.join(dst, 'SKILL.md'));
  ok(`技能已复制到 ${dst}`);
}

function claudeDesktop() {
  const file =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['tiktok-scraper'] = { command: NODE, args: [SERVER] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  ok(`Claude Desktop 配置已写入 ${file}（重启 Claude Desktop 生效）`);
}

function claudeCode() {
  const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'tiktok-scraper', '--', NODE, SERVER], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) ok('已注册到 Claude Code（user 范围）');
  else warn(`没找到 claude 命令。可手动运行：claude mcp add --scope user tiktok-scraper -- "${NODE}" "${SERVER}"`);
}

const target = process.argv[2] || 'help';
const map = { codex, 'claude-desktop': claudeDesktop, 'claude-code': claudeCode };
if (target === 'all') Object.values(map).forEach((f) => f());
else if (map[target]) map[target]();
else {
  console.log(`用法：node scripts/setup-agents.js <codex | claude-desktop | claude-code | all>

Claude Code 推荐用插件：
  /plugin marketplace add liyangru/tiktok-scraper
  /plugin install tiktok-scraper@liyangru-tiktok
（插件用 Claude 自带浏览器抓取，零依赖；这里的 codex / claude-desktop / claude-code 是完整版，用自带的 Patchright 浏览器抓取）`);
  process.exit(target === 'help' ? 0 : 1);
}
if (target !== 'help') console.log('\n首次调用时会自动安装依赖和抓取用浏览器；也可以先运行：npm run setup');
