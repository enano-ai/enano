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

DEFAULT_PORT = 8599
API_VERSION = 1
GUI_PRIMARY = "/enano/"
GUI_LEGACY = "/etiny/"
# A built GUI inside the source checkout (webapp/dist) wins over the store
# copy so `enano web` serves what the repo is developing.
CHECKOUT_DIST = Path(__file__).resolve().parent.parent / "webapp" / "dist"


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
    """Where the GUI build lives: an explicit path, ENANO_WEB_DIR, the
    checkout's webapp/dist, or <store>/web.

    The public build is compiled with base /etiny/, so it is served under the
    /etiny/ legacy alias (and /enano/ as primary) regardless of source.
    """
    for candidate in (explicit, os.environ.get("ENANO_WEB_DIR")):
        if candidate:
            path = Path(candidate)
            if not path.is_dir():
                raise SystemExit(f"web app folder not found: {path}")
            return path
    if (CHECKOUT_DIST / "index.html").is_file():
        return CHECKOUT_DIST
    bundled = store.store_root() / "web"
    return bundled if (bundled / "index.html").is_file() else None


def _elevators_doc(model: str) -> dict | None:
    """The source works shipped inside an installed bundle (data/elevators.json)."""
    bundle = store.resolve_version(model, None)
    path = (bundle / "data" / "elevators.json") if bundle else None
    if not path or not path.is_file():
        return None
    return {"model": model, "elevators": jsonlib.loads(path.read_text(encoding="utf-8"))}


def _serve_runtime(self, path: str) -> bool:
    """Serve the shared runtime layer (engine assets) from the store under
    /runtime/ so the GUI never fetches model weights from a CDN. Returns
    False when no runtime is installed (caller 404s)."""
    root = store.resolve_runtime()
    if root is None or not path.startswith("/runtime/"):
        return False
    rel = path[len("/runtime/"):]
    target = (root / rel).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        self._send_json({"error": f"not found: {path}"}, status=404)
        return True
    ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    self._send(target.read_bytes(), ctype)
    return True


class _Handler(BaseHTTPRequestHandler):
    server_version = f"enano/{__version__}"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._api(parsed)
            elif _serve_runtime(self, parsed.path):
                pass
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
        elif parsed.path.startswith("/api/models/") and parsed.path.endswith("/elevators"):
            model = parsed.path[len("/api/models/") : -len("/elevators")]
            doc = _elevators_doc(model)
            if doc is None:
                self._send_json({"error": f"no elevators for {model} (is the model installed?)"}, status=404)
            else:
                self._send_json(doc)
        elif parsed.path == "/api/registry":
            refresh = parse_qs(parsed.query).get("refresh", [""])[0].lower() in ("1", "true", "yes")
            self._send_json(_registry_doc(refresh))
        elif parsed.path == "/api/runtime":
            root = store.resolve_runtime()
            self._send_json({"runtime": {"version": store.read_runtime_latest(), "path": str(root) if root else None}})
        else:
            self._send_json({"error": f"not found: {parsed.path}"}, status=404)

    def _serve_gui(self, path: str, root: Path) -> None:
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", GUI_PRIMARY)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        rel = None
        for prefix in (GUI_PRIMARY, GUI_LEGACY):
            if path == prefix.rstrip("/"):
                rel = "index.html"
            elif path.startswith(prefix):
                rel = path[len(prefix):]
                if rel == "" or rel.endswith("/"):
                    rel += "index.html"
            if rel is not None:
                break
        if rel is None:
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
    return httpd, f"http://localhost:{httpd.server_address[1]}/"


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
    The port is fixed by default (8599, IANA-unassigned, no known tool uses
    it) so the URL is documentable and a future native app can rely on it; a
    busy port is an error, not a silent port change. on_ready(server, url)
    fires after the socket is listening, before the blocking loop (tests).
    """
    root = resolve_web_root(web_dir)
    try:
        httpd, url = make_server(port, web_root=root)
    except OSError:
        raise SystemExit(f"port {port} is already in use (try: enano web --port <other>)")
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
# The enano.ai pitch-deck design system (enano.ai repo: tailwind.config.ts +
# src/index.css): white ground, Inter 400-900, SF Mono micro-labels, black
# rules only (2px section tops, 1px hairline rows), square mono buttons,
# monochrome hierarchy. Every number still comes from the local API.

_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>enano</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #ffffff;
    --paper-deep: #f7f7f5;
    --ink: #000000;
    --ink-soft: #555555;
    --ink-faint: #8c8c8c;
    --rule-faint: #dbdbdb;
    --mono: "SF Mono", ui-monospace, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  ::selection { background: #000; color: #fff; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 1120px; margin: 0 auto; padding-left: 1.5rem; padding-right: 1.5rem; }
  @media (min-width: 1024px) { .container { padding-left: 2rem; padding-right: 2rem; } }

  .label {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin: 0;
  }

  .cover { padding-top: 3.5rem; padding-bottom: 4rem; }
  .wordmark {
    margin: 2rem 0 0;
    font-size: clamp(64px, 12vw, 120px);
    font-weight: 900;
    line-height: 0.95;
    letter-spacing: -0.045em;
  }
  .tagline {
    margin: 1rem 0 0;
    max-width: 68ch;
    font-size: 22px;
    font-weight: 400;
    line-height: 1.35;
  }
  .meta {
    margin: 1.5rem 0 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink-soft);
  }
  .meta b { color: var(--ink); font-weight: 600; }

  section.block, footer.block { border-top: 2px solid var(--ink); }
  .block-pad { padding-top: 3rem; padding-bottom: 3rem; }
  .section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid var(--ink);
    padding-bottom: 1rem;
    margin-bottom: 0.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ink);
    background: transparent;
    color: var(--ink);
    border-radius: 0;
    padding: 6px 12px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1;
    transition: background-color 150ms;
  }
  .btn:hover { background: var(--paper-deep); }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .btn[disabled] { opacity: 0.55; cursor: default; }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th {
    text-align: left;
    padding: 0.75rem 1rem 0.5rem 0;
    border-bottom: 2px solid var(--ink);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    white-space: nowrap;
  }
  td { padding: 0.625rem 1rem 0.625rem 0; border-bottom: 1px solid var(--rule-faint); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  th.num, td.num { text-align: right; }
  td .mono { font-family: var(--mono); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .state-on { font-weight: 600; }
  .state-off { color: var(--ink-soft); }
  td.loading { color: var(--ink-soft); }

  .note { margin: 0.75rem 0 0; font-size: 15px; line-height: 1.6; color: var(--ink-soft); max-width: 68ch; }
  .note code { font-family: var(--mono); font-size: 13px; color: var(--ink); }
  .error { margin: 0.75rem 0 0; font-size: 15px; line-height: 1.6; font-weight: 500; max-width: 68ch; }

  footer.block .container { padding-top: 2.5rem; padding-bottom: 4rem; }
  .api { margin: 0.75rem 0 0; font-family: var(--mono); font-size: 13px; color: var(--ink-soft); }
  .api code { color: var(--ink); }

  .reveal { opacity: 0; animation: reveal 0.6s ease forwards; }
  @keyframes reveal {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .reveal { animation: none; opacity: 1; }
  }

  @media (max-width: 640px) {
    .cover { padding-top: 2.5rem; padding-bottom: 2.5rem; }
    .tagline { font-size: 19px; }
    .block-pad { padding-top: 2rem; padding-bottom: 2rem; }
  }
</style>
</head>
<body>
<main>
  <section class="container cover">
    <p class="label reveal">enano web · local</p>
    <h1 class="wordmark reveal" style="animation-delay: 80ms">Enano</h1>
    <p class="tagline reveal" style="animation-delay: 160ms">Your models, on this machine.</p>
    <p class="meta reveal" style="animation-delay: 240ms">
      <span id="version">v…</span> · default <b id="default-model">…</b> · store <b id="store">…</b>
    </p>
  </section>

  <section class="block">
    <div class="container block-pad">
      <div class="section-head">
        <p class="label">Registry</p>
        <button id="refresh" class="btn" type="button">Refresh</button>
      </div>
      <div class="scroll">
        <table>
          <thead><tr><th>Model</th><th>Description</th><th class="num">Size</th><th>Updated</th><th>State</th></tr></thead>
          <tbody id="registry-rows"></tbody>
        </table>
      </div>
      <p class="note" id="registry-empty" hidden>registry unreachable. <code>enano list</code> works from the terminal once you are back online.</p>
      <p class="error" id="registry-error" hidden></p>
    </div>
  </section>

  <section class="block">
    <div class="container block-pad">
      <div class="section-head">
        <p class="label">Installed</p>
      </div>
      <div class="scroll">
        <table>
          <thead><tr><th>Model</th><th>Version</th><th class="num">Size</th><th>Pulled</th><th>State</th></tr></thead>
          <tbody id="models-rows"></tbody>
        </table>
      </div>
      <p class="note" id="models-empty" hidden>nothing installed yet. try <code>enano pull personal-goals</code></p>
      <p class="error" id="models-error" hidden></p>
    </div>
  </section>

  <footer class="block">
    <div class="container">
      <p class="label">Local API</p>
      <p class="api">GET <code>/api/version</code> · <code>/api/models</code> · <code>/api/registry</code> · localhost, <code>Ctrl-C</code> stops</p>
    </div>
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

  function loadingRow() {
    return '<tr><td colspan="5" class="loading">loading…</td></tr>';
  }

  function stateSpan(state) {
    var on = state === "installed" || state === "latest";
    return '<span class="' + (on ? "state-on" : "state-off") + '">' + esc(state) + "</span>";
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
    var error = document.getElementById("models-error");
    rows.innerHTML = loadingRow();
    empty.hidden = true;
    error.hidden = true;
    return fetchJson("/api/models").then(function (doc) {
      if (!doc.models.length) {
        rows.innerHTML = "";
        empty.hidden = false;
        return;
      }
      rows.innerHTML = doc.models.map(function (m) {
        return row([
          "<strong>" + esc(m.model) + "</strong>",
          '<span class="mono">' + esc(m.version) + "</span>",
          '<span class="mono">' + fmtBytes(m.bytes) + "</span>",
          '<span class="mono">' + esc(m.pulled) + "</span>",
          stateSpan(m.state)
        ]);
      }).join("");
    }).catch(function (err) {
      rows.innerHTML = "";
      error.hidden = false;
      error.textContent = "could not read installed models: " + err.message;
    });
  }

  var refreshButton = document.getElementById("refresh");

  function loadRegistry(refresh) {
    var rows = document.getElementById("registry-rows");
    var empty = document.getElementById("registry-empty");
    var error = document.getElementById("registry-error");
    rows.innerHTML = loadingRow();
    empty.hidden = true;
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
          '<span class="mono">' + fmtBytes(m.bytes) + "</span>",
          '<span class="mono">' + esc(m.version) + "</span>",
          stateSpan(m.state)
        ]);
      }).join("");
    }).catch(function (err) {
      rows.innerHTML = "";
      empty.hidden = false;
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
