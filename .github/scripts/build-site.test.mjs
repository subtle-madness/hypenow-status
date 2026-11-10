// 실행: node --test .github/scripts/build-site.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, parseMaintenance, render, cleanHtml, isTrustedComment, parseStage, progressOf, buildHero,
  aggregate90, fmtPct, messageSlugs, fmtMinutes, fmtWhen,
} from './build-site.mjs';

const sites = [
  { name: '웹사이트', slug: 'website' },
  { name: '서비스 서버', slug: 'api' },
  { name: '데이터 조회', slug: 'data' },
];
const NOW = Date.parse('2026-11-10T05:00:00Z');
const mk = (o) => ({
  number: 1, title: 't', state: 'open', body: '', body_html: '<p>본문</p>',
  created_at: '2026-11-10T04:00:00Z', closed_at: null, labels: [{ name: 'status' }],
  user: { login: 'chlwoomin' }, author_association: 'OWNER', ...o,
});

test('외부인 이슈는 라벨이 붙어도 제외', () => {
  const r = classify([mk({ user: { login: 'evil' }, author_association: 'NONE', title: '가짜 공지' })], sites, NOW);
  assert.equal(r.active.length, 0);
  const m = classify([mk({ user: { login: 'evil' }, author_association: 'NONE', labels: [{ name: 'maintenance' }],
    body: '<!--\nstart: 2026-11-11T00:00:00Z\nend: 2026-11-11T01:00:00Z\n-->' })], sites, NOW);
  assert.equal(m.maintenance.length, 0);
});

const botIssue = (o) => mk({ user: { login: 'github-actions[bot]' }, author_association: 'NONE', ...o });

test('봇 이슈는 고객용 헤드라인으로 치환, 원문(커밋 해시 등)은 노출 안 함', () => {
  const r = classify([
    botIssue({ number: 2, title: '🛑 서비스 서버 is down', labels: [{ name: 'status' }, { name: 'api' }], body_html: '<p>In <code>abc123</code></p>' }),
    botIssue({ number: 3, title: '🟨 웹사이트 has degraded performance', created_at: '2026-11-10T01:00:00Z', labels: [{ name: 'status' }, { name: 'website' }] }),
  ], sites, NOW);
  assert.deepEqual(r.active.map((a) => a.title).sort(), ['지금 로그인과 기능 이용이 어려워요', '지금 하입나우 사이트가 평소보다 느려요']);
  const html = render({ sites, summary: sites.map((s) => ({ ...s, status: 'up' })), metas: {}, data: r, comments: {}, nowMs: NOW, lastCheckMs: NOW });
  assert.ok(!html.includes('abc123'));
});

test('동시에 열린 봇 장애는 하나로 묶는다(15분 이내), 수동 장애는 묶지 않는다', () => {
  const api = botIssue({ number: 2, created_at: '2026-11-10T04:00:00Z', title: '🛑 서비스 서버 is down', labels: [{ name: 'status' }, { name: 'api' }] });
  const data = botIssue({ number: 3, created_at: '2026-11-10T04:10:00Z', title: '🛑 데이터 조회 is down', labels: [{ name: 'status' }, { name: 'data' }] });
  const far = botIssue({ number: 4, created_at: '2026-11-10T04:30:00Z', title: '🛑 웹사이트 is down', labels: [{ name: 'status' }, { name: 'website' }] });
  const manual1 = mk({ number: 5, title: '[장애] 가', labels: [{ name: 'status' }, { name: 'api' }], created_at: '2026-11-10T04:01:00Z' });
  const manual2 = mk({ number: 6, title: '[장애] 나', labels: [{ name: 'status' }, { name: 'api' }], created_at: '2026-11-10T04:02:00Z' });
  const r = classify([data, api, far, manual1, manual2], sites, NOW);
  assert.equal(r.active.length, 4);
  const g = r.active.find((a) => a.numbers.length === 2);
  assert.deepEqual(g.numbers, [2, 3]);
  assert.deepEqual(g.slugs, ['api', 'data']);
  assert.equal(g.created, Date.parse('2026-11-10T04:00:00Z'));
  assert.equal(g.title, '지금 로그인과 기능 이용이 어려워요');
  assert.ok(r.active.some((a) => a.numbers[0] === 4 && a.numbers.length === 1));
  // 우선순위: website > api > data
  const g2 = classify([api, data, botIssue({ number: 7, created_at: '2026-11-10T04:05:00Z', title: '🛑 웹사이트 is down', labels: [{ name: 'status' }, { name: 'website' }] })], sites, NOW);
  assert.equal(g2.active[0].title, '지금 하입나우 사이트가 열리지 않아요');
  assert.deepEqual(g2.active[0].slugs, ['website', 'api', 'data']);
});

test('지난 문제도 묶이고 과거형 제목, 가장 늦은 복구 시각 기준', () => {
  const closed = (n, slug, at, end) => botIssue({ number: n, state: 'closed', created_at: at, closed_at: end, title: '🛑 x is down', labels: [{ name: 'status' }, { name: slug }] });
  const r = classify([closed(2, 'api', '2026-11-09T01:00:00Z', '2026-11-09T01:20:00Z'), closed(3, 'data', '2026-11-09T01:02:00Z', '2026-11-09T01:30:00Z')], sites, NOW);
  assert.equal(r.past.length, 1);
  assert.equal(r.past[0].pastTitle, '로그인과 기능 이용이 어려웠어요');
  assert.equal(r.past[0].closed, Date.parse('2026-11-09T01:30:00Z'));
});

test('사람 이슈는 body_html 그대로, [장애] 접두 제거', () => {
  const r = classify([mk({ title: '[장애] 검색이 느려요' })], sites, NOW);
  assert.equal(r.active[0].title, '검색이 느려요');
  assert.equal(r.active[0].bodyHtml, '<p>본문</p>');
  assert.equal(r.active[0].bot, false);
});

test('지난 장애: 30일 이내 닫힌 것만', () => {
  const r = classify([
    mk({ number: 4, state: 'closed', closed_at: '2026-11-09T00:00:00Z' }),
    mk({ number: 5, state: 'closed', closed_at: '2026-09-01T00:00:00Z' }),
  ], sites, NOW);
  assert.deepEqual(r.past.map((p) => p.numbers), [[4]]);
});

test('점검 파싱: 안내 문구 속 예시는 무시, 예정/진행 구분', () => {
  const body = `<!--
예) 11월 5일 → start: 2026-11-04T17:00:00Z / end: 2026-11-04T18:00:00Z
-->
<!--
start: 2026-11-10T04:30:00Z
end: 2026-11-10T06:00:00Z
expectedDown: api, data
-->`;
  const m = parseMaintenance(body);
  assert.equal(m.start, Date.parse('2026-11-10T04:30:00Z'));
  assert.deepEqual(m.expectedDown, ['api', 'data']);
  const r = classify([mk({ labels: [{ name: 'maintenance' }], body }), mk({ number: 9, labels: [{ name: 'maintenance' }],
    body: body.replace(/2026-11-10T04:30/, '2026-11-12T04:30').replace(/2026-11-10T06/, '2026-11-12T06') })], sites, NOW);
  assert.deepEqual(r.maintenance.map((x) => x.ongoing), [true, false]);
  // 종료된 점검은 숨김
  assert.equal(classify([mk({ labels: [{ name: 'maintenance' }], body }) ], sites, Date.parse('2026-11-10T07:00:00Z')).maintenance.length, 0);
});

test('댓글: 외부인·봇 댓글 제외', () => {
  assert.equal(isTrustedComment({ user: { login: 'x' }, author_association: 'NONE' }), false);
  assert.equal(isTrustedComment({ user: { login: 'github-actions[bot]' }, author_association: 'MEMBER' }), false);
  assert.equal(isTrustedComment({ user: { login: 'me' }, author_association: 'COLLABORATOR' }), true);
});

test('cleanHtml: 스크립트·이벤트 속성 제거', () => {
  const h = cleanHtml('<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">l</a>');
  assert.ok(!/script|onclick|javascript:/i.test(h));
});

test('단계 접두어: 콜론 뒤 공백·전각 콜론 허용, 본문에서 접두어 제거', () => {
  assert.deepEqual(parseStage('<p>원인 파악: 접속 폭주예요</p>'), { stage: 1, html: '<p>접속 폭주예요</p>' });
  assert.deepEqual(parseStage('<p>복구 중：다시 시작했어요</p>'), { stage: 2, html: '<p>다시 시작했어요</p>' });
  assert.equal(parseStage('<p>해결:   끝</p>').html, '<p>끝</p>');
  assert.equal(parseStage('<p>확인 중:원인을 봐요</p>').stage, 0);
  assert.equal(parseStage('<p>접두어 없는 소식이에요</p>').stage, null);
  assert.equal(parseStage('<p>지금 복구 중: 아님</p>').stage, null);
});

test('진행 단계: 접두어 없으면 직전 단계 유지, 기본 확인 중, 닫히면 해결', () => {
  const cs = [
    { created_at: '2026-11-10T04:10:00Z', body_html: '<p>살펴보는 중이에요</p>' },
    { created_at: '2026-11-10T04:20:00Z', body_html: '<p>복구 중: 재시작했어요</p>' },
    { created_at: '2026-11-10T04:30:00Z', body_html: '<p>조금만 기다려 주세요</p>' },
  ];
  const p = progressOf(cs, false);
  assert.deepEqual(p.entries.map((e) => e.stage), [0, 2, 2]);
  assert.equal(p.stage, 2);
  assert.equal(progressOf([], false).stage, 0);
  assert.equal(progressOf(cs, true).stage, 3);
});

const inc = (o) => ({ numbers: [1], bot: true, kind: 'down', slugs: ['api'], topSlug: 'api', created: NOW - 600000, closed: null, title: '지금 로그인과 기능 이용이 어려워요', ...o });
const mt = (o) => ({ number: 9, title: '점검', start: NOW + DAY_MS, end: NOW + DAY_MS + 3600000, expectedDown: ['api'], ongoing: false, ...o });
const DAY_MS = 86400000;

test('hero 우선순위: 장애 > 점검 중 > 느림 > 7일 내 예정 점검 > 정상', () => {
  const h = (incidents, maintenance) => buildHero({ incidents, maintenance, nowMs: NOW, sites });
  assert.equal(h([], []).cls, 'ok');
  assert.equal(h([], []).title, '모든 기능이 정상이에요');
  assert.equal(h([], [mt()]).cls, 'info');
  assert.ok(h([], [mt()]).desc.includes('지금은 모든 기능이 정상이에요'));
  assert.equal(h([], [mt({ start: NOW + 8 * DAY_MS, end: NOW + 8 * DAY_MS + 1 })]).cls, 'ok');
  const slow = inc({ kind: 'degraded', title: '지금 로그인과 기능 이용이 평소보다 느려요' });
  assert.equal(h([slow], [mt()]).cls, 'warn');
  assert.ok(h([slow], []).title.includes('평소보다 느려요'));
  assert.equal(h([slow], [mt({ ongoing: true, start: NOW - 1000 })]).cls, 'info');
  assert.equal(h([slow, inc()], [mt({ ongoing: true })]).cls, 'bad');
  const bad = h([inc()], []);
  assert.equal(bad.cls, 'bad');
  assert.ok(/^13:50부터 로그인이 되지 않거나 화면에 오류가 날 수 있어요\. 원인을 확인하고 있어요\.$/.test(bad.desc), bad.desc);
});

test('hero: 단계 문장, 어제 시작이면 날짜 포함', () => {
  const i = inc({ created: NOW - DAY_MS });
  const d = buildHero({ incidents: [i], maintenance: [], nowMs: NOW, progress: { 1: { stage: 2 } }, sites }).desc;
  assert.ok(d.startsWith('11월 9일 14:00부터 '), d);
  assert.ok(d.endsWith('원인을 찾았고 복구하고 있어요.'));
});

test('90일 막대 집계: 기록 없음/정상/장애/오늘 느림, 가동률', () => {
  const now = Date.parse('2026-11-10T03:00:00Z');
  const { cells, pct } = aggregate90({ '2026-11-08': 1440 / 2 }, '2026-11-05T00:00:00Z', now, true);
  assert.equal(cells.length, 90);
  assert.equal(cells[0].cls, 'none');
  assert.deepEqual(cells.slice(-6).map((c) => c.cls), ['ok', 'ok', 'ok', 'bad', 'ok', 'warn']);
  // 기록 시작(11-05 09:00 KST)부터 now(11-10 12:00 KST)까지 약 5.125일, 720분 중단
  assert.ok(pct > 90 && pct < 100, String(pct));
  assert.equal(aggregate90({}, undefined, now).pct, null);
  assert.equal(aggregate90({}, '2026-11-05T00:00:00Z', now).pct, 100);
});

test('가동률 표기: 소수 최대 2자리, 100이면 정수, 반올림으로 100이 되지 않음', () => {
  assert.equal(fmtPct(100), '100');
  assert.equal(fmtPct(99.9), '99.9');
  assert.equal(fmtPct(99.876), '99.87');
  assert.equal(fmtPct(99.999), '99.99');
  assert.equal(fmtPct(99.5), '99.5');
});

test('시간 표기: 60분 이상은 시간 단위, 오늘 아니면 날짜', () => {
  assert.equal(fmtMinutes(25), '25분');
  assert.equal(fmtMinutes(65), '1시간 5분');
  assert.equal(fmtMinutes(60), '1시간');
  assert.equal(fmtWhen(Date.parse('2026-11-09T13:52:00Z'), NOW), '11월 9일 22:52');
  assert.equal(fmtWhen(Date.parse('2026-11-10T01:05:00Z'), NOW), '10:05');
});

test('렌더: 정상 화면, GitHub API 호출 코드·스크립트 없음, 마지막 확인 시각', () => {
  const summary = sites.map((s) => ({ ...s, status: 'up', dailyMinutesDown: {} }));
  const html = render({ sites, summary, metas: {}, data: { active: [], past: [], maintenance: [] }, comments: {}, nowMs: NOW, lastCheckMs: NOW });
  assert.ok(html.includes('모든 기능이 정상이에요'));
  assert.ok(html.includes('최근 30일 동안 문제가 없었어요.'));
  assert.ok(!html.includes('api.github.com'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('마지막 확인 14:00 · 5분마다 자동으로 확인해요'));
  assert.ok(!html.includes('—'));
});

test('렌더: 묶인 장애 한 카드, 진행 단계·접두어 제거·api 증상만', () => {
  const tdata = classify([
    botIssue({ number: 2, title: '🛑 a is down', created_at: '2026-11-10T04:00:00Z', labels: [{ name: 'status' }, { name: 'api' }] }),
    botIssue({ number: 3, title: '🛑 b is down', created_at: '2026-11-10T04:01:00Z', labels: [{ name: 'status' }, { name: 'data' }] }),
  ], sites, NOW);
  const comments = { 2: [{ user: { login: 'me' }, author_association: 'OWNER', created_at: '2026-11-10T04:20:00Z', body_html: '<p>원인 파악: 접속 폭주예요</p>' }] };
  const summary = sites.map((s) => ({ ...s, status: s.slug === 'website' ? 'up' : 'down', dailyMinutesDown: {} }));
  const html = render({ sites, summary, metas: {}, data: tdata, comments, nowMs: NOW, lastCheckMs: NOW });
  assert.equal((html.match(/class="card inc /g) || []).length, 1);
  assert.ok(html.includes('<span class="pill bad">원인 파악</span>'));
  assert.ok(html.includes('<p>접속 폭주예요</p>') && !html.includes('원인 파악: 접속'));
  assert.ok(!html.includes('찾기·랭킹 화면의 목록이 비어 보여요') && html.includes('로그인 버튼을 눌러도'));
  assert.ok(html.includes('자동 점검에서 문제를 발견해 살펴보고 있어요.'));
});

test('api가 영향에 있으면 data 증상·점검 문구는 뺀다(기능별 상태 행은 그대로)', () => {
  assert.deepEqual(messageSlugs(['api', 'data']), ['api']);
  assert.deepEqual(messageSlugs(['data']), ['data']);
  const m = mt({ expectedDown: ['api', 'data'] });
  const h = buildHero({ incidents: [], maintenance: [m], nowMs: NOW, sites });
  assert.ok(h.desc.includes('로그인과 기능 이용이 잠시 멈춰요. 지금은'), h.desc);
  assert.ok(!h.desc.includes('인플루언서'));
  const tdata = { active: [inc({ slugs: ['api', 'data'] })], past: [], maintenance: [{ ...m, bodyHtml: '', ongoing: false }] };
  const summary = sites.map((s) => ({ ...s, status: 'up', dailyMinutesDown: {} }));
  const html = render({ sites, summary, metas: {}, data: tdata, comments: {}, nowMs: NOW, lastCheckMs: NOW });
  assert.ok(!html.includes('찾기·랭킹 화면의 목록이 비어 보여요'));
  assert.ok(!html.includes('<li>인플루언서·콘텐츠 정보를 잠시 불러올 수 없어요</li>'));
  assert.ok(html.includes('<li>로그인과 기능 이용이 잠시 멈춰요</li>'));
  assert.equal((html.match(/class="svc"/g) || []).length, 3);
});
