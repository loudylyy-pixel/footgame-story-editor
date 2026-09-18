#!/usr/bin/env python3
"""剧情路线编辑器（本地 / Render）：静态页 + 读写 story_graph.json。
云端用 GitHub 仓库文件做持久化：闲置休眠后数据不丢，地址不变。
环境变量（Render）：
  PORT          默认 8765
  GITHUB_TOKEN  有 repo 写权限的 PAT（或 gho_）
  GITHUB_REPO   如 loudylyy-pixel/footgame-story-editor
  GITHUB_BRANCH 默认 main
  GRAPH_PATH    默认 story_graph.json
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
GRAPH = ROOT / os.environ.get("GRAPH_PATH", "story_graph.json")
PORT = int(os.environ.get("PORT", "8765"))
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
GH_REPO = os.environ.get("GITHUB_REPO", "").strip()
GH_BRANCH = os.environ.get("GITHUB_BRANCH", "main").strip()
GRAPH_PATH = os.environ.get("GRAPH_PATH", "story_graph.json").strip()


def _tz_now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat()


def _gh_headers():
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {GH_TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "footgame-story-editor",
    }


def _gh_enabled() -> bool:
    return bool(GH_TOKEN and GH_REPO)


def load_graph_bytes() -> bytes:
    """Prefer GitHub (durable across sleep); fall back to local file."""
    if _gh_enabled():
        url = f"https://api.github.com/repos/{GH_REPO}/contents/{GRAPH_PATH}?ref={GH_BRANCH}"
        req = urllib.request.Request(url, headers=_gh_headers())
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                meta = json.loads(resp.read().decode("utf-8"))
            content_b64 = meta.get("content", "").replace("\n", "")
            raw = base64.b64decode(content_b64)
            # keep local mirror warm
            try:
                GRAPH.write_bytes(raw)
            except OSError:
                pass
            return raw
        except Exception as e:
            print(f"[warn] GitHub load failed: {e}; using local file")
    if not GRAPH.exists():
        empty = {
            "version": 3,
            "title": "空白线路板",
            "nodes": [],
            "edges": [],
            "updatedAt": _tz_now(),
        }
        raw = (json.dumps(empty, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        GRAPH.write_bytes(raw)
        return raw
    return GRAPH.read_bytes()


def save_graph_obj(obj: dict) -> dict:
    obj["updatedAt"] = _tz_now()
    text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    raw = text.encode("utf-8")
    try:
        GRAPH.write_bytes(raw)
    except OSError as e:
        print(f"[warn] local write failed: {e}")

    if not _gh_enabled():
        return {"ok": True, "path": str(GRAPH), "updatedAt": obj["updatedAt"], "persist": "local-only"}

    # get current sha (required for update)
    url = f"https://api.github.com/repos/{GH_REPO}/contents/{GRAPH_PATH}?ref={GH_BRANCH}"
    req = urllib.request.Request(url, headers=_gh_headers())
    sha = None
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            sha = json.loads(resp.read().decode("utf-8")).get("sha")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    put_url = f"https://api.github.com/repos/{GH_REPO}/contents/{GRAPH_PATH}"
    payload = {
        "message": f"chore: save story graph ({obj['updatedAt']})",
        "content": base64.b64encode(raw).decode("ascii"),
        "branch": GH_BRANCH,
    }
    if sha:
        payload["sha"] = sha
    body = json.dumps(payload).encode("utf-8")
    put_req = urllib.request.Request(
        put_url, data=body, headers={**_gh_headers(), "Content-Type": "application/json"}, method="PUT"
    )
    with urllib.request.urlopen(put_req, timeout=60) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return {
        "ok": True,
        "path": str(GRAPH),
        "updatedAt": obj["updatedAt"],
        "persist": "github",
        "commit": (result.get("commit") or {}).get("sha"),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/healthz":
            return self._send(200, b"ok", "text/plain")
        if path in ("/", "/index.html"):
            return self._send(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/graph":
            try:
                return self._send(200, load_graph_bytes(), "application/json; charset=utf-8")
            except Exception as e:
                return self._send(
                    500,
                    json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode(),
                    "application/json; charset=utf-8",
                )
        rel = path.lstrip("/")
        if ".." in rel:
            return self._send(400, b"bad path", "text/plain")
        fp = ROOT / rel
        if fp.is_file():
            ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
            if fp.suffix == ".js":
                ctype = "text/javascript; charset=utf-8"
            elif fp.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            return self._send(200, fp.read_bytes(), ctype)
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if urlparse(self.path).path != "/api/graph":
            return self._send(404, b"not found", "text/plain")
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._send(
                400,
                json.dumps({"ok": False, "error": str(e)}).encode(),
                "application/json",
            )
        if not isinstance(obj, dict) or "nodes" not in obj or "edges" not in obj:
            return self._send(
                400,
                json.dumps({"ok": False, "error": "invalid graph"}).encode(),
                "application/json",
            )
        try:
            result = save_graph_obj(obj)
        except Exception as e:
            return self._send(
                500,
                json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode(),
                "application/json",
            )
        self._send(200, json.dumps(result, ensure_ascii=False).encode(), "application/json; charset=utf-8")


def main():
    mode = f"github:{GH_REPO}@{GH_BRANCH}" if _gh_enabled() else "local-file"
    print(f"剧情路线编辑器 → http://0.0.0.0:{PORT}  persist={mode}")
    print(f"数据文件：{GRAPH}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
