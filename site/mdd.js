/*
 * MDD(고점 대비 하락률) 계산 로직.
 *
 * 날짜는 1970-01-01부터 센 "일 번호"(정수)로 다룬다. 하락률은 비율(-0.25 = -25%)이다.
 * 브라우저에서는 window.MDD, Node 테스트에서는 require('./mdd.js')로 쓴다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MDD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 분포표 구간: 0%, -5%, -10%, ... -100%
  const LEVELS = [0];
  for (let x = 5; x <= 100; x += 5) LEVELS.push(-x);

  // 부동소수 오차로 "정확히 고점"인 날이 -1e-16 같은 값이 되는 것을 막는다.
  const EPS = 1e-9;
  const DAY_MS = 864e5;

  function dayToISO(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }

  function isoToDay(iso) {
    const t = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
  }

  // 각 날짜의 '그날까지의 최고가 대비 하락률'
  function drawdown(close) {
    const out = new Array(close.length);
    let peak = -Infinity;
    for (let i = 0; i < close.length; i++) {
      if (close[i] > peak) peak = close[i];
      out[i] = close[i] / peak - 1;
    }
    return out;
  }

  // level 행의 days = 하락률이 level 이상(덜 빠진)이었던 날 수.
  // cum_pct(회복률)는 그 비율, bucket_*은 바로 위 행과의 차이.
  function distribution(dd) {
    const n = dd.length;
    const rows = [];
    let prev = 0;
    for (const level of LEVELS) {
      const floor = level / 100 - EPS;
      let days = 0;
      for (let i = 0; i < n; i++) if (dd[i] >= floor) days++;
      rows.push({
        level,
        days,
        cum_pct: days / n,
        bucket_days: days - prev,
        bucket_pct: (days - prev) / n,
      });
      prev = days;
    }
    return rows;
  }

  // 고점 → 저점 → 회복까지를 하나의 하락 구간으로 묶는다(오래된 순).
  function episodes(days, close, dd) {
    const n = dd.length;
    const result = [];

    function record(peakI, recoverI) {
      const stop = recoverI == null ? n : recoverI;
      let troughI = peakI;
      for (let i = peakI; i < stop; i++) if (dd[i] < dd[troughI]) troughI = i;
      const endI = recoverI == null ? n - 1 : recoverI;
      result.push({
        peak_day: days[peakI],
        peak_price: close[peakI],
        trough_day: days[troughI],
        trough_price: close[troughI],
        recovery_day: recoverI == null ? null : days[recoverI],
        depth: dd[troughI],
        decline_days: troughI - peakI,
        recovery_days: recoverI == null ? null : recoverI - troughI,
        total_days: endI - peakI,
        calendar_days: days[endI] - days[peakI],
        recovered: recoverI != null,
      });
    }

    let peakI = 0;
    let underwaterFrom = null;
    for (let i = 0; i < n; i++) {
      if (dd[i] >= -EPS) {
        if (underwaterFrom != null) {
          record(underwaterFrom, i);
          underwaterFrom = null;
        }
        peakI = i;
      } else if (underwaterFrom == null) {
        underwaterFrom = peakI;
      }
    }
    if (underwaterFrom != null) record(underwaterFrom, null);
    return result;
  }

  // 연도별 종가, 수익률, 연중 최대 하락률, 연말 하락률
  function yearly(days, close, dd) {
    const rows = [];
    let prevClose = null;
    let i = 0;
    while (i < days.length) {
      const year = new Date(days[i] * DAY_MS).getUTCFullYear();
      const first = i;
      let minDd = dd[i];
      while (i < days.length && new Date(days[i] * DAY_MS).getUTCFullYear() === year) {
        if (dd[i] < minDd) minDd = dd[i];
        i++;
      }
      const last = close[i - 1];
      const base = prevClose != null ? prevClose : close[first];
      rows.push({
        year,
        close: last,
        return: last / base - 1,
        min_dd: minDd,
        end_dd: dd[i - 1],
        partial: prevClose == null,
      });
      prevClose = last;
    }
    return rows;
  }

  function cleanSeries(days, close) {
    const d = [];
    const c = [];
    for (let i = 0; i < days.length; i++) {
      const v = close[i];
      if (v != null && Number.isFinite(v) && v > 0) {
        d.push(days[i]);
        c.push(v);
      }
    }
    return { days: d, close: c };
  }

  // 차트·요약·분포표·하락장 목록·연도별 요약을 한 번에 계산한다.
  function analyze(rawDays, rawClose) {
    const { days, close } = cleanSeries(rawDays, rawClose);
    if (close.length < 2) throw new Error('분석할 가격 데이터가 너무 적어요.');

    const n = close.length;
    const dd = drawdown(close);
    const eps = episodes(days, close, dd);

    let athI = 0;
    let mddI = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (close[i] > close[athI]) athI = i;
      if (dd[i] < dd[mddI]) mddI = i;
      sum += dd[i];
    }
    let mddPeakI = 0;
    for (let i = 0; i <= mddI; i++) if (close[i] > close[mddPeakI]) mddPeakI = i;

    const currentDd = dd[n - 1];
    let deeper = 0;
    for (let i = 0; i < n; i++) if (dd[i] < currentDd - EPS) deeper++;

    let longest = null;
    for (const e of eps) if (!longest || e.total_days > longest.total_days) longest = e;

    return {
      summary: {
        first_day: days[0],
        last_day: days[n - 1],
        days: n,
        last_close: close[n - 1],
        ath: close[athI],
        ath_day: days[athI],
        current_dd: currentDd,
        mdd: dd[mddI],
        mdd_day: days[mddI],
        mdd_peak_day: days[mddPeakI],
        avg_dd: sum / n,
        deeper_than_now_pct: deeper / n,
        longest,
      },
      series: { days, close, dd },
      distribution: distribution(dd),
      episodes: eps,
      yearly: yearly(days, close, dd),
    };
  }

  // 정렬된 일 번호 배열에서 [startDay, endDay] 범위만 잘라낸다. 비어 있는 끝은 제한 없음.
  function slice(days, values, startDay, endDay) {
    let lo = 0;
    let hi = days.length;
    if (startDay != null) lo = lowerBound(days, startDay);
    if (endDay != null) hi = lowerBound(days, endDay + 1);
    return { days: days.slice(lo, hi), values: values.slice(lo, hi) };
  }

  function lowerBound(arr, x) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 가격을 같은 날(없으면 직전 날) 환율로 원화 환산한다. 환율이 없는 앞부분은 버린다.
  function toKrw(days, close, fxDays, fxClose) {
    const outDays = [];
    const outClose = [];
    let j = -1;
    for (let i = 0; i < days.length; i++) {
      while (j + 1 < fxDays.length && fxDays[j + 1] <= days[i]) j++;
      if (j < 0 || close[i] == null) continue;
      outDays.push(days[i]);
      outClose.push(close[i] * fxClose[j]);
    }
    return { days: outDays, values: outClose };
  }

  // 회복률이 기준을 처음 넘는 구간
  function buyLine(rows, base) {
    return rows.find((r) => r.cum_pct >= base - 1e-12) || null;
  }

  return {
    LEVELS, EPS, dayToISO, isoToDay, drawdown, distribution, episodes, yearly,
    analyze, slice, toKrw, buyLine,
  };
});
