"""`enano web`: a localhost server with a JSON API and a small built-in page.

Ollama-shaped architecture: the CLI process is the backend, bound to
127.0.0.1 only, and any front end can talk to it. Today the front end is the
embedded HTML page opened in the user's browser; a native menubar app could
speak the same `/api/*` endpoints later. Nothing leaves the machine.

Endpoints (all GET, all JSON):

  /api/version              name, version, api level, default model, store path
  /api/models               installed bundles (same rows as `enano models`)
  /api/registry[?refresh=1] registry catalog (same rows as `enano list`);
                            refresh=1 re-fetches the index like the CLI does
"""

from __future__ import annotations

import json as jsonlib
import mimetypes
import os
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from . import registry as reg
from . import store

DEFAULT_PORT = 8765
API_VERSION = 1
GUI_PREFIX = "/etiny/"


# ------------------------------------------------------------------ api docs


def _version_doc() -> dict:
    return {
        "name": "enano",
        "version": __version__,
        "api": API_VERSION,
        "default_model": store.default_model(),
        "store": str(store.store_root()),
    }


def _models_doc() -> dict:
    rows = []
    for m in store.local_models():
        rows.append(
            {
                "model": m.model,
                "version": m.version,
                "bytes": m.bytes,
                "pulled": time.strftime("%Y-%m-%d", time.localtime(m.path.stat().st_mtime)),
                "state": "latest" if store.read_latest(m.model) == m.version else "old",
                "runnable": m.runnable,
            }
        )
    return {"default_model": store.default_model(), "models": rows}


def _registry_doc(refresh: bool) -> dict:
    registry = reg.fetch_registry(refresh=refresh)
    models = reg.registry_models(registry)
    rows = []
    for name in sorted(models):
        entry = models[name]
        version = entry.get("latest") or sorted(entry.get("versions", {}))[-1]
        meta = entry.get("versions", {}).get(version, {})
        local = store.read_latest(name)
        if local == version:
            state = "installed"
        elif local:
            state = f"update ({local})"
        else:
            state = "-"
        rows.append(
            {
                "model": name,
                "version": version,
                "description": entry.get("description", ""),
                "bytes": meta.get("bytes", 0),
                "state": state,
            }
        )
    return {"models": rows}


# ------------------------------------------------------------------- server


def _exit_message(exc: SystemExit) -> str:
    code = exc.code
    if code is None:
        return "error"
    return str(code)


def resolve_web_root(explicit: str | None) -> Path | None:
    """Where the GUI build lives: an explicit path, ENANO_WEB_DIR, or <store>/web.

    The public build is compiled with base /etiny/, so it is served under the
    /etiny/ path regardless of where its files come from.
    """
    for candidate in (explicit, os.environ.get("ENANO_WEB_DIR")):
        if candidate:
            path = Path(candidate)
            if not path.is_dir():
                raise SystemExit(f"web app folder not found: {path}")
            return path
    bundled = store.store_root() / "web"
    return bundled if (bundled / "index.html").is_file() else None


class _Handler(BaseHTTPRequestHandler):
    server_version = f"enano/{__version__}"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._api(parsed)
            elif self.server.web_root is not None:
                self._serve_gui(parsed.path, self.server.web_root)
            elif parsed.path in ("/", "/index.html"):
                self._send(_PAGE.encode("utf-8"), "text/html; charset=utf-8")
            else:
                self._send_json({"error": f"not found: {parsed.path}"}, status=404)
        except SystemExit as exc:
            self._send_json({"error": _exit_message(exc)}, status=502)
        except Exception as exc:
            self._send_json({"error": f"internal error: {exc}"}, status=500)

    def _api(self, parsed) -> None:
        if parsed.path == "/api/version":
            self._send_json(_version_doc())
        elif parsed.path == "/api/models":
            self._send_json(_models_doc())
        elif parsed.path == "/api/registry":
            refresh = parse_qs(parsed.query).get("refresh", [""])[0].lower() in ("1", "true", "yes")
            self._send_json(_registry_doc(refresh))
        else:
            self._send_json({"error": f"not found: {parsed.path}"}, status=404)

    def _serve_gui(self, path: str, root: Path) -> None:
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", GUI_PREFIX)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == GUI_PREFIX.rstrip("/"):
            rel = "index.html"
        elif path.startswith(GUI_PREFIX):
            rel = path[len(GUI_PREFIX):]
            if rel == "" or rel.endswith("/"):
                rel += "index.html"
        else:
            self._send_json({"error": f"not found: {path}"}, status=404)
            return
        target = (root / rel).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            self._send_json({"error": f"not found: {path}"}, status=404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(target.read_bytes(), ctype)

    def _send(self, body: bytes, ctype: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, doc: dict, status: int = 200) -> None:
        self._send(jsonlib.dumps(doc, indent=2).encode("utf-8"), "application/json", status)

    def log_message(self, format: str, *args: object) -> None:
        # Quiet by design: the server is a back end for a GUI, not a log stream.
        pass


def make_server(port: int, web_root: Path | None = None) -> tuple[ThreadingHTTPServer, str]:
    """Bind the handler to 127.0.0.1. port 0 lets the kernel pick a free one.

    web_root is the GUI build folder to serve under /etiny/ (None serves the
    built-in status page instead). Raises OSError when the port is taken.
    """
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    httpd.web_root = web_root
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


def serve(
    port: int = DEFAULT_PORT,
    open_browser: bool = True,
    json_mode: bool = False,
    web_dir: str | None = None,
    on_ready=None,
) -> int:
    """Run the backend until Ctrl-C. Returns an exit code (always 0).

    Resolves the GUI build once (see resolve_web_root), serves it under /etiny/
    with the JSON API alongside, and opens the browser at the GUI when asked.
    A busy default port silently falls back to a free one; a busy explicitly
    requested port is an error. on_ready(server, url) fires after the socket
    is listening and before the blocking loop starts (used by tests).
    """
    root = resolve_web_root(web_dir)
    try:
        httpd, url = make_server(port, web_root=root)
    except OSError:
        if port != DEFAULT_PORT:
            raise SystemExit(f"port {port} is already in use (try: enano web --port 0)")
        httpd, url = make_server(0, web_root=root)
        if not json_mode:
            print(f"port {DEFAULT_PORT} busy, using a free one", flush=True)
    if open_browser:
        webbrowser.open(url)
    info = {
        "url": url,
        "port": httpd.server_address[1],
        "pid": os.getpid(),
        "api": API_VERSION,
        "web_root": str(root) if root else None,
    }
    if json_mode:
        print(jsonlib.dumps(info), flush=True)
    else:
        gui_note = str(root) if root else "status page only (no web app installed)"
        print(f"enano web at {url}  gui: {gui_note}  (Ctrl-C stops)", flush=True)
    if on_ready:
        on_ready(httpd, url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


# ------------------------------------------------------------------ the page
# Brand tokens mirror the enano web app's boot splash (#f4f4f0 paper,
# #1a1a1a ink, #e8912d accent, system font stack) so the local page and the
# public playground read as one product. Utility page: no imagery, no
# vertical-specific content, every number comes from the API.

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>enano</title>
<style>
  :root {
    --paper: #f4f4f0;
    --ink: #1a1a1a;
    --muted: #6b6b5c;
    --line: #e0e0d8;
    --accent: #e8912d;
    --accent-ink: #8f5610;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; }
  header { border-bottom: 3px solid var(--accent); padding: 20px 0 14px; margin-bottom: 26px; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; }
  .meta { margin-top: 6px; color: var(--muted); font-size: 13.5px; }
  .meta code { color: var(--ink); font-size: 13px; }
  h2 { font-size: 15px; font-weight: 600; margin: 30px 0 10px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .state-latest, .state-installed { color: var(--accent-ink); font-weight: 600; }
  .state-old, .state-update { color: var(--muted); }
  .note { color: var(--muted); padding: 10px 2px; }
  .note code { color: var(--ink); }
  .error { color: #8c2f0e; padding: 10px 2px; }
  #refresh {
    font: inherit; font-size: 14px;
    background: #fff; color: var(--ink);
    border: 1px solid var(--ink); border-radius: 4px;
    padding: 7px 14px; cursor: pointer;
  }
  #refresh:hover { background: var(--ink); color: var(--paper); }
  #refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #refresh[disabled] { opacity: 0.55; cursor: default; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  footer { margin-top: 44px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 14px; }
  footer code { color: var(--ink); }
</style>
</head>
<body>
<main>
  <header>
    <div class="wordmark">enano</div>
    <div class="meta">
      <span id="version">v…</span> · default model: <code id="default-model">…</code> · store: <code id="store">…</code>
    </div>
  </header>

  <div class="bar">
    <h2 style="margin: 0;">Registry</h2>
    <button id="refresh" type="button">Refresh registry</button>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>Model</th><th>Description</th><th class="num">Size</th><th>Updated</th><th>State</th></tr></thead>
      <tbody id="registry-rows"></tbody>
    </table>
  </div>
  <p class="note" id="registry-note" hidden>registry unreachable, showing nothing. <code>enano list</code> works from the terminal once you are back online.</p>
  <p class="error" id="registry-error" hidden></p>

  <h2>Installed</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Model</th><th>Version</th><th class="num">Size</th><th>Pulled</th><th>State</th></tr></thead>
      <tbody id="models-rows"></tbody>
    </table>
  </div>
  <p class="note" id="models-empty" hidden>nothing installed yet. try: <code>enano pull personal-goals</code></p>

  <footer>
    This page talks to the same local API any front end can:
    <code>GET /api/version</code>, <code>/api/models</code>, <code>/api/registry</code>.
    Served from 127.0.0.1 by <code>enano web</code>; Ctrl-C in the terminal stops it.
  </footer>
</main>
<script>
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtBytes(n) {
    if (!n) return "0 B";
    var units = ["B", "KB", "MB", "GB"], u = 0;
    while (n >= 1000 && u < units.length - 1) { n /= 1000; u++; }
    return u === 0 ? n + " B" : n.toFixed(1) + " " + units[u];
  }

  function fetchJson(url) {
    return fetch(url).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (doc) {
        if (!response.ok) throw new Error(doc.error || "HTTP " + response.status);
        return doc;
      });
    });
  }

  function row(cells) {
    return "<tr>" + cells.map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
  }

  function loadVersion() {
    return fetchJson("/api/version").then(function (doc) {
      document.getElementById("version").textContent = "v" + doc.version;
      document.getElementById("default-model").textContent = doc.default_model;
      document.getElementById("store").textContent = doc.store;
    }).catch(function () {
      document.getElementById("version").textContent = "v?";
    });
  }

  function loadModels() {
    var rows = document.getElementById("models-rows");
    var empty = document.getElementById("models-empty");
    rows.innerHTML = row(["<span class=\\"note\\">loading…</span>", "", "", "", ""]);
    return fetchJson("/api/models").then(function (doc) {
      if (!doc.models.length) {
        rows.innerHTML = "";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      rows.innerHTML = doc.models.map(function (m) {
        return row([
          "<strong>" + esc(m.model) + "</strong>",
          "<span class=\\"mono\\">" + esc(m.version) + "</span>",
          "<span class=\\"num\\">" + fmtBytes(m.bytes) + "</span>",
          "<span class=\\"mono\\">" + esc(m.pulled) + "</span>",
          "<span class=\\"state-" + esc(m.state) + "\\">" + esc(m.state) + "</span>"
        ]);
      }).join("");
    }).catch(function (err) {
      rows.innerHTML = "";
      empty.hidden = true;
      var p = document.createElement("p");
      p.className = "error";
      p.textContent = "could not read installed models: " + err.message;
      empty.parentNode.insertBefore(p, empty);
    });
  }

  var refreshButton = document.getElementById("refresh");

  function loadRegistry(refresh) {
    var rows = document.getElementById("registry-rows");
    var note = document.getElementById("registry-note");
    var error = document.getElementById("registry-error");
    rows.innerHTML = row(["<span class=\\"note\\">loading…</span>", "", "", "", ""]);
    note.hidden = true;
    error.hidden = true;
    if (refresh) {
      refreshButton.disabled = true;
      refreshButton.setAttribute("aria-busy", "true");
    }
    return fetchJson("/api/registry" + (refresh ? "?refresh=1" : "")).then(function (doc) {
      rows.innerHTML = doc.models.map(function (m) {
        return row([
          "<strong>" + esc(m.model) + "</strong>",
          esc(m.description),
          "<span class=\\"num\\">" + fmtBytes(m.bytes) + "</span>",
          "<span class=\\"mono\\">" + esc(m.version) + "</span>",
          "<span class=\\"state-" + esc(m.state.split(" ")[0]) + "\\">" + esc(m.state) + "</span>"
        ]);
      }).join("");
    }).catch(function (err) {
      rows.innerHTML = "";
      note.hidden = false;
      error.hidden = false;
      error.textContent = "registry unreachable: " + err.message;
    }).finally(function () {
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
    });
  }

  refreshButton.addEventListener("click", function () { loadRegistry(true); });
  loadVersion();
  loadModels();
  loadRegistry(false);
})();
</script>
</body>
</html>
"""
