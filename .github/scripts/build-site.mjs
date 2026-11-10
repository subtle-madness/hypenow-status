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
const INTRO = '하입나우의 주요 기능이 정상인지 5분마다 확인해 보여드려요. 장애가 생기면 이곳에 상황과 해결 소식을 올려요.';
const LOGO = 'https://www.hypenow.io/android-chrome-192x192.png';
const HOME_URL = 'https://www.hypenow.io';
const CNAME = 'status.hypenow.io';
const BOT_INCIDENT_BODY = '자동 점검에서 문제가 확인돼 살펴보고 있어요.';
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

const stripTag = (t) => String(t ?? '').replace(/^\s*\[(장애|점검)\]\s*/, '').trim();

const serviceOf = (issue, sites) => {
  const labels = labelNames(issue);
  const bySlug = sites.filter((s) => labels.includes(s.slug));
  if (bySlug.length) return bySlug;
  return sites.filter((s) => issue.title?.includes(s.name));
};

export const classify = (issues, sites, nowMs) => {
  const active = [], past = [], maintenance = [];
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
    const svc = serviceOf(i, sites);
    let title = stripTag(i.title), bodyHtml = i.body_html;
    if (bot) {
      const name = svc.length ? svc.map((s) => s.name).join(', ')
        : (i.title.replace(/^\S+\s+/, '').replace(/\s+(is down|has degraded performance)\s*$/i, '').trim() || '일부 서비스');
      const degraded = /🟨|degraded/i.test(i.title);
      title = `${name} ${degraded ? '응답 지연' : '장애'}`;
      bodyHtml = `<p>${esc(BOT_INCIDENT_BODY)}</p>`;
    }
    const item = {
      number: i.number, title, bodyHtml, bot, created,
      closed: i.closed_at ? Date.parse(i.closed_at) : null,
      services: svc.map((s) => s.name),
    };
    if (i.state === 'open') active.push(item);
    else if (item.closed && nowMs - item.closed <= 30 * DAY) past.push(item);
  }
  active.sort((a, b) => b.created - a.created);
  past.sort((a, b) => b.closed - a.closed);
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
  // 열린 장애 공지의 댓글만 가져온다(사람 댓글만 쓴다).
  const comments = {};
  for (const i of open) {
    if (!isTrustedIssue(i) || isBotIssue(i) || !labelNames(i).includes('status')) continue;
    comments[i.number] = await apiAll(`/repos/${repo}/issues/${i.number}/comments`, token);
    await trustByPermission(comments[i.number]);
  }
  return { issues: [...open, ...closed], comments, repo };
};

// ---------- 렌더 ----------
const STATUS = {
  up: { label: '정상', cls: 'up' },
  down: { label: '장애', cls: 'down' },
  degraded: { label: '느림', cls: 'degraded' },
  maint: { label: '점검 중', cls: 'maint' },
};

const bars = (svc, meta, nowMs) => {
  const daily = svc.dailyMinutesDown || {};
  const startDate = meta.startTime ? kstDate(meta.startTime) : null;
  const cells = [];
  for (let k = 29; k >= 0; k--) {
    const d = kstDate(nowMs - k * DAY);
    const mm = d.slice(5);
    let cls = 'none', tip = `${mm} 기록 없음`;
    if (startDate && d >= startDate) {
      const mins = daily[d] || 0;
      if (mins <= 0) { cls = 'up'; tip = `${mm} 정상`; }
      else if (mins < 60) { cls = 'degraded'; tip = `${mm} 장애 ${fmtMinutes(mins)}`; }
      else { cls = 'down'; tip = `${mm} 장애 ${fmtMinutes(mins)}`; }
    }
    cells.push(`<span class="b ${cls}" title="${esc(tip)}"></span>`);
  }
  return `<div class="bars" role="img" aria-label="최근 30일 상태">${cells.join('')}</div>
<div class="bars-cap"><span>30일 전</span><span>오늘</span></div>`;
};

export const render = ({ sites, summary, metas, data, comments, nowMs, lastCheckMs, repoUrl }) => {
  const bySlug = Object.fromEntries(summary.map((s) => [s.slug, s]));
  const ongoingMaint = data.maintenance.filter((m) => m.ongoing);
  const maintDown = new Set(ongoingMaint.flatMap((m) => m.expectedDown));
  const rows = sites.map((s) => {
    const sum = bySlug[s.slug] || {};
    let st = sum.status === 'down' ? 'down' : sum.status === 'degraded' ? 'degraded' : 'up';
    if (st !== 'up' && maintDown.has(s.slug)) st = 'maint';
    return { site: s, sum, st };
  });
  const bad = rows.filter((r) => r.st === 'down' || r.st === 'degraded');
  let banner;
  if (bad.length) {
    const down = bad.filter((r) => r.st === 'down').length, slow = bad.length - down;
    const parts = [];
    if (down) parts.push(`${down}개 서비스에 장애가 있어요`);
    if (slow) parts.push(`${slow}개 서비스가 느려요`);
    banner = { cls: down ? 'down' : 'degraded', text: parts.join(' · ') };
  } else if (data.active.length) {
    banner = { cls: 'degraded', text: '확인 중인 장애 소식이 있어요' };
  } else {
    banner = { cls: 'up', text: '모든 서비스가 정상이에요' };
  }

  const tag = (st) => `<span class="tag ${STATUS[st].cls}">${STATUS[st].label}</span>`;

  const maintHtml = data.maintenance.map((m) => {
    const when = `${fmtKst(m.start)} ~ ${fmtKst(m.end)}`;
    const mins = fmtMinutes((m.end - m.start) / 60000);
    const names = m.expectedDown.map((slug) => sites.find((s) => s.slug === slug)?.name).filter(Boolean);
    return `<section class="card notice maint-card">
<div class="notice-head"><h3>${esc(m.title)}</h3><span class="tag maint">${m.ongoing ? '진행 중' : '예정'}</span></div>
<p class="meta">${esc(when)} (${esc(mins)}${names.length ? ` · 영향: ${esc(names.join(', '))}` : ''})</p>
<div class="prose">${cleanHtml(m.bodyHtml)}</div>
</section>`;
  }).join('\n');

  const activeHtml = data.active.map((a) => {
    const cs = (comments[a.number] || []).filter(isTrustedComment)
      .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
    return `<section class="card notice incident-card">
<div class="notice-head"><h3>${esc(a.title)}</h3><span class="tag down">진행 중</span></div>
<p class="meta">${esc(fmtKst(a.created))} 시작${a.services.length ? ` · 영향: ${esc(a.services.join(', '))}` : ''}</p>
<div class="prose">${cleanHtml(a.bodyHtml)}</div>
${cs.map((c) => `<div class="update"><p class="meta">${esc(fmtKst(c.created_at))}</p><div class="prose">${cleanHtml(c.body_html)}</div></div>`).join('\n')}
</section>`;
  }).join('\n');

  const cards = rows.map(({ site, sum, st }) => `<section class="card svc">
<div class="svc-head"><h3>${esc(site.name)}</h3>${tag(st)}</div>
${bars(sum, metas[site.slug] || {}, nowMs)}
<dl class="stats">
<div><dt>24시간</dt><dd>${esc(sum.uptimeDay ?? '-')}</dd></div>
<div><dt>7일</dt><dd>${esc(sum.uptimeWeek ?? '-')}</dd></div>
<div><dt>30일</dt><dd>${esc(sum.uptimeMonth ?? '-')}</dd></div>
<div><dt>1년</dt><dd>${esc(sum.uptimeYear ?? '-')}</dd></div>
</dl>
<p class="meta">가동률 · 평균 응답 시간 ${sum.time != null ? esc(sum.time) + 'ms' : '-'}</p>
</section>`).join('\n');

  const pastHtml = data.past.length
    ? data.past.map((p) => `<li><strong>${esc(p.title)}</strong>
<span class="meta">${esc(fmtKst(p.created))} 시작 · ${p.closed ? `${esc(fmtMinutes((p.closed - p.created) / 60000))} 만에 해결` : ''}</span></li>`).join('\n')
    : '<li class="empty">최근 30일 동안 장애가 없었어요.</li>';

  const css = `
:root{--bg:#fdf2f8;--fg:#1f2937;--accent:#ec4899;--accent-d:#d61f7f;--line:#fbcfe8;--up:#20bf6b;--down:#eb3b5a;--deg:#f7b731;--maint:#3b82f6;--muted:#6b7280}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;overflow-wrap:anywhere}
a{color:var(--accent-d)}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
nav{border-bottom:1px solid var(--line);background:#fff}
nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--fg);text-decoration:none}
.brand img{width:28px;height:28px;border-radius:6px}
.menu{display:flex;gap:16px;font-size:14px}
.menu a{text-decoration:none;color:var(--fg);padding:16px 0;border-bottom:2px solid transparent}
.menu a.cur{border-bottom-color:var(--accent)}
h1{font-size:24px;margin:28px 0 8px}
h1 b{color:var(--accent-d)}
h2{font-size:18px;margin:32px 0 12px}
h3{font-size:16px;margin:0}
.intro{margin:0 0 20px;color:var(--muted)}
.banner{border-radius:12px;padding:14px 16px;color:#fff;font-weight:700}
.banner.up{background:var(--up)}.banner.down{background:var(--down)}.banner.degraded{background:var(--deg);color:#1f2937}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.svc-head,.notice-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.tag{display:inline-block;flex:none;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:700;color:#fff}
.tag.up{background:var(--up)}.tag.down{background:var(--down)}.tag.degraded{background:var(--deg);color:#1f2937}.tag.maint{background:var(--maint)}
.meta{margin:4px 0 0;font-size:13px;color:var(--muted)}
.bars{display:flex;gap:2px;height:28px;margin-top:12px}
.b{flex:1;min-width:0;border-radius:2px;background:#e5e7eb}
.b.up{background:var(--up)}.b.down{background:var(--down)}.b.degraded{background:var(--deg)}
.bars-cap{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 0}
.stats div{background:var(--bg);border-radius:8px;padding:6px 8px;min-width:0}
.stats dt{font-size:12px;color:var(--muted)}
.stats dd{margin:0;font-weight:700;font-size:14px}
.prose{margin-top:8px;font-size:15px}
.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}
.prose img{max-width:100%;height:auto}
.prose pre{overflow:auto;background:var(--bg);padding:8px;border-radius:8px}
.update{border-top:1px solid var(--line);margin-top:12px;padding-top:8px}
.incident-card{border-left:4px solid var(--down)}
.maint-card{border-left:4px solid var(--maint)}
ul.past{list-style:none;margin:0;padding:0}
ul.past li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:8px 0}
ul.past .meta{display:block}
.empty{color:var(--muted)}
footer{margin:36px 0 32px;font-size:13px;color:var(--muted);text-align:center}
footer p{margin:4px 0}
@media (max-width:420px){.stats{grid-template-columns:repeat(2,1fr)}}`;

  const sections = [
    ongoingMaint.length || data.maintenance.length ? `<h2>정기 점검</h2>\n${maintHtml}` : '',
    data.active.length ? `<h2>진행 중인 장애</h2>\n${activeHtml}` : '',
    `<h2>현재 상태</h2>\n${cards}`,
    `<h2>지난 장애</h2>\n<ul class="past">${pastHtml}</ul>`,
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
<nav><div class="wrap">
<a class="brand" href="/"><img src="${LOGO}" alt="" width="28" height="28"><span>${esc(SITE_NAME)}</span></a>
<div class="menu"><a class="cur" href="/">서비스 상태</a><a href="${HOME_URL}">하입나우 바로가기</a></div>
</div></nav>
<main class="wrap">
<h1><b>하입나우</b> 서비스 상태</h1>
<p class="intro">${esc(INTRO)}</p>
<div class="banner ${banner.cls}" role="status">${esc(banner.text)}</div>
${sections}
</main>
<footer class="wrap">
<p>마지막 확인: ${esc(fmtKst(lastCheckMs))} (한국 시간)</p>
<p>이 페이지는 5분마다 새로 만들어져요.</p>
<p><a href="${esc(repoUrl)}">공개 저장소</a>에서 Upptime으로 만들었어요.</p>
</footer>
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
  const repo = process.env.GITHUB_REPOSITORY || 'subtle-madness/hypenow-status';
  const html = render({ sites, summary, metas, data, comments, nowMs, lastCheckMs, repoUrl: `https://github.com/${repo}` });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, 'CNAME'), `${CNAME}\n`);
  writeFileSync(join(out, '.nojekyll'), '');
  return { html, data };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().then(({ data }) => {
    console.log(`생성 완료: 진행 중 장애 ${data.active.length}, 지난 장애 ${data.past.length}, 점검 ${data.maintenance.length}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
