/**
 * 极简 .env 读写（不引依赖）
 *
 * 为什么不用 dotenv：本项目对依赖数量敏感（pkg 打包、体积），.env 语法又很简单，
 * 自己实现能同时拿到「写入」能力 —— 设置页填的密钥要能写回 .env。
 *
 * ⚠️ 密钥只走这里，**永远不写进 settings.json**，也永远不进 git。
 */
const fs = require('fs');
const path = require('path');

/** 解析 .env 文本 → 对象（忽略注释与空行，支持 KEY="value" / KEY='value'） */
function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** 读 .env（文件不存在返回 {}） */
function read(file) {
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * 把 .env 加载进 process.env。
 * ⚠️ 已存在的环境变量优先（命令行显式传入的不能被文件覆盖）。
 */
function load(file) {
  const vars = read(file);
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return vars;
}

/**
 * 写入 / 更新若干键，**保留原有注释与顺序**。
 * 值为空字符串时写空（而不是删行），这样键仍然可见、可发现。
 */
function write(file, patch) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (_) {
    lines = [];
  }
  const remaining = new Set(Object.keys(patch));
  const out = lines.map((raw) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw.trim());
    if (!m || !remaining.has(m[1])) return raw;
    const k = m[1];
    remaining.delete(k);
    return `${k}=${patch[k]}`;
  });
  for (const k of remaining) out.push(`${k}=${patch[k]}`);
  // 去掉结尾多余空行
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
}

/** 该键是否已配置（非空） */
function has(file, key) {
  const v = read(file)[key];
  return !!(v && String(v).trim());
}

module.exports = { parse, read, load, write, has };
