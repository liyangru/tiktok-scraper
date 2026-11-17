# TikTokScraper · 2.0 极简分析版

本地 TikTok 数据分析工具。**无浏览器抓取、无登录、无卖家/开放平台 API** —— 只做三件事：导入数据 → AI 分析 → 数据报表。安装包不含 Chromium（体积从 ~250MB 降到 ~15MB）。

## 功能
- **导入数据**：把已有 TikTok 数据（xlsx/csv/json 解析后的 accounts 结构）导入本地视频库，按视频 ID 去重、指标滚动更新
- **AI 分析**（模块 `ai-analyst`）：单条视频 AI 解读、品牌/账号级 AI 解读；需在设置里配 LLM_BASE_URL / LLM_API_KEY
- **数据报表**：账号汇总、视频明细、TOP20、挂车对比、期次对比 → Excel / CSV
- 界面：中/英/泰三语；极简黑白灰

## 运行
```bash
npm install
node server.js          # http://127.0.0.1:8899
```
桌面版：`npm run build:app`（Electron 便携版 + NSIS 安装包）

## 数据来源
`POST /api/import` 提交 `{ accounts: [{ handle, nickname, stats, items:[...] }] }`，或直接在 `data/videodb.json` 沉淀。前端「加载本地数据」按钮调 `/api/load-db` 把库转成可分析任务。

## 已移除（2.0）
真实浏览器抓取、Patchright/Playwright、创作中心登录、卖家中心登录、开放平台 API、视频下载、脚本复刻（ffmpeg 抽帧）、品牌分析模块、Docker 部署、浏览器载荷。

## 许可
MIT
