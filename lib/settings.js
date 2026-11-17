/**
 * 用户设置：模块开关 + 模块的非敏感配置
 *
 * 存储：<BASE_DIR>/settings.json
 * ⚠️ 密钥不在这里 —— 只走 .env（见 lib/envfile.js）。
 *    设置页读密钥时只返回「是否已配置」，绝不回显明文。
 */
const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.TT_BASE_DIR || path.join(__dirname, '..');
const FILE = path.join(BASE_DIR, 'settings.json');
const ENV_FILE = path.join(BASE_DIR, '.env');

const DEFAULTS = {
  version: 1,
  /* 模块：{ <id>: { enabled: bool, config: {…} } } */
  modules: {},
  /* 已知模块：装过又被删掉的模块要留在这里，
     否则设置里就再也找不到它、没法重新下载（用户明确要求：删除后仍可下载）。
     结构：{ <id>: { name, description, version, deletedAt } } */
  known: {},
  /* 核心设置 */
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
  cache = {
    ...DEFAULTS,
    ...disk,
    modules: { ...DEFAULTS.modules, ...(disk.modules || {}) },
    known: { ...DEFAULTS.known, ...(disk.known || {}) },
    core: { ...DEFAULTS.core, ...(disk.core || {}) },
  };
  return cache;
}

function save() {
  const s = load();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
  return s;
}

/* ---------------- 核心设置 ---------------- */

function getCore() {
  return { ...load().core };
}

function setCore(patch) {
  const s = load();
  s.core = { ...s.core, ...patch };
  save();
  return { ...s.core };
}

/* ---------------- 模块 ---------------- */

function moduleState(id) {
  const m = load().modules[id];
  return { enabled: !!(m && m.enabled), config: { ...((m && m.config) || {}) } };
}

function isEnabled(id) {
  return moduleState(id).enabled;
}

function setEnabled(id, enabled) {
  const s = load();
  const cur = s.modules[id] || { config: {} };
  s.modules[id] = { ...cur, enabled: !!enabled };
  save();
  return moduleState(id);
}

function getConfig(id) {
  return moduleState(id).config;
}

function setConfig(id, patch) {
  const s = load();
  const cur = s.modules[id] || { enabled: false, config: {} };
  s.modules[id] = { ...cur, config: { ...(cur.config || {}), ...patch } };
  save();
  return moduleState(id).config;
}

/** 卸载时清掉它的开关与配置（**不是**「已知模块」，那个要留着以便重新下载） */
function forget(id) {
  const s = load();
  delete s.modules[id];
  save();
}

/* ---------------- 已知模块（删过也要留名） ---------------- */

function knownModules() {
  return { ...(load().known || {}) };
}

/** 记下模块的基本信息，卸载后设置里仍能看到它、能重新下载 */
function rememberModule(id, meta) {
  if (!id) return;
  const s = load();
  const prev = s.known[id] || {};
  s.known[id] = {
    name: (meta && meta.name) || prev.name || id,
    description: (meta && meta.description) || prev.description || '',
    version: (meta && meta.version) || prev.version || '',
    deletedAt: new Date().toISOString(),
  };
  save();
  return s.known[id];
}

/** 模块真的装回来了 → 从「已删除」名单里去掉 */
function forgetKnown(id) {
  const s = load();
  if (!s.known[id]) return;
  delete s.known[id];
  save();
}

module.exports = {
  BASE_DIR,
  FILE,
  ENV_FILE,
  load,
  save,
  getCore,
  setCore,
  moduleState,
  isEnabled,
  setEnabled,
  getConfig,
  setConfig,
  forget,
  knownModules,
  rememberModule,
  forgetKnown,
};
