from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    airtable_token: str | None = None
    airtable_base_id: str | None = None
    airtable_customers_table_name: str = "Customers"
    airtable_reservations_table_name: str = "Reservations"
    airtable_orders_table_name: str = "Orders"
    airtable_items_table_name: str = "Gold Items"
    airtable_allocations_table_name: str = "Order Item Allocations"
    airtable_company_sales_table_name: str = "Company Sales"
    airtable_company_sale_lines_table_name: str = "Company Sale Lines"
    airtable_xu_sales_table_name: str = "Xu Sales"
    airtable_xu_sale_lines_table_name: str = "Xu Sale Lines"
    airtable_brazil_sales_table_name: str = "Brazil Sales"
    airtable_brazil_sale_lines_table_name: str = "Brazil Sale Lines"
    airtable_brazil_balance_ledger_table_name: str = "Brazil Balance Ledger"
    allowed_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    app_users_json: str = ""
    default_usd_to_usdt_rate: float = 1.0

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
