"""야후 파이낸스(yfinance)에서 가격과 환율을 받아와 사이트용 JSON으로 만든다."""

from __future__ import annotations

import logging
import math
import re
import threading
import time

import pandas as pd
import yfinance as yf

# 없는 종목을 조회할 때 yfinance가 콘솔에 남기는 오류 로그를 숨긴다.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# 구글 시트(GOOGLEFINANCE) 식 코드나 자주 쓰는 이름을 야후 코드로 바꾼다.
ALIASES = {
    "BTCUSD": "BTC-USD",
    "ETHUSD": "ETH-USD",
    "GCW00": "GC=F",  # 금 선물
    "SIW00": "SI=F",  # 은 선물
    "CLW00": "CL=F",  # WTI 원유 선물
    "KOSPI": "^KS11",
    "KOSDAQ": "^KQ11",
    "SPX": "^GSPC",
    "NDX": "^NDX",
    "USDKRW": "KRW=X",
}

# 국내 종목코드: 숫자 6자리, 또는 숫자로 시작하는 6자리 영숫자(신규 ETF 등)
KR_CODE = re.compile(r"^[0-9][0-9A-Z]{5}$")

# 없는 코드면 yfinance가 빈 표 대신 이런 오류를 낼 때가 있다.
# (네트워크 오류는 그대로 올려보내서 따로 알려준다.)
LOOKUP_ERRORS = (KeyError, ValueError, TypeError, IndexError)

CACHE_TTL = 15 * 60  # 초
_cache: dict[str, tuple[float, pd.DataFrame | None, dict]] = {}
_lock = threading.Lock()

EPOCH = pd.Timestamp("1970-01-01")


class NotFound(Exception):
    pass


def candidates(query: str) -> list[str]:
    """사용자가 입력한 코드를 시도해볼 야후 코드 목록으로 바꾼다."""
    code = re.sub(r"\s+", "", query).upper()
    if not code:
        return []
    code = ALIASES.get(code, code)
    if KR_CODE.match(code):
        return [f"{code}.KS", f"{code}.KQ"]
    return [code]


def fx_symbol(currency: str) -> str | None:
    """해당 통화를 원화로 바꿀 환율 코드. 원화면 None."""
    if not currency or currency == "KRW":
        return None
    if currency == "USD":
        return "KRW=X"
    return f"{currency}KRW=X"


def _download(symbol: str) -> tuple[pd.DataFrame | None, dict]:
    with _lock:
        hit = _cache.get(symbol)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1], hit[2]

    ticker = yf.Ticker(symbol)
    df = ticker.history(period="max", auto_adjust=False, actions=False)
    meta = dict(ticker.history_metadata or {})
    if df is None or df.empty or "Close" not in df:
        df = None
    else:
        df = df[["Close", "Adj Close"]].copy()
        # 거래소 현지 날짜만 남긴다(시간대 제거).
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
        df.index = df.index.normalize()
        df = df[~df.index.duplicated(keep="last")].sort_index()
        df = df.dropna(subset=["Close"])
        # 영국 주식은 펜스(GBp)로 나온다 → 파운드로 바꾼다.
        if meta.get("currency") == "GBp":
            df = df / 100
            meta["currency"] = "GBP"
        if df.empty:
            df = None

    with _lock:
        _cache[symbol] = (time.time(), df, meta)
    return df, meta


def load(query: str) -> tuple[str, pd.DataFrame, dict]:
    """입력한 코드로 종목을 찾아 (야후 코드, 가격표, 메타데이터)를 돌려준다."""
    tried = candidates(query)
    if not tried:
        raise NotFound("종목코드를 입력해 주세요.")
    for symbol in tried:
        try:
            df, meta = _download(symbol)
        except LOOKUP_ERRORS:
            continue
        if df is not None:
            return symbol, df, meta
    raise NotFound(f"'{query.strip()}' 종목을 찾지 못했어요. 코드를 다시 확인해 주세요.")


def load_fx(currency: str) -> pd.Series | None:
    """통화 → 원화 환율 종가. 구할 수 없으면 None."""
    symbol = fx_symbol(currency)
    if symbol is None:
        return None
    try:
        df, _ = _download(symbol)
    except LOOKUP_ERRORS:
        return None
    if df is None:
        return None
    return df["Close"]


def _days(index: pd.DatetimeIndex) -> list[int]:
    return [int(d) for d in (index - EPOCH) // pd.Timedelta(days=1)]


def _sig(value: float, digits: int = 7) -> float | None:
    """유효숫자 digits자리로 줄여 파일 크기를 줄인다(하락률 계산에는 영향 없는 수준)."""
    value = float(value)
    if not math.isfinite(value):
        return None
    return float(f"{value:.{digits}g}")


def payload(symbol: str, df: pd.DataFrame, meta: dict) -> dict:
    """사이트와 로컬 서버가 함께 쓰는 종목 가격 JSON."""
    close = df["Close"]
    adj = df["Adj Close"].fillna(close)
    same = bool(((adj - close).abs() <= close.abs() * 1e-9).all())
    return {
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "type": meta.get("instrumentType") or "",
        "currency": meta.get("currency") or "",
        "exchange": meta.get("exchangeName") or "",
        "d": _days(df.index),
        "close": [_sig(v) for v in close],
        # 배당 반영 가격이 종가와 같으면(암호화폐 등) 생략한다.
        "adj": None if same else [_sig(v) for v in adj],
    }


def fx_payload(currency: str, series: pd.Series) -> dict:
    """원화 환율 JSON."""
    series = series.dropna()
    return {
        "currency": currency,
        "symbol": fx_symbol(currency),
        "d": _days(series.index),
        "close": [_sig(v) for v in series],
    }
