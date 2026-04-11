from fastapi import Depends, FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import (
    BrazilBalanceResponse,
    BrazilSaleCreate,
    BrazilSaleResponse,
    CalculationRequest,
    CalculationResponse,
    CompanySaleCreate,
    CompanySaleResponse,
    CreateOrderRequest,
    FinancialDefaultsResponse,
    FinancialDefaultsUpdateRequest,
    HealthResponse,
    LoginRequest,
    LoginResponse,
    OrderItemCreate,
    OrderResponse,
    ReservationCreateRequest,
    ReservationResponse,
    UserSessionResponse,
    XuSaleCreate,
    XuSaleResponse,
)
from app.services.auth import (
    authenticate_user,
    create_session,
    get_current_user,
    get_financial_defaults,
    remove_session,
    require_any_permission,
    require_permissions,
    update_financial_defaults,
)
from app.services.airtable import airtable_is_configured, current_storage_mode, get_storage
from app.services.calculator import calculate_record

app = FastAPI(title="Gold Price Calculator API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        airtable_enabled=airtable_is_configured(),
        storage_mode=current_storage_mode(),
    )


@app.post("/api/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest) -> LoginResponse:
    user = authenticate_user(payload.username, payload.password)
    token = create_session(user)
    return LoginResponse(token=token, user=user)


@app.get("/api/auth/me", response_model=UserSessionResponse)
async def me(user: UserSessionResponse = Depends(get_current_user)) -> UserSessionResponse:
    return user


@app.post("/api/auth/logout")
async def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    if authorization and authorization.startswith("Bearer "):
        remove_session(authorization[len("Bearer "):].strip())
    return {"ok": True}


@app.get("/api/financial-defaults", response_model=FinancialDefaultsResponse)
async def read_financial_defaults(
    _: UserSessionResponse = Depends(
        require_any_permission("canSellGold", "canManageFinancialDefaults", "canViewProfit")
    ),
) -> FinancialDefaultsResponse:
    return get_financial_defaults()


@app.patch("/api/financial-defaults", response_model=FinancialDefaultsResponse)
async def patch_financial_defaults(
    payload: FinancialDefaultsUpdateRequest,
    _: UserSessionResponse = Depends(require_permissions("canManageFinancialDefaults")),
) -> FinancialDefaultsResponse:
    return update_financial_defaults(usd_to_usdt_rate=payload.usdToUsdtRate)


@app.post("/api/calculate", response_model=CalculationResponse)
async def calculate(payload: CalculationRequest) -> CalculationResponse:
    result = calculate_record(
        water_weight=payload.waterWeight,
        dry_weight=payload.dryWeight,
        tax_rate=payload.taxRate,
        intl_gold_price=payload.intlGoldPrice,
        formula_rule=payload.formulaRule,
    )
    return CalculationResponse(**result)


@app.post("/api/orders", response_model=OrderResponse)
async def create_order(
    payload: CreateOrderRequest,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> OrderResponse:
    return await get_storage().create_order(payload)


@app.get("/api/reservations", response_model=list[ReservationResponse])
async def list_reservations(
    customer_name: str,
    customer_phone: str = "",
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> list[ReservationResponse]:
    return await get_storage().list_reservations(customer_name, customer_phone)


@app.post("/api/reservations", response_model=ReservationResponse)
async def create_reservation(
    payload: ReservationCreateRequest,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> ReservationResponse:
    return await get_storage().create_reservation(payload)


@app.delete("/api/reservations/{reservation_id}")
async def delete_reservation(
    reservation_id: str,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> dict[str, bool]:
    await get_storage().delete_reservation(reservation_id)
    return {"ok": True}


@app.get("/api/orders/{order_id}", response_model=OrderResponse)
async def get_order(
    order_id: str,
    _: UserSessionResponse = Depends(require_any_permission("canIntakeGold", "canMeltGold", "canSellGold")),
) -> OrderResponse:
    return await get_storage().get_order(order_id)


@app.get("/api/orders", response_model=list[OrderResponse])
async def list_orders(
    _: UserSessionResponse = Depends(require_any_permission("canIntakeGold", "canMeltGold", "canSellGold")),
) -> list[OrderResponse]:
    return await get_storage().list_orders()


@app.get("/api/company-sales", response_model=list[CompanySaleResponse])
async def list_company_sales(
    _: UserSessionResponse = Depends(require_permissions("canViewProfit")),
) -> list[CompanySaleResponse]:
    return await get_storage().list_company_sales()


@app.post("/api/company-sales", response_model=CompanySaleResponse)
async def create_company_sale(
    payload: CompanySaleCreate,
    _: UserSessionResponse = Depends(require_permissions("canSellGold")),
) -> CompanySaleResponse:
    return await get_storage().create_company_sale(payload)


@app.get("/api/xu-sales", response_model=list[XuSaleResponse])
async def list_xu_sales(
    _: UserSessionResponse = Depends(require_permissions("canViewProfit")),
) -> list[XuSaleResponse]:
    return await get_storage().list_xu_sales()


@app.post("/api/xu-sales", response_model=XuSaleResponse)
async def create_xu_sale(
    payload: XuSaleCreate,
    _: UserSessionResponse = Depends(require_permissions("canSellGold")),
) -> XuSaleResponse:
    if payload.usdToUsdtRate <= 0:
        payload = payload.model_copy(update={"usdToUsdtRate": get_financial_defaults().usdToUsdtRate})
    return await get_storage().create_xu_sale(payload)


@app.get("/api/brazil-sales", response_model=list[BrazilSaleResponse])
async def list_brazil_sales(
    _: UserSessionResponse = Depends(require_permissions("canViewProfit")),
) -> list[BrazilSaleResponse]:
    return await get_storage().list_brazil_sales()


@app.get("/api/brazil-balance", response_model=BrazilBalanceResponse)
async def get_brazil_balance(
    _: UserSessionResponse = Depends(require_permissions("canSellGold")),
) -> BrazilBalanceResponse:
    return await get_storage().get_brazil_balance()


@app.post("/api/brazil-sales", response_model=BrazilSaleResponse)
async def create_brazil_sale(
    payload: BrazilSaleCreate,
    _: UserSessionResponse = Depends(require_permissions("canSellGold")),
) -> BrazilSaleResponse:
    if payload.usdToUsdtRate <= 0:
        payload = payload.model_copy(update={"usdToUsdtRate": get_financial_defaults().usdToUsdtRate})
    return await get_storage().create_brazil_sale(payload)


@app.post("/api/orders/{order_id}/items", response_model=OrderResponse)
async def add_order_item(
    order_id: str,
    payload: OrderItemCreate,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> OrderResponse:
    return await get_storage().add_item(order_id, payload)


@app.delete("/api/orders/{order_id}/items/{item_id}", response_model=OrderResponse)
async def delete_order_item(
    order_id: str,
    item_id: str,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> OrderResponse:
    return await get_storage().delete_item(order_id, item_id)


@app.patch("/api/orders/{order_id}/pay", response_model=OrderResponse)
async def pay_order(
    order_id: str,
    _: UserSessionResponse = Depends(require_permissions("canIntakeGold")),
) -> OrderResponse:
    return await get_storage().pay_order(order_id)
