/**
 * TikTok Display API 客户端（官方 / 免费 / 无 IP 限制）
 * ---------------------------------------------------------------------------
 * 适用场景：取「已 OAuth 授权」的账号【自己】的视频数据。
 *   - 字段齐全：view/like/comment/share（collect 官方不返回，置 0）
 *   - cursor 为时间戳游标，可任意翻历史区间（不像浏览器方案被住宅 IP 卡）
 *   - 官方接口，不存在 X-Bogus / 风控，云上数据中心 IP 也能用
 *
 * 重要语义：
 *   Display API 只能取「走 OAuth 登录授权」的那个账号本人的视频。
 *   所以要监控 @loopearplugs.th 与 @loop.earplugs.offi 两个号，需要分别
 *   做一次 OAuth 登录，拿到两个 access_token，按 handle 分别存。
 *
 * 文档：https://developers.tiktok.com/doc/display-api-reference
 * ---------------------------------------------------------------------------
 */
const https = require('https');
const querystring = require('querystring');

const HOST = 'open.tiktokapis.com';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';

/** 极简 HTTPS JSON 请求（仅用 Node 内置，无第三方依赖） */
function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data =
      body != null
        ? typeof body === 'string'
          ? body
          : querystring.stringify(body)
        : null;
    const h = { Host: HOST, ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
    if (data) h['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ host: HOST, path, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(buf);
        } catch (e) {
          json = { raw: buf, status: res.statusCode };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 拼出 TikTok 授权页 URL（把用户导过去登录授权） */
function authorizeUrl({ clientKey, redirectUri, state, scopes }) {
  const scope = (scopes || ['user.info.basic', 'video.list']).join(',');
  const q = querystring.stringify({
    client_key: clientKey,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_URL}?${q}`;
}

/** code → token（授权回调里拿到 code 后调用） */
async function exchangeToken({ clientKey, clientSecret, code, redirectUri }) {
  const r = await call('/v2/oauth/token/', {
    method: 'POST',
    body: {
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
  });
  return r.json;
}

/** refresh_token → 新 token（access_token 过期后用） */
async function refreshToken({ clientKey, clientSecret, refreshToken }) {
  const r = await call('/v2/oauth/token/', {
    method: 'POST',
    body: {
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });
  return r.json;
}

/** 取一页视频（cursor：首翻传 0；之后传上次的 data.cursor） */
async function listVideos({ accessToken, cursor = 0, maxCount = 20, fields }) {
  const f = fields || [
    'id',
    'video_description',
    'create_time',
    'like_count',
    'comment_count',
    'share_count',
    'view_count',
    'hashtag_names',
    'share_url',
    'cover_image_url',
  ];
  const q = querystring.stringify({
    fields: f.join(','),
    cursor: String(cursor),
    max_count: String(maxCount),
  });
  const r = await call(`/v2/video/list/?${q}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return r.json;
}

/**
 * 拉取 [from, to]（曼谷日期 YYYY-MM-DD）区间内的视频，整理成与现有
 * report.toRows 完全兼容的 accounts 结构，可直接喂给 buildWorkbook。
 *
 * 返回：[{ handle, nickname, stats:{}, items:[{id,desc,createTime,stats,textExtra,video}] }]
 */
async function fetchToRows({ accessToken, handle, from, to }) {
  const sinceTs = Math.floor(new Date(from + 'T00:00:00+07:00').getTime() / 1000);
  const untilTs = Math.floor(new Date(to + 'T23:59:59+07:00').getTime() / 1000);

  const seen = new Set();
  const collected = [];
  let cursor = 0;

  for (let i = 0; i < 300; i++) {
    const j = await listVideos({ accessToken, cursor, maxCount: 20 });
    if (!j || j.error || !j.data || !Array.isArray(j.data.videos)) {
      if (j && j.error) throw new Error(`Display API ${j.error.code}: ${j.error.message}`);
      break;
    }
    const vids = j.data.videos;
    if (!vids.length) break;

    for (const v of vids) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const ct = v.create_time;
      if (ct >= sinceTs && ct <= untilTs) collected.push(v);
    }

    // Display API 倒序返回（最新在前）。当本页最旧一条已早于区间起点，可提前停。
    const minCt = Math.min(...vids.map((v) => v.create_time));
    if (minCt < sinceTs) break;

    cursor = j.data.cursor || 0;
    if (!cursor || j.data.has_more === false) break;
  }

  const items = collected
    .sort((a, b) => b.create_time - a.create_time)
    .map((v) => ({
      id: v.id,
      desc: v.video_description || '',
      createTime: v.create_time, // UTC 秒，与 web 抓取一致，report 的 TZ_OFFSET 负责曼谷显示
      stats: {
        playCount: v.view_count || 0,
        diggCount: v.like_count || 0,
        commentCount: v.comment_count || 0,
        shareCount: v.share_count || 0,
        collectCount: v.collect_count || 0, // Display API 不返回，恒为 0
      },
      textExtra: (v.hashtag_names || []).map((n) => ({ hashtagName: String(n).replace(/^#/, '') })),
      video: { duration: v.video_duration || 0 }, // Display API 不返回时长，恒为 0
    }));

  return [
    {
      handle,
      nickname: handle, // Display API 不含昵称/粉丝，留待后续补
      stats: {},
      items,
    },
  ];
}

module.exports = {
  HOST,
  authorizeUrl,
  exchangeToken,
  refreshToken,
  listVideos,
  fetchToRows,
};
