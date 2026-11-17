/**
 * 浏览器采集结果 → 任务数据
 *
 * browser/collect.js 在 Claude 内置浏览器里采集，返回紧凑二维数组（省 token）：
 *   fields = ['id','createTime','views','likes','comments','shares','saves','reposts','duration','cart','ad','pinned','desc']
 * 这里还原成 report.toRows 认识的 TikTok 原始字段，后面的统计、对比、导出和桌面应用完全同一套。
 */
const DEFAULT_FIELDS = ['id', 'createTime', 'views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'duration', 'cart', 'ad', 'pinned', 'desc'];

function toRawItems(fields, items) {
  const f = Array.isArray(fields) && fields.length ? fields : DEFAULT_FIELDS;
  const ix = Object.fromEntries(f.map((k, i) => [k, i]));
  const at = (row, k) => (ix[k] === undefined ? undefined : row[ix[k]]);
  const out = [];
  for (const row of items || []) {
    if (!Array.isArray(row)) continue;
    const id = String(at(row, 'id') || '');
    const ct = Number(at(row, 'createTime'));
    if (!id || !Number.isFinite(ct)) continue;
    const n = (k) => {
      const v = at(row, k);
      return v === null || v === undefined || v === '' ? 0 : Number(v) || 0;
    };
    out.push({
      id,
      createTime: ct,
      desc: String(at(row, 'desc') || ''),
      statsV2: {
        playCount: n('views'),
        diggCount: n('likes'),
        commentCount: n('comments'),
        shareCount: n('shares'),
        collectCount: n('saves'),
        repostCount: n('reposts'),
      },
      video: { id, duration: n('duration') },
      isECVideo: !!at(row, 'cart'),
      isAd: !!at(row, 'ad'),
      isPinnedItem: !!at(row, 'pinned'),
    });
  }
  return out;
}

/** 账号信息（collect.js 的 profile）→ 任务里的 stats */
function toStats(p) {
  const n = (v) => {
    if (v === null || v === undefined || v === '') return undefined;
    if (typeof v === 'number') return v;
    // 页面兜底读到的是「3.7K / 1.2M / 1.2万」这类文字
    const m = String(v).trim().match(/^([\d.,]+)\s*([KkMmBb万千亿]?)/);
    if (!m) return undefined;
    const x = parseFloat(m[1].replace(/,/g, ''));
    const mul = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 }[m[2]] || 1;
    return Math.round(x * mul);
  };
  return { followerCount: n(p && p.followers), heartCount: n(p && p.likes), videoCount: n(p && p.videos) };
}

module.exports = { DEFAULT_FIELDS, toRawItems, toStats };
