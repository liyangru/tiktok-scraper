---
name: tiktok-analytics
description: 用 Claude 自带的浏览器抓取 TikTok 账号视频数据（播放、互动、挂车、发布时间），做本期 vs 上周 / 上月同期 / 上一周期对比、挂车 vs 非挂车分析，导出 Excel。用户提到抓 TikTok 账号数据、视频复盘、内容复盘、挂车视频表现、账号对比、发布时间时使用。
---

# TikTok 账号数据（浏览器采集）

用 Claude 的浏览器在 tiktok.com 采集视频数据，交给 `tiktok-scraper` MCP 工具统计，再给出**结论 + 动作**。

## 1. 定参数（用户没说就用默认，不追问）

- 账号：用户给的 @用户名，多个一起抓。
- 日期：「本月」`preset: thisMonth`；「上周」`lastWeek`；「最近 7 天」`last7`；具体日期用 `from`/`to`（YYYY-MM-DD，曼谷时间）。默认本月。
- 对比：复盘默认 `compare: lastMonth`（上月同期，严格同日期，上月没有的日期取月末）；「周环比 / 和上周比」→ `lastWeek`（只用于 7 天以内的区间：本周、上周、最近 7 天；更长区间改用 `previous`）；「环比」→ `previous`；用户说不对比才用 `none`。

## 2. 规划

调用 `prepare_scrape`。记下 `job_id`、`collect.from`、`collect.to`、`script`。

## 3. 浏览器采集

- **浏览器**：优先 Claude 内置浏览器（`Claude_Browser` 工具）；没有就用 Claude in Chrome。用之前先加载对应浏览器技能。
- 浏览器面板收起也能采集（脚本会让页面保持「可见」状态），不用让用户打开面板。
- 打开 `https://www.tiktok.com`（新标签：`preview_start`）。页面空白或 10 秒内没内容 → 刷新一次再继续，不要直接放弃。
- `javascript_tool` 执行 `script`（只需执行一次；页面刷新或跳转后要重新执行）。
- 每个账号依次执行：
  ```js
  await TTC({ handle: '账号', from: 'collect.from', to: 'collect.to' })
  ```
  - `status: "running"`：原样再调一次（每次最多约 25 秒，脚本会续跑，不会重来）。给用户的进度只说一句「正在加载 @账号 视频，已到 11-05」。
  - `status: "done"`：把返回对象里的 `fields`、`items`、`profile`、`complete`、`oldestDate` 原样交给 `submit_account`（带上 `job_id`、`handle`）。
  - `status: "error"` 或连续两次 `found` 为 0：刷新页面（`navigate` 到 https://www.tiktok.com）、重新执行 `script` 再试一次；仍失败就 `submit_account` 传 `error`，继续下一个账号。
  - 账号是否挂车看 `cart`；`ad` = 投放过广告（Spark Ads）的作品，照常统计。
- 一个账号一般 1–3 分钟。脚本卡住时会自己上下滚动、刷新重试，不需要手动处理。

## 4. 出结果

最后一个账号交齐后，`submit_account` 直接返回分析摘要。需要明细用 `list_videos`，要文件用 `export_report`（xlsx，默认存到下载文件夹，把路径告诉用户）。挂车对比要「去掉最高最低」时用 `get_report(cart_mode: "trim")`。

### 读结果的规则

- `compare.insufficient` 有值 = 对比期没加载完整，**不下涨跌结论**，说明哪个账号缺到哪天。
- 账号 `incompleteFrom` 有值 = 较早日期可能不完整。
- 两期天数不同（`compare.sameSpan=false`）看日均 / 条均，不比总量。
- `cart.fallback` = 样本 <3 条，已按条均算，标注「样本少」。
- 数字只用工具返回的，不估算、不补全。

## 5. 回复格式（简洁、排版清楚）

```
**@账号 · 11-01~11-17 vs 上月同期**

| 指标 | 本期 | 对比 | 变化 |
|---|---|---|---|
| 视频数 | 20 | 18 | ▲11% |
| 总播放 | 125万 | 98万 | ▲27% |
| 条均播放 | 6.3万 | 5.4万 | ▲15% |
| 互动率 | 6.4% | 5.9% | +0.5pp |

**结论**
- 一句话说清整体涨跌和主因（如 1 条爆款贡献 35% 播放）

**下一步**
1. 具体动作 + 依据数字（如：挂车视频条均播放比非挂车低 52%，挂车视频改用 xx 开头，先测 3 条）
2. 发布时间调到 14:00 前后（该时段条均最高，样本 ≥2 条）
```

- 先结论后数据；表格只放 4–6 个核心指标。
- 多账号加一行账号对比，指出谁拉动、谁拖累。
