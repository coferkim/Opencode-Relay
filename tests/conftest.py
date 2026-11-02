import pytest


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RELAY_API_KEY", raising=False)
