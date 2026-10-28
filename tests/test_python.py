import json
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as app_module  # noqa: E402
import data  # noqa: E402
from scripts import build_data  # noqa: E402


def frame(values, start="2010-01-01", adj_factor=None):
    idx = pd.bdate_range(start, periods=len(values))
    close = pd.Series(values, index=idx, dtype=float)
    adj = close * adj_factor if adj_factor else close.copy()
    return pd.DataFrame({"Close": close, "Adj Close": adj})


def strict_json(text):
    def reject(constant):
        raise AssertionError(f"JSON에 {constant} 값이 있어요")

    return json.loads(text, parse_constant=reject)


# ---------- data.py ----------


@pytest.mark.parametrize(
    "query, expected",
    [
        ("qqq", ["QQQ"]),
        (" 005930 ", ["005930.KS", "005930.KQ"]),
        ("0091P0", ["0091P0.KS", "0091P0.KQ"]),
        ("BTCUSD", ["BTC-USD"]),
        ("GCW00", ["GC=F"]),
        ("KOSPI", ["^KS11"]),
        ("7203.T", ["7203.T"]),
        ("", []),
    ],
)
def test_candidates(query, expected):
    assert data.candidates(query) == expected


def test_load_treats_yfinance_key_error_as_not_found(monkeypatch):
    def broken(symbol):
        raise KeyError("tradingPeriods")

    monkeypatch.setattr(data, "_download", broken)
    with pytest.raises(data.NotFound):
        data.load("ZZZZQ")


def test_load_falls_back_to_kosdaq(monkeypatch):
    df = frame([1.0, 2.0])
    monkeypatch.setattr(data, "_download", lambda s: (df, {"currency": "KRW"}) if s.endswith(".KQ") else (None, {}))
    symbol, _, _ = data.load("247540")
    assert symbol == "247540.KQ"


def test_payload_uses_day_numbers_and_rounds():
    df = frame([709.8012345678, 759.66], start="2026-10-15", adj_factor=0.99)
    p = data.payload("QQQ", df, {"longName": "Invesco QQQ Trust", "currency": "USD", "instrumentType": "ETF"})
    assert p["d"] == [20741, 20742]  # 1970-01-01부터 센 날 수: 2026-10-15, 2026-10-16
    assert p["close"] == [709.8012, 759.66]  # 유효숫자 7자리
    assert p["adj"] is not None
    assert p["name"] == "Invesco QQQ Trust"
    assert p["type"] == "ETF"
    strict_json(json.dumps(p))


def test_payload_drops_adj_when_same_as_close():
    p = data.payload("BTC-USD", frame([1.0, 2.0]), {"currency": "USD"})
    assert p["adj"] is None
    assert p["name"] == "BTC-USD"


def test_fx_payload():
    s = pd.Series([1300.0, None, 1310.5], index=pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-05"]))
    p = data.fx_payload("USD", s)
    assert p["symbol"] == "KRW=X"
    assert p["close"] == [1300.0, 1310.5]
    assert len(p["d"]) == 2


# ---------- app.py (로컬 서버) ----------


@pytest.fixture
def client(monkeypatch):
    df = frame([100, 120, 90, 60, 130, 117])
    fx = pd.Series(1300.0, index=df.index[3:])

    def fake_load(query):
        if query.strip().upper() != "TEST":
            raise data.NotFound("없음")
        return "TEST", df, {"currency": "USD", "longName": "Test Corp", "instrumentType": "ETF"}

    monkeypatch.setattr(data, "load", fake_load)
    monkeypatch.setattr(data, "load_fx", lambda currency: fx if currency == "USD" else None)
    return app_module.app.test_client()


def test_mode_js_switches_site_to_api_mode(client):
    resp = client.get("/mode.js")
    assert resp.status_code == 200
    assert "'api'" in resp.get_data(as_text=True)


def test_serves_site_files(client):
    assert "MDD 분석기" in client.get("/").get_data(as_text=True)
    assert client.get("/mdd.js").status_code == 200
    assert client.get("/no-such-file.js").status_code == 404


def test_api_prices(client):
    resp = client.get("/api/prices?q=test")
    assert resp.status_code == 200
    body = strict_json(resp.get_data(as_text=True))
    assert body["symbol"] == "TEST"
    assert body["close"] == [100, 120, 90, 60, 130, 117]
    assert client.get("/api/prices?q=NOPE").status_code == 404


def test_api_fx(client):
    body = strict_json(client.get("/api/fx?currency=USD").get_data(as_text=True))
    assert body["close"] == [1300.0, 1300.0, 1300.0]
    assert client.get("/api/fx?currency=JPY").status_code == 404
    assert client.get("/api/fx?currency=usd!").status_code == 400


# ---------- scripts/build_data.py ----------


def test_file_name():
    assert build_data.file_name("^KS11") == "idx-KS11.json"
    assert build_data.file_name("GC=F") == "GC_F.json"
    assert build_data.file_name("005930.KS") == "005930.KS.json"


def test_build_writes_index_prices_and_fx(monkeypatch, tmp_path):
    frames = {
        "QQQ": ("QQQ", frame([1.0, 2.0, 1.5]), {"currency": "USD", "longName": "Invesco QQQ Trust", "instrumentType": "ETF"}),
        "005930": ("005930.KS", frame([5.0, 6.0]), {"currency": "KRW", "longName": "Samsung", "instrumentType": "EQUITY"}),
    }
    calls = {"flaky": 0}

    def fake_load(code):
        if code == "FLAKY":
            calls["flaky"] += 1
            if calls["flaky"] < 2:
                raise ConnectionError("잠깐 끊김")
            return frames["QQQ"]  # 같은 종목이 또 나오면 한 번만 저장
        if code not in frames:
            raise data.NotFound("없음")
        return frames[code]

    monkeypatch.setattr(data, "load", fake_load)
    monkeypatch.setattr(data, "load_fx", lambda cur: pd.Series([1300.0], index=pd.to_datetime(["2010-01-01"])))

    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "stale.json").write_text("{}")
    result = build_data.build(
        [{"code": "QQQ"}, {"code": "005930", "label": "삼성전자"}, {"code": "NOPE"}, {"code": "FLAKY"}],
        out_dir=tmp_path / "data",
        sleep=lambda s: None,
    )

    assert result["ok"] == 2
    assert [code for code, _ in result["failures"]] == ["NOPE"]
    assert calls["flaky"] == 2
    assert not (tmp_path / "data" / "stale.json").exists()

    index = strict_json((tmp_path / "data" / "index.json").read_text(encoding="utf-8"))
    assert [t["label"] for t in index["tickers"]] == [None, "삼성전자"]
    assert index["tickers"][0]["name"] == "Invesco QQQ Trust"
    # 종목 목록용 요약: 1.0 → 2.0(고점) → 1.5 이면 현재 -25%
    assert index["tickers"][0]["last_close"] == 1.5
    assert index["tickers"][0]["dd"] == -0.25
    assert index["fx"] == {"USD": "fx/USD.json"}
    assert (tmp_path / "data" / "QQQ.json").exists()
    assert (tmp_path / "data" / "005930.KS.json").exists()
    assert (tmp_path / "data" / "fx" / "USD.json").exists()
