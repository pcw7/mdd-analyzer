(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MDD = window.MDD;

  // 'static' = GitHub Pages (미리 만든 data/ 파일), 'api' = 로컬 서버(app.py)로 아무 종목이나 조회
  const MODE = window.MDD_MODE === 'api' ? 'api' : 'static';

  const API_EXAMPLES = [
    { code: 'QQQ' }, { code: 'SPY' }, { code: 'SOXX' },
    { code: '005930', label: '삼성전자' }, { code: 'BTCUSD', label: '비트코인' }, { code: 'GCW00', label: '금' },
  ];
  // 회복률 기준을 80%로 두는 유형 (나머지는 90%)
  const LOW_BASE_TYPES = new Set(['ETF', 'INDEX', 'MUTUALFUND']);
  const CURRENCY_NAMES = { USD: '달러', KRW: '원화', JPY: '엔화', EUR: '유로', CNY: '위안', HKD: '홍콩달러', GBP: '파운드' };
  const TYPE_NAMES = {
    ETF: 'ETF', EQUITY: '주식', INDEX: '지수', CRYPTOCURRENCY: '암호화폐',
    FUTURE: '선물', MUTUALFUND: '펀드', CURRENCY: '환율',
  };
  const EPISODE_MIN_DEPTH = -0.10;
  const YEARLY_CAP = 8;
  const MINUS = '−';

  const state = {
    catalog: null, // static 모드의 data/index.json
    raw: null, // 지금 보고 있는 종목의 가격
    code: '', // 지금 보고 있는 종목의 입력 코드
    fx: null,
    views: null,
    viewsKey: '',
    view: 'native',
    baseTouched: false,
    preset: 0,
    req: 0,
    statusKind: '',
    extra: [], // api 모드에서 검색해 본 종목
    ddByCode: {}, // api 모드: 불러온 종목의 현재 하락률
    showAllEpisodes: false,
    showAllYears: false,
  };
  const cache = new Map();
  let chart = null;

  /* ---------- 작은 도우미 ---------- */

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') Object.assign(node.style, value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

  // 음수에는 진짜 빼기 기호(−)를 쓴다
  function pct(v, digits = 1) {
    if (v == null || !Number.isFinite(v)) return '–';
    const s = Math.abs(v * 100).toFixed(digits);
    return (v < 0 && Number(s) !== 0 ? MINUS : '') + s + '%';
  }
  const signedPct = (v, digits = 1) => (v > 0 && Number((v * 100).toFixed(digits)) !== 0 ? '+' : '') + pct(v, digits);

  function money(v, cur) {
    if (v == null || !Number.isFinite(v)) return '–';
    const digits = cur === 'KRW' || cur === 'JPY' ? 0 : v < 1 ? 4 : 2;
    if (!cur) return v.toLocaleString('ko-KR', { maximumFractionDigits: digits });
    try {
      return new Intl.NumberFormat('ko-KR', {
        style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(v);
    } catch {
      return `${v.toLocaleString('ko-KR', { maximumFractionDigits: digits })} ${cur}`;
    }
  }

  const int = (n) => Number(n).toLocaleString('ko-KR');
  const fmtDay = (day) => (day == null ? '–' : MDD.dayToISO(day).replaceAll('-', '.'));

  // 기간: 문자열('16년 5개월')과, 단위를 작게 쓴 노드 둘 다 만든다
  function spanParts(days) {
    if (days == null) return null;
    if (days < 31) return [[days, '일']];
    const months = Math.round(days / 30.44);
    if (months < 12) return [[months, '개월']];
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m ? [[y, '년'], [m, '개월']] : [[y, '년']];
  }
  const span = (days) => {
    const p = spanParts(days);
    return p ? p.map(([n, u]) => `${n}${u}`).join(' ') : '–';
  };
  const spanNode = (days) => {
    const p = spanParts(days);
    return p ? p.flatMap(([n, u]) => [String(n), el('small', { text: u })]) : ['–'];
  };

  function localISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // kind: 'info' | 'error' | 'compute'(기간 설정 오류 — 설정을 고치면 저절로 지운다)
  function setStatus(text, kind = 'info') {
    const box = $('status');
    box.textContent = text;
    box.hidden = !text;
    box.classList.toggle('error', !!text && kind !== 'info');
    state.statusKind = text ? kind : '';
  }

  /* ---------- 데이터 불러오기 ---------- */

  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(MODE === 'api'
        ? '서버에 연결하지 못했어요. app.py가 실행 중인지 확인해 주세요.'
        : '데이터를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // JSON이 아닌 응답(404 페이지 등)
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || `데이터를 불러오지 못했어요 (HTTP ${res.status}).`);
      err.status = res.status;
      throw err;
    }
    if (!body) throw new Error('데이터 형식이 올바르지 않아요.');
    return body;
  }

  function cached(key, fn) {
    if (!cache.has(key)) {
      cache.set(key, fn().catch((err) => {
        cache.delete(key);
        throw err;
      }));
    }
    return cache.get(key);
  }

  function entries() {
    if (MODE === 'static') return (state.catalog && state.catalog.tickers) || [];
    const seen = new Set(API_EXAMPLES.map((e) => norm(e.code)));
    return [...API_EXAMPLES, ...state.extra.filter((e) => !seen.has(norm(e.code)))];
  }

  function findEntry(query) {
    const q = norm(query);
    return entries().find((e) => [e.code, e.symbol, e.label, e.name].some((v) => v && norm(v) === q)) || null;
  }

  async function getPrices(query) {
    if (MODE === 'api') {
      const prices = await cached(`p:${norm(query)}`, () => getJSON(`api/prices?q=${encodeURIComponent(query)}`));
      const known = findEntry(query);
      return { ...prices, label: known ? known.label : null, code: known ? known.code : query.trim().toUpperCase() };
    }
    const entry = findEntry(query);
    if (!entry) throw new Error(`'${query}'는 이 사이트 종목 목록에 없어요. 종목 목록에서 골라 주세요.`);
    const prices = await cached(`p:${entry.file}`, () => getJSON(`data/${entry.file}`));
    return { ...prices, label: entry.label, code: entry.code };
  }

  async function getFx(currency) {
    if (!currency || currency === 'KRW') return null;
    try {
      if (MODE === 'api') {
        return await cached(`fx:${currency}`, () => getJSON(`api/fx?currency=${encodeURIComponent(currency)}`));
      }
      const rel = state.catalog && state.catalog.fx && state.catalog.fx[currency];
      if (!rel) return null;
      return await cached(`fx:${currency}`, () => getJSON(`data/${rel}`));
    } catch {
      return null; // 환율이 없어도 현지 통화 기준은 볼 수 있게 한다
    }
  }

  async function loadCatalog() {
    if (MODE === 'api') return;
    try {
      state.catalog = await getJSON('data/index.json');
    } catch (err) {
      throw new Error(err.status === 404
        ? '아직 데이터가 없어요. python scripts/build_data.py 를 실행하거나, GitHub Actions 배포가 끝났는지 확인해 주세요.'
        : err.message);
    }
  }

  async function load(query) {
    const q = String(query || '').trim();
    if (!q) return;
    const my = ++state.req;
    setStatus(`${q.toUpperCase()} 불러오는 중…`);
    document.body.classList.add('loading');
    try {
      const raw = await getPrices(q);
      const fx = await getFx(raw.currency);
      if (my !== state.req) return;

      state.raw = raw;
      state.code = raw.code;
      state.fx = fx;
      state.viewsKey = '';
      state.showAllEpisodes = false;
      state.showAllYears = false;
      if (!state.baseTouched) $('base').value = LOW_BASE_TYPES.has(raw.type) ? 80 : 90;
      if (MODE === 'api') rememberApiTicker(raw);
      updateUrl();
      setStatus('');
      render();
    } catch (err) {
      if (my !== state.req) return;
      setStatus(err.message, 'error');
    } finally {
      if (my === state.req) document.body.classList.remove('loading');
    }
  }

  // api 모드: 검색해 본 종목을 목록에 남기고, 전체 기간 고점 대비 하락률을 표시한다
  function rememberApiTicker(raw) {
    const key = norm(raw.code);
    if (!findEntry(raw.code)) state.extra.push({ code: raw.code, name: raw.name });
    let peak = 0;
    for (const v of raw.close) if (v > peak) peak = v;
    state.ddByCode[key] = raw.close[raw.close.length - 1] / peak - 1;
    renderWatchlist();
  }

  function updateUrl() {
    const params = new URLSearchParams({ q: state.code });
    if ($('start').value) params.set('start', $('start').value);
    if ($('end').value) params.set('end', $('end').value);
    if ($('adjusted').checked) params.set('adjusted', '1');
    history.replaceState(null, '', `?${params}`);
  }

  /* ---------- 계산 ---------- */

  function readSettings() {
    const baseRaw = Number($('base').value);
    const base = clamp(Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : 80, 1, 100) / 100;
    const thresholds = ['t1', 't2', 't3'].map((id, i) => {
      const raw = Number($(id).value);
      return { name: `기준${i + 1}`, level: clamp(Number.isFinite(raw) ? -Math.abs(raw) : 0, -99, 0) / 100 };
    });
    return { base, thresholds };
  }

  // 기간·배당 반영 설정이 바뀔 때만 다시 계산한다.
  function getViews() {
    const raw = state.raw;
    const adjusted = $('adjusted').checked && !!raw.adj;
    const start = $('start').value;
    const end = $('end').value;
    const key = [raw.symbol, adjusted, start, end, state.fx ? state.fx.symbol : ''].join('|');
    if (key === state.viewsKey) return state.views;

    const startDay = start ? MDD.isoToDay(start) : null;
    const endDay = end ? MDD.isoToDay(end) : null;
    if (startDay != null && endDay != null && startDay > endDay) throw new Error('시작일이 종료일보다 늦어요.');

    const cut = MDD.slice(raw.d, adjusted ? raw.adj : raw.close, startDay, endDay);
    let native;
    try {
      native = MDD.analyze(cut.days, cut.values);
    } catch {
      throw new Error('선택한 기간에 데이터가 너무 적어요. 기간을 넓혀 주세요.');
    }
    native.currency = raw.currency;

    let krw = null;
    let krwNote = null;
    if (raw.currency && raw.currency !== 'KRW') {
      if (!state.fx) {
        krwNote = `${raw.currency}/KRW 환율 데이터가 없어서 원화 기준은 볼 수 없어요.`;
      } else {
        const k = MDD.toKrw(cut.days, cut.values, state.fx.d, state.fx.close);
        try {
          krw = MDD.analyze(k.days, k.values);
          krw.currency = 'KRW';
          if (krw.summary.first_day !== native.summary.first_day) {
            krwNote = `환율 데이터가 ${fmtDay(krw.summary.first_day)}부터 있어서, 원화 기준은 그날부터 계산했어요.`;
          }
        } catch {
          krwNote = '선택한 기간에는 환율 데이터가 부족해서 원화 기준을 계산할 수 없어요.';
        }
      }
    }

    state.views = { native, krw, krwNote, adjusted };
    state.viewsKey = key;
    return state.views;
  }

  /* ---------- 화면 그리기 ---------- */

  function render() {
    if (!state.raw) return;
    let views;
    try {
      views = getViews();
    } catch (err) {
      setStatus(err.message, 'compute');
      return;
    }
    if (state.statusKind === 'compute') setStatus('');

    if (!views.krw && state.view === 'krw') state.view = 'native';
    const view = views[state.view];
    const cur = view.currency;
    const { base, thresholds } = readSettings();
    const buy = MDD.buyLine(view.distribution, base);

    $('result').hidden = false;
    renderControls(views);
    renderTitle(views, view, cur);
    renderKpis(view.summary, cur);
    renderLevels(view, cur, thresholds, buy, base);
    renderChart(view, cur, thresholds, buy);
    const ladderRows = renderLadder(view, cur, base, buy);
    renderEpisodes(view, ladderRows);
    renderYearly(view, cur);
    markWatch();
  }

  function renderControls(views) {
    const raw = state.raw;
    const nativeCur = raw.currency;
    $('currency').hidden = !nativeCur || nativeCur === 'KRW';
    $('currency-native').textContent = CURRENCY_NAMES[nativeCur] || nativeCur || '현지통화';
    for (const b of $('currency').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
      if (b.dataset.view === 'krw') {
        b.disabled = !views.krw;
        b.title = views.krw ? '' : (views.krwNote || '원화 기준을 계산할 수 없어요.');
      }
    }
    const adj = $('adjusted');
    adj.disabled = !raw.adj;
    adj.closest('label').title = raw.adj ? '' : '이 종목은 배당 반영 가격이 종가와 같아요.';
  }

  function renderTitle(views, view, cur) {
    const raw = state.raw;
    const s = view.summary;
    const title = raw.label || raw.name;
    $('name').textContent = title;
    document.title = `${title} · MDD 분석기`;

    const parts = [
      title !== raw.name ? raw.name : null,
      raw.symbol,
      TYPE_NAMES[raw.type] || raw.type,
      `${fmtDay(s.first_day)} ~ ${fmtDay(s.last_day)} · ${int(s.days)}거래일`,
      `${CURRENCY_NAMES[cur] || cur} 기준${views.adjusted ? ' · 배당 반영' : ''}`,
    ].filter(Boolean);
    $('symbol-meta').textContent = parts.join(' · ');

    // 이 화면의 발견: 지금 위치와, 그게 역사적으로 얼마나 흔한지
    const f = $('finding');
    f.replaceChildren();
    const since = `${fmtDay(s.first_day)} 이후 거래일의 `;
    if (s.current_dd > -0.0005) {
      f.append('지금이 조회 기간의 최고가예요. ', since, el('strong', { text: pct(s.deeper_than_now_pct) }), '는 지금보다 아래에 있었어요.');
    } else {
      f.append(
        `최고가 ${money(s.ath, cur)}(${fmtDay(s.ath_day)})보다 `, el('strong', { text: pct(-s.current_dd) }), ' 아래예요. ',
        since, el('strong', { text: pct(s.deeper_than_now_pct) }), '는 지금보다 깊이 빠져 있었어요.',
      );
    }
    const note = state.view === 'krw' || !views.krw ? views.krwNote : null;
    if (note) f.append(el('br'), note);
  }

  function kpi(label, value, sub, opts = {}) {
    return el('div', { class: opts.lead ? 'kpi lead' : 'kpi' },
      el('div', { class: 'kpi-label', text: label }),
      el('div', { class: opts.money ? 'kpi-value money' : 'kpi-value' }, value),
      sub ? el('div', { class: 'kpi-sub', text: sub }) : null);
  }

  function renderKpis(s, cur) {
    const longest = s.longest;
    $('kpis').replaceChildren(
      kpi('고점 대비 현재', pct(s.current_dd), `최고가 ${money(s.ath, cur)} · ${fmtDay(s.ath_day)}`, { lead: true }),
      kpi('현재가', money(s.last_close, cur), `${fmtDay(s.last_day)} 종가`, { money: true }),
      kpi('최대 하락', pct(s.mdd), `${fmtDay(s.mdd_peak_day)} → ${fmtDay(s.mdd_day)}`),
      kpi('평균 하락률', pct(s.avg_dd), '매일의 고점 대비 하락률 평균'),
      longest
        ? kpi('최장 하락 기간', spanNode(longest.calendar_days),
          `${fmtDay(longest.peak_day)} ~ ${longest.recovered ? fmtDay(longest.recovery_day) : '회복 중'}`)
        : kpi('최장 하락 기간', '–', '조회 기간 내내 최고가를 경신했어요'),
    );
  }

  function fillLevel(row, s, cur, level, extra) {
    const price = s.ath * (1 + level);
    const reached = s.current_dd <= level + 1e-12;
    const progress = level < 0 ? clamp(s.current_dd / level, 0, 1) : 1;
    row.querySelector('[data-role="price"]').textContent = money(price, cur);
    row.querySelector('[data-role="fill"]').style.width = `${(progress * 100).toFixed(1)}%`;
    const sub = row.querySelector('[data-role="sub"]');
    sub.replaceChildren();
    if (extra) sub.append(extra, ' · ');
    if (reached) sub.append(el('span', { class: 'reached', text: '도달' }), ' · 현재가가 이 가격 이하예요');
    else sub.append(`현재가보다 ${pct(1 - price / s.last_close)} 아래`);
  }

  function renderLevels(view, cur, thresholds, buy, base) {
    const s = view.summary;
    const rows = document.querySelectorAll('.levels .level');
    thresholds.forEach((t, i) => fillLevel(rows[i], s, cur, t.level));

    const buyRow = rows[3];
    buyRow.querySelector('[data-role="tag"]').textContent = buy ? pct(buy.level / 100, 0) : '';
    if (buy) fillLevel(buyRow, s, cur, buy.level / 100, `회복률 ${pct(buy.cum_pct)}`);

    const raw = state.raw;
    const typeName = TYPE_NAMES[raw.type] || raw.type || '이 종목';
    const preset = LOW_BASE_TYPES.has(raw.type) ? 80 : 90;
    const why = '회복률이 이 값을 처음 넘는 구간이에요.';
    $('base-hint').textContent = !state.baseTouched || Math.round(base * 100) === preset
      ? `${why} ${typeName} 기본값(ETF·지수 80%, 개별 종목 90%)이에요.`
      : `${why} ${typeName} 기본값은 ${preset}%예요.`;
  }

  /* ---------- 차트 ---------- */

  function timeTicks(min, max, width) {
    const years = (max - min) / (365.25 * 864e5);
    const maxTicks = clamp(Math.floor(width / 90), 3, 8);
    const ticks = [];
    if (years >= 2) {
      const step = [1, 2, 5, 10, 20, 25, 50].find((st) => years / st <= maxTicks) || 50;
      const startYear = new Date(min).getUTCFullYear();
      for (let y = Math.ceil(startYear / step) * step; ; y += step) {
        const t = Date.UTC(y, 0, 1);
        if (t > max) break;
        if (t >= min) ticks.push({ value: t });
      }
      return { ticks, mode: 'year' };
    }
    const months = years * 12;
    const step = [1, 2, 3, 6].find((st) => months / st <= maxTicks) || 6;
    const d0 = new Date(min);
    for (let k = d0.getUTCFullYear() * 12 + d0.getUTCMonth(); ; k++) {
      const t = Date.UTC(Math.floor(k / 12), k % 12, 1);
      if (t > max) break;
      if (t >= min && k % step === 0) ticks.push({ value: t });
    }
    return { ticks, mode: 'month' };
  }

  const overlaps = (a, b) => !(a.right < b.left - 4 || a.left > b.right + 4 || a.bottom < b.top || a.top > b.bottom);

  function labelBox(ctx, text, x, y, align) {
    const w = ctx.measureText(text).width;
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    return { left, right: left + w, top: y - 13, bottom: y + 2, text, x: left };
  }

  const overlayPlugin = {
    id: 'overlay',
    afterDatasetsDraw(ch, _args, opts) {
      const { ctx, chartArea: a, scales: { x, y } } = ch;
      const c = opts.colors;
      ctx.save();
      ctx.textBaseline = 'alphabetic';

      // 마우스 위치의 세로선
      const active = ch.tooltip && ch.tooltip.getActiveElements();
      if (active && active.length) {
        const px = Math.round(active[0].element.x) + 0.5;
        ctx.strokeStyle = c.control;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, a.top);
        ctx.lineTo(px, a.bottom);
        ctx.stroke();
      }

      // 기준선: 1px 점선, 이름은 오른쪽 끝 위에 (겹치면 뒤의 것은 생략 — 매수 기준가 카드에 모두 있다)
      const placed = [];
      for (const line of opts.lines) {
        const py = Math.round(y.getPixelForValue(line.value)) + 0.5;
        if (py < a.top || py > a.bottom) continue;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.left, py);
        ctx.lineTo(a.right, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `${line.bold ? 500 : 400} 12px ${c.font}`;
        const box = labelBox(ctx, line.label, a.right - 2, py - 5, 'right');
        if (box.top < a.top || placed.some((p) => overlaps(p, box))) continue;
        placed.push(box);
        ctx.fillStyle = c.surfaceAlpha;
        ctx.fillRect(box.left - 3, box.top - 1, box.right - box.left + 6, box.bottom - box.top + 2);
        ctx.fillStyle = line.bold ? c.text : c.faint;
        ctx.fillText(line.label, box.left, py - 5);
      }

      // 주석: 위쪽 줄에 이름, 점까지 1px 지시선 (현재, 최대 하락)
      const notes = [];
      for (const n of opts.notes) {
        const px = x.getPixelForValue(n.x);
        const py = y.getPixelForValue(n.y);
        ctx.font = `500 12px ${c.font}`;
        const w = ctx.measureText(n.label).width;
        let left = px - w / 2;
        left = clamp(left, a.left, a.right - w);
        const box = { left, right: left + w, top: a.top - 22, bottom: a.top - 8 };
        if (notes.some((p) => overlaps(p, box))) continue;
        notes.push(box);
        ctx.strokeStyle = c.text;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, a.top - 6);
        ctx.lineTo(Math.round(px) + 0.5, py - 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = n.hue ? c.hue : c.text;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = c.surface;
        ctx.stroke();
        ctx.fillStyle = c.text;
        ctx.fillText(n.label, left, a.top - 11);
      }
      ctx.restore();
    },
  };

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function renderChart(view, cur, thresholds, buy) {
    const s = view.summary;
    $('chart-sub').textContent = `${fmtDay(s.first_day)} ~ ${fmtDay(s.last_day)} · 일별 종가`;

    const box = $('chart-box');
    if (typeof Chart === 'undefined') {
      box.replaceChildren(el('p', { class: 'meta', text: '차트를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' }));
      return;
    }
    const sr = view.series;
    const n = sr.days.length;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = { x: sr.days[i] * 864e5, y: sr.dd[i] * 100, c: sr.close[i] };

    const c = {
      font: css('--font'), hue: css('--hue'), hueFill: css('--hue-fill'), text: css('--text'),
      muted: css('--muted'), faint: css('--faint'), grid: css('--grid'), control: css('--control'),
      surface: css('--surface'), border: css('--border'),
    };
    c.surfaceAlpha = hexToRgba(c.surface, 0.9);

    // y 눈금: 둥근 간격 4~7개, 맨 아래 눈금은 가장 깊은 값(최대 하락·기준선)보다 아래
    const deepest = Math.min(s.mdd * 100, ...thresholds.map((t) => t.level * 100), buy ? buy.level : 0);
    const step = deepest < -60 ? 20 : deepest < -30 ? 10 : 5;
    const ymin = Math.max(-100, Math.floor((deepest - step * 0.25) / step) * step);

    const lines = [];
    if (buy) lines.push({ value: buy.level, label: `저점매수 ${pct(buy.level / 100, 0)}`, color: c.text, bold: true });
    for (const t of thresholds) lines.push({ value: t.level * 100, label: `${t.name} ${pct(t.level, 0)}`, color: c.faint });

    // 주석: 현재 위치, 최대 하락 지점
    const mddI = sr.days.indexOf(s.mdd_day);
    const notes = [{ x: pts[n - 1].x, y: pts[n - 1].y, label: `현재 ${pct(s.current_dd)}`, hue: true }];
    if (mddI >= 0 && mddI !== n - 1) notes.push({ x: pts[mddI].x, y: pts[mddI].y, label: `최대 하락 ${pct(s.mdd)} · ${fmtDay(s.mdd_day).slice(0, 7)}` });

    let tickMode = 'year';
    Chart.defaults.font.family = c.font;
    Chart.defaults.font.size = 12;

    if (chart) chart.destroy();
    chart = new Chart($('chart'), {
      type: 'line',
      data: {
        datasets: [{
          data: pts,
          borderColor: c.hue,
          borderWidth: 1.5,
          backgroundColor: c.hueFill,
          fill: 'origin',
          pointRadius: 0,
          pointHitRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: c.surface,
          pointHoverBackgroundColor: c.hue,
          tension: 0,
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { top: 26, right: 4 } },
        plugins: {
          legend: { display: false },
          decimation: { enabled: true, algorithm: 'min-max' },
          overlay: { lines, notes, colors: c },
          tooltip: {
            displayColors: false,
            backgroundColor: c.surface,
            borderColor: c.border,
            borderWidth: 1,
            titleColor: c.muted,
            titleFont: { weight: '400', size: 12 },
            bodyColor: c.text,
            bodyFont: { weight: '500', size: 13 },
            padding: 8,
            cornerRadius: 6,
            caretSize: 0,
            callbacks: {
              title: (items) => fmtDay(Math.round(items[0].raw.x / 864e5)),
              label: (item) => [`고점 대비 ${pct(item.raw.y / 100)}`, `종가 ${money(item.raw.c, cur)}`],
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: pts[0].x,
            max: pts[n - 1].x,
            grid: { display: false },
            border: { display: false },
            afterBuildTicks: (axis) => {
              const res = timeTicks(axis.min, axis.max, axis.width || 700);
              tickMode = res.mode;
              axis.ticks = res.ticks;
            },
            ticks: {
              color: c.faint,
              maxRotation: 0,
              autoSkip: false,
              callback: (v) => {
                const d = new Date(v);
                if (tickMode === 'year') return String(d.getUTCFullYear());
                return `${String(d.getUTCFullYear()).slice(2)}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
              },
            },
          },
          y: {
            min: ymin,
            max: 0,
            grid: {
              // 0%(최고가) 선이 기준선이라 한 단계 진하게
              color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? c.control : c.grid),
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              color: c.faint,
              padding: 8,
              stepSize: step,
              callback: (v) => pct(v / 100, 0),
            },
          },
        },
      },
      plugins: [overlayPlugin],
    });
  }

  /* ---------- 표 ---------- */

  function pill(text, ink) {
    return el('span', { class: ink ? 'pill ink' : 'pill', text });
  }

  // 하락 사다리: 5% 구간마다 가격·회복률·머문 날. 최대 하락보다 깊은 구간은 한 줄로 줄인다.
  function renderLadder(view, cur, base, buy) {
    const rows = view.distribution;
    const s = view.summary;
    const current = rows.find((r) => s.current_dd >= r.level / 100 - MDD.EPS);
    const firstFull = rows.findIndex((r) => r.cum_pct >= 1 - 1e-12);
    const shown = rows.slice(0, firstFull >= 0 ? firstFull + 1 : rows.length);

    const head = el('thead', {}, el('tr', {},
      el('th', { text: '고점 대비' }),
      el('th', { text: '가격' }),
      el('th', { text: '회복률' }),
      el('th', { text: '조건일' }),
      el('th', { text: '구간 일수' }),
      el('th', { text: '비중' })));

    const body = el('tbody', {}, shown.map((r) => {
      const isBuy = buy && r.level === buy.level;
      const isCurrent = current && r.level === current.level;
      const cls = [isBuy ? 'buy' : '', isCurrent ? 'current' : ''].filter(Boolean).join(' ');
      return el('tr', { class: cls || null },
        el('td', {}, r.level === 0 ? '0% 최고가' : pct(r.level / 100, 0),
          isCurrent ? pill(`현재 ${pct(s.current_dd)}`) : null,
          isBuy ? pill('저점매수', true) : null),
        el('td', { text: money(s.ath * (1 + r.level / 100), cur) }),
        el('td', {},
          el('span', { class: 'meter', 'aria-hidden': 'true' },
            el('span', { style: { width: `${r.cum_pct * 100}%` } }),
            el('i', { style: { left: `${base * 100}%` } })),
          pct(r.cum_pct)),
        el('td', { text: int(r.days) }),
        el('td', { class: r.bucket_days ? null : 'quiet', text: int(r.bucket_days) }),
        el('td', { class: r.bucket_days ? null : 'quiet', text: pct(r.bucket_pct) }));
    }));

    $('dist').replaceChildren(head, body);
    const last = shown[shown.length - 1];
    $('dist-note').textContent = last && last.level > -100
      ? `${pct(last.level / 100, 0)}보다 깊이 빠진 날은 없었어요. 최대 하락은 ${pct(s.mdd)}예요.`
      : '';
    return shown.length;
  }

  function renderEpisodes(view, ladderRows) {
    const all = view.episodes.filter((e) => e.depth <= EPISODE_MIN_DEPTH + 1e-12).reverse();
    const mdd = view.summary.mdd;
    // 옆의 하락 사다리와 높이가 맞도록 줄 수를 맞춘다
    const cap = Math.max(4, ladderRows - 2);
    const list = state.showAllEpisodes ? all : all.slice(0, cap);

    const head = el('thead', {}, el('tr', {},
      el('th', { text: '고점 → 저점' }),
      el('th', { text: '하락률' }),
      el('th', { text: '하락 기간' }),
      el('th', { text: '회복 기간' })));

    const body = el('tbody', {}, list.length
      ? list.map((e) => el('tr', { title: e.recovered ? `${fmtDay(e.recovery_day)} 회복 · 전체 ${span(e.calendar_days)}` : '아직 회복 중' },
        el('td', { text: `${fmtDay(e.peak_day)} → ${fmtDay(e.trough_day)}` }),
        el('td', {}, Math.abs(e.depth - mdd) < 1e-12 ? el('strong', { text: pct(e.depth) }) : pct(e.depth)),
        el('td', { text: span(e.trough_day - e.peak_day) }),
        el('td', {}, e.recovered ? span(e.recovery_day - e.trough_day) : pill('회복 중'))))
      : el('tr', { class: 'empty-row' }, el('td', { colspan: '4', text: '조회 기간에 10% 넘게 빠진 적이 없어요.' })));
    $('episodes').replaceChildren(head, body);

    const more = $('episodes-more');
    more.hidden = all.length <= cap;
    more.textContent = state.showAllEpisodes ? '접기' : `모두 보기 (${all.length}개)`;
  }

  function renderYearly(view, cur) {
    const all = [...view.yearly].reverse();
    const list = state.showAllYears ? all : all.slice(0, YEARLY_CAP);
    const lastIso = MDD.dayToISO(view.summary.last_day);
    const firstIso = MDD.dayToISO(view.summary.first_day);
    const head = el('thead', {}, el('tr', {},
      el('th', { text: '연도' }),
      el('th', { text: '종가' }),
      el('th', { text: '연간 수익률' }),
      el('th', { text: '연중 최대 하락' }),
      el('th', { text: '연말 하락률' })));
    const body = el('tbody', {}, list.map((r) => {
      let label = String(r.year);
      if (r === all[0] && lastIso.slice(5) < '12-24') label += ` (${lastIso.slice(5).replace('-', '.')}까지)`;
      if (r.partial) label += ` (${firstIso.slice(5).replace('-', '.')}부터)`;
      return el('tr', {},
        el('td', { text: label }),
        el('td', { text: money(r.close, cur) }),
        el('td', { text: signedPct(r.return) }),
        el('td', { text: pct(r.min_dd) }),
        el('td', { class: r.end_dd > -0.0005 ? 'quiet' : null, text: pct(r.end_dd) }));
    }));
    $('yearly').replaceChildren(head, body);

    const more = $('yearly-more');
    more.hidden = all.length <= YEARLY_CAP;
    more.textContent = state.showAllYears ? '접기' : `모두 보기 (${all.length}년)`;
  }

  /* ---------- 종목 목록 ---------- */

  function ddFor(e) {
    const v = MODE === 'static' ? e.dd : state.ddByCode[norm(e.code)];
    return v == null ? '–' : pct(v);
  }

  function renderWatchlist() {
    $('watchlist').replaceChildren(...entries().map((e) =>
      el('a', { class: 'watch', href: `?q=${encodeURIComponent(e.code)}`, 'data-code': e.code, title: e.name || null },
        el('span', { class: 'watch-name', text: e.label || e.code }),
        el('span', { class: 'watch-dd', text: ddFor(e) }))));
    $('ticker-list').replaceChildren(...entries().map((e) =>
      el('option', { value: e.code, label: e.label || e.name || e.code })));
    filterWatchlist();
    markWatch();
  }

  function markWatch() {
    const current = norm(state.code);
    for (const a of $('watchlist').querySelectorAll('.watch')) {
      if (norm(a.dataset.code) === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // 검색창에 입력하면 목록을 거른다 (코드·이름·한글 이름)
  function filterWatchlist() {
    const q = norm($('q').value);
    const list = entries();
    for (const a of $('watchlist').querySelectorAll('.watch')) {
      const e = list.find((x) => x.code === a.dataset.code);
      a.hidden = !!q && !(e && [e.code, e.symbol, e.label, e.name].some((v) => v && norm(v).includes(q)));
    }
  }

  function openSheet(open) {
    document.body.classList.toggle('sheet-open', open);
    $('menu-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('q').focus();
  }

  /* ---------- 조회 조건 ---------- */

  function markPreset() {
    for (const b of $('presets').querySelectorAll('button[data-years]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.years) === state.preset));
    }
    const open = document.body.classList.contains('dates-open');
    $('custom-range').setAttribute('aria-pressed', String(state.preset == null || open));
    $('custom-range').setAttribute('aria-expanded', String(open));
  }

  function applyPreset(years) {
    state.preset = years;
    if (years === 0) {
      $('start').value = '';
    } else {
      const d = new Date();
      d.setFullYear(d.getFullYear() - years);
      $('start').value = localISO(d);
    }
    $('end').value = '';
    markPreset();
  }

  function updateDataInfo() {
    if (MODE === 'static') {
      const updated = new Date(state.catalog.generated_at);
      const when = updated.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      $('data-info').textContent = `${state.catalog.tickers.length}개 종목 · ${when} 갱신`;
    } else {
      $('data-info').textContent = '로컬 서버 · 아무 종목이나 검색';
    }
  }

  async function init() {
    $('watchlist').addEventListener('click', (e) => {
      const a = e.target.closest('.watch');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      $('q').value = '';
      filterWatchlist();
      openSheet(false);
      load(a.dataset.code);
    });
    $('search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('q').value.trim();
      if (!q) return;
      // 목록에서 하나만 남았으면 그 종목을 연다
      const visible = [...$('watchlist').querySelectorAll('.watch:not([hidden])')];
      const target = findEntry(q) ? q : (MODE === 'static' && visible.length === 1 ? visible[0].dataset.code : q);
      $('q').value = '';
      filterWatchlist();
      openSheet(false);
      load(target);
    });
    $('q').addEventListener('input', filterWatchlist);
    $('menu-toggle').addEventListener('click', () => openSheet(true));
    $('sheet-close').addEventListener('click', () => openSheet(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) openSheet(false);
    });

    $('presets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'custom-range') {
        // 휴대폰: 날짜 직접 입력 줄을 펼치거나 접는다
        const open = !document.body.classList.contains('dates-open');
        document.body.classList.toggle('dates-open', open);
        markPreset();
        if (open) $('start').focus();
        return;
      }
      document.body.classList.remove('dates-open');
      applyPreset(Number(b.dataset.years));
      updateUrl();
      render();
    });
    for (const id of ['start', 'end']) {
      $(id).addEventListener('change', () => {
        state.preset = null;
        markPreset();
        updateUrl();
        render();
      });
    }
    $('adjusted').addEventListener('change', () => {
      updateUrl();
      render();
    });
    $('base').addEventListener('input', () => {
      state.baseTouched = true;
      render();
    });
    for (const id of ['t1', 't2', 't3']) $(id).addEventListener('input', render);
    $('currency').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      state.view = b.dataset.view;
      render();
    });
    $('episodes-more').addEventListener('click', () => {
      state.showAllEpisodes = !state.showAllEpisodes;
      render();
    });
    $('yearly-more').addEventListener('click', () => {
      state.showAllYears = !state.showAllYears;
      render();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

    const p = new URLSearchParams(location.search);
    $('start').value = p.get('start') || '';
    $('end').value = p.get('end') || '';
    $('adjusted').checked = p.get('adjusted') === '1';
    state.preset = $('start').value || $('end').value ? null : 0;
    markPreset();

    try {
      await loadCatalog();
    } catch (err) {
      $('name').textContent = 'MDD 분석기';
      setStatus(err.message, 'error');
      return;
    }
    updateDataInfo();
    renderWatchlist();
    const list = entries();
    load(p.get('q') || (list.length ? list[0].code : 'QQQ'));
  }

  init();
})();
