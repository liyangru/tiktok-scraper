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

/** 平台独有指标（创作中心 / 卖家中心同步来的）—— 这些是趋势图的第二个数据来源 */
const PLATFORM_KEYS = [
  'gmv',
  'orders',
  'productClicks',
  'gpm',
  'finishRate',
  'completionRate',
  'avgWatchTime',
  'newFans',
  'ctr',
  'ctor',
];

/**
 * 把平台同步来的指标也沉淀进历史点。
 * ⚠️ 为什么不复用 upsertRows：平台指标是**另一个来源**、另一个时间点，
 *    强行写 views=0 会在播放曲线上插一个假谷底。
 *    所以只写自己有的字段，日期与抓取快照同一天时会自动合并成一个点。
 * 这样「指标趋势」里创作中心的完播率 / 平均观看时长才能形成时间序列。
 */
function upsertPlatform(rows) {
  const db = load();
  const d = today();
  let n = 0;
  for (const r of rows) {
    const vid = String(r.vid || '');
    if (!vid) continue;
    const cur = db.videos[vid];
    if (!cur) continue;
    const patch = {};
    for (const k of PLATFORM_KEYS) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== '') patch[k] = r[k];
    }
    if (!Object.keys(patch).length) continue;
    const last = cur.history[cur.history.length - 1];
    if (last && last.date === d) Object.assign(last, patch);
    else cur.history.push(Object.assign({ date: d }, patch));
    n++;
  }
  if (n) {
    dirty = true;
    persist();
  }
  return n;
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


/** 把视频库转成 report.toRows 需要的 accounts 结构（本地数据分析用，不经过浏览器） */
function toAccounts() {
  const db = load();
  return Object.values(db.accounts).map((a) => {
    const items = Object.values(db.videos)
      .filter((v) => v.account === a.handle)
      .map((v) => {
        let ts = 0;
        try { ts = Math.floor(new Date(String(v.createTime || '').replace(' ', 'T') + ':00+07:00').getTime() / 1000); } catch (_) {}
        if (!ts || isNaN(ts)) ts = 0;
        const latest = v.latest || {};
        return {
          id: v.vid,
          desc: v.desc || '',
          createTime: ts,
          stats: {
            playCount: latest.views || 0,
            diggCount: latest.likes || 0,
            commentCount: latest.comments || 0,
            shareCount: latest.shares || 0,
            collectCount: latest.saves || 0,
            repostCount: latest.reposts || 0,
          },
          textExtra: String(v.tags || '').split(/\s+/).filter((t) => t.startsWith('#')).map((t) => ({ hashtagName: t.slice(1) })),
          video: { duration: v.duration || 0, downloadAddr: v.playUrl || '', playAddr: v.playUrl || '' },
          isECVideo: !!v.isEC,
        };
      });
    const last = (a.history && a.history[a.history.length - 1]) || {};
    return {
      handle: a.handle,
      nickname: a.nickname || a.handle,
      stats: { followerCount: a.followers || 0, videoCount: last.videos || items.length, heartCount: last.hearts || 0 },
      items,
    };
  });
}

module.exports = { toAccounts, upsertRows, upsertAccount, upsertPlatform, ingest, stats, load, FILE };
