import concurrent.futures
import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient
from test_gateway import UpstreamHandler, chat_body, upstream  # noqa: F401

from backend.app import create_app
from backend.bridge import RelayError
from backend.config import Settings
from backend.store import SESSION_COOKIE, ConfigStore


@pytest.fixture
def configured(request):
    settings = Settings(opencode_base_url=request.getfixturevalue("upstream"), _env_file=None)
    app = create_app(settings)
    with TestClient(app) as browser:
        yield browser, settings


def bootstrap(browser):
    response = browser.post("/api/session", json={})
    assert response.status_code == 200
    assert "httponly" in response.headers["set-cookie"].lower()
    assert "samesite=strict" in response.headers["set-cookie"].lower()


def test_first_browser_can_use_free_models_but_anonymous_clients_cannot(configured):
    browser, _ = configured
    assert browser.get("/api/health").json()["auth_required"] is True
    assert browser.get("/api/session").json() == {"authenticated": False, "api_key_created": False}
    assert browser.get("/v1/models").status_code == 401
    assert browser.get("/api/settings").status_code == 401
    assert browser.post("/api/settings/api-key").status_code == 401
    bootstrap(browser)
    assert browser.get("/v1/models").status_code == 200
    headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
    assert headers["authorization"] == "Bearer public"


def test_only_one_key_and_external_auth_never_uses_upstream_key(configured):
    browser, _ = configured
    bootstrap(browser)
    response = browser.post("/api/settings/api-key")
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    key = response.json()["api_key"]
    assert key.startswith("sk-relay-") and len(key) >= 48
    assert browser.post("/api/settings/api-key").status_code == 409
    metadata = browser.get("/api/settings")
    assert metadata.json()["api_key"]["exists"] is True
    assert key not in metadata.text
    assert key not in str(dict(metadata.headers))
    assert key not in str(dict(browser.app.state.store.snapshot()))
    # The raw key is only available in the create/rotate response, even after login.
    browser.delete("/api/session")
    assert browser.get("/v1/models").status_code == 401
    for invalid in ("public", "some-opencode-key", "wrong"):
        response = browser.get("/v1/models", headers={"Authorization": f"Bearer {invalid}"})
        assert response.status_code == 401
    response = browser.post(
        "/v1/chat/completions", json=chat_body(), headers={"Authorization": f"Bearer {key}"}
    )
    assert response.status_code == 200
    headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
    assert headers["authorization"] == "Bearer public"
    assert key not in str(UpstreamHandler.requests[-1])
    assert browser.post("/api/session", json={}).status_code == 401
    assert browser.post("/api/session", json={"api_key": key}).status_code == 200
    assert key not in browser.get("/api/settings").text


def test_concurrent_key_creation_is_atomic(configured):
    browser, settings = configured
    bootstrap(browser)
    token = browser.cookies[SESSION_COOKIE]

    def create(_):
        try:
            return browser.app.state.store.issue_key(token)
        except RelayError as exc:
            return exc.status

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(8)))
    assert sum(isinstance(result, str) for result in results) == 1
    assert results.count(409) == 7
    with closing(sqlite3.connect(settings.relay_data_dir / "relay.sqlite3")) as db:
        assert db.execute("SELECT COUNT(*) FROM config").fetchone()[0] == 1
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO config (id) VALUES (2)")


def test_rotation_revokes_old_key_and_other_sessions(configured):
    browser, settings = configured
    bootstrap(browser)
    old = browser.post("/api/settings/api-key").json()["api_key"]
    with TestClient(browser.app) as other:
        assert other.post("/api/session", json={"api_key": old}).status_code == 200
        new = browser.post("/api/settings/api-key/rotate").json()["api_key"]
        assert new != old
        assert other.get("/api/settings").status_code == 401
        assert (
            other.get("/v1/models", headers={"Authorization": f"Bearer {old}"}).status_code == 401
        )
        assert (
            other.get("/v1/models", headers={"Authorization": f"Bearer {new}"}).status_code == 200
        )
    assert browser.get("/api/settings").status_code == 200
    assert browser.post("/api/settings/api-key").status_code == 409
    # An old environment variable must never restore the old key after a restart.
    restored = ConfigStore(settings.relay_data_dir, old)
    assert not restored.verify_key(old)
    assert restored.verify_key(new)


def test_creation_revokes_other_anonymous_bootstrap_sessions(configured):
    browser, _ = configured
    bootstrap(browser)
    with TestClient(browser.app) as other:
        bootstrap(other)
        browser.post("/api/settings/api-key")
        assert other.put("/api/settings/upstream", json={"api_key": "intruder"}).status_code == 401
        assert other.get("/v1/models").status_code == 401
        assert browser.get("/api/settings").status_code == 200


def test_saved_upstream_key_and_sessions_survive_restart(configured):
    browser, settings = configured
    bootstrap(browser)
    relay_key = browser.post("/api/settings/api-key").json()["api_key"]
    response = browser.put("/api/settings/upstream", json={"api_key": "paid-upstream-secret"})
    assert response.status_code == 200
    assert response.json()["upstream"]["configured"] is True
    assert "paid-upstream-secret" not in response.text
    session = browser.cookies[SESSION_COOKIE]
    restarted = create_app(settings)
    with TestClient(restarted) as after:
        after.cookies.set(SESSION_COOKIE, session)
        assert after.get("/api/settings").json()["upstream"]["configured"] is True
        response = after.post(
            "/v1/chat/completions",
            json=chat_body(),
            headers={"Authorization": f"Bearer {relay_key}"},
        )
        assert response.status_code == 200
        headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
        assert headers["authorization"] == "Bearer paid-upstream-secret"
        assert "paid-upstream-secret" not in response.text
        assert (
            after.get(
                "/v1/models", headers={"Authorization": "Bearer paid-upstream-secret"}
            ).status_code
            == 401
        )
        assert (
            after.put("/api/settings/upstream", json={"api_key": ""}).json()["upstream"][
                "configured"
            ]
            is False
        )
        assert after.get("/v1/models").status_code == 200
        headers = {k.lower(): v for k, v in UpstreamHandler.requests[-1]["headers"].items()}
        assert headers["authorization"] == "Bearer public"


@pytest.mark.parametrize(
    "path", ["/api/session", "/api/settings/api-key", "/api/settings/upstream"]
)
def test_management_rejects_cross_origin_requests(configured, path):
    browser, _ = configured
    bootstrap(browser)
    method = "PUT" if path.endswith("upstream") else "POST"
    for headers in ({"Origin": "https://evil.invalid"}, {"Sec-Fetch-Site": "same-site"}):
        response = browser.request(method, path, json={}, headers=headers)
        assert response.status_code == 403
    assert browser.request(
        method, path, json={}, headers={"Origin": "http://testserver"}
    ).status_code in (200, 201)


def test_upstream_validation_and_management_access_do_not_leak_secrets(configured):
    browser, _ = configured
    assert (
        browser.put("/api/settings/upstream", json={"api_key": "private-upstream"}).status_code
        == 401
    )
    bootstrap(browser)
    for invalid in ("bad key", "secret\x00value", "中" * 3, "x" * 4097):
        response = browser.put("/api/settings/upstream", json={"api_key": invalid})
        assert response.status_code == 400
        assert invalid not in response.text
    assert browser.get("/api/settings").json()["upstream"]["configured"] is False
    key = browser.post("/api/settings/api-key").json()["api_key"]
    assert browser.get("/v1/models", headers={"Authorization": "Bearer invalid"}).status_code == 401
    # Expired/revoked sessions cannot edit settings or continue using the web playground.
    with browser.app.state.store.connect() as db:
        db.execute("UPDATE sessions SET expires_at=0")
    assert browser.get("/api/settings").status_code == 401
    assert browser.get("/v1/models").status_code == 401
    assert browser.get("/v1/models", headers={"Authorization": f"Bearer {key}"}).status_code == 200


def test_secure_cookie_and_same_origin_with_nonstandard_port(configured):
    browser, _ = configured
    headers = {
        "Host": "localhost:8948",
        "Origin": "https://localhost:8948",
        "X-Forwarded-Proto": "https",
    }
    response = browser.post("/api/session", json={}, headers=headers)
    assert response.status_code == 200
    assert "secure" in response.headers["set-cookie"].lower()


def test_upstream_keys_cannot_be_passed_by_external_callers(configured):
    browser, _ = configured
    bootstrap(browser)
    key = browser.post("/api/settings/api-key").json()["api_key"]
    headers = {"Authorization": f"Bearer {key}"}
    for path in ("/v1/models?api_key=should-not-forward", "/v1/models?opencode_api_key=secret"):
        assert browser.get(path, headers=headers).status_code == 400
    payload = {
        **chat_body(),
        "api_key": "secret",
        "opencode_api_key": "secret",
        "authorization": "secret",
        "Authorization": "Bearer secret",
    }
    assert browser.post("/v1/chat/completions", json=payload, headers=headers).status_code == 200
    assert not any(
        name.lower() in {"api_key", "opencode_api_key", "authorization"}
        for name in UpstreamHandler.requests[-1]["body"]
    )
