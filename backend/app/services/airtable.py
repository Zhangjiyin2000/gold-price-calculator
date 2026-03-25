from __future__ import annotations

from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.config import settings
from app.schemas import GoldRecord


def airtable_is_configured() -> bool:
    return bool(settings.airtable_token and settings.airtable_base_id and settings.airtable_table_name)


def _record_fields(record: GoldRecord) -> dict:
    return {
        "Saved At": record.savedAt,
        "Customer Name": record.customerName,
        "Customer Phone": record.customerPhone,
        "Rule Name": record.ruleName,
        "Rule Constant": record.ruleConstant,
        "Water Weight": record.waterWeight,
        "Dry Weight": record.dryWeight,
        "Tax Rate": record.taxRate,
        "International Gold Price": record.intlGoldPrice,
        "Purity": record.purity,
        "Per Gram Price": record.perGramPrice,
        "Final Price": record.finalPrice,
        "Total Price": record.totalPrice,
    }


async def create_airtable_record(record: GoldRecord) -> dict:
    if not airtable_is_configured():
        raise HTTPException(status_code=503, detail="Airtable is not configured on the backend")

    url = f"https://api.airtable.com/v0/{settings.airtable_base_id}/{quote(settings.airtable_table_name, safe='')}"
    headers = {
        "Authorization": f"Bearer {settings.airtable_token}",
        "Content-Type": "application/json",
    }
    payload = {
        "records": [
            {
                "fields": _record_fields(record),
            }
        ]
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.is_success:
        return response.json()

    try:
        detail = response.json()
    except ValueError:
        detail = response.text

    raise HTTPException(status_code=response.status_code, detail=detail)
