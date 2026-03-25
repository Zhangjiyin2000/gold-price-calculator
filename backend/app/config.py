from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    airtable_token: str | None = None
    airtable_base_id: str | None = None
    airtable_table_name: str = "Gold Records"
    allowed_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
