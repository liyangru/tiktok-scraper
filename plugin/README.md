# TikTok Scraper 插件 v2.3.0

在 Claude 里直接抓取和分析 TikTok 账号数据，不用打开桌面应用，也不用装浏览器或依赖。

- 抓取：Claude 用自带的浏览器（内置浏览器优先，其次 Claude in Chrome）打开 TikTok 主页采集视频数据
- 分析：本期 vs 上周 / 上月同期 / 上一周期、挂车 vs 非挂车（条均 / 去掉最高最低）、最佳发布时段、TOP 视频
- 导出：Excel（汇总对比、账号、视频明细、挂车对比、发布时段）/ CSV
- 历史：电脑上装过桌面应用时和应用共用历史任务

需要：Node.js 18+（Claude Code 自带环境即可）。

使用：对 Claude 说「抓 @账号 本月数据，和上月同期比」。

本目录由 `npm run build:plugin` 从仓库源文件生成，不要直接修改。
