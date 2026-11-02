"""Persistent singleton API key, upstream configuration and hashed browser sessions."""

import hashlib
import hmac
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .bridge import RelayError

SESSION_SECONDS = 7 * 24 * 60 * 60
SESSION_COOKIE = "relay_session"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class ConfigStore:
    def __init__(self, directory: Path, initial_api_key: str | None = None):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        self.path = directory / "relay.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS config (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    api_key_hash TEXT,
                    api_key_prefix TEXT,
                    key_created_at INTEGER,
                    key_updated_at INTEGER,
                    upstream_api_key TEXT
                );
                INSERT OR IGNORE INTO config (id) VALUES (1);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    expires_at INTEGER NOT NULL
                );
            """)
            if initial_api_key:
                now = int(time.time())
                db.execute(
                    "UPDATE config SET api_key_hash=?, api_key_prefix=?, "
                    "key_created_at=?, key_updated_at=? WHERE id=1 AND api_key_hash IS NULL",
                    (
                        digest(initial_api_key),
                        initial_api_key[: min(10, len(initial_api_key) // 3)],
                        now,
                        now,
                    ),
                )
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def snapshot(self) -> sqlite3.Row:
        with self.connect() as db:
            return db.execute("SELECT * FROM config WHERE id=1").fetchone()

    def key_exists(self) -> bool:
        return self.snapshot()["api_key_hash"] is not None

    def verify_key(self, key: str) -> bool:
        expected = self.snapshot()["api_key_hash"]
        return bool(key and expected and hmac.compare_digest(digest(key), expected))

    @staticmethod
    def session_in(db: sqlite3.Connection, token: str) -> bool:
        return bool(
            token
            and db.execute(
                "SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?",
                (digest(token), int(time.time())),
            ).fetchone()
        )

    def verify_session(self, token: str) -> bool:
        with self.connect() as db:
            return self.session_in(db, token)

    def login(self, key: str, current_token: str = "") -> str:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            expected = db.execute("SELECT api_key_hash FROM config WHERE id=1").fetchone()[0]
            if current_token and self.session_in(db, current_token) and not key:
                return current_token
            if expected and not hmac.compare_digest(digest(key), expected):
                raise RelayError("调用 API Key 无效，请输入已创建的密钥。", 401, "invalid_api_key")
            token = secrets.token_urlsafe(32)
            now = int(time.time())
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?)", (digest(token), now + SESSION_SECONDS))
            return token

    def logout(self, token: str) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (digest(token),))

    def issue_key(self, token: str, *, rotate: bool = False) -> str:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not self.session_in(db, token):
                raise RelayError("管理会话已失效，请重新登录。", 401, "session_expired")
            exists = db.execute("SELECT api_key_hash FROM config WHERE id=1").fetchone()[0]
            if exists and not rotate:
                raise RelayError(
                    "只能创建一条 API Key；需要更换时请重置现有密钥。", 409, "key_exists"
                )
            if rotate and not exists:
                raise RelayError("尚未创建 API Key。", 409, "key_missing")
            key = "sk-relay-" + secrets.token_urlsafe(32)
            now = int(time.time())
            db.execute(
                "UPDATE config SET api_key_hash=?, api_key_prefix=?, "
                "key_created_at=COALESCE(key_created_at, ?), key_updated_at=? WHERE id=1",
                (digest(key), key[:17], now, now),
            )
            # The current browser keeps access; every other session must use the new key.
            db.execute("DELETE FROM sessions WHERE token_hash<>?", (digest(token),))
            return key

    def save_upstream(self, token: str, key: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not self.session_in(db, token):
                raise RelayError("管理会话已失效，请重新登录。", 401, "session_expired")
            db.execute("UPDATE config SET upstream_api_key=? WHERE id=1", (key or "public",))

    def upstream_key(self, default: str) -> str:
        return self.snapshot()["upstream_api_key"] or default or "public"

    def public_settings(self, default_upstream: str) -> dict:
        row = self.snapshot()
        effective = row["upstream_api_key"] or default_upstream or "public"
        return {
            "api_key": {
                "exists": row["api_key_hash"] is not None,
                "prefix": row["api_key_prefix"],
                "created_at": row["key_created_at"],
                "updated_at": row["key_updated_at"],
            },
            "upstream": {"configured": effective != "public"},
        }
