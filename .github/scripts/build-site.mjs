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
const LOGO = 'https://www.hypenow.io/android-chrome-192x192.png';
const HOME_URL = 'https://www.hypenow.io';
const CNAME = 'status.hypenow.io';
// 고객 문의 창구(나중에 바꿀 수 있게 상수로 둔다)
const HELP_URL = 'https://www.hypenow.io/cs-inquiry';
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
    const lines = m.expectedDown.map((s) => svcText(s, sites).maint);
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

  const box = (label, inner) => `<div class="box"><b>${esc(label)}</b>${inner}</div>`;

  const maintCard = (m) => {
    const sameDay = kstDate(m.start) === kstDate(m.end);
    const when = `${fmtMdW(m.start)} ${fmtHm(m.start)} ~ ${sameDay ? '' : fmtMdW(m.end) + ' '}${fmtHm(m.end)} · 약 ${fmtMinutes((m.end - m.start) / 60000)}`;
    const items = m.expectedDown.map((s) => `<li>${esc(svcText(s, sites).maint)}</li>`).join('');
    const extra = stripHtml(m.bodyHtml) ? `<div class="prose">${cleanHtml(m.bodyHtml)}</div>` : '';
    const inner = (items ? `<ul>${items}</ul>` : '') + extra;
    return `<div class="card inc">
<div class="top"><h3>${esc(m.title)}</h3><span class="pill info">${m.ongoing ? '점검 중' : '예정'}</span></div>
${box('언제', esc(when))}
${inner ? box('이 시간에는', inner) : ''}
</div>`;
  };
  const maintSection = (list, h) => (list.length ? `<h2>${h}</h2>\n${list.map(maintCard).join('\n')}` : '');

  const incidentCard = ({ inc, pr }) => {
    const color = inc.kind === 'down' ? 'bad' : 'warn';
    const stage = pr.stage;
    const steps = STAGES.map((n, k) => `<div class="step${k <= stage ? ' done' : ''}${k === stage ? ' now' : ''}"><i></i>${n}</div>`).join('');
    const symptoms = inc.kind === 'down' ? [...new Set(inc.slugs.flatMap((s) => svcText(s, sites).symptoms))] : [];
    const tl = pr.entries.slice().reverse().map((e, k) => `<li${k === 0 ? ' class="cur"' : ''}><span class="s">${STAGES[e.stage]}</span><span class="t">${esc(fmtWhen(e.at, nowMs))}</span><div class="tx">${cleanHtml(e.html)}</div></li>`);
    const startText = inc.bot ? `<p>${esc(BOT_START_TEXT)}</p>` : cleanHtml(inc.bodyHtml);
    const startAt = inc.created != null ? `<span class="t">${esc(fmtWhen(inc.created, nowMs))}</span>` : '';
    tl.push(`<li${pr.entries.length ? '' : ' class="cur"'}><span class="s">확인 중</span>${startAt}<div class="tx">${startText}</div></li>`);
    return `<div class="card inc ${color}">
<div class="top"><h3>${esc(inc.title.replace(/^지금 /, ''))}</h3><span class="pill ${stage === 3 ? 'ok' : color}">${STAGES[stage]}</span></div>
<div class="steps">${steps}</div>
${symptoms.length ? box('이렇게 보일 수 있어요', `<ul>${symptoms.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`) : ''}
<ul class="tl">${tl.join('\n')}</ul>
</div>`;
  };

  const svcRows = rows.map(({ site, sum, st }, idx) => {
    const t = svcText(site.slug, sites);
    const { cells, pct } = aggregate90(sum.dailyMinutesDown, metas[site.slug]?.startTime, nowMs, st === 'degraded');
    const bars = cells.map((c) => `<span class="${c.cls === 'ok' ? '' : c.cls}" title="${esc(c.tip)}"></span>`).join('');
    const mid = pct == null ? '기록 없음' : `최근 90일 ${fmtPct(pct)}% 정상`;
    return `<div class="svc"><div class="row"><div class="name"><span class="dot ${SVC_DOT[st]}"></span>${esc(t.name)}</div><span class="st ${SVC_DOT[st]}">${SVC_LABEL[st]}</span></div>
<div class="desc">${esc(t.desc)}</div>
<div class="bars" role="img" aria-label="최근 90일 상태">${bars}</div>
<div class="axis"><span>90일 전</span><span>${esc(mid)}</span><span>오늘</span></div></div>`;
  }).join('\n');

  const pastHtml = data.past.length
    ? data.past.map((p) => `<div class="it">${esc(p.pastTitle)}<div class="t">${esc(fmtMd(p.created))} ${esc(fmtHm(p.created))} · ${esc(fmtMinutes((p.closed - p.created) / 60000))} 만에 해결</div></div>`).join('\n')
    : '<div class="empty">최근 30일 동안 문제가 없었어요.</div>';

  const css = `
:root{--pink:#ec4899;--ink:#0f172a;--sub:#475569;--mute:#94a3b8;--line:#e2e8f0;--bg:#f8fafc;
--ok:#16a34a;--ok-bg:#f0fdf4;--bad:#dc2626;--bad-bg:#fef2f2;--warn:#d97706;--warn-bg:#fffbeb;--info:#2563eb;--info-bg:#eff6ff}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere;word-break:keep-all}
.wrap{max-width:720px;margin:0 auto;padding:0 16px 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 0}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px}
.logo{width:28px;height:28px;border-radius:8px;flex:none}
.back{font-size:14px;color:var(--sub);text-decoration:none;white-space:nowrap}
.hero{border-radius:16px;padding:22px 22px 18px;margin-top:4px;border:1px solid}
.hero.ok{background:var(--ok-bg);border-color:#bbf7d0}.hero.bad{background:var(--bad-bg);border-color:#fecaca}.hero.info{background:var(--info-bg);border-color:#bfdbfe}.hero.warn{background:var(--warn-bg);border-color:#fde68a}
.hero h1{margin:0;font-size:21px;line-height:1.4;display:flex;gap:10px;align-items:center}
.dot{width:12px;height:12px;border-radius:50%;flex:none}
.ok .dot,.dot.ok{background:var(--ok)}.bad .dot,.dot.bad{background:var(--bad)}.warn .dot,.dot.warn{background:var(--warn)}.info .dot,.dot.info{background:var(--info)}
.hero p{margin:10px 0 0;color:var(--sub);font-size:15px;line-height:1.6}
.hero .meta{margin-top:14px;font-size:13px;color:var(--mute)}
h2{font-size:15px;margin:32px 0 12px;color:var(--sub);font-weight:600}
.card{background:#fff;border:1px solid var(--line);border-radius:14px}
.inc{padding:20px;margin-bottom:12px;--c:var(--info)}
.inc.bad{--c:var(--bad)}.inc.warn{--c:var(--warn)}
.inc .top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.inc h3{margin:0;font-size:17px;line-height:1.4}
.pill{font-size:12px;font-weight:700;padding:4px 10px;border-radius:99px;white-space:nowrap}
.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.info{background:var(--info-bg);color:var(--info)}
.steps{display:flex;margin:18px 0 6px;gap:4px}
.step{flex:1;text-align:center;font-size:12px;color:var(--mute)}
.step i{display:block;height:4px;border-radius:2px;background:var(--line);margin-bottom:6px}
.step.done i{background:var(--c)}.step.done{color:var(--ink);font-weight:600}
.step.now{color:var(--c);font-weight:700}
.box{background:var(--bg);border-radius:10px;padding:14px 16px;margin-top:14px;font-size:14px;line-height:1.65}
.box b{display:block;font-size:13px;color:var(--sub);margin-bottom:4px}
.box ul{margin:0;padding-left:18px}
.box .prose{margin-top:8px}
.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}
.prose img{max-width:100%;height:auto}
.prose pre{overflow:auto;background:#fff;padding:8px;border-radius:8px}
.tl{margin:16px 0 0 4px;padding:0;list-style:none;border-left:2px solid var(--line)}
.tl li{position:relative;padding:0 0 14px 16px;font-size:14px;line-height:1.6}
.tl li:last-child{padding-bottom:0}
.tl li:before{content:"";position:absolute;left:-6px;top:6px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid var(--mute)}
.tl li.cur:before{border-color:var(--c);background:var(--c)}
.tl .t{font-size:12px;color:var(--mute)}.tl .s{font-weight:700;margin-right:6px}
.tl .tx{margin-top:2px}.tl .tx p{margin:0 0 4px}.tl .tx>:last-child{margin-bottom:0}
.tl .tx img{max-width:100%;height:auto}
.svc{padding:18px 20px;border-top:1px solid var(--line)}.svc:first-child{border-top:0}
.svc .row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.svc .name{font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.svc .desc{font-size:13px;color:var(--sub);margin:4px 0 12px 20px}
.st{font-size:13px;font-weight:700;white-space:nowrap}.st.ok{color:var(--ok)}.st.bad{color:var(--bad)}.st.warn{color:var(--warn)}.st.info{color:var(--info)}
.bars{display:flex;gap:2px;height:28px;margin-left:20px}
.bars span{flex:1;min-width:0;border-radius:2px;background:#22c55e}
.bars span.none{background:#eef2f7}.bars span.bad{background:var(--bad)}.bars span.warn{background:#f59e0b}
.axis{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mute);margin:6px 0 0 20px}
.past{padding:4px 20px}
.past .it{padding:14px 0;border-top:1px solid var(--line);font-size:14px}.past .it:first-child{border-top:0}
.past .it .t{font-size:12px;color:var(--mute);margin-top:3px}
.empty{padding:18px 0;color:var(--sub);font-size:14px}
.help{margin-top:28px;padding:18px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px}
.btn{background:var(--pink);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 14px;border-radius:10px;white-space:nowrap}
footer{margin-top:20px;font-size:12px;color:var(--mute);line-height:1.7;text-align:center}
@media (max-width:420px){.hero{padding:18px 16px 14px}.hero h1{font-size:19px}.inc{padding:16px}.svc{padding:16px}.past{padding:4px 16px}.help{padding:16px;flex-direction:column;align-items:stretch;text-align:center}.axis{font-size:11px}}`;

  const incidentSection = views.length ? `<h2>진행 중인 문제</h2>\n${views.map(incidentCard).join('\n')}` : '';
  const sections = [
    maintSection(data.maintenance.filter((m) => m.ongoing), '진행 중인 점검'),
    incidentSection,
    maintSection(data.maintenance.filter((m) => !m.ongoing), '예정된 점검'),
    `<h2>기능별 상태</h2>\n<div class="card">${svcRows}</div>`,
    `<h2>지난 문제 (최근 30일)</h2>\n<div class="card past">${pastHtml}</div>`,
  ].filter(Boolean).join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<meta name="theme-color" content="#ec4899">
<meta name="description" content="${esc(INTRO)}">
<title>${esc(SITE_NAME)}</title>
<link rel="icon" href="${LOGO}">
<style>${css}</style>
</head>
<body>
<div class="wrap">
<header><div class="brand"><img class="logo" src="${LOGO}" alt="" width="28" height="28">${esc(SITE_NAME)}</div><a class="back" href="${HOME_URL}">하입나우로 돌아가기 →</a></header>
<div class="hero ${hero.cls}" role="status"><h1><span class="dot"></span>${esc(hero.title)}</h1><p>${esc(hero.desc)}</p><div class="meta">마지막 확인 ${esc(fmtHm(lastCheckMs))} · 5분마다 자동으로 확인해요</div></div>
${sections}
<div class="card help"><span>문제가 계속되거나 여기 없는 문제를 겪고 있다면 알려 주세요.</span><a class="btn" href="${esc(HELP_URL)}">문의하기</a></div>
<footer>이 페이지는 하입나우 서버와 따로 운영돼요. 하입나우가 멈춰도 이곳은 열려요.</footer>
</div>
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
