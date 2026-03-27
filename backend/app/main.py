from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import (
    CalculationRequest,
    CalculationResponse,
    CreateOrderRequest,
    HealthResponse,
    OrderItemCreate,
    OrderResponse,
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
async def create_order(payload: CreateOrderRequest) -> OrderResponse:
    return await get_storage().create_order(payload)


@app.get("/api/orders/{order_id}", response_model=OrderResponse)
async def get_order(order_id: str) -> OrderResponse:
    return await get_storage().get_order(order_id)


@app.post("/api/orders/{order_id}/items", response_model=OrderResponse)
async def add_order_item(order_id: str, payload: OrderItemCreate) -> OrderResponse:
    return await get_storage().add_item(order_id, payload)


@app.delete("/api/orders/{order_id}/items/{item_id}", response_model=OrderResponse)
async def delete_order_item(order_id: str, item_id: str) -> OrderResponse:
    return await get_storage().delete_item(order_id, item_id)


@app.patch("/api/orders/{order_id}/pay", response_model=OrderResponse)
async def pay_order(order_id: str) -> OrderResponse:
    return await get_storage().pay_order(order_id)
