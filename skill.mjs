#!/usr/bin/env node
/**
 * ae-store-new-monitor — 对标店铺新品日常监控
 *
 * 对配置的 AliExpress 店铺（1~10 个）抓「全部商品」列表页按 new_desc（Newest）排序前 N 页，
 * 用销量/评价组合判据筛出「新上架且已出单」的 ★★ 跟卖标的 与 疑似刷评，产出分店汇总
 * CSV + Markdown 报告，并维护本地 history/<storeId>.json 记录每个商品的 firstSeen（首次见到日期）。
 *
 * 全程零 token：纯确定性代码 + Extension Relay HTTP API（端口 3459）驱动浏览器，无任何 LLM 子会话。
 *
 * 主链路（探索已验证）：
 *   1. relay tab.create 打开店铺 all-items.html?shop_sortType=new_desc（active:true）
 *   2. page.eval 从 performance resource 捕获 mtop.ae.shop.search.product.group 请求完整 URL
 *      （其 query 的 data 参数即请求体模板：sellerId/storeNumber/buyerId/cookieId 每店一套）
 *   3. page.eval 取 document.cookie（_m_h5_tk token）+ UA + href（referer）+ document.title（店名）
 *   4. Node 端按 mtop 协议签名重放：sign = md5(token & t & appKey & dataStr)，appKey 从捕获 URL 读取
 *   5. JSONP 去壳后商品数组位于 parsed.data.data（兜底 itemList/items）；翻页改 data.currentPage 重签
 *   6. 字段映射 + 判据分类 + 本地历史 firstSeen + CSV/MD 产出
 *
 * 用法：node skill.mjs <input.json 路径>
 * input.json: { storeUrls: string[], pagesPerStore?: number(1~5), outDir?: string,
 *               output_dir?: string, output_files?: {result?, data?} }
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ===================== 常量 =====================

// Extension Relay HTTP API（所有浏览器操作只走此通道）
const RELAY_URL = 'http://127.0.0.1:3459';
// 每店采集页数默认/上限（new_desc 前 2 页 = 80 品，实测基数足够）
const DEFAULT_PAGES_PER_STORE = 2;
const MAX_PAGES_PER_STORE = 5;
// 每店条数验收线（2 页 × 40）
const PER_STORE_MIN = 60;
// 3 店配置时的总量验收线
const MIN_TOTAL_3STORE = 180;
// 节流：页间隔 ≥2s、店间隔 ≥5s（保持正常访问节奏）
const PAGE_GAP_MS = 2500;
const STORE_GAP_MS = 5000;
// tab.create 后首屏稳定时间；若首屏未触发 mtop 请求则轮询等待
const TAB_SETTLE_MS = 8000;
const CAPTURE_POLL_MS = 3000;
const CAPTURE_POLL_TRIES = 4;
// token 过期重签重试前的冷却
const TOKEN_RETRY_MS = 3000;
// 响应异常/解析失败时的退避重试
const BLOCK_BACKOFF_MS = 8000;
const MAX_PAGE_TRIES = 4; // token 过期→换新可能需要两轮（实测 9/5：expired→empty→成功），2 次不够
// 命中平台临时拦截页：关 tab 冷却 60~90s 后重开（一次机会）
const BLOCK_COOLDOWN_MS = 45000;

const DATE = dateStr(new Date());

// ===================== 小工具 =====================

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

// ===================== Relay 封装 =====================

async function relayCall(op, params = {}, timeout = 30000) {
  const res = await fetch(`${RELAY_URL}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, params, timeout }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${op}: ${data.error}`);
  return data.result;
}

async function ensureRelay() {
  try {
    const status = await (await fetch(`${RELAY_URL}/api/status`)).json();
    if (!status.extensionConnected) throw new Error('Extension not connected');
  } catch (e) {
    throw new Error(`Relay not available at ${RELAY_URL}：${e.message}`);
  }
}

// page.eval 直接传 code 字符串（不写文件再读回）。结果可能是 JSON 字符串，也可能是已解析对象。
async function pageEval(tabId, code, groupId) {
  const res = await relayCall('page.eval', { tabId, code, groupId });
  if (typeof res === 'string') {
    try {
      return JSON.parse(res);
    } catch {
      return res;
    }
  }
  return res;
}

// ===================== 页面内执行脚本（探索验证过） =====================

// 捕获会话：店铺页首次加载会自动发出 mtop.ae.shop.search.product.group 请求，从 performance
// resource 取完整 URL（含 data 请求体模板），连同 cookie/UA/href/title 一次性带回。
const CAPTURE_JS = `JSON.stringify((() => {
  const names = performance.getEntriesByType("resource")
    .filter(e => e.name.indexOf("mtop.ae.shop.search.product.group") >= 0)
    .map(e => e.name);
  return {
    href: location.href,
    title: document.title,
    cookie: document.cookie,
    ua: navigator.userAgent,
    mtop: names.length ? names[names.length - 1] : null
  };
})())`;

// 兜底：首屏未捕获到 mtop 请求时，合成点击一次分页数字触发重新请求（React Router 不校验
// 事件校验）。为什么只做兜底：合成点击有概率被平台临时拦截，主链路翻页全走 mtop 数据接口。
const PAGINATE_JS = `(() => {
  const cand = Array.from(document.querySelectorAll('a,button,li,div')).filter(el => {
    const t = (el.textContent || '').trim();
    if (!/^\\d+$/.test(t) || t.length > 3) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const target = cand.find(el => el.textContent.trim() === '2') || cand[cand.length - 1];
  if (!target) return 'no-paginator';
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'clicked';
})()`;

class BlockedError extends Error {}

const BLOCKED_RE = /_____tmd_____/i; // 平台临时拦截页（统一走 /_____tmd_____/ 路径）

// ---- 页面校验组件恢复（平台临时拦截页出现时，以正常访问节奏完成页面上的拖动校验组件）----

const SLIDER_GEOM_JS = `JSON.stringify((() => {
  const h = document.querySelector('#nc_1_n1z');
  const t = document.querySelector('.nc_scale');
  if (!h || !t) return JSON.stringify({ ok: false });
  const hr = h.getBoundingClientRect(), tr = t.getBoundingClientRect();
  return JSON.stringify({ ok: true, hx: hr.x + hr.width / 2, hy: hr.y + hr.height / 2, trackLeft: tr.x, trackRight: tr.x + tr.width, handleW: hr.width });
})())`;

const SLIDER_DOWN_JS = `JSON.stringify((() => {
  const h = document.querySelector('#nc_1_n1z');
  if (!h) return JSON.stringify({ ok: false });
  const r = h.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true };
  ['pointerdown', 'mousedown'].forEach(t => h.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts)));
  return JSON.stringify({ ok: true, x, y });
})())`;

function sliderMoveJS(x, y) {
  return `JSON.stringify((() => {
    const opts = { bubbles: true, cancelable: true, view: window, clientX: ${x.toFixed(2)}, clientY: ${y.toFixed(2)}, button: 0, pointerId: 1, isPrimary: true };
    const el = document.elementFromPoint(${x.toFixed(2)}, ${y.toFixed(2)}) || document.querySelector('#nc_1_n1z') || document;
    ['pointermove', 'mousemove'].forEach(t => el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts)));
    return JSON.stringify({ ok: 1 });
  })())`;
}

function sliderUpJS(x, y) {
  return `JSON.stringify((() => {
    const opts = { bubbles: true, cancelable: true, view: window, clientX: ${x.toFixed(2)}, clientY: ${y.toFixed(2)}, button: 0, pointerId: 1, isPrimary: true };
    const el = document.elementFromPoint(${x.toFixed(2)}, ${y.toFixed(2)}) || document;
    ['pointerup', 'mouseup'].forEach(t => el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts)));
    return JSON.stringify({ ok: 1 });
  })())`;
}

// 在拦截页 tab 上完成一次拖动校验（变速轨迹 + 手势抖动 + 末端过冲），成功则页面自动跳回原地址
async function tryRestoreAccess(tabId, groupId) {
  try {
    await pageEval(tabId, `(() => { location.reload(); return 1; })()`, groupId);
    await sleep(9000);
    const g = await pageEval(tabId, SLIDER_GEOM_JS, groupId);
    if (!g || !g.ok) return false;
    const down = await pageEval(tabId, SLIDER_DOWN_JS, groupId);
    if (!down || !down.ok) return false;
    const startX = down.x, startY = down.y;
    const endX = g.trackRight - g.handleW / 2 + 10;
    const D = endX - startX;
    const STEPS = 46;
    let x = startX;
    for (let i = 1; i <= STEPS; i++) {
      const p = i / STEPS;
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      x = startX + D * ease;
      const jitter = (Math.random() - 0.5) * 3 * (1 - p * 0.6);
      const y = startY + (Math.random() - 0.5) * 2.5;
      await pageEval(tabId, sliderMoveJS(x + jitter, y), groupId);
      const delay = p < 0.2 || p > 0.85 ? 26 + Math.random() * 18 : 9 + Math.random() * 14;
      await sleep(delay);
    }
    await sleep(80 + Math.random() * 70);
    await pageEval(tabId, sliderMoveJS(endX - 2, startY), groupId);
    await sleep(60);
    await pageEval(tabId, sliderUpJS(endX, startY), groupId);
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const st = await pageEval(tabId, `JSON.stringify({ href: location.href })`, groupId);
      if (st && !BLOCKED_RE.test(st.href || '')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 修复 2026-09-05：先扫现有 tab，找到健康的同店铺页（有商品卡）直接复用其捕获会话，
// 避免短时间内反复开新 tab 引发临时拦截；复用的 tab 结束时不关闭（可能是用户自己开的）
async function findHealthyTab(storeId, groupId) {
  let tabs = [];
  try {
    // 不按 groupId 过滤：健康的店铺页可能在默认组（如用户自己开的 tab）；
    // 这里只做只读 eval（performance/cookie），不会对外部 tab 产生写操作
    const res = await relayCall('tab.list', {}, 15000);
    tabs = Array.isArray(res) ? res : (res.tabs || []);
  } catch { return null; }
  // 收集所有健康候选，选「页面加载时间最新」的——旧 tab 的 mtop token/会话状态易过期导致重放失败
  const candidates = [];
  for (const t of tabs) {
    if (!t.url || !t.url.includes(`/store/${storeId}/`)) continue;
    // 外部 tab 不在自身 group 里，eval 必须不带 groupId（否则归属校验直接报错）
    let s = null;
    try {
      const raw = await relayCall('page.eval', { tabId: t.id, code: CAPTURE_JS }, 30000);
      s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { continue; }
    if (s && s.mtop && !BLOCKED_RE.test(s.href || '')) {
      let timeOrigin = 0;
      try {
        const to = await relayCall('page.eval', { tabId: t.id, code: 'JSON.stringify(performance.timeOrigin)' }, 15000);
        timeOrigin = Number(JSON.parse(to)) || 0;
      } catch {}
      candidates.push({ tab: { id: t.id, reused: true }, session: s, timeOrigin, title: t.title || '' });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.timeOrigin - a.timeOrigin);
  const best = candidates[0];
  console.error(`[capture] 复用健康 tab ${best.tab.id}（${best.title.slice(0, 30)}，timeOrigin=${best.timeOrigin}，候选 ${candidates.length} 个）`);
  return { tab: best.tab, session: best.session };
}

// 每店：先试复用健康 tab → 开新 tab → 捕获模板/cookie；捕获失败（页面被临时拦截）时关 tab 冷却后重开一次
async function openAndCapture(storeUrl, groupId) {
  const storeId = (storeUrl.match(/\/store\/(\d+)/) || [])[1] || '';
  // 0. 复用路径：已有健康 tab 就不开新的
  if (storeId) {
    const reuse = await findHealthyTab(storeId, groupId);
    if (reuse) return reuse;
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let tab = null;
    try {
      tab = await relayCall('tab.create', { url: storeUrl, active: true, groupId }, 60000);
      await sleep(TAB_SETTLE_MS);
      let s = await tryCapture(tab.id, groupId);
      if (!s || !s.mtop) {
        try { await pageEval(tab.id, PAGINATE_JS, groupId); } catch {}
        await sleep(4000);
        s = await tryCapture(tab.id, groupId);
      }
      if (s && s.mtop) {
        // 命中平台临时拦截页 → href 会变化；此时关闭冷却后重开
        if (BLOCKED_RE.test(s.href)) throw new BlockedError('页面被平台临时拦截');
        return { tab, session: s };
      }
      // 页面本身可能已被重定向到挑战页（无 mtop 可言）→ 按 blocked 处理
      let href = '';
      try {
        const st = await pageEval(tab.id, `JSON.stringify({href:location.href})`, groupId);
        href = st ? (JSON.parse(st).href || '') : '';
      } catch {}
      if (BLOCKED_RE.test(href)) throw new BlockedError('页面被平台临时拦截');
      throw new Error('首屏未捕获到 mtop 数据请求');
    } catch (e) {
      lastErr = e;
      if (e instanceof BlockedError && tab) {
        // 优先尝试在当前拦截页上完成页面校验恢复（避免冷却等待与重复开 tab）
        console.error('[capture] page blocked, trying in-place access restore');
        const restored = await tryRestoreAccess(tab.id, groupId);
        if (restored) {
          const s = await tryCapture(tab.id, groupId);
          if (s && s.mtop && !BLOCKED_RE.test(s.href || '')) {
            console.error('[capture] access restored');
            return { tab, session: s };
          }
        }
      }
      if (tab) { try { await relayCall('tab.close', { tabId: tab.id }); } catch {} }
      if (e instanceof BlockedError) {
        console.error(`[capture] page blocked, cooldown ${BLOCK_COOLDOWN_MS}ms then reopen`);
        await sleep(BLOCK_COOLDOWN_MS);
      } else {
        console.error(`[capture] attempt ${attempt + 1} failed: ${e.message}`);
        await sleep(3000);
      }
    }
  }
  // 兜底：冷却后仍失败，最后再试一次复用路径（期间用户可能手动通过挑战）
  if (storeId) {
    const reuse = await findHealthyTab(storeId, groupId);
    if (reuse) return reuse;
  }
  throw lastErr || new Error('capture failed');
}

async function tryCapture(tabId, groupId) {
  for (let i = 0; i < CAPTURE_POLL_TRIES; i++) {
    try {
      const s = await pageEval(tabId, CAPTURE_JS, groupId);
      if (s && s.mtop) return s;
    } catch {}
    await sleep(CAPTURE_POLL_MS);
  }
  return null;
}

// 解析 mtop 请求 URL：取 appKey + data 请求体模板
function parseMtopUrl(mtopUrl) {
  const u = new URL(mtopUrl);
  const dataRaw = u.searchParams.get('data');
  const appKeyRaw = u.searchParams.get('appKey');
  if (!dataRaw) throw new Error('mtop URL 缺少 data 参数');
  if (!appKeyRaw) throw new Error('mtop URL 缺少 appKey');
  let data;
  try {
    data = JSON.parse(decodeURIComponent(dataRaw));
  } catch (e) {
    throw new Error(`data 参数解析失败: ${e.message}`);
  }
  return { data, appKey: Number(appKeyRaw) };
}

function extractToken(cookieStr) {
  const m = cookieStr.match(/_m_h5_tk=([^;]+)/);
  if (!m) return null;
  return (m[1].split('_')[0]) || null;
}

// token 过期时响应 set-cookie 会带新 _m_h5_tk，用它更新 cookie jar
function mergeSetCookies(headers, cookieJar) {
  // getSetCookie() 返回每条独立的 set-cookie（Node 22 undici 支持）；老实现仅 get('set-cookie') 会被逗号粘连
  let setCookies = [];
  if (typeof headers.getSetCookie === 'function') {
    try { setCookies = headers.getSetCookie(); } catch {}
  }
  if (!setCookies.length && headers.get('set-cookie')) setCookies = [headers.get('set-cookie')];
  let jar = cookieJar;
  for (const sc of setCookies) {
    const clean = sc.split(';')[0].trim();
    const eq = clean.indexOf('=');
    if (eq > 0 && /^_m_h5_tk/.test(clean.slice(0, eq))) {
      const re = new RegExp('(?:^|; )' + clean.slice(0, eq) + '=[^;]*');
      jar = re.test(jar) ? jar.replace(re, clean) : jar + '; ' + clean;
    }
  }
  return jar;
}

// ===================== mtop 重放（每店一套模板 + cookie） =====================

/**
 * 用浏览器会话 cookie/token 按 mtop 协议签名重放列表请求，翻页至 pagesPerStore/totalPage。
 * 返回 { items: [{page, item}], totalCount, totalPage, pagesDone, errors }。
 */
async function fetchStoreItems({ session, pagesPerStore }) {
  const { cookie, ua, href, mtop } = session;
  let token = extractToken(cookie);
  if (!token) throw new Error('cookie 缺少 _m_h5_tk token');
  const { data: dataTemplate, appKey } = parseMtopUrl(mtop);
  let jar = cookie;

  async function callOne(dataObj) {
    const dataStr = JSON.stringify(dataObj);
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${appKey}&${dataStr}`);
    const api = 'mtop.ae.shop.search.product.group';
    const url =
      `https://acs.aliexpress.com/h5/${api}/1.0/?` +
      `jsv=2.5.1&appKey=${appKey}&t=${t}&sign=${sign}&api=${api}&v=1.0` +
      `&type=jsonp&dataType=jsonp&callback=cb&data=${encodeURIComponent(dataStr)}`;
    const res = await fetch(url, {
      headers: { cookie: jar, 'user-agent': ua, referer: href, accept: '*/*' },
      redirect: 'manual',
    });
    const newJar = mergeSetCookies(res.headers, jar);
    if (newJar !== jar) {
      jar = newJar;
      token = extractToken(jar) || token; // 若签名失败返回的 set-cookie 带新 token
    }
    let body = (await res.text()).trim();
    if (body.startsWith('cb(') && body.endsWith(')')) body = body.slice(3, -1);
    let parsed = null;
    let blocked = false;
    try {
      parsed = JSON.parse(body);
    } catch {
      blocked = true;
    }
    const retStr = parsed && parsed.ret ? parsed.ret.join(';') : '';
    return { parsed, retStr, blocked, body };
  }

  const collected = [];
  const errors = [];
  let totalCount = null;
  let totalPage = null;
  let pagesDone = 0;

  for (let page = 1; page <= pagesPerStore; page++) {
    let ok = false;
    for (let tryNo = 1; tryNo <= MAX_PAGE_TRIES; tryNo++) {
      const r = await callOne({ ...dataTemplate, currentPage: page });
      if (r.blocked || /tmd_____|unusual traffic/i.test(r.body)) {
        // 响应异常：退避后重试
        if (tryNo < MAX_PAGE_TRIES) { await sleep(BLOCK_BACKOFF_MS); continue; }
        errors.push(`第 ${page} 页响应异常（临时限流）`);
        break;
      }
      if (/FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN/i.test(r.retStr)) {
        // token 过期：mergeSetCookies 已换新 token，重签重试一次
        if (tryNo < MAX_PAGE_TRIES) { await sleep(TOKEN_RETRY_MS); continue; }
        errors.push(`第 ${page} 页 token 刷新后仍失败`);
        break;
      }
      if (!r.parsed || !/SUCCESS/.test(r.retStr)) {
        if (tryNo < MAX_PAGE_TRIES) { await sleep(BLOCK_BACKOFF_MS); continue; }
        errors.push(`第 ${page} 页接口未成功：${r.retStr || '无响应'}`);
        break;
      }
      const d = r.parsed.data || {};
      totalCount = d.totalCount ?? totalCount;
      totalPage = d.totalPage ?? totalPage;
      // 商品数组路径兜底：data.data || itemList || items
      const items = d.data || d.itemList || d.items || [];
      for (const it of items) collected.push({ page, item: it });
      pagesDone++;
      ok = true;
      break;
    }
    if (!ok) break;
    if (totalPage && page >= totalPage) break;
    if (page < pagesPerStore) await sleep(PAGE_GAP_MS);
  }

  return { items: collected, totalCount, totalPage, pagesDone, errors };
}

// ===================== 字段映射 + 判据（2026-09-05 用 80 品样本标定） =====================

/**
 * 判据：
 *  - ★★ 跟卖标的: orders>=10 且 feedbacks <= max(5, orders×10%)
 *      （orders<50 时 fb 上限 5，低单量比例噪声大；orders>=50 时上限=销量×10%，
 *         AE 自然评价率 1~8%，>10% 即刷评嫌疑）
 *  - 疑似刷评:   orders>=10 且 feedbacks > orders×10%
 *  - 丢弃:       orders < 10（零星弱品）
 */
function classify(orders, fb) {
  if (orders >= 10 && fb <= Math.max(5, orders * 0.1)) return 'STAR2';
  if (orders >= 10 && fb > orders * 0.1) return 'SUSPECT';
  return 'DROP';
}

function mapItem(item, page, firstSeen) {
  // 0 销商品没有 orders/sales 键（不是值为 0）！必须缺省按 0
  const ordersRaw = item.orders ?? item.sales;
  const orders = ordersRaw === undefined || ordersRaw === null ? 0 : Number(ordersRaw);
  const feedbacks = item.feedbacks === undefined || item.feedbacks === null ? 0 : Number(item.feedbacks);
  const feedbackRate = orders > 0 ? Number(((feedbacks / orders) * 100).toFixed(1)) : 0;
  const price =
    item.prices?.promotionPiecePrice?.amount ??
    item.promotionPiecePriceMoney?.amount ??
    item.piecePriceMoney?.amount ??
    '';
  const rawUrl = item.pcDetailUrl || '';
  const url = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
  // item.id 是内部 prod id（10050...），公网 itemId（32568...）在详情链接里——以链接为准
  const publicId = (url.match(/\/item\/(\d+)/) || [])[1] || String(item.id ?? '');
  return {
    item_id: publicId,
    title: item.subject || item.seoTitle || '',
    orders,
    feedbacks,
    feedbackRate,
    price,
    url,
    page,
    firstSeen,
    tag: classify(orders, feedbacks),
  };
}

// ===================== 本地历史（firstSeen 持久化） =====================

function loadHistory(storeId, historyDir) {
  const f = join(historyDir, `${storeId}.json`);
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

// ===================== 输出渲染 =====================

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function flagText(tag) {
  return tag === 'STAR2' ? '★★跟卖标的' : tag === 'SUSPECT' ? '疑似刷评' : '丢弃(orders<10)';
}

// markdown 表格单元格转义 + 截断
function cell(s, len) {
  const t = String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return len ? t.slice(0, len) : t;
}

// 通用商品表渲染（★ / 疑似刷评 / 全量共用一套，避免分类复制）
function renderItemTable(rows) {
  if (!rows.length) return ['无'];
  const lines = [
    '| item_id | title | orders | feedbacks | 评价率% | price | firstSeen | page | url |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const it of rows) {
    lines.push(`| ${cell(it.item_id)} | ${cell(it.title, 90)} | ${it.orders} | ${it.feedbacks} | ${it.feedbackRate} | ${cell(it.price)} | ${it.firstSeen} | ${it.page} | ${cell(it.url)} |`);
  }
  return lines;
}

// ===================== 主流程 =====================

async function main() {
  // ---- 读入参 ----
  const input = readInput();
  const rawUrls = input.storeUrls;
  if (!Array.isArray(rawUrls) || rawUrls.length === 0 || rawUrls.length > 10) {
    throw new Error('入参 storeUrls 必须为 1~10 个店铺全部商品页链接数组');
  }
  let pagesPerStore = input.pagesPerStore === undefined ? DEFAULT_PAGES_PER_STORE : Number(input.pagesPerStore);
  if (!Number.isFinite(pagesPerStore) || pagesPerStore < 1) pagesPerStore = DEFAULT_PAGES_PER_STORE;
  pagesPerStore = Math.min(pagesPerStore, MAX_PAGES_PER_STORE);

  // storeUrls 仅支持 /store/<ID>/pages/all-items.html 一种形式；提取店铺 ID 后统一改写为 new_desc 标准入口
  const stores = rawUrls.map((u, i) => {
    const m = String(u).match(/\/store\/(\d+)\/pages\/all-items\.html/);
    if (!m) throw new Error(`第 ${i + 1} 个 storeUrls 不是受支持形式（须为 .../store/<店铺ID>/pages/all-items.html）: ${u}`);
    return {
      storeId: m[1],
      url: `https://www.aliexpress.com/store/${m[1]}/pages/all-items.html?shop_sortType=new_desc`,
    };
  });

  // ---- 输出目录（约定：调用方传 output_dir / output_files；否则按需求默认 <skill>/runs/<日期>/）----
  const outputDir = input.output_dir || input.outDir || join(import.meta.dirname, 'runs', DATE);
  const outputFiles = input.output_files || {};
  mkdirSync(outputDir, { recursive: true });
  const resultFile = join(outputDir, outputFiles.result || 'res.json');
  const dataFile = join(outputDir, outputFiles.data || 'data.md');
  const csvFile = join(outputDir, `items-${DATE}.csv`);
  const reportFile = join(outputDir, `report-${DATE}.md`);

  // ---- 历史目录 ----
  // 为什么：history 必须跨日累计才有 firstSeen 意义；当输出目录本身是日期目录（默认 runs/<date>/）
  // 时，历史放其父级 runs/history/；显式指定 outDir 时放 outDir/history（隔离每次调用）。
  const outBase = /^\d{4}-\d{2}-\d{2}$/.test(join(outputDir).split(/[\\/]/).pop()) ? join(outputDir, '..') : outputDir;
  const historyDir = input.historyDir || join(outBase, 'history');
  mkdirSync(historyDir, { recursive: true });

  // ---- 浏览器会话 ----
  await ensureRelay();
  const { groupId } = await relayCall('group.create', { name: 'ae-store-new-monitor' });

  const storeResults = []; // 每店分析结果
  const allCsvRows = [];
  const partialReasons = [];

  try {
    for (let i = 0; i < stores.length; i++) {
      const { storeId, url } = stores[i];
      console.error(`[store ${storeId}] 开始采集 (${i + 1}/${stores.length})`);
      let session = null;
      let tab = null;
      let rawItems = [];
      let totalCount = null;
      let totalPage = null;
      let errors = [];
      let storeName = '';
      let newToday = 0;
      let pagesDone = 0;

      try {
        const cap = await openAndCapture(url, groupId);
        tab = cap.tab;
        session = cap.session;
        storeName = cleanStoreName(session.title || '', storeId);
        const fetched = await fetchStoreItems({ session, pagesPerStore });
        rawItems = fetched.items;
        totalCount = fetched.totalCount;
        totalPage = fetched.totalPage;
        errors = fetched.errors;
        pagesDone = fetched.pagesDone;
      } catch (e) {
        errors.push(e.message);
      } finally {
        // 复用的健康 tab（可能是用户自己开的）不关闭
        if (tab && !tab.reused) { try { await relayCall('tab.close', { tabId: tab.id }); } catch {} }
      }

      // ---- 映射 + 去重（翻页期间上新可能造成跨页重复）+ firstSeen ----
      const history = loadHistory(storeId, historyDir);
      const items = [];
      const seenIds = new Set();
      let missingId = 0;
      for (const { page, item } of rawItems) {
        const id = String(item?.id ?? '');
        if (!id) { missingId++; continue; }
        if (seenIds.has(id)) continue; // 按首次出现保留（更小页号 = 更新）
        seenIds.add(id);
        const fs = history[id];
        if (!fs) { history[id] = DATE; newToday++; }
        items.push(mapItem(item, page, history[id] || DATE));
      }
      if (newToday > 0) writeFileSync(join(historyDir, `${storeId}.json`), JSON.stringify(history, null, 2));

      const star2 = items.filter((x) => x.tag === 'STAR2');
      const suspect = items.filter((x) => x.tag === 'SUSPECT');
      const dropped = items.filter((x) => x.tag === 'DROP');
      const withOrders = items.filter((x) => x.orders > 0).length;
      const zeroOrders = items.length - withOrders;

      for (const it of items) allCsvRows.push({ storeId, ...it });

      storeResults.push({
        storeId, storeName, items, star2, suspect, dropped, withOrders, zeroOrders,
        newToday, pagesDone,
        totalCount, totalPage, errors, missingId,
      });

      // 验收：单店条目 >=60（店铺商品总量不足时允许低并说明）
      const available = totalCount != null ? Math.min(pagesPerStore * 40, totalCount) : pagesPerStore * 40;
      if (errors.length) {
        partialReasons.push(`${storeId}: ${errors.join('；')}`);
      } else if (totalCount === 0) {
        partialReasons.push(`${storeId}: 店铺列表为空（totalCount=0），疑似店铺页异常`);
      } else if (items.length < Math.min(PER_STORE_MIN, available)) {
        partialReasons.push(`${storeId}: 仅采集 ${items.length} 条（可用约 ${available} 条），低于 60 条验收线`);
      }
      console.error(`[store ${storeId}] 采集完成：${items.length} 条（★2=${star2.length} 疑似刷评=${suspect.length} 丢弃=${dropped.length}），本次新增 firstSeen=${newToday}`);

      // 店间隔 ≥5s
      if (i < stores.length - 1) await sleep(STORE_GAP_MS);
    }
  } finally {
    try { await relayCall('group.close', { groupId }); } catch {}
  }

  // ---- 总量验收（3 店配置 ≥180）----
  const totalItems = allCsvRows.length;
  if (stores.length >= 3 && totalItems < MIN_TOTAL_3STORE) {
    partialReasons.push(`配置 ${stores.length} 店，总条目 ${totalItems} < ${MIN_TOTAL_3STORE}，不达标`);
  }
  const status = partialReasons.length === 0 ? 'success' : totalItems > 0 ? 'partial' : 'failed';

  // ---- CSV（全量含判定标记）----
  const csvHeader = ['storeId', 'item_id', 'title', 'orders', 'feedbacks', 'feedbackRate', 'price', 'url', 'page', 'firstSeen', 'flag'];
  const csvLines = [csvHeader.join(',')];
  for (const r of allCsvRows) {
    csvLines.push([
      r.storeId, r.item_id, csvEscape(r.title), r.orders, r.feedbacks, r.feedbackRate,
      csvEscape(r.price), csvEscape(r.url), r.page, r.firstSeen, csvEscape(flagText(r.tag)),
    ].join(','));
  }
  writeFileSync(csvFile, csvLines.join('\n') + '\n');

  // ---- report-<日期>.md ----
  writeFileSync(reportFile, buildReportMd({ stores, storeResults, pagesPerStore, totalItems, partialReasons, status }));

  // ---- data.md（采集说明 + 汇总 + 全量条目） ----
  writeFileSync(dataFile, buildDataMd({ stores, storeResults, pagesPerStore, totalItems, partialReasons, status, reportFile, csvFile }));

  // ---- res.json（仅元信息，完整数据在 data.md / csv）----
  const summary = `采集 ${stores.length} 店共 ${totalItems} 条；` +
    storeResults.map((s) => `${s.storeId}:${s.items.length}条(★2=${s.star2.length}/疑=${s.suspect.length})`).join('，') +
    (partialReasons.length ? `；partial: ${partialReasons.join('；')}` : '');
  const result = {
    status,
    date: DATE,
    storeCount: stores.length,
    pagesPerStore,
    totalItems,
    perStore: storeResults.map((s) => ({
      storeId: s.storeId, name: s.storeName, items: s.items.length,
      star2: s.star2.length, suspect: s.suspect.length, dropped: s.dropped.length,
      totalCount: s.totalCount, errors: s.errors,
    })),
    partialReasons,
    summary,
  };
  writeFileSync(resultFile, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({ status, summary, output_dir: outputDir }));
}

// ===================== 报告渲染 =====================

// 店铺页 title 形如 "<店名> - <副标题> - AliExpress"，取第一个 " - " 前的店名段
function cleanStoreName(title, storeId) {
  if (!title) return storeId;
  const seg = String(title).split(/\s*[-–—|]\s*/)[0].trim();
  return seg || storeId;
}

function buildReportMd({ stores, storeResults, pagesPerStore, totalItems, partialReasons, status }) {
  const sections = [];
  for (const st of storeResults) {
    sections.push(`### ${st.storeId} — ${st.storeName || st.storeId}`);
    const pagesLabel = st.totalPage != null ? `采集 ${st.pagesDone} 页 / totalCount=${st.totalCount}（totalPage=${st.totalPage}）` : `采集 ${st.pagesDone} 页`;
    sections.push(`- ${pagesLabel} → 落库条目 ${st.items.length}（跨页去重后）`);
    sections.push(`- 有销量条目 ${st.withOrders} / ${st.items.length}；orders=0（刚上架未出单，明天再看）${st.zeroOrders} 条`);
    sections.push(`- ★★ 跟卖标的 ${st.star2.length} 条 | 疑似刷评 ${st.suspect.length} 条 | 丢弃(orders<10) ${st.dropped.length} 条`);
    if (st.newToday > 0) sections.push(`- 本次新增（firstSeen=${DATE}）${st.newToday} 个商品`);
    if (st.missingId > 0) sections.push(`- 注意：${st.missingId} 条响应缺 item_id 被跳过`);
    if (st.errors.length) sections.push(`- ⚠ 部分失败：${st.errors.join('；')}`);
    sections.push('');

    sections.push(`#### ★★ 跟卖标的 TOP（跟卖候选，按 orders 降序）`);
    sections.push(...renderItemTable([...st.star2].sort((a, b) => b.orders - a.orders)));
    sections.push('');

    sections.push('#### 疑似刷评（orders>=10 且 feedbacks > orders×10%，供人工复核）');
    sections.push(...renderItemTable([...st.suspect].sort((a, b) => b.orders - a.orders)));
    sections.push('');
  }

  const zeroStore = storeResults.filter((s) => s.totalCount != null && s.totalCount < PER_STORE_MIN);
  const acceptText = partialReasons.length === 0
    ? (zeroStore.length ? '达标（商品总量不足 2 页的店按允许低处理）' : '达标')
    : '视 partial 说明';
  let md = `# AliExpress 店铺新品监控报告 — ${DATE}\n\n`;
  md += `- 配置店铺数：${stores.length}\n`;
  md += `- 采集策略：每店店铺列表页 new_desc 排序前 ${pagesPerStore} 页（pageSize=40），mtop 结构化接口（纯本地零 token）\n`;
  md += `- 判据：★★跟卖标的 = orders>=10 且 feedbacks<=max(5, orders×10%)；疑似刷评 = orders>=10 且 feedbacks>orders×10%；orders<10 丢弃\n`;
  md += `- firstSeen：本地历史首次见到日期（累计 ${storeResults.reduce((n, s) => n + s.newToday, 0)} 个新 id 本轮首次见到）\n`;
  md += `- 验收：单店条目 >=60 → ${acceptText}；${stores.length >= 3 ? `3 店配置总条目 ${totalItems} >= ${MIN_TOTAL_3STORE} → ${totalItems >= MIN_TOTAL_3STORE ? '达标' : '不达标'}` : '单店配置总量线不适用'}\n`;
  if (zeroStore.length) md += `- 备注：${zeroStore.map((s) => `${s.storeId} 店铺商品总数 ${s.totalCount} 条（不足 2 页）`).join('；')}\n`;
  if (partialReasons.length) md += `- ⚠ partial：${partialReasons.join('；')}\n`;
  md += `\n## 分店汇总\n\n`;
  for (const st of storeResults) {
    md += `- ${st.storeId}：共 ${st.items.length} 条（含 orders=0 待观察 ${st.zeroOrders} 条）| ★★ ${st.star2.length} | 疑似刷评 ${st.suspect.length} | 丢弃 ${st.dropped.length}\n`;
  }
  md += `\n---\n\n`;
  md += sections.join('\n');
  return md;
}

function buildDataMd({ stores, storeResults, pagesPerStore, totalItems, partialReasons, status, reportFile, csvFile }) {
  const lines = [];
  lines.push(`# 采集数据 — ae-store-new-monitor · ${DATE}\n`);
  lines.push('## 采集说明\n');
  lines.push('- 通道：Extension Relay 打开店铺 all-items 页，捕获 mtop 请求模板 + cookie（各店一套）；随后 Node 端按标准 mtop 协议（md5(token&t&appKey&dataStr)）签名重放，纯本地零 token，不依赖 UI 翻页\n');
  lines.push('- 接口：`acs.aliexpress.com/h5/mtop.ae.shop.search.product.group/1.0/`，appKey 从捕获 URL 读取\n');
  lines.push('- 排序：店铺列表页 `shop_sortType=new_desc`（AE 唯一可靠的 Newest 排序，搜索结果页 new/latest 等参数被 SSR 忽略）\n');
  lines.push('- 分页：改 data.currentPage 重签请求，页间隔 ≥2s，串行；token 过期时按 set-cookie 换新后重试\n');
  lines.push('- 字段映射：item_id=item.id｜title=subject(备 seoTitle)｜orders=item.orders(0 销无此字段，缺失按 0)｜feedbacks=item.feedbacks｜price=prices.promotionPiecePrice.amount(备 promotionPiecePriceMoney/piecePriceMoney)｜url=item.pcDetailUrl 补 https:\n');
  lines.push('- 首次见到日期 firstSeen：本地历史 history/<storeId>.json 补充，本轮新增 id 自动标当天日期\n');
  lines.push('## 判定结果汇总\n');
  lines.push('| 店铺 | 店铺名 | 采集页/条目 | totalCount | ★★ 跟卖标的 | 疑似刷评 | 丢弃 orders<10 | orders=0 待观察 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const st of storeResults) {
    lines.push(`| ${st.storeId} | ${cell(st.storeName || st.storeId, 40)} | ${st.pagesDone} / ${st.items.length} | ${st.totalCount ?? ''} | ${st.star2.length} | ${st.suspect.length} | ${st.dropped.length} | ${st.zeroOrders} |`);
  }
  lines.push('');
  lines.push(`- 状态：${status === 'success' ? '成功（无 partial）' : status}；总条目 ${totalItems}；${partialReasons.length ? 'partial 说明：' + partialReasons.join('；') : '无 partial'}\n`);
  lines.push('## 全量条目（按店，含判定标记）\n');
  for (const st of storeResults) {
    lines.push(`### ${st.storeId} — ${st.storeName || st.storeId}\n`);
    lines.push('| item_id | title | orders | feedbacks | 评价率% | price | page | firstSeen | flag |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const it of st.items) {
      const flag = it.tag === 'STAR2' ? '★★跟卖标的' : it.tag === 'SUSPECT' ? '疑似刷评' : '丢弃';
      lines.push(`| ${cell(it.item_id)} | ${cell(it.title, 80)} | ${it.orders} | ${it.feedbacks} | ${it.feedbackRate} | ${cell(it.price)} | ${it.page} | ${it.firstSeen} | ${flag} |`);
    }
    lines.push('');
  }
  lines.push('## 详细分店报告\n');
  lines.push(`- ${reportFile}（每店 ★★ TOP 表含完整商品链接 + 疑似刷评表）`);
  lines.push(`- ${csvFile}（全量条目 CSV，含判定标记）\n`);
  return lines.join('\n');
}

// ===================== 入参读取 =====================

function readInput() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, 'utf8'));
  const local = join(process.cwd(), 'input.json');
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  throw new Error('缺少入参：请以 node skill.mjs <input.json> 方式传入，或在工作目录放置 input.json');
}

// stdout 只输出一行 JSON；所有日志走 stderr
main().then(
  () => {},
  (e) => {
    console.error(`[skill] 失败: ${e.message || e}`);
    console.log(JSON.stringify({ status: 'failed', summary: String(e.message || e), output_dir: null }));
    process.exit(1);
  }
);
