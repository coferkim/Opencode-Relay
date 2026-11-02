from pathlib import Path
from shutil import which

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    opencode_api_key: str = "public"
    opencode_base_url: str = "https://opencode.ai/inference/openai/v1"
    opencode_models_url: str | None = None
    opencode_client: str = "desktop"
    opencode_version: str = "2.2.5"
    opencode_timeout_seconds: float = Field(default=120, gt=0, le=1800)
    opencode_max_concurrent_requests: int = Field(default=8, ge=1, le=128)
    relay_api_key: str | None = None
    bun_executable: str = Field(default_factory=lambda: which("bun.exe") or which("bun") or "bun")
