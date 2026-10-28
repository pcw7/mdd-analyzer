"""GitHub Pages 사이트에 올릴 가격 데이터를 만든다.

tickers.json에 적힌 종목을 야후 파이낸스에서 받아 site/data/에 JSON으로 저장한다.
GitHub Actions가 매일 실행하며, 직접 실행해도 된다:

    python scripts/build_data.py
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import data  # noqa: E402

TICKERS_FILE = ROOT / "tickers.json"
OUT_DIR = ROOT / "site" / "data"
RETRIES = 2


def file_name(symbol: str) -> str:
    """야후 코드를 파일 이름으로 쓸 수 있게 바꾼다. 예: ^KS11 → idx-KS11, GC=F → GC_F

    GitHub Pages는 밑줄(_)로 시작하는 파일을 무시할 수 있어서 지수(^)는 idx-로 바꾼다.
    """
    return re.sub(r"[^A-Za-z0-9.-]", "_", symbol.replace("^", "idx-")) + ".json"


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def with_retry(fn, label: str, sleep=time.sleep):
    """일시적인 네트워크 오류는 몇 번 더 시도한다. 없는 종목(NotFound)은 바로 넘긴다."""
    for attempt in range(RETRIES + 1):
        try:
            return fn()
        except data.NotFound:
            raise
        except Exception as exc:
            if attempt == RETRIES:
                raise
            print(f"  {label}: {exc} → {attempt + 1}번째 재시도")
            sleep(2 * (attempt + 1))


def build(tickers: list[dict], out_dir: Path = OUT_DIR, sleep=time.sleep) -> dict:
    # 지난번에 만든 파일이 남지 않도록 비우고 시작한다.
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    entries: list[dict] = []
    failures: list[tuple[str, str]] = []
    currencies: set[str] = set()
    seen: set[str] = set()

    for item in tickers:
        code = str(item["code"]).strip()
        try:
            symbol, df, meta = with_retry(lambda: data.load(code), code, sleep)
        except Exception as exc:
            failures.append((code, str(exc)))
            print(f"✗ {code}: {exc}")
            continue
        if symbol in seen:
            continue
        seen.add(symbol)

        p = data.payload(symbol, df, meta)
        name = file_name(symbol)
        write_json(out_dir / name, p)
        entries.append(
            {
                "code": code,
                "label": item.get("label") or None,  # 없으면 화면에서 코드를 보여준다
                "symbol": symbol,
                "name": p["name"],
                "type": p["type"],
                "currency": p["currency"],
                "file": name,
                "first": p["d"][0],
                "last": p["d"][-1],
            }
        )
        if p["currency"] and p["currency"] != "KRW":
            currencies.add(p["currency"])
        print(f"✓ {code} → {symbol} ({len(p['d'])}일)")

    fx_files: dict[str, str] = {}
    for currency in sorted(currencies):
        try:
            series = with_retry(lambda: data.load_fx(currency), f"{currency}/KRW", sleep)
        except Exception as exc:
            series = None
            print(f"✗ {currency}/KRW 환율: {exc}")
        if series is None:
            failures.append((f"{currency}/KRW", "환율을 찾지 못했어요"))
            continue
        rel = f"fx/{currency}.json"
        write_json(out_dir / rel, data.fx_payload(currency, series))
        fx_files[currency] = rel
        print(f"✓ {currency}/KRW 환율")

    write_json(
        out_dir / "index.json",
        {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "Yahoo Finance (yfinance)",
            "tickers": entries,
            "fx": fx_files,
        },
    )
    return {"ok": len(entries), "failures": failures}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    tickers = json.loads(TICKERS_FILE.read_text(encoding="utf-8"))
    result = build(tickers)
    print(f"\n완료: {result['ok']}개 종목 저장 → {OUT_DIR}")
    if result["failures"]:
        print(f"실패 {len(result['failures'])}건: " + ", ".join(code for code, _ in result["failures"]))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
