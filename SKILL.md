---
name: ae-store-new-monitor
slug: ae-store-new-monitor
displayName: AE 店铺上新跟踪
version: 1.0.0
summary: 对关注的 AliExpress 店铺按上新排序跟踪公开商品列表，用销量与评价率组合判据筛出近期上架且已有订单的选品参考标的，产出分店 CSV + Markdown 报告。
license: MIT
description: 关注店铺上新跟踪——对 1~10 个 AliExpress 店铺的全部商品页按上新排序（new_desc）读取前 N 页公开商品数据，用「销量≥10 且评价率≤10%」的组合判据筛出「近期上架且已有订单」的选品参考标的与数据复核清单，产出分店 CSV + Markdown 报告 + 本地 firstSeen 历史。适合每天定时重复跑。触发场景：用户给出 AliExpress 店铺 all-items 链接数组，要求跟踪上新/筛新品链接。
---

# ae-store-new-monitor

## 功能描述

关注店铺上新跟踪：对配置的若干个（默认 3 个，支持 1~10 个）AliExpress 店铺，读取其「全部商品」列表页按 **new_desc（Newest）** 排序下的公开商品数据，用「销量 / 评价数」组合判据筛出「近期上架且已有订单」的链接（选品参考），产出分店汇总的 CSV + Markdown 报告。纯本地脚本、**零 token**，可每天重复跑；本地 `history/<storeId>.json` 记录每个商品「首次见到日期」（firstSeen），作为新品近似的上架窗口。

## 前置条件

- 已登录 AliExpress 的 Chrome + Extension Relay 已启动（端口 3459 可访问）。
- Node.js 22+。
- 纯确定性代码，无 LLM 子会话，不需要本地 pipeline/LLM 服务运行。

## 使用方式

```bash
node skill.mjs <input.json>
```

`input.json` 入参：

```json
{
  "storeUrls": [
    "https://www.aliexpress.com/store/<店铺ID>/pages/all-items.html"
  ],
  "pagesPerStore": 2,
  "outDir": "/path/to/output"
}
```

| 参数 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `storeUrls` | string[] | 必填（1~10 个） | 仅支持 `https://www.aliexpress.com/store/<店铺ID>/pages/all-items.html` 形式；可带任意 query 参数（会被忽略），skill 内部统一改写为 `?shop_sortType=new_desc` |
| `pagesPerStore` | number | 默认 2（范围 1~5） | 每店采集页数（2 页 = 80 品，实测基数足够） |
| `outDir` | string | 可选 | 输出目录；不传则默认 `<skill目录>/runs/<YYYY-MM-DD>/` |
| `output_dir` / `output_files` | string/object | 可选 | 调用方约定（pipeline）传输出目录与 res/data 文件名；未传则用上方默认 |

> 兼容说明：`outDir` 与 `output_dir` 二选一；两者都不传时用默认日期目录。

## 采集原理（主链路）

1. Relay `tab.create` 打开店铺全部商品页（`active:true`，等首屏稳定）。
2. `page.eval` 从 `performance` resource 捕获 `mtop.ae.shop.search.product.group` 请求完整 URL——其 query `data` 参数即请求体模板（sellerId / storeNumber / buyerId / cookieId 每店一套）；同时取 cookie（`_m_h5_tk` token）、UA、href（referer）、title（店名）。
3. Node 端按标准 mtop 协议签名重放：`sign = md5(token & t & appKey & dataStr)`，GET `acs.aliexpress.com/h5/...`，带浏览器 cookie/UA/referer。
4. JSONP 去壳后商品数组在 `parsed.data.data`（兜底 `itemList` / `items`）；翻页 = 改 `data.currentPage` 重签请求，页间隔 ≥2s；token 过期（ret 含 `FAIL_SYS_TOKEN_*`）时按响应 set-cookie 换新 token 重试一次。
5. 字段映射 + 判据分类 + 本地历史 firstSeen + 报告产出。

## 判据

- **★★ 跟卖标的**：`orders >= 10` 且 `feedbacks <= max(5, orders × 10%)`
  - orders<50 时 fb 上限 5（低单量比例噪声大）
  - orders≥50 时 fb 上限 = 销量×10%（AE 自然评价率 1~8%，>10% 即刷评嫌疑）
- **疑似刷评**：`orders >= 10` 且 `feedbacks > orders × 10%`（单独列出供人工复核）
- **丢弃**：`orders < 10`（零星弱品，含 orders=0 刚上架未出单，明天再看）

> 列表数据无商品发布时间字段，firstSeen（本地历史首次见到日期）即为上架窗口近似；跑得越久越准。

## 输出格式

stdout 一行 JSON：`{ "status": "success|partial|failed", "summary": "...", "output_dir": "..." }`（其余日志走 stderr）。

输出目录内生成：

- `items-<日期>.csv` — 全量条目，含判定标记列 `flag`（`storeId,item_id,title,orders,feedbacks,feedbackRate,price,url,page,firstSeen,flag`）
- `report-<日期>.md` — 分店汇总 + 每店 ★★ 跟卖标的 TOP 表（按 orders 降序，含完整链接）+ 疑似刷评表 + partial 说明
- `data.md` — 采集说明 + 判定汇总表 + 全量条目
- `res.json` — 元信息（status / 分店计数 / partial 原因 / summary）
- `history/<storeId>.json` — 本地 firstSeen 历史（自动维护，跨日累计）

## 验收底线

- 单店条目 ≥ 60（2 页 × 40）；商品总数不足 2 页的店允许低，会在报告标注说明。
- 3 店配置时总条目 ≥ 180，不达标标 `partial` 并逐店说明。
- 每条含 `item_id`/`title` 非空、`orders`/`feedbacks`/`feedbackRate`/`price`/`url`/`page`/`firstSeen` 字段。
