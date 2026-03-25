from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.schemas import CalculationRequest, CalculationResponse, GoldRecord, HealthResponse
from app.services.airtable import airtable_is_configured, create_airtable_record
from app.services.calculator import calculate_record

app = FastAPI(title="Gold Price Calculator API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", airtable_enabled=airtable_is_configured())


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


@app.post("/api/records")
async def create_record(record: GoldRecord) -> dict:
    response = await create_airtable_record(record)
    return {
        "ok": True,
        "airtable": response,
    }
