// 실행: node --test .github/scripts/build-site.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseMaintenance, render, cleanHtml, isTrustedComment } from './build-site.mjs';

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

test('봇 이슈는 한국어 제목·고정 본문으로 치환', () => {
  const r = classify([
    mk({ number: 2, title: '🛑 서비스 서버 is down', user: { login: 'github-actions[bot]' }, author_association: 'NONE',
      labels: [{ name: 'status' }, { name: 'api' }], body_html: '<p>In <code>abc123</code>, 서비스 서버 was down</p>' }),
    mk({ number: 3, title: '🟨 웹사이트 has degraded performance', user: { login: 'github-actions[bot]' }, author_association: 'NONE',
      labels: [{ name: 'status' }, { name: 'website' }] }),
  ], sites, NOW);
  assert.deepEqual(r.active.map((a) => a.title).sort(), ['서비스 서버 장애', '웹사이트 응답 지연']);
  assert.ok(r.active.every((a) => a.bodyHtml.includes('자동 점검에서 문제가 확인돼')));
  assert.ok(r.active.every((a) => !a.bodyHtml.includes('abc123')));
});

test('사람 이슈는 body_html 그대로, [장애] 접두 제거', () => {
  const r = classify([mk({ title: '[장애] 검색이 느려요' })], sites, NOW);
  assert.equal(r.active[0].title, '검색이 느려요');
  assert.equal(r.active[0].bodyHtml, '<p>본문</p>');
});

test('지난 장애: 30일 이내 닫힌 것만', () => {
  const r = classify([
    mk({ number: 4, state: 'closed', closed_at: '2026-11-09T00:00:00Z' }),
    mk({ number: 5, state: 'closed', closed_at: '2026-09-01T00:00:00Z' }),
  ], sites, NOW);
  assert.deepEqual(r.past.map((p) => p.number), [4]);
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

test('렌더: GitHub API 호출 코드 없음, 정상 문구', () => {
  const summary = sites.map((s) => ({ ...s, status: 'up', uptimeDay: '100.00%', uptimeWeek: '100.00%', uptimeMonth: '100.00%', uptimeYear: '100.00%', time: 400, dailyMinutesDown: {} }));
  const html = render({ sites, summary, metas: {}, data: { active: [], past: [], maintenance: [] }, comments: {}, nowMs: NOW, lastCheckMs: NOW, repoUrl: 'https://github.com/x/y' });
  assert.ok(html.includes('모든 서비스가 정상이에요'));
  assert.ok(!html.includes('api.github.com'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('마지막 확인: 2026-11-10 14:00'));
});
