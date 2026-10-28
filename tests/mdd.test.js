// 실행: node --test "tests/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MDD = require(path.join(__dirname, '..', 'site', 'mdd.js'));

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const day = (iso) => MDD.isoToDay(iso);

// 평일 n일의 일 번호
function weekdays(startIso, n) {
  const out = [];
  let d = day(startIso);
  while (out.length < n) {
    const wd = new Date(d * 864e5).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
    d++;
  }
  return out;
}

// 100 → 120(고점) → 90 → 60(저점, -50%) → 130(회복·새 고점) → 117(-10%, 진행 중)
const PRICES = [100, 120, 90, 60, 130, 117];
const DAYS = weekdays('2020-01-01', PRICES.length); // 01-01(수) ~ 01-08(수)

test('날짜 변환', () => {
  assert.equal(MDD.dayToISO(0), '1970-01-01');
  assert.equal(MDD.isoToDay('2020-01-01'), 18262);
  assert.equal(MDD.dayToISO(MDD.isoToDay('2026-10-28')), '2026-10-28');
  assert.equal(MDD.isoToDay('not-a-date'), null);
});

test('고점 대비 하락률', () => {
  const dd = MDD.drawdown(PRICES).map((v) => Math.round(v * 1e4) / 1e4);
  assert.deepEqual(dd, [0, 0, -0.25, -0.5, 0, -0.1]);
});

test('분포표는 각 구간보다 덜 빠진 날을 센다', () => {
  const rows = Object.fromEntries(MDD.distribution(MDD.drawdown(PRICES)).map((r) => [r.level, r]));
  assert.equal(rows[0].days, 3); // 고점에 있던 날
  assert.equal(rows[-5].days, 3);
  assert.equal(rows[-10].days, 4); // 정확히 -10%인 날 포함
  assert.equal(rows[-25].days, 5);
  assert.equal(rows[-50].days, 6);
  assert.equal(rows[-100].days, 6);
  assert.equal(rows[-10].bucket_days, 1);
  assert.ok(close(rows[-50].cum_pct, 1));
  assert.equal(Object.values(rows).reduce((s, r) => s + r.bucket_days, 0), 6);
  assert.equal(Object.keys(rows).length, 21);
});

test('하락 구간: 고점·저점·회복, 진행 중인 구간', () => {
  const dd = MDD.drawdown(PRICES);
  const eps = MDD.episodes(DAYS, PRICES, dd);
  assert.equal(eps.length, 2);
  const [a, b] = eps;
  assert.equal(a.peak_price, 120);
  assert.equal(a.trough_price, 60);
  assert.ok(close(a.depth, -0.5));
  assert.equal(a.recovered, true);
  assert.equal(a.decline_days, 2);
  assert.equal(a.recovery_days, 1);
  assert.equal(a.total_days, 3);
  assert.equal(MDD.dayToISO(a.peak_day), '2020-01-02');
  assert.equal(MDD.dayToISO(a.recovery_day), '2020-01-07');
  assert.equal(a.calendar_days, 5);

  assert.equal(b.peak_price, 130);
  assert.equal(b.recovered, false);
  assert.equal(b.recovery_day, null);
  assert.ok(close(b.depth, -0.1));
  assert.equal(b.total_days, 1);
});

test('요약 수치', () => {
  const r = MDD.analyze(DAYS, PRICES);
  const s = r.summary;
  assert.equal(s.ath, 130);
  assert.equal(s.last_close, 117);
  assert.ok(close(s.current_dd, -0.1));
  assert.ok(close(s.mdd, -0.5));
  assert.equal(MDD.dayToISO(s.mdd_peak_day), '2020-01-02');
  assert.equal(MDD.dayToISO(s.mdd_day), '2020-01-06');
  assert.ok(close(s.avg_dd, (-0.25 - 0.5 - 0.1) / 6));
  assert.ok(close(s.deeper_than_now_pct, 2 / 6)); // -25%, -50% 두 날
  assert.equal(s.longest.total_days, 3);
  assert.equal(r.series.days.length, 6);
});

test('가격이 없거나 0 이하인 날은 빼고 계산한다', () => {
  const r = MDD.analyze([1, 2, 3, 4], [100, null, 0, 80]);
  assert.equal(r.summary.days, 2);
  assert.ok(close(r.summary.mdd, -0.2));
});

test('데이터가 하루뿐이면 오류', () => {
  assert.throws(() => MDD.analyze([1], [100]), /너무 적어요/);
});

test('연도별 수익률', () => {
  const days = ['2020-06-01', '2020-12-31', '2021-06-01', '2021-12-31'].map(day);
  const prices = [100, 110, 90, 121];
  const rows = MDD.yearly(days, prices, MDD.drawdown(prices));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].partial, true);
  assert.ok(close(rows[0].return, 0.1));
  assert.ok(close(rows[1].return, 0.1));
  assert.ok(close(rows[1].min_dd, 90 / 110 - 1));
});

test('기간 자르기', () => {
  const days = [10, 11, 12, 15, 16];
  const vals = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(MDD.slice(days, vals, 11, 15).values, ['b', 'c', 'd']);
  assert.deepEqual(MDD.slice(days, vals, 13, null).values, ['d', 'e']);
  assert.deepEqual(MDD.slice(days, vals, null, 11).values, ['a', 'b']);
  assert.deepEqual(MDD.slice(days, vals, null, null).values, vals);
  assert.deepEqual(MDD.slice(days, vals, 20, 30).values, []);
});

test('원화 환산: 직전 환율을 쓰고, 환율 시작 전은 버린다', () => {
  const k = MDD.toKrw([1, 2, 3, 4], [10, 10, 10, 10], [2, 4], [1000, 1200]);
  assert.deepEqual(k.days, [2, 3, 4]);
  assert.deepEqual(k.values, [10000, 10000, 12000]);
});

test('저점매수 구간 = 회복률이 기준을 처음 넘는 구간', () => {
  const rows = [
    { level: 0, cum_pct: 0.1 },
    { level: -5, cum_pct: 0.5 },
    { level: -10, cum_pct: 0.8 },
    { level: -15, cum_pct: 1 },
  ];
  assert.equal(MDD.buyLine(rows, 0.8).level, -10);
  assert.equal(MDD.buyLine(rows, 0.9).level, -15);
  assert.equal(MDD.buyLine(rows, 0.05).level, 0);
});
