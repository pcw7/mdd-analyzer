(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MDD = window.MDD;

  // 'static' = GitHub Pages (미리 만든 data/ 파일), 'api' = 로컬 서버(app.py)로 아무 종목이나 조회
  const MODE = window.MDD_MODE === 'api' ? 'api' : 'static';

  const API_EXAMPLES = [
    { code: 'QQQ', label: 'QQQ' },
    { code: 'SPY', label: 'SPY' },
    { code: 'SOXX', label: 'SOXX' },
    { code: '005930', label: '삼성전자' },
    { code: 'BTCUSD', label: '비트코인' },
    { code: 'GCW00', label: '금' },
  ];
  // 회복률 기준을 80%로 두는 유형 (나머지는 90%)
  const LOW_BASE_TYPES = new Set(['ETF', 'INDEX', 'MUTUALFUND']);
  const CURRENCY_NAMES = { USD: '달러', KRW: '원화', JPY: '엔화', EUR: '유로', CNY: '위안', HKD: '홍콩달러', GBP: '파운드' };
  const TYPE_NAMES = {
    ETF: 'ETF', EQUITY: '주식', INDEX: '지수', CRYPTOCURRENCY: '암호화폐',
    FUTURE: '선물', MUTUALFUND: '펀드', CURRENCY: '환율',
  };
  const EPISODE_MIN_DEPTH = -0.10;

  const state = {
    catalog: null, // static 모드의 data/index.json
    raw: null, // 지금 보고 있는 종목의 가격
    fx: null, // 그 종목 통화의 원화 환율
    views: null,
    viewsKey: '',
    view: 'native',
    baseTouched: false,
    preset: 0,
    req: 0,
    statusKind: '',
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

  function pct(v, digits = 1) {
    if (v == null || !Number.isFinite(v)) return '–';
    let s = (v * 100).toFixed(digits);
    if (/^-0\.?0*$/.test(s)) s = s.slice(1);
    return s + '%';
  }

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

  function span(days) {
    if (days == null) return '–';
    if (days < 31) return `${days}일`;
    const months = Math.round(days / 30.44);
    if (months < 12) return `${months}개월`;
    const y = Math.floor(months / 12);
    const m = months % 12;
    return m ? `${y}년 ${m}개월` : `${y}년`;
  }

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
    $('status').textContent = text;
    $('status').classList.toggle('error', !!text && kind !== 'info');
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

  function findEntry(query) {
    const q = norm(query);
    const list = (state.catalog && state.catalog.tickers) || [];
    return list.find((e) => [e.code, e.symbol, e.label, e.name].some((v) => norm(v) === q)) || null;
  }

  async function getPrices(query) {
    if (MODE === 'api') {
      return cached(`p:${norm(query)}`, () => getJSON(`api/prices?q=${encodeURIComponent(query)}`));
    }
    const entry = findEntry(query);
    if (!entry) {
      throw new Error(`'${query}'는 이 사이트 종목 목록에 없어요. 아래 목록에서 골라 주세요.`);
    }
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
      const missing = err.status === 404;
      throw new Error(missing
        ? '아직 데이터가 없어요. python scripts/build_data.py 를 실행하거나, GitHub Actions 배포가 끝났는지 확인해 주세요.'
        : err.message);
    }
  }

  async function load() {
    const q = $('q').value.trim();
    if (!q) {
      setStatus('종목코드를 입력해 주세요.', 'error');
      return;
    }
    const my = ++state.req;
    setStatus(`${q.toUpperCase()} 불러오는 중…`);
    document.body.classList.add('loading');
    try {
      const raw = await getPrices(q);
      const fx = await getFx(raw.currency);
      if (my !== state.req) return;

      state.raw = raw;
      state.fx = fx;
      state.viewsKey = '';
      if (!state.baseTouched) $('base').value = LOW_BASE_TYPES.has(raw.type) ? 80 : 90;
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

  function updateUrl() {
    const params = new URLSearchParams({ q: $('q').value.trim() });
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
    renderHeadline(views, view, cur);
    renderTiles(view.summary, cur, buy, base);
    renderLevels(view.summary, cur, thresholds, buy);
    renderChart(view, cur, thresholds, buy);
    renderDistribution(view, base, buy);
    renderEpisodes(view);
    renderYearly(view, cur);
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

    const typeName = TYPE_NAMES[raw.type] || raw.type || '알 수 없음';
    $('base-hint').textContent = state.baseTouched
      ? 'ETF·지수 80%, 개별종목 90% 권장'
      : `유형: ${typeName} → 기본 ${LOW_BASE_TYPES.has(raw.type) ? 80 : 90}%`;
  }

  function renderHeadline(views, view, cur) {
    const raw = state.raw;
    const s = view.summary;
    const title = raw.label || raw.name;
    $('name').textContent = title;
    const parts = [
      title !== raw.name ? raw.name : null,
      raw.symbol,
      TYPE_NAMES[raw.type] || raw.type,
      `${fmtDay(s.first_day)} ~ ${fmtDay(s.last_day)}`,
      `${int(s.days)}거래일`,
      `${CURRENCY_NAMES[cur] || cur} 기준`,
      views.adjusted ? '수정주가' : null,
    ].filter(Boolean);
    $('symbol-meta').textContent = parts.join(' · ');

    $('hero').textContent = pct(s.current_dd);
    const text = $('hero-text');
    text.replaceChildren();
    if (s.current_dd > -0.0005) {
      text.append('지금이 조회 기간의 최고가예요. ',
        `조회 기간 ${int(s.days)}거래일 중 `, el('strong', { text: pct(s.deeper_than_now_pct) }),
        '는 지금보다 아래에 있었어요.');
    } else {
      text.append(
        `최고가 ${money(s.ath, cur)} (${fmtDay(s.ath_day)})보다 `,
        el('strong', { text: pct(-s.current_dd) }), ' 아래예요. ',
        `조회 기간 ${int(s.days)}거래일 중 `, el('strong', { text: pct(s.deeper_than_now_pct) }),
        '는 지금보다 더 깊이 빠져 있었어요.',
      );
    }

    const note = state.view === 'krw' || !views.krw ? views.krwNote : null;
    $('krw-note').hidden = !note;
    $('krw-note').textContent = note || '';
  }

  function tile(label, value, sub) {
    return el('div', { class: 'tile' },
      el('div', { class: 'tile-label', text: label }),
      el('div', { class: 'tile-value', text: value }),
      sub ? el('div', { class: 'tile-sub', text: sub }) : null);
  }

  function renderTiles(s, cur, buy, base) {
    const longest = s.longest;
    $('tiles').replaceChildren(
      tile('현재가', money(s.last_close, cur), fmtDay(s.last_day)),
      tile('과거 최고가', money(s.ath, cur), fmtDay(s.ath_day)),
      tile('최대 하락 (MDD)', pct(s.mdd), `${fmtDay(s.mdd_peak_day)} → ${fmtDay(s.mdd_day)}`),
      tile('평균 하락률', pct(s.avg_dd), '매일의 고점 대비 하락률 평균'),
      longest
        ? tile('최장 하락 기간', span(longest.calendar_days),
          `${fmtDay(longest.peak_day)} ~ ${longest.recovered ? fmtDay(longest.recovery_day) : '아직 회복 중'}`)
        : tile('최장 하락 기간', '없음', '조회 기간 내내 최고가를 경신했어요'),
      tile('저점매수 구간', buy ? `${buy.level}%` : '–',
        buy ? `회복률 ${pct(buy.cum_pct)} · 기준 ${pct(base, 0)} 첫 돌파` : ''),
    );
  }

  function renderLevels(s, cur, thresholds, buy) {
    const items = thresholds.map((t) => ({ ...t, buy: false }));
    if (buy) items.push({ name: '저점매수', level: buy.level / 100, buy: true });

    $('levels').replaceChildren(...items.map((item) => {
      const price = s.ath * (1 + item.level);
      const reached = s.last_close <= price;
      const gap = price / s.last_close - 1;
      return el('div', { class: item.buy ? 'level buy' : 'level' },
        el('div', { class: 'level-head' },
          el('span', { class: item.buy ? 'key accent' : 'key', 'aria-hidden': 'true' }),
          `${item.name} ${pct(item.level, 0)}`),
        el('div', { class: 'level-price', text: money(price, cur) }),
        el('div', { class: 'level-sub' },
          reached
            ? el('span', { class: 'tag reached', text: '도달 · 현재가가 이 가격 이하' })
            : `현재가보다 ${pct(-gap)} 아래`));
    }));
  }

  /* ---------- 차트 ---------- */

  function timeTicks(min, max, width) {
    const years = (max - min) / (365.25 * 864e5);
    const maxTicks = Math.max(2, Math.floor(width / 64));
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

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 글자 뒤에 배경을 깔아 선이나 면 위에서도 읽히게 한다.
  function drawLabel(ctx, text, x, y, align, colors, weight = 500) {
    ctx.font = `${weight} 11px ${colors.font}`;
    const w = ctx.measureText(text).width + 8;
    const h = 16;
    const left = align === 'right' ? x - w : x;
    ctx.fillStyle = colors.labelBg;
    roundRect(ctx, left, y - h / 2, w, h, 4);
    ctx.fill();
    ctx.fillStyle = colors.text2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 4, y + 0.5);
    return { left, top: y - h / 2, right: left + w, bottom: y + h / 2 };
  }

  const overlaps = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

  const overlayPlugin = {
    id: 'overlay',
    afterDatasetsDraw(ch, _args, opts) {
      const { ctx, chartArea: a, scales: { x, y } } = ch;
      const colors = opts.colors;
      ctx.save();

      // 마우스 위치의 세로선
      const active = ch.tooltip && ch.tooltip.getActiveElements();
      if (active && active.length) {
        const px = Math.round(active[0].element.x) + 0.5;
        ctx.strokeStyle = colors.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, a.top);
        ctx.lineTo(px, a.bottom);
        ctx.stroke();
      }

      // 기준선
      for (const line of opts.lines) {
        const py = Math.round(y.getPixelForValue(line.value)) + 0.5;
        if (py < a.top || py > a.bottom) continue;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.width;
        ctx.setLineDash(line.dash);
        ctx.beginPath();
        ctx.moveTo(a.left, py);
        ctx.lineTo(a.right, py);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 기준선 이름: 겹치면 뒤의 것을 생략한다(매수 기준가 카드에 모두 있다).
      const placed = [];
      for (const line of opts.lines) {
        const py = y.getPixelForValue(line.value);
        if (py < a.top || py > a.bottom) continue;
        const ly = py - 10;
        const weight = line.bold ? 650 : 500;
        ctx.font = `${weight} 11px ${colors.font}`;
        const w = ctx.measureText(line.label).width + 8;
        const box = { left: a.left + 6, right: a.left + 6 + w, top: ly - 8, bottom: ly + 8 };
        if (box.top < a.top || placed.some((p) => overlaps(p, box))) continue;
        placed.push(drawLabel(ctx, line.label, a.left + 6, ly, 'left', colors, weight));
      }

      // 현재 위치 점
      const last = opts.last;
      if (last) {
        const px = x.getPixelForValue(last.x);
        const py = y.getPixelForValue(last.y);
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = colors.surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = colors.series;
        ctx.fill();
        const ly = py - 18 > a.top + 8 ? py - 18 : py + 18;
        drawLabel(ctx, `현재 ${last.label}`, px - 4, ly, 'right', colors, 650);
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
    $('chart-sub').textContent =
      `${fmtDay(view.summary.first_day)} ~ ${fmtDay(view.summary.last_day)} · ${CURRENCY_NAMES[cur] || cur} 기준 · 일별 종가`;

    const box = $('chart-box');
    if (typeof Chart === 'undefined') {
      box.replaceChildren(el('p', { class: 'sub', text: '차트 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' }));
      return;
    }
    const s = view.series;
    const n = s.days.length;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = { x: s.days[i] * 864e5, y: s.dd[i] * 100, c: s.close[i] };

    const colors = {
      font: css('--font'),
      series: css('--series-1'),
      accent: css('--accent'),
      axis: css('--axis'),
      grid: css('--grid'),
      muted: css('--text-muted'),
      text1: css('--text-primary'),
      text2: css('--text-secondary'),
      surface: css('--surface-1'),
    };
    colors.labelBg = hexToRgba(colors.surface, 0.88);

    const minThreshold = Math.min(...thresholds.map((t) => t.level)) * 100;
    const ymin = Math.max(-100, Math.min(
      -10,
      Math.floor((view.summary.mdd * 100 - 3) / 10) * 10,
      Math.floor((minThreshold - 5) / 10) * 10,
    ));

    const lines = [];
    if (buy) {
      lines.push({ value: buy.level, label: `저점매수 ${buy.level}%`, color: colors.accent, width: 1.5, dash: [6, 4], bold: true });
    }
    for (const t of thresholds) {
      lines.push({ value: t.level * 100, label: `${t.name} ${pct(t.level, 0)}`, color: colors.muted, width: 1, dash: [3, 4], bold: false });
    }

    const lastPt = pts[n - 1];
    let tickMode = 'year';

    Chart.defaults.font.family = colors.font;
    Chart.defaults.font.size = 11;

    if (chart) chart.destroy();
    chart = new Chart($('chart'), {
      type: 'line',
      data: {
        datasets: [{
          data: pts,
          borderColor: colors.series,
          borderWidth: 1.5,
          backgroundColor: hexToRgba(colors.series, 0.14),
          fill: 'origin',
          pointRadius: 0,
          pointHitRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBorderColor: colors.surface,
          pointHoverBackgroundColor: colors.series,
          tension: 0,
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { top: 6, right: 8 } },
        plugins: {
          legend: { display: false },
          decimation: { enabled: true, algorithm: 'min-max' },
          overlay: { lines, colors, last: { x: lastPt.x, y: lastPt.y, label: pct(lastPt.y / 100) } },
          tooltip: {
            displayColors: false,
            backgroundColor: colors.surface,
            borderColor: colors.axis,
            borderWidth: 1,
            titleColor: colors.text2,
            titleFont: { weight: '500', size: 11 },
            bodyColor: colors.text1,
            bodyFont: { weight: '600', size: 12 },
            padding: 10,
            cornerRadius: 8,
            caretSize: 0,
            callbacks: {
              title: (items) => fmtDay(Math.round(items[0].raw.x / 864e5)),
              label: (item) => [`${pct(item.raw.y / 100)}  고점 대비`, `${money(item.raw.c, cur)}  종가`],
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: pts[0].x,
            max: lastPt.x,
            grid: { display: false },
            border: { color: colors.axis },
            afterBuildTicks: (axis) => {
              const res = timeTicks(axis.min, axis.max, axis.width || 800);
              tickMode = res.mode;
              axis.ticks = res.ticks;
            },
            ticks: {
              color: colors.muted,
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
            grid: { color: colors.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: colors.muted,
              padding: 8,
              stepSize: -ymin > 50 ? 10 : 5,
              callback: (v) => `${v}%`,
            },
          },
        },
      },
      plugins: [overlayPlugin],
    });
  }

  /* ---------- 표 ---------- */

  function tag(text, dotClass) {
    return el('span', { class: 'tag' }, el('span', { class: `dot ${dotClass}`, 'aria-hidden': 'true' }), text);
  }

  function renderDistribution(view, base, buy) {
    const rows = view.distribution;
    const s = view.summary;
    const current = rows.find((r) => s.current_dd >= r.level / 100 - MDD.EPS);
    const firstFull = rows.findIndex((r) => r.cum_pct >= 1 - 1e-12);
    const maxBucket = Math.max(...rows.map((r) => r.bucket_pct), 1e-9);

    const head = el('thead', {}, el('tr', {},
      el('th', { text: '구간' }),
      el('th', { text: '회복률' }),
      el('th', { text: '조건일' }),
      el('th', { text: '구간 일수' }),
      el('th', { text: '비중' })));

    const body = el('tbody', {}, rows.map((r, i) => {
      const isBuy = buy && r.level === buy.level;
      const isCurrent = current && r.level === current.level;
      const beyondMdd = firstFull >= 0 && i > firstFull;
      const classes = [isBuy ? 'buy' : '', !isBuy && isCurrent ? 'current' : '', beyondMdd ? 'muted' : '']
        .filter(Boolean).join(' ');
      const tags = [];
      if (isBuy) tags.push(tag('저점매수', 'accent'));
      if (isCurrent) tags.push(tag(`현재 ${pct(s.current_dd)}`, 'series'));

      return el('tr', { class: classes || null },
        el('td', {}, r.level === 0 ? '0% 최고가' : `${r.level}%`,
          tags.length ? el('span', { class: 'tags' }, tags) : null),
        el('td', {},
          el('span', { class: 'meter', 'aria-hidden': 'true' },
            el('span', { style: { width: `${r.cum_pct * 100}%` } }),
            el('i', { style: { left: `calc(${base * 100}% - 1px)` } })),
          pct(r.cum_pct)),
        el('td', { text: int(r.days) }),
        el('td', { text: int(r.bucket_days) }),
        el('td', {},
          el('span', { class: 'bar', 'aria-hidden': 'true', style: { width: `${(r.bucket_pct / maxBucket) * 32}px` } }),
          pct(r.bucket_pct)));
    }));

    $('dist').replaceChildren(head, body);
  }

  function renderEpisodes(view) {
    const list = view.episodes.filter((e) => e.depth <= EPISODE_MIN_DEPTH + 1e-12).reverse();
    const mdd = view.summary.mdd;

    const head = el('thead', {}, el('tr', {},
      el('th', { text: '고점' }),
      el('th', { text: '저점' }),
      el('th', { text: '하락률' }),
      el('th', { text: '하락 기간' }),
      el('th', { text: '회복' }),
      el('th', { text: '회복 기간' }),
      el('th', { text: '전체 기간' })));

    const body = el('tbody', {}, list.length
      ? list.map((e) => el('tr', {},
        el('td', { text: fmtDay(e.peak_day) }),
        el('td', { text: fmtDay(e.trough_day) }),
        el('td', {}, Math.abs(e.depth - mdd) < 1e-12 ? el('strong', { text: pct(e.depth) }) : pct(e.depth)),
        el('td', { text: span(e.trough_day - e.peak_day) }),
        el('td', {}, e.recovered ? fmtDay(e.recovery_day) : tag('회복 중', 'series')),
        el('td', { text: e.recovered ? span(e.recovery_day - e.trough_day) : '–' }),
        el('td', { text: e.recovered ? span(e.calendar_days) : `${span(e.calendar_days)}+` })))
      : el('tr', {}, el('td', { colspan: '7', text: '조회 기간에 10% 넘게 빠진 적이 없어요.' })));

    $('episodes').replaceChildren(head, body);
  }

  function renderYearly(view, cur) {
    const rows = [...view.yearly].reverse();
    const lastIso = MDD.dayToISO(view.summary.last_day);
    const firstIso = MDD.dayToISO(view.summary.first_day);
    const head = el('thead', {}, el('tr', {},
      el('th', { text: '연도' }),
      el('th', { text: '종가' }),
      el('th', { text: '연간 수익률' }),
      el('th', { text: '연중 최대 하락' }),
      el('th', { text: '연말 하락률' })));
    const body = el('tbody', {}, rows.map((r, i) => {
      let label = String(r.year);
      if (i === 0 && lastIso.slice(5) < '12-24') label += ` (${lastIso.slice(5).replace('-', '.')}까지)`;
      if (r.partial) label += ` (${firstIso.slice(5).replace('-', '.')}부터)`;
      return el('tr', {},
        el('td', { text: label }),
        el('td', { text: money(r.close, cur) }),
        el('td', { text: `${r.return > 0 ? '+' : ''}${pct(r.return)}` }),
        el('td', { text: pct(r.min_dd) }),
        el('td', { text: pct(r.end_dd) }));
    }));
    $('yearly').replaceChildren(head, body);
  }

  /* ---------- 조회 조건 ---------- */

  function markPreset() {
    for (const b of $('presets').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.years) === state.preset));
    }
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

  function fillTickerChoices() {
    const list = MODE === 'api' ? API_EXAMPLES : state.catalog.tickers;
    $('examples').replaceChildren(...list.map((e) =>
      el('button', { type: 'button', 'data-q': e.code, title: e.name || null, text: e.label || e.code })));
    $('ticker-list').replaceChildren(...list.map((e) =>
      el('option', { value: e.code, label: e.label || e.name || e.code })));

    if (MODE === 'static') {
      const updated = new Date(state.catalog.generated_at);
      $('data-info').textContent = `이 사이트에서 볼 수 있는 종목 ${state.catalog.tickers.length}개 · 데이터 갱신 ${
        updated.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' })} (한국시간)`;
    } else {
      $('data-info').textContent = '로컬 서버 모드: 야후 파이낸스에서 아무 종목이나 바로 조회해요.';
    }
  }

  async function init() {
    $('examples').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('q').value = b.dataset.q;
      load();
    });
    $('controls').addEventListener('submit', (e) => {
      e.preventDefault();
      load();
    });
    $('presets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
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
      setStatus(err.message, 'error');
      return;
    }
    fillTickerChoices();
    const first = MODE === 'static' && state.catalog.tickers.length ? state.catalog.tickers[0].code : 'QQQ';
    $('q').value = p.get('q') || first;
    load();
  }

  init();
})();
