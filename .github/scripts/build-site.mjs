// 하입나우 상태 페이지 정적 생성기 (외부 의존성 없음, Node 20+).
// GitHub Actions 안에서 GITHUB_TOKEN으로 이슈를 읽어 _site/index.html 등을 만든다.
// 브라우저는 GitHub API를 호출하지 않는다(서버 쪽에서 미리 렌더).
//
// 실행: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node .github/scripts/build-site.mjs
// 드라이런: FIXTURE_FILE=<json> NOW=<ISO 시각> node .github/scripts/build-site.mjs  (API 호출 없음)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TZ = 'Asia/Seoul';
const SITE_NAME = '하입나우 서비스 상태';
const INTRO = '하입나우의 주요 기능이 정상인지 5분마다 확인해 보여드려요. 문제가 생기면 이곳에 상황과 해결 소식을 올려요.';
const HOME_URL = 'https://www.hypenow.io';
const CNAME = 'status.hypenow.io';
// 고객 문의 메일(나중에 바꿀 수 있게 상수로 둔다)
const SUPPORT_EMAIL = 'support@hypenow.io';
// 로고는 하입나우 프론트(celfit-front public/icon-logo-pink-star.png·main-color-text-logo.png)를 줄여 페이지에 직접 싣는다.
// 하입나우 사이트가 멈춰도 이 페이지의 로고는 보여야 하므로 다른 주소에서 불러오지 않는다.
const asset = (f) => `data:image/png;base64,${readFileSync(new URL(`./assets/${f}`, import.meta.url)).toString('base64')}`;
const LOGO_STAR = asset('logo-star.png');
const LOGO_WORDMARK = asset('logo-wordmark.png');
// 글꼴은 하입나우와 같은 조합(영문·숫자 Poppins, 한글 Noto Sans KR, 수치 Geist Mono)을 공개 CDN에서 받는다.
// 못 받으면 시스템 글꼴로 그대로 보인다(하입나우 서버에는 기대지 않는다).
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Noto+Sans+KR:wght@400;500;700&family=Poppins:wght@400;500;600;700&display=swap';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const BOT_LOGIN = 'github-actions[bot]';
const DAY = 86400000;

// ---------- 시각 ----------
const kstParts = (d) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
};
export const fmtKst = (d) => {
  const p = kstParts(new Date(d));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
export const kstDate = (d) => {
  const p = kstParts(new Date(d));
  return `${p.year}-${p.month}-${p.day}`;
};
export const fmtMinutes = (m) => {
  m = Math.max(1, Math.round(m));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}시간 ${r}분` : `${h}시간`;
  const dd = Math.floor(h / 24), hr = h % 24;
  return hr ? `${dd}일 ${hr}시간` : `${dd}일`;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// GitHub이 정화한 HTML이지만 한 겹 더 거른다.
export const cleanHtml = (h) => String(h ?? '')
  .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
  .replace(/<(script|style|iframe|object|embed)\b[^>]*>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');

// ---------- 이슈 판정 ----------
const labelNames = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
export const isBotIssue = (i) => i.user?.login === BOT_LOGIN;
// 외부인 이슈·댓글은 싣지 않는다. 팀원(OWNER/MEMBER/COLLABORATOR) 또는 Actions 봇만.
export const isTrustedIssue = (i) => !i.pull_request && (TRUSTED.has(i.author_association) || isBotIssue(i));
export const isTrustedComment = (c) => c.user?.login !== BOT_LOGIN && TRUSTED.has(c.author_association);

export const parseMaintenance = (body) => {
  const comments = [...String(body ?? '').matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  let found = null;
  for (const c of comments) {
    // 줄 맨 앞의 start:/end:만 인정(안내 문구 속 예시는 건너뛴다). 마지막 일치 블록을 쓴다.
    const s = c.match(/^[ \t]*start:[ \t]*(\S+)[ \t]*$/m);
    const e = c.match(/^[ \t]*end:[ \t]*(\S+)[ \t]*$/m);
    if (!s || !e) continue;
    const start = Date.parse(s[1]), end = Date.parse(e[1]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const x = c.match(/^[ \t]*expectedDown:[ \t]*(.*)$/m);
    const expectedDown = x ? x[1].split(',').map((v) => v.trim()).filter(Boolean) : [];
    found = { start, end, expectedDown };
  }
  return found;
};

const stripTag = (t) => String(t ?? '').replace(/^\s*\[(장애|점검|정기 점검)\]\s*/, '').trim();

const serviceOf = (issue, sites) => {
  const labels = labelNames(issue);
  const bySlug = sites.filter((s) => labels.includes(s.slug));
  if (bySlug.length) return bySlug;
  return sites.filter((s) => issue.title?.includes(s.name));
};

// ---------- 고객용 문구 ----------
// 설정 파일(.upptimerc.yml)의 name/slug는 그대로 두고, 고객에게 보일 이름·문구는 여기서 slug로 매핑한다.
export const SERVICES = {
  website: {
    name: '하입나우 접속',
    desc: '하입나우 사이트 화면이 열리는지 확인해요',
    headline: '지금 하입나우 사이트가 열리지 않아요',
    pastTitle: '하입나우 사이트가 열리지 않았어요',
    slowHeadline: '지금 하입나우 사이트가 평소보다 느려요',
    slowPastTitle: '하입나우 사이트가 느렸어요',
    summary: '하입나우 사이트가 열리지 않을 수 있어요',
    slowSummary: '하입나우 사이트가 평소보다 느리게 열릴 수 있어요',
    symptoms: ['주소를 열어도 화면이 뜨지 않거나 오류 페이지가 보여요'],
    maint: '하입나우 사이트가 잠시 열리지 않아요',
  },
  api: {
    name: '로그인·기능 이용',
    desc: '로그인하고 메뉴를 눌렀을 때 서버가 응답하는지 확인해요',
    headline: '지금 로그인과 기능 이용이 어려워요',
    pastTitle: '로그인과 기능 이용이 어려웠어요',
    slowHeadline: '지금 로그인과 기능 이용이 평소보다 느려요',
    slowPastTitle: '로그인과 기능 이용이 느렸어요',
    summary: '로그인이 되지 않거나 화면에 오류가 날 수 있어요',
    slowSummary: '로그인과 화면 이동이 평소보다 느릴 수 있어요',
    symptoms: [
      '로그인 버튼을 눌러도 넘어가지 않아요',
      '화면에 "일시적인 문제가 발생했어요"가 떠요',
      '목록이 비어 보이거나 불러오는 중에서 멈춰요',
    ],
    maint: '로그인과 기능 이용이 잠시 멈춰요',
  },
  data: {
    name: '인플루언서·콘텐츠 정보',
    desc: '찾기·랭킹·분석 화면에 정보가 불러와지는지 확인해요',
    headline: '지금 인플루언서·콘텐츠 정보를 불러오기 어려워요',
    pastTitle: '인플루언서·콘텐츠 정보를 불러오기 어려웠어요',
    slowHeadline: '지금 인플루언서·콘텐츠 정보가 평소보다 느리게 불러와져요',
    slowPastTitle: '인플루언서·콘텐츠 정보가 느리게 불러와졌어요',
    summary: '인플루언서·콘텐츠 정보가 보이지 않을 수 있어요',
    slowSummary: '인플루언서·콘텐츠 정보가 평소보다 늦게 보일 수 있어요',
    symptoms: ['찾기·랭킹 화면의 목록이 비어 보여요', '"불러오지 못했어요" 문구가 떠요'],
    maint: '인플루언서·콘텐츠 정보를 잠시 불러올 수 없어요',
  },
};
// 헤드라인 우선순위(앞쪽이 우선). 목록에 없는 slug는 뒤로.
export const SLUG_ORDER = ['website', 'api', 'data'];
export const STAGES = ['확인 중', '원인 파악', '복구 중', '해결'];
const STAGE_SENTENCE = [
  '원인을 확인하고 있어요.',
  '원인을 찾았고 고치고 있어요.',
  '원인을 찾았고 복구하고 있어요.',
  '문제가 해결됐어요. 곧 정상으로 바뀌어요.',
];
const BOT_START_TEXT = '자동 점검에서 문제를 발견해 살펴보고 있어요.';
const GROUP_WINDOW = 15 * 60000;

// api(로그인·기능 이용)가 영향에 있으면 data(정보 불러오기)는 그 증상에 포함되므로 안내 문구에서는 뺀다.
export const messageSlugs = (slugs) => (slugs.includes('api') ? slugs.filter((s) => s !== 'data') : slugs);
const slugRank = (s) => { const i = SLUG_ORDER.indexOf(s); return i < 0 ? 99 : i; };
const bySlugOrder = (a, b) => slugRank(a) - slugRank(b);
// 설정에만 있고 문구 맵에 없는 slug도 깨지지 않게 이름으로 만든 기본 문구를 쓴다.
export const svcText = (slug, sites = []) => {
  if (SERVICES[slug]) return SERVICES[slug];
  const name = sites.find((s) => s.slug === slug)?.name || slug;
  return {
    name, desc: `${name}이(가) 정상인지 확인해요`,
    headline: `지금 ${name}에 문제가 있어요`, pastTitle: `${name}에 문제가 있었어요`,
    slowHeadline: `지금 ${name}이(가) 평소보다 느려요`, slowPastTitle: `${name}이(가) 느렸어요`,
    summary: `${name}을(를) 이용하기 어려울 수 있어요`, slowSummary: `${name}이(가) 평소보다 느릴 수 있어요`,
    symptoms: [], maint: `${name}을(를) 잠시 이용할 수 없어요`,
  };
};

// ---------- 진행 단계 ----------
const STAGE_RE = /^(\s*(?:<p[^>]*>\s*)?)(확인 중|원인 파악|복구 중|해결)[ \t]*[:：][ \t]*/;
// 신뢰된 팀원 댓글 맨 앞의 "원인 파악:" 같은 접두어를 단계로 읽고 본문에서 뗀다.
export const parseStage = (html) => {
  const m = String(html ?? '').match(STAGE_RE);
  if (!m) return { stage: null, html: String(html ?? '') };
  return { stage: STAGES.indexOf(m[2]), html: String(html).replace(STAGE_RE, '$1') };
};

// 댓글(시간순)과 종료 여부로 현재 단계와 타임라인 항목을 만든다. 접두어 없는 댓글은 직전 단계 유지.
export const progressOf = (comments, closed) => {
  let cur = 0;
  const entries = comments.map((c) => {
    const p = parseStage(c.body_html);
    if (p.stage != null) cur = p.stage;
    return { stage: cur, at: Date.parse(c.created_at), html: p.html };
  });
  return { stage: closed ? 3 : cur, entries };
};

// ---------- 이슈 분류 ----------
// 같은 순간 봇 이슈가 여러 개 열리면(api가 죽으면 data도 죽는다) 고객에겐 하나의 문제로 보여준다.
// 팀원이 쓴 수동 장애는 묶지 않는다.
const mergeIncident = (items, sites) => {
  const kind = items.some((i) => i.kind === 'down') ? 'down' : 'degraded';
  const slugs = [...new Set(items.flatMap((i) => i.slugs))].sort(bySlugOrder);
  const head = [...new Set(items.filter((i) => i.kind === kind).flatMap((i) => i.slugs))].sort(bySlugOrder)[0];
  const first = items[0];
  const closedAll = items.every((i) => i.closed);
  const inc = {
    numbers: items.map((i) => i.number), bot: first.bot, kind, slugs, topSlug: head,
    created: Math.min(...items.map((i) => i.created)),
    closed: closedAll ? Math.max(...items.map((i) => i.closed)) : null,
    bodyHtml: first.bodyHtml,
  };
  if (first.bot) {
    const t = head ? svcText(head, sites) : null;
    inc.title = t ? (kind === 'down' ? t.headline : t.slowHeadline) : '지금 일부 기능에 문제가 있어요';
    inc.pastTitle = t ? (kind === 'down' ? t.pastTitle : t.slowPastTitle) : '일부 기능에 문제가 있었어요';
  } else {
    inc.title = inc.pastTitle = first.title;
  }
  return inc;
};
export const groupIncidents = (items, sites = []) => {
  const bots = items.filter((i) => i.bot).sort((a, b) => a.created - b.created);
  const groups = [];
  let cur = null;
  for (const b of bots) {
    if (cur && b.created - cur.start <= GROUP_WINDOW) cur.items.push(b);
    else { cur = { start: b.created, items: [b] }; groups.push(cur); }
  }
  return [...groups.map((g) => mergeIncident(g.items, sites)), ...items.filter((i) => !i.bot).map((i) => mergeIncident([i], sites))];
};

export const classify = (issues, sites, nowMs) => {
  const activeItems = [], pastItems = [], maintenance = [];
  for (const i of issues) {
    if (!isTrustedIssue(i)) continue;
    const labels = labelNames(i);
    const created = Date.parse(i.created_at);
    if (labels.includes('maintenance')) {
      if (i.state !== 'open') continue;
      const m = parseMaintenance(i.body);
      if (!m || nowMs >= m.end) continue;
      maintenance.push({
        number: i.number, title: stripTag(i.title), bodyHtml: i.body_html, ...m,
        ongoing: nowMs >= m.start,
      });
      continue;
    }
    if (!labels.includes('status')) continue;
    const bot = isBotIssue(i);
    const slugs = serviceOf(i, sites).map((s) => s.slug);
    const item = {
      number: i.number, title: stripTag(i.title), bodyHtml: i.body_html, bot, created,
      kind: bot && /🟨|degraded/i.test(i.title) ? 'degraded' : 'down', slugs,
      closed: i.closed_at ? Date.parse(i.closed_at) : null,
    };
    if (i.state === 'open') activeItems.push(item);
    else if (item.closed && nowMs - item.closed <= 30 * DAY) pastItems.push(item);
  }
  const active = groupIncidents(activeItems, sites).sort((a, b) => a.created - b.created);
  const past = groupIncidents(pastItems, sites).sort((a, b) => b.closed - a.closed);
  maintenance.sort((a, b) => a.start - b.start);
  return { active, past, maintenance };
};

// ---------- 데이터 읽기 ----------
const readConfigSites = (root) => {
  // .upptimerc.yml의 sites 순서·이름(name/slug)만 읽는다. 별도 YAML 라이브러리 없이 처리.
  const txt = readFileSync(join(root, '.upptimerc.yml'), 'utf8');
  const block = txt.split(/^sites:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const sites = [];
  let cur = null;
  for (const line of block.split('\n')) {
    const n = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (n) { cur = { name: n[1].replace(/^['"]|['"]$/g, '') }; sites.push(cur); continue; }
    const s = line.match(/^\s+slug:\s*(.+?)\s*$/);
    if (s && cur) cur.slug = s[1].replace(/^['"]|['"]$/g, '');
  }
  return sites.filter((s) => s.slug);
};

const readHistoryMeta = (root, slug) => {
  const p = join(root, 'history', `${slug}.yml`);
  if (!existsSync(p)) return {};
  const t = readFileSync(p, 'utf8');
  return {
    startTime: t.match(/^startTime:\s*(\S+)/m)?.[1],
    lastUpdated: t.match(/^lastUpdated:\s*(\S+)/m)?.[1],
  };
};

const api = async (path, token, retries = 3) => {
  let last;
  for (let n = 0; n < retries; n++) {
    try {
      const r = await fetch(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github.html+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'hypenow-status-site-builder',
        },
      });
      if (!r.ok) throw new Error(`GitHub API ${r.status} ${path}`);
      return await r.json();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 1500 * (n + 1))); }
  }
  throw last;
};
const apiAll = async (path, token) => {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const rows = await api(`${path}${sep}per_page=100&page=${page}`, token);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
};

// 마지막 점검 시각: history/*.yml의 lastUpdated는 상태가 바뀔 때만 갱신되므로,
// 가장 최근에 성공한 Uptime CI 실행 시각을 쓴다(실패하면 호출자가 폴백).
const lastCheckFromRuns = async () => {
  if (process.env.FIXTURE_FILE) return null;
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'subtle-madness/hypenow-status';
    const r = await api(`/repos/${repo}/actions/workflows/uptime.yml/runs?status=success&per_page=1`, process.env.GITHUB_TOKEN, 1);
    const t = Date.parse(r.workflow_runs?.[0]?.updated_at);
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
};

// 조직 멤버십을 비공개로 둔 팀원은 Actions 토큰에 MEMBER가 아니라 CONTRIBUTOR/NONE으로 보인다.
// 그래서 소속 표시로 못 믿는 작성자는 저장소 쓰기 권한을 직접 물어 확인하고, 확인되면 COLLABORATOR로 고쳐 둔다.
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const permissionChecker = (repo, token) => {
  const cache = new Map();
  return async (items) => {
    for (const it of items) {
      const login = it.user?.login;
      if (!login || login === BOT_LOGIN || TRUSTED.has(it.author_association)) continue;
      if (!cache.has(login)) {
        let ok = false;
        try {
          const r = await api(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, token, 1);
          ok = WRITE_PERMISSIONS.has(r.permission);
        } catch { ok = false; }
        cache.set(login, ok);
      }
      if (cache.get(login)) it.author_association = 'COLLABORATOR';
    }
  };
};

const loadIssues = async (nowMs) => {
  if (process.env.FIXTURE_FILE) {
    const f = JSON.parse(readFileSync(process.env.FIXTURE_FILE, 'utf8'));
    return { issues: [...(f.open || []), ...(f.closed || [])], comments: f.comments || {} };
  }
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'subtle-madness/hypenow-status';
  if (!token) throw new Error('GITHUB_TOKEN이 필요해요');
  const since = new Date(nowMs - 35 * DAY).toISOString();
  const open = await apiAll(`/repos/${repo}/issues?state=open`, token);
  const closed = await apiAll(`/repos/${repo}/issues?state=closed&since=${since}`, token);
  const trustByPermission = permissionChecker(repo, token);
  await trustByPermission([...open, ...closed]);
  // 열린 장애 공지의 댓글만 가져온다(사람 댓글만 쓴다). 자동 장애 공지에 팀원이 단 소식도 싣는다.
  const comments = {};
  for (const i of open) {
    if (!isTrustedIssue(i) || !labelNames(i).includes('status')) continue;
    comments[i.number] = await apiAll(`/repos/${repo}/issues/${i.number}/comments`, token);
    await trustByPermission(comments[i.number]);
  }
  return { issues: [...open, ...closed], comments, repo };
};

// ---------- 표시용 시각·숫자 ----------
export const fmtHm = (d) => { const p = kstParts(new Date(d)); return `${p.hour}:${p.minute}`; };
export const fmtMd = (d) => { const p = kstParts(new Date(d)); return `${Number(p.month)}월 ${Number(p.day)}일`; };
const WEEKDAY = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, weekday: 'short' });
const fmtMdW = (d) => `${fmtMd(d)}(${WEEKDAY.format(new Date(d))})`;
// 오늘이면 "22:52", 아니면 "11월 9일 22:52"
export const fmtWhen = (d, nowMs) => (kstDate(d) === kstDate(nowMs) ? fmtHm(d) : `${fmtMd(d)} ${fmtHm(d)}`);
const dayWord = (h) => (h < 6 ? '새벽' : h < 12 ? '오전' : h < 18 ? '오후' : h < 21 ? '저녁' : '밤');

// 소수 최대 2자리, 100이면 "100". 반올림으로 100이 되지 않게 내림한다.
export const fmtPct = (p) => {
  if (p >= 100) return '100';
  const v = Math.min(99.99, Math.floor(p * 100) / 100);
  return String(Number(v.toFixed(2)));
};

// 최근 90일 막대 집계: 기록 시작 전 날은 none, 장애 분이 있던 날 down, 오늘 느림이면 degraded.
export const aggregate90 = (daily, startTime, nowMs, todayDegraded = false) => {
  const startMs = Date.parse(startTime);
  const startDate = Number.isNaN(startMs) ? null : kstDate(startMs);
  const cells = [];
  let downMin = 0;
  for (let k = 89; k >= 0; k--) {
    const d = kstDate(nowMs - k * DAY);
    const md = `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
    let cls = 'none', tip = `${md} 기록 없음`;
    if (startDate && d >= startDate) {
      const mins = daily?.[d] || 0;
      downMin += mins;
      if (mins > 0) { cls = 'bad'; tip = `${md} 문제 ${fmtMinutes(mins)}`; }
      else if (k === 0 && todayDegraded) { cls = 'warn'; tip = `${md} 느림`; }
      else { cls = 'ok'; tip = `${md} 정상`; }
    }
    cells.push({ cls, tip });
  }
  let pct = null;
  if (startDate) {
    const from = Math.max(startMs, nowMs - 90 * DAY);
    const total = (nowMs - from) / 60000;
    if (total >= 1) pct = Math.max(0, Math.min(100, 100 * (1 - downMin / total)));
  }
  return { cells, pct };
};

const stripHtml = (h) => String(h ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

// 맨 위 큰 카드. 우선순위: 진행 중 장애 > 점검 진행 중 > 응답 느림 > 7일 내 예정 점검 > 정상
export const buildHero = ({ incidents, maintenance, nowMs, progress = {}, sites = [] }) => {
  const stageOf = (inc) => progress[inc.numbers.join(',')]?.stage ?? 0;
  const down = incidents.filter((i) => i.kind === 'down');
  if (down.length) {
    const inc = down[0];
    const t = inc.topSlug ? svcText(inc.topSlug, sites) : null;
    const sum = t ? t.summary : '일부 기능을 이용하기 어려울 수 있어요';
    const when = inc.created != null ? `${fmtWhen(inc.created, nowMs)}부터 ` : '';
    return { cls: 'bad', title: inc.title, desc: `${when}${sum}. ${STAGE_SENTENCE[stageOf(inc)]}` };
  }
  const maintText = (m) => {
    const lines = messageSlugs(m.expectedDown).map((s) => svcText(s, sites).maint);
    return lines.length ? lines.join('. ') : '일부 기능을 이용하기 어려울 수 있어요';
  };
  const ongoing = maintenance.find((m) => m.ongoing);
  if (ongoing) {
    return { cls: 'info', title: '지금 점검 중이에요',
      desc: `${fmtWhen(ongoing.end, nowMs)}까지 ${maintText(ongoing)}.` };
  }
  const slow = incidents[0];
  if (slow) {
    const t = slow.topSlug ? svcText(slow.topSlug, sites) : null;
    const when = slow.created != null ? `${fmtWhen(slow.created, nowMs)}부터 ` : '';
    return { cls: 'warn', title: slow.title,
      desc: `${when}${t ? t.slowSummary : '일부 기능이 평소보다 느릴 수 있어요'}. ${STAGE_SENTENCE[stageOf(slow)]}` };
  }
  const next = maintenance.find((m) => !m.ongoing && m.start - nowMs <= 7 * DAY);
  if (next) {
    const dd = kstDate(next.start);
    const day = dd === kstDate(nowMs) ? '오늘' : dd === kstDate(nowMs + DAY) ? '내일' : fmtMd(next.start);
    const word = dayWord(Number(fmtHm(next.start).slice(0, 2)));
    const range = `${fmtHm(next.start)} ~ ${kstDate(next.end) === dd ? '' : fmtMd(next.end) + ' '}${fmtHm(next.end)}`;
    return { cls: 'info', title: `${day} ${word}에 점검이 있어요`,
      desc: `${range} 동안 ${maintText(next)}. 지금은 모든 기능이 정상이에요.` };
  }
  return { cls: 'ok', title: '모든 기능이 정상이에요', desc: '하입나우를 평소처럼 이용할 수 있어요.' };
};

const SVC_LABEL = { up: '정상', degraded: '느림', down: '문제 있음', maint: '점검 중' };
const SVC_DOT = { up: 'ok', degraded: 'warn', down: 'bad', maint: 'info' };

// 상태 아이콘(하입나우 화면이 쓰는 lucide 계열 선 굵기에 맞춘 단순 SVG). 색은 CSS currentColor로 준다.
const ALERT = '<path d="M10 5.6v5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.25" fill="#fff"/>';
const ICON_BODY = {
  ok: '<path d="M6.1 10.3l2.6 2.6 5.2-5.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  bad: ALERT,
  warn: ALERT,
  info: '<path d="M10 5.9V10l2.7 1.7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (cls) => `<svg class="ic ${cls}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="currentColor"/>${ICON_BODY[cls]}</svg>`;
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const render = ({ sites, summary, metas, data, comments, nowMs, lastCheckMs }) => {
  const bySlug = Object.fromEntries(summary.map((s) => [s.slug, s]));
  const ongoingMaint = data.maintenance.filter((m) => m.ongoing);
  const maintDown = new Set(ongoingMaint.flatMap((m) => m.expectedDown));

  // 점검 중인 기능에서 난 장애는 장애로 따로 알리지 않는다.
  let incidents = data.active.filter((i) => !(i.slugs.length && i.slugs.every((s) => maintDown.has(s))));
  // 자동 점검은 실패했는데 장애 이슈가 아직 열리기 전이면 화면에는 먼저 알린다.
  const covered = new Set(incidents.flatMap((i) => i.slugs));
  const uncovered = sites.filter((s) => {
    const st = bySlug[s.slug]?.status;
    return (st === 'down' || st === 'degraded') && !covered.has(s.slug) && !maintDown.has(s.slug);
  });
  if (uncovered.length) {
    const kind = uncovered.some((s) => bySlug[s.slug].status === 'down') ? 'down' : 'degraded';
    const slugs = uncovered.map((s) => s.slug).sort(bySlugOrder);
    const top = uncovered.filter((s) => bySlug[s.slug].status === kind).map((s) => s.slug).sort(bySlugOrder)[0];
    const t = svcText(top, sites);
    incidents = [...incidents, { numbers: [], bot: true, kind, slugs, topSlug: top, created: null, closed: null,
      title: kind === 'down' ? t.headline : t.slowHeadline, synthetic: true }];
  }

  const progress = {};
  const views = incidents.map((inc) => {
    const cs = inc.numbers.flatMap((n) => comments[n] || []).filter(isTrustedComment)
      .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
    const pr = progressOf(cs, false);
    progress[inc.numbers.join(',')] = pr;
    return { inc, pr };
  });
  const hero = buildHero({ incidents, maintenance: data.maintenance, nowMs, progress, sites });

  const rows = sites.map((s) => {
    const sum = bySlug[s.slug] || {};
    let st = sum.status === 'down' ? 'down' : sum.status === 'degraded' ? 'degraded' : 'up';
    for (const { inc } of views) {
      if (inc.slugs.includes(s.slug) && (inc.kind === 'down' || st === 'up')) st = inc.kind;
    }
    if (maintDown.has(s.slug)) st = 'maint';
    return { site: s, sum, st };
  });

  // 카드 안의 한 줄: 왼쪽 이름표, 오른쪽 내용(좁은 화면에서는 위아래로 쌓인다)
  const field = (label, inner) => `<div class="field"><div class="lbl">${esc(label)}</div><div class="val">${inner}</div></div>`;
  const list = (items) => `<ul class="list">${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;

  const maintCard = (m) => {
    const sameDay = kstDate(m.start) === kstDate(m.end);
    const when = `${fmtMdW(m.start)} ${fmtHm(m.start)} ~ ${sameDay ? '' : fmtMdW(m.end) + ' '}${fmtHm(m.end)}`;
    const dur = `약 ${fmtMinutes((m.end - m.start) / 60000)}`;
    const items = messageSlugs(m.expectedDown).map((s) => svcText(s, sites).maint);
    const extra = stripHtml(m.bodyHtml) ? `<div class="prose">${cleanHtml(m.bodyHtml)}</div>` : '';
    const inner = (items.length ? list(items) : '') + extra;
    return `<article class="card mt">
<div class="card-h"><h3>${esc(m.title)}</h3><span class="pill info">${m.ongoing ? '점검 중' : '예정'}</span></div>
${field('언제', `<span class="when">${esc(when)}</span><span class="dur">${esc(dur)}</span>`)}
${inner ? field('이 시간에는', inner) : ''}
</article>`;
  };
  const section = (title, body, meta = '') => `<section class="sec">
<div class="sec-h"><h2>${esc(title)}</h2>${meta ? `<span class="sec-m">${esc(meta)}</span>` : ''}</div>
${body}
</section>`;
  const maintSection = (list2, h) => (list2.length ? section(h, list2.map(maintCard).join('\n')) : '');

  const incidentCard = ({ inc, pr }) => {
    const color = inc.kind === 'down' ? 'bad' : 'warn';
    const stage = pr.stage;
    const steps = STAGES.map((n, k) => `<li class="${[k <= stage ? 'done' : '', k === stage ? 'now' : ''].filter(Boolean).join(' ')}">${n}</li>`).join('');
    const symptoms = inc.kind === 'down' ? [...new Set(messageSlugs(inc.slugs).flatMap((s) => svcText(s, sites).symptoms))] : [];
    const entry = (cur, st, at, html) => `<li${cur ? ' class="cur"' : ''}><div class="tl-h"><b>${st}</b>${at}</div><div class="tx">${html}</div></li>`;
    const tl = pr.entries.slice().reverse().map((e, k) => entry(k === 0, STAGES[e.stage], `<time>${esc(fmtWhen(e.at, nowMs))}</time>`, cleanHtml(e.html)));
    const startText = inc.bot ? `<p>${esc(BOT_START_TEXT)}</p>` : cleanHtml(inc.bodyHtml);
    const startAt = inc.created != null ? `<time>${esc(fmtWhen(inc.created, nowMs))}</time>` : '';
    tl.push(entry(!pr.entries.length, '확인 중', startAt, startText));
    return `<article class="card inc ${color}">
<div class="card-h"><h3>${esc(inc.title.replace(/^지금 /, ''))}</h3><span class="pill ${stage === 3 ? 'ok' : color}">${STAGES[stage]}</span></div>
<ol class="steps" aria-label="진행 단계">${steps}</ol>
${symptoms.length ? field('이렇게 보일 수 있어요', list(symptoms)) : ''}
${field('진행 소식', `<ol class="tl">${tl.join('\n')}</ol>`)}
</article>`;
  };

  const svcRows = rows.map(({ site, sum, st }) => {
    const t = svcText(site.slug, sites);
    const { cells, pct } = aggregate90(sum.dailyMinutesDown, metas[site.slug]?.startTime, nowMs, st === 'degraded');
    // 막대에 올리면 날짜·장애 시간을 보여 준다(CSS 말풍선, 스크립트 없음)
    const bars = cells.map((c) => `<span class="${c.cls}" data-tip="${esc(c.tip)}"></span>`).join('');
    const mid = pct == null ? '기록 없음' : `최근 90일 ${fmtPct(pct)}% 정상`;
    const cls = SVC_DOT[st];
    return `<div class="svc">
<div class="svc-h">${icon(cls)}<div class="svc-n"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div><span class="st ${cls}">${SVC_LABEL[st]}</span></div>
<div class="bars" role="img" aria-label="최근 90일 상태">${bars}</div>
<div class="axis"><span>90일 전</span><span class="up">${esc(mid)}</span><span>오늘</span></div>
</div>`;
  }).join('\n');

  const pastHtml = data.past.length
    ? `<ul class="past">${data.past.map((p) => `<li>${icon('ok')}<div><b>${esc(p.pastTitle)}</b><span>${esc(fmtMd(p.created))} ${esc(fmtHm(p.created))} · ${esc(fmtMinutes((p.closed - p.created) / 60000))} 만에 해결</span></div></li>`).join('\n')}</ul>`
    : '<p class="empty">최근 30일 동안 문제가 없었어요.</p>';

  // 색·글꼴·모서리·테두리는 하입나우 프론트(celfit-front src/app/globals.css, components/ui/*)의 값을 그대로 쓴다.
  const css = `
:root{--hn-50:#fdeef6;--hn-400:#ec4899;--hn-500:#d61f7f;
--s900:#0f172a;--s800:#1e293b;--s700:#334155;--s600:#475569;--s500:#64748b;--s400:#94a3b8;--s300:#cbd5e1;--s200:#e2e8f0;--s100:#f1f5f9;--s50:#f8fafc;
--ok:#10b981;--ok-bar:#34d399;--ok-t:#059669;--ok-50:#ecfdf5;--bad:#f43f5e;--bad-t:#e11d48;--bad-50:#fff1f2;
--warn:#f59e0b;--warn-t:#d97706;--warn-50:#fffbeb;--info:#0ea5e9;--info-t:#0284c7;--info-50:#f0f9ff;
--sans:"Poppins","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
--mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:#fff;color:var(--s900);font:400 14px/1.6 var(--sans);-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}
a{color:inherit}
.wrap{max-width:768px;margin:0 auto;padding:0 20px}
.top{position:relative;border-bottom:1px solid var(--s200)}
.top:before{content:"";position:absolute;inset:0;background-image:radial-gradient(circle,rgba(15,23,42,.08) 1px,transparent 1px);background-size:22px 22px;-webkit-mask-image:linear-gradient(#000,transparent 85%);mask-image:linear-gradient(#000,transparent 85%);pointer-events:none}
.top>*{position:relative}
.nav{display:flex;align-items:center;justify-content:space-between;gap:12px;height:64px}
.brand{display:flex;align-items:center;gap:6px;text-decoration:none;min-width:0}
.brand img{display:block;height:28px;width:auto}
.brand .sfx{margin-left:6px;padding-left:10px;border-left:1px solid var(--s200);font-size:14px;font-weight:600;color:var(--s500);white-space:nowrap;line-height:20px}
.back{display:inline-flex;align-items:center;gap:2px;font-size:14px;font-weight:500;color:var(--s700);text-decoration:none;white-space:nowrap}
.back:hover{color:var(--hn-500)}
.chev{width:16px;height:16px}
.back .long{margin-right:.3em}
.hero{padding:40px 0 36px}
.hero-t{display:flex;gap:16px;align-items:center}
.hero .ic{width:28px;height:28px;border-radius:50%}
.hero.ok .ic{box-shadow:0 0 0 6px var(--ok-50)}.hero.bad .ic{box-shadow:0 0 0 6px var(--bad-50)}.hero.warn .ic{box-shadow:0 0 0 6px var(--warn-50)}.hero.info .ic{box-shadow:0 0 0 6px var(--info-50)}
.hero h1{margin:0;font-size:26px;line-height:1.35;font-weight:700;letter-spacing:-.01em}
.hero p{margin:8px 0 0 44px;font-size:15px;line-height:1.65;color:var(--s600);max-width:600px}
.hero .meta{margin-top:14px;font-size:13px;color:var(--s400)}
.ic{flex:none;display:block;width:18px;height:18px}
.ic.ok{color:var(--ok)}.ic.bad{color:var(--bad)}.ic.warn{color:var(--warn)}.ic.info{color:var(--info)}
main{padding-bottom:8px}
.sec{margin-top:36px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.sec h2{margin:0;font-size:16px;font-weight:700;line-height:1.4}
.sec-m{font-size:13px;color:var(--s400)}
.card{background:#fff;border:1px solid var(--s200);border-radius:12px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.card+.card{margin-top:12px}
.card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px 0}
.card-h h3{margin:0;font-size:17px;font-weight:700;line-height:1.45}
.mt .card-h{padding-bottom:16px}
.pill{flex:none;margin-top:2px;font-size:12px;font-weight:500;line-height:18px;padding:2px 10px;border-radius:999px;white-space:nowrap}
.pill.bad{background:var(--bad-50);color:var(--bad-t)}.pill.ok{background:var(--ok-50);color:var(--ok-t)}.pill.warn{background:var(--warn-50);color:var(--warn-t)}.pill.info{background:var(--info-50);color:var(--info-t)}
.inc{--c:var(--bad)}.inc.warn{--c:var(--warn)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;list-style:none;margin:16px 20px 18px;padding:0}
.steps li{padding-top:8px;border-top:3px solid var(--s100);font-size:12px;line-height:1.4;color:var(--s400)}
.steps li.done{border-top-color:var(--c);color:var(--s700)}
.steps li.now{color:var(--c);font-weight:600}
.field{display:grid;grid-template-columns:148px 1fr;gap:16px;padding:16px 20px;border-top:1px solid var(--s100)}
.lbl{font-size:13px;font-weight:500;color:var(--s500);line-height:22px}
.val{min-width:0;font-size:14px;line-height:22px;color:var(--s800)}
.when{font-weight:500}.dur{margin-left:8px;color:var(--s500)}
.list{margin:0;padding:0;list-style:none}
.list li{position:relative;padding-left:14px}
.list li+li{margin-top:4px}
.list li:before{content:"";position:absolute;left:2px;top:10px;width:4px;height:4px;border-radius:50%;background:var(--s300)}
.prose{color:var(--s600)}
.list+.prose{margin-top:8px}
.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}
.prose img,.tx img{max-width:100%;height:auto}
.prose pre,.tx pre{overflow:auto;background:var(--s50);padding:8px;border-radius:8px}
.tl{margin:0;padding:0;list-style:none}
.tl li{position:relative;padding:0 0 16px 18px}
.tl li:last-child{padding-bottom:0}
.tl li:before{content:"";position:absolute;left:0;top:8px;width:7px;height:7px;border-radius:50%;background:var(--s300)}
.tl li:after{content:"";position:absolute;left:3px;top:20px;bottom:2px;width:1px;background:var(--s200)}
.tl li:last-child:after{display:none}
.tl li.cur:before{background:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 18%,transparent)}
.tl-h{display:flex;align-items:baseline;gap:8px}
.tl-h b{font-weight:600;color:var(--s900)}
.tl li.cur .tl-h b{color:var(--c)}
time{font-family:var(--mono);font-size:12px;color:var(--s400)}
.tx{color:var(--s600);margin-top:2px}.tx p{margin:0 0 4px}.tx>:last-child{margin-bottom:0}
.svc{padding:18px 20px 16px}
.svc+.svc{border-top:1px solid var(--s100)}
.svc-h{display:flex;align-items:flex-start;gap:10px}
.svc-h .ic{margin-top:2px}
.svc-n{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;column-gap:10px}
.svc-n b{font-size:15px;font-weight:600;line-height:22px}
.svc-n span{font-size:13px;color:var(--s500);line-height:20px}
.st{flex:none;font-size:13px;font-weight:600;line-height:22px}
.st.ok{color:var(--ok-t)}.st.bad{color:var(--bad-t)}.st.warn{color:var(--warn-t)}.st.info{color:var(--info-t)}
.bars{display:flex;gap:2px;height:26px;margin-top:14px}
.bars span{position:relative;flex:1;min-width:0;border-radius:2px;background:var(--ok-bar)}
.bars span.none{background:var(--s100)}.bars span.bad{background:var(--bad)}.bars span.warn{background:var(--warn)}
.bars span:hover{filter:brightness(.88)}
.bars span:hover:after{content:attr(data-tip);position:absolute;z-index:2;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);padding:5px 9px;border-radius:6px;background:var(--s900);color:#fff;font-size:12px;font-weight:500;line-height:1.4;white-space:nowrap;pointer-events:none}
.bars span:nth-child(-n+15):hover:after{left:0;transform:none}
.bars span:nth-last-child(-n+15):hover:after{left:auto;right:0;transform:none}
.axis{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:12px;color:var(--s400)}
.axis .up{color:var(--s600);font-weight:500}
.past{margin:0;padding:0 20px;list-style:none;border:1px solid var(--s200);border-radius:12px}
.past li{display:flex;gap:10px;padding:14px 0}
.past li+li{border-top:1px solid var(--s100)}
.past .ic{margin-top:2px;width:16px;height:16px}
.past b{display:block;font-weight:500;line-height:20px}
.past span{display:block;font-size:12px;color:var(--s400);margin-top:2px}
.empty{margin:0;padding:16px 20px;border:1px solid var(--s200);border-radius:12px;color:var(--s500)}
.help{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:40px;padding:18px 20px;border-radius:12px;background:var(--s50)}
.help p{margin:0;color:var(--s700)}
.help p a{font-weight:600;color:var(--s900);text-decoration:none;border-bottom:1px solid var(--s300)}
.btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;background:var(--hn-400);color:#fff;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--hn-500)}
footer{margin-top:28px;padding:18px 0 40px;border-top:1px solid var(--s100);font-size:12px;color:var(--s400);line-height:1.7}
@media (max-width:560px){
.wrap{padding:0 16px}
.nav{height:56px}
.brand img{height:22px}
.brand .sfx{font-size:13px;margin-left:4px;padding-left:8px}
.back{font-size:13px}
.back .long{display:none}
.hero{padding:28px 0 26px}
.hero-t{gap:12px}
.hero .ic{width:24px;height:24px}
.hero h1{font-size:20px}
.hero p{margin-left:0;font-size:14px}
.hero p.meta{margin-top:12px}
.sec{margin-top:30px}
.card-h{padding:16px 16px 0}
.card-h h3{font-size:16px}
.steps{margin:14px 16px 16px}
.field{grid-template-columns:1fr;gap:6px;padding:14px 16px}
.lbl{line-height:20px}
.svc{padding:16px}
.svc-n{display:block}
.svc-n span{display:block}
.bars{gap:1px;height:24px}
.bars span{border-radius:1px}
.bars span:nth-child(-n+30):hover:after{left:0;transform:none}
.bars span:nth-last-child(-n+30):hover:after{left:auto;right:0;transform:none}
.past{padding:0 16px}
.empty{padding:14px 16px}
.help{flex-direction:column;align-items:stretch;padding:16px}
}`;

  const incidentSection = views.length ? section('진행 중인 문제', views.map(incidentCard).join('\n')) : '';
  const sections = [
    maintSection(data.maintenance.filter((m) => m.ongoing), '진행 중인 점검'),
    incidentSection,
    maintSection(data.maintenance.filter((m) => !m.ongoing), '예정된 점검'),
    section('기능별 상태', `<div class="card">${svcRows}</div>`),
    section('지난 문제', pastHtml, '최근 30일'),
  ].filter(Boolean).join('\n');
  const mail = `mailto:${SUPPORT_EMAIL}`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<meta name="theme-color" content="#ffffff">
<meta name="description" content="${esc(INTRO)}">
<title>${esc(SITE_NAME)}</title>
<link rel="icon" type="image/png" href="${LOGO_STAR}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_CSS}">
<style>${css}</style>
</head>
<body>
<div class="top">
<div class="wrap">
<header class="nav"><a class="brand" href="${HOME_URL}" aria-label="하입나우 홈"><img src="${LOGO_STAR}" alt="" width="28" height="28"><img src="${LOGO_WORDMARK}" alt="hypenow" width="101" height="28"><span class="sfx">서비스 상태</span></a><a class="back" href="${HOME_URL}"><span class="long">하입나우로</span>돌아가기${CHEVRON}</a></header>
<div class="hero ${hero.cls}" role="status"><div class="hero-t">${icon(hero.cls)}<h1>${esc(hero.title)}</h1></div><p>${esc(hero.desc)}</p><p class="meta">마지막 확인 ${esc(fmtHm(lastCheckMs))} · 5분마다 자동으로 확인해요</p></div>
</div>
</div>
<main class="wrap">
${sections}
<div class="help"><p>문제가 계속되거나 여기 없는 문제를 겪고 있다면 <a href="${mail}">${esc(SUPPORT_EMAIL)}</a>로 알려 주세요.</p><a class="btn" href="${mail}">메일 보내기</a></div>
<footer>이 페이지는 하입나우 서버와 따로 운영돼요. 하입나우가 멈춰도 이곳은 열려요.</footer>
</main>
</body>
</html>
`;
};

// ---------- 실행 ----------
export const build = async ({ root = process.cwd(), out = join(process.cwd(), '_site') } = {}) => {
  const nowMs = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
  const sites = readConfigSites(root);
  const summary = JSON.parse(readFileSync(join(root, 'history', 'summary.json'), 'utf8'));
  const metas = Object.fromEntries(sites.map((s) => [s.slug, readHistoryMeta(root, s.slug)]));
  const lasts = Object.values(metas).map((m) => Date.parse(m.lastUpdated)).filter((n) => !Number.isNaN(n));
  // 점검 실행이 끝나며 부른 경우 그 점검 시각을 받는다(그 실행은 아직 성공 목록에 없다)
  const checkedAt = Date.parse(process.env.CHECKED_AT || '');
  const fromRuns = await lastCheckFromRuns();
  const lastCheckMs = Math.max(Number.isNaN(checkedAt) ? 0 : checkedAt, fromRuns ?? 0)
    || (lasts.length ? Math.max(...lasts) : nowMs);
  const { issues, comments } = await loadIssues(nowMs);
  const data = classify(issues, sites, nowMs);
  const html = render({ sites, summary, metas, data, comments, nowMs, lastCheckMs });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, 'CNAME'), `${CNAME}\n`);
  writeFileSync(join(out, '.nojekyll'), '');
  return { html, data };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().then(({ data }) => {
    console.log(`생성 완료: 진행 중 문제 ${data.active.length}, 지난 문제 ${data.past.length}, 점검 ${data.maintenance.length}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
