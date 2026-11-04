"""Tests for enano.web: localhost API server, embedded page, browser launch."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import pytest

from enano import __version__, web


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.status, response.headers, response.read()


def _get_json(url):
    status, _, body = _get(url)
    return status, json.loads(body.decode("utf-8"))


@pytest.fixture
def server(store_home):
    httpd, url = web.make_server(0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd, url
    httpd.shutdown()
    httpd.server_close()
    thread.join(5)


# ------------------------------------------------------------------- server


def test_make_server_binds_loopback_with_free_port():
    httpd, url = web.make_server(0)
    try:
        port = httpd.server_address[1]
        assert port > 0
        assert url == f"http://127.0.0.1:{port}/"
    finally:
        httpd.server_close()


# ---------------------------------------------------------------- endpoints


def test_api_version(server):
    _, url = server
    status, doc = _get_json(url + "api/version")
    assert status == 200
    assert doc["name"] == "enano"
    assert doc["version"] == __version__
    assert doc["api"] == web.API_VERSION


def test_api_models_empty_store(server):
    _, url = server
    status, doc = _get_json(url + "api/models")
    assert status == 200
    assert doc["models"] == []
    assert doc["default_model"] == "personal-goals"


def test_api_models_lists_installed(server, bundle_factory):
    _, url = server
    bundle_factory(model="personal-goals", version="2026-01-01")
    status, doc = _get_json(url + "api/models")
    assert status == 200
    assert doc["default_model"] == "personal-goals"
    row = doc["models"][0]
    assert row["model"] == "personal-goals"
    assert row["version"] == "2026-01-01"
    assert row["state"] == "latest"
    assert row["bytes"] > 0


def test_index_serves_html(server):
    _, url = server
    status, headers, body = _get(url)
    assert status == 200
    assert headers.get_content_type() == "text/html"
    assert b"enano" in body.lower()


def test_unknown_path_is_json_404(server):
    _, url = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(url + "nope", timeout=5)
    assert exc.value.code == 404
    assert json.loads(exc.value.read())["error"]


def test_api_registry_uses_cache_without_network(server, store_home, monkeypatch):
    from enano import registry as reg

    def no_network(url):
        raise AssertionError("network hit; the cache should have been used")

    monkeypatch.setattr(reg, "_get_json", no_network)
    cache = store_home / "registry.json"
    cache.write_text(
        json.dumps(
            {"models": {"cached-model": {"description": "d", "latest": "v1",
                                          "versions": {"v1": {"bytes": 10}}}}}
        )
    )
    _, url = server
    status, doc = _get_json(url + "api/registry")
    assert status == 200
    assert [r["model"] for r in doc["models"]] == ["cached-model"]


def test_api_registry_refresh_flag_hits_fetch(server, monkeypatch):
    from enano import registry as reg

    calls = []
    monkeypatch.setattr(
        reg, "fetch_registry", lambda refresh=False, cache_path=None: calls.append(refresh)
        or {"models": {"fresh": {"description": "d", "latest": "v1",
                                 "versions": {"v1": {"bytes": 1}}}}}
    )
    _, url = server
    status, doc = _get_json(url + "api/registry?refresh=1")
    assert status == 200
    assert calls == [True]
    assert doc["models"][0]["model"] == "fresh"


def test_api_registry_unreachable_returns_json_error(server, monkeypatch):
    from enano import registry as reg

    def boom(refresh=False, cache_path=None):
        raise SystemExit("registry fetch failed: offline")

    monkeypatch.setattr(reg, "fetch_registry", boom)
    _, url = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(url + "api/registry", timeout=5)
    assert exc.value.code == 502
    assert "offline" in json.loads(exc.value.read())["error"]


# ------------------------------------------------------------------- serve


def _run_serve_until_stopped(**kwargs):
    ready = threading.Event()
    holder = {}

    def on_ready(httpd, url):
        holder["server"] = httpd
        holder["url"] = url
        ready.set()

    result = {}
    thread = threading.Thread(
        target=lambda: result.setdefault("code", web.serve(on_ready=on_ready, **kwargs))
    )
    thread.start()
    assert ready.wait(5), "server never became ready"
    return holder, thread, result


def test_serve_opens_browser_and_stops_cleanly(monkeypatch, store_home):
    opened = []
    monkeypatch.setattr(web.webbrowser, "open", lambda url: opened.append(url) or True)
    holder, thread, result = _run_serve_until_stopped(port=0, open_browser=True, json_mode=True)
    try:
        status, doc = _get_json(holder["url"] + "api/version")
        assert status == 200 and doc["name"] == "enano"
    finally:
        holder["server"].shutdown()
    thread.join(5)
    assert not thread.is_alive()
    assert result["code"] == 0
    assert opened == [holder["url"]]


def test_serve_no_open_leaves_browser_alone(monkeypatch, store_home):
    opened = []
    monkeypatch.setattr(web.webbrowser, "open", lambda url: opened.append(url) or True)
    holder, thread, _ = _run_serve_until_stopped(port=0, open_browser=False, json_mode=True)
    holder["server"].shutdown()
    thread.join(5)
    assert opened == []


def test_serve_default_port_busy_falls_back_to_free_port(store_home):
    try:
        blocker, _ = web.make_server(web.DEFAULT_PORT)
    except OSError:
        pytest.skip(f"port {web.DEFAULT_PORT} already busy on this machine")
    try:
        holder, thread, _ = _run_serve_until_stopped(
            port=web.DEFAULT_PORT, open_browser=False, json_mode=True
        )
        try:
            assert holder["server"].server_address[1] != web.DEFAULT_PORT
        finally:
            holder["server"].shutdown()
        thread.join(5)
    finally:
        blocker.server_close()


def test_serve_explicit_port_busy_exits_with_message(store_home):
    blocker, _ = web.make_server(0)
    try:
        busy_port = blocker.server_address[1]
        with pytest.raises(SystemExit, match="already in use"):
            web.serve(port=busy_port, open_browser=False)
    finally:
        blocker.server_close()


# ------------------------------------------------------------- cli wiring


def test_web_command_parses():
    from enano import cli

    args = cli.build_parser().parse_args(["web", "--no-open", "--port", "0"])
    assert args.func is cli.cmd_web
    assert args.port == 0
    assert args.no_open is True
    assert args.json is False


def test_web_dispatch_passes_flags(monkeypatch, store_home):
    from enano import cli, web

    calls = {}
    monkeypatch.setattr(web, "serve", lambda **kw: calls.update(kw) or 0)
    assert cli.main(["web", "--no-open", "--port", "9"]) == 0
    assert calls == {"port": 9, "open_browser": False, "json_mode": False, "web_dir": None}


# ------------------------------------------------------------- gui serving


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@pytest.fixture
def gui_dir(tmp_path):
    gui = tmp_path / "gui"
    (gui / "assets").mkdir(parents=True)
    (gui / "index.html").write_text('<html><script src="/etiny/assets/app.js"></script></html>')
    (gui / "assets" / "app.js").write_text("console.log('enano')")
    return gui


@pytest.fixture
def gui_server(store_home, gui_dir):
    httpd, url = web.make_server(0, web_root=gui_dir)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd, url
    httpd.shutdown()
    httpd.server_close()
    thread.join(5)


def test_resolve_web_root_prefers_explicit(gui_dir, store_home):
    assert web.resolve_web_root(str(gui_dir)) == gui_dir


def test_resolve_web_root_env_var(gui_dir, store_home, monkeypatch):
    monkeypatch.setenv("ENANO_WEB_DIR", str(gui_dir))
    assert web.resolve_web_root(None) == gui_dir


def test_resolve_web_root_store_bundle(store_home):
    bundled = store_home / "web"
    bundled.mkdir()
    (bundled / "index.html").write_text("<html></html>")
    assert web.resolve_web_root(None) == bundled


def test_resolve_web_root_none_when_nothing_installed(store_home):
    assert web.resolve_web_root(None) is None


def test_resolve_web_root_explicit_missing_dir_exits(store_home):
    with pytest.raises(SystemExit, match="not found"):
        web.resolve_web_root("/definitely/not/here")


def test_root_redirects_to_gui(gui_server):
    _, url = gui_server
    opener = urllib.request.build_opener(_NoRedirect)
    with pytest.raises(urllib.error.HTTPError) as exc:
        opener.open(url, timeout=5)
    assert exc.value.code == 302
    assert exc.value.headers["Location"] == "/etiny/"


def test_serves_gui_under_etiny_path(gui_server, gui_dir):
    _, url = gui_server
    status, headers, body = _get(url + "etiny/")
    assert status == 200
    assert headers.get_content_type() == "text/html"
    assert body == (gui_dir / "index.html").read_bytes()

    status, headers, body = _get(url + "etiny/assets/app.js")
    assert status == 200
    assert "javascript" in headers.get_content_type()
    assert b"enano" in body


def test_serves_gui_index_without_trailing_slash(gui_server):
    _, url = gui_server
    status, headers, _body = _get(url + "etiny")
    assert status == 200
    assert headers.get_content_type() == "text/html"


def test_gui_traversal_blocked(gui_server, store_home):
    import http.client

    (store_home / "secret.txt").write_text("s3cret")
    httpd, _ = gui_server
    conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
    conn.request("GET", "/etiny/../secret.txt")
    response = conn.getresponse()
    assert response.status == 404
    conn.close()


def test_api_still_served_alongside_gui(gui_server):
    _, url = gui_server
    status, doc = _get_json(url + "api/version")
    assert status == 200
    assert doc["name"] == "enano"
