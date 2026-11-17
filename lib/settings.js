/**
 * 用户设置（非敏感项）
 *
 * 存储：<BASE_DIR>/settings.json
 * ⚠️ 密钥不在这里 —— 只走 .env（见 lib/envfile.js）。
 *    设置页读密钥时只返回「是否已配置」，绝不回显明文。
 *
 * 2.1 起应用不再有「模块」概念：旧版 settings.json 里的 modules / known 字段
 * 原样保留在磁盘上（不读也不删），降级回旧版时不丢状态。
 */
const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.TT_BASE_DIR || path.join(__dirname, '..');
const FILE = path.join(BASE_DIR, 'settings.json');
const ENV_FILE = path.join(BASE_DIR, '.env');

const DEFAULTS = {
  version: 2,
  core: {
    concurrency: 1,
    headless: true,
    downloadDir: '',
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    disk = {};
  }
  cache = { ...DEFAULTS, ...disk, core: { ...DEFAULTS.core, ...(disk.core || {}) } };
  return cache;
}

function save() {
  const s = load();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
  return s;
}

function getCore() {
  return { ...load().core };
}

function setCore(patch) {
  const s = load();
  s.core = { ...s.core, ...patch };
  save();
  return { ...s.core };
}

module.exports = { BASE_DIR, FILE, ENV_FILE, load, save, getCore, setCore };
