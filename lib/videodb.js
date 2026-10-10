/**
 * 视频数据库 —— 所有抓取过的视频沉淀在这里（按 vid 去重，指标滚动更新）。
 *
 * 存储：<BASE_DIR>/data/videodb.json
 *   { videos: { <vid>: { …最新字段, firstSeen, lastSeen, history:[{date,views,likes,…}] } },
 *     accounts: { <handle>: { firstSeen, lastSeen, followers, history:[{date,followers}] } } }
 *
 * 用途：AI 分析的数据底座 + 粉丝/播放的历史趋势（多次抓取后自动有曲线）。
 * JSON 而非 SQLite 的原因：pkg 打包原生模块风险大，且单机数据量（万级）JSON 足够；
 * 真到瓶颈再迁 SQLite，接口保持不变。
 */
const fs = require('fs');
const path = require('path');

const BASE_DIR = process.env.TT_BASE_DIR || path.join(__dirname, '..');
const FILE = path.join(BASE_DIR, 'data', 'videodb.json');

let cache = null;
let dirty = false;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    cache = { videos: {}, accounts: {} };
  }
  if (!cache.videos) cache.videos = {};
  if (!cache.accounts) cache.accounts = {};
  return cache;
}

function persist() {
  if (!dirty) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 原子写：先写临时文件再替换，避免写一半损坏库
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, FILE);
  dirty = false;
}

const today = () => new Date().toISOString().slice(0, 10);

/** 把一次抓取的行沉淀进库（按 vid 去重；指标更新 + 历史点追加） */
function upsertRows(rows) {
  const db = load();
  const d = today();
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const vid = String(r.vid || '').trim();
    if (!vid) continue;
    const cur = db.videos[vid];
    const point = {
      date: d,
      views: r.views || 0,
      likes: r.likes || 0,
      comments: r.comments || 0,
      shares: r.shares || 0,
      saves: r.saves || 0,
      reposts: r.reposts || 0,
    };
    if (!cur) {
      db.videos[vid] = {
        vid,
        account: r.account,
        desc: r.desc,
        url: r.url,
        duration: r.duration,
        createTime: r.date + ' ' + r.time,
        tags: r.tags,
        isEC: !!r.isEC,
        playUrl: r.playUrl || '',
        firstSeen: d,
        lastSeen: d,
        history: [point],
        latest: point,
      };
      added++;
    } else {
      // 内容变了就更新文案；指标追加历史点（同一天覆盖最后一个点）
      cur.account = r.account || cur.account;
      cur.desc = r.desc || cur.desc;
      cur.isEC = !!r.isEC;
      if (r.playUrl) cur.playUrl = r.playUrl;
      cur.lastSeen = d;
      const last = cur.history[cur.history.length - 1];
      if (last && last.date === d) Object.assign(last, point);
      else cur.history.push(point);
      cur.latest = point;
      updated++;
    }
  }
  dirty = true;
  persist();
  return { added, updated };
}

/** 账号快照（粉丝历史 → 粉丝增长曲线的数据来源） */
function upsertAccount(handle, stats) {
  if (!handle) return;
  const db = load();
  const d = today();
  const followers = Number(stats && stats.followerCount) || 0;
  const cur = db.accounts[handle] || { firstSeen: d, history: [] };
  cur.handle = handle;
  cur.nickname = (stats && stats.nickname) || cur.nickname || '';
  cur.lastSeen = d;
  const last = cur.history[cur.history.length - 1];
  const point = { date: d, followers, videos: (stats && stats.videoCount) || 0, hearts: (stats && stats.heartCount) || 0 };
  if (last && last.date === d) Object.assign(last, point);
  else cur.history.push(point);
  cur.followers = followers;
  db.accounts[handle] = cur;
  dirty = true;
  persist();
}

/** 一次抓取完整入库（行 + 账号快照） */
function ingest(job) {
  const rows = require('./report').toRows(job.results || []);
  const r1 = upsertRows(rows);
  for (const a of job.results || []) upsertAccount(a.handle, a.stats);
  return { rows: rows.length, ...r1 };
}

function stats() {
  const db = load();
  return { videos: Object.keys(db.videos).length, accounts: Object.keys(db.accounts).length, file: FILE };
}

module.exports = { upsertRows, upsertAccount, ingest, stats, load, FILE };
