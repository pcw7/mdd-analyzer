"""MDD 분석기 로컬 서버.

GitHub Pages에 올리는 site/ 화면을 그대로 띄우되, 미리 만든 종목 목록 대신
야후 파이낸스에서 아무 종목이나 바로 조회할 수 있게 해준다.

실행: python app.py  →  http://127.0.0.1:8050
"""

from __future__ import annotations

import argparse
import re
import threading
import webbrowser
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

import data

SITE_DIR = Path(__file__).resolve().parent / "site"

app = Flask(__name__, static_folder=None)


@app.get("/mode.js")
def mode():
    # 사이트의 site/mode.js('static')를 덮어써서 화면이 이 서버의 API를 쓰게 한다.
    return Response("window.MDD_MODE = 'api';\n", mimetype="text/javascript")


@app.get("/api/prices")
def api_prices():
    query = request.args.get("q", "")
    try:
        symbol, df, meta = data.load(query)
    except data.NotFound as exc:
        return _error(str(exc), 404)
    except Exception as exc:  # 네트워크 오류 등
        return _error(f"데이터를 가져오지 못했어요: {exc}", 502)
    return jsonify(data.payload(symbol, df, meta))


@app.get("/api/fx")
def api_fx():
    currency = request.args.get("currency", "").strip()
    if not re.fullmatch(r"[A-Z]{3}", currency):
        return _error("통화 코드가 올바르지 않아요.", 400)
    try:
        series = data.load_fx(currency)
    except Exception as exc:
        return _error(f"환율을 가져오지 못했어요: {exc}", 502)
    if series is None:
        return _error(f"{currency}/KRW 환율을 찾지 못했어요.", 404)
    return jsonify(data.fx_payload(currency, series))


@app.get("/")
def index():
    return send_from_directory(SITE_DIR, "index.html")


@app.get("/<path:path>")
def site_file(path: str):
    return send_from_directory(SITE_DIR, path)


def _error(message: str, status: int):
    return jsonify({"error": message}), status


def main() -> None:
    parser = argparse.ArgumentParser(description="MDD 분석기 로컬 서버")
    parser.add_argument("--port", type=int, default=8050)
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args()

    url = f"http://127.0.0.1:{args.port}"
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"MDD 분석기 실행 중: {url}  (종료: Ctrl+C)")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
