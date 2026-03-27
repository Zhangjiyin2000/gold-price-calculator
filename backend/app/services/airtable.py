from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app.config import settings
from app.schemas import CreateOrderRequest, OrderItemCreate, OrderItemResponse, OrderResponse, OrderSummary


def _table_names_available() -> bool:
    return bool(
        settings.airtable_customers_table_name
        and settings.airtable_orders_table_name
        and settings.airtable_items_table_name
    )


def airtable_is_configured() -> bool:
    return bool(settings.airtable_token and settings.airtable_base_id and _table_names_available())


def current_storage_mode() -> str:
    return "airtable" if airtable_is_configured() else "memory"


def _quote_table_name(table_name: str) -> str:
    return quote(table_name, safe="")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _normalize_datetime_value(value: str) -> str:
    if not value:
        return _utc_now_iso()

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized.replace("Z", "+00:00")

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return _utc_now_iso()

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)

    return parsed.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _escape_formula(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _order_summary(items: list[dict[str, Any]]) -> OrderSummary:
    return OrderSummary(
        itemCount=len(items),
        totalAmount=sum(float(item["totalPrice"]) for item in items),
    )


def _build_order_response(order: dict[str, Any], items: list[dict[str, Any]]) -> OrderResponse:
    item_models = [OrderItemResponse(**item) for item in items]
    return OrderResponse(
        id=order["id"],
        customerId=order["customerId"],
        customerName=order["customerName"],
        customerPhone=order["customerPhone"],
        status=order["status"],
        createdAt=order["createdAt"],
        paidAt=order.get("paidAt", ""),
        items=item_models,
        summary=_order_summary(items),
    )


class MemoryStorage:
    def __init__(self) -> None:
        self.customers_by_id: dict[str, dict[str, Any]] = {}
        self.customer_ids_by_key: dict[tuple[str, str], str] = {}
        self.orders_by_id: dict[str, dict[str, Any]] = {}
        self.items_by_order_id: dict[str, list[dict[str, Any]]] = {}

    async def create_order(self, payload: CreateOrderRequest) -> OrderResponse:
        customer_name = payload.customerName.strip()
        customer_phone = payload.customerPhone.strip()
        customer_key = (customer_name, customer_phone)

        customer_id = self.customer_ids_by_key.get(customer_key)
        if not customer_id:
            customer_id = f"cust-{uuid4().hex[:12]}"
            self.customer_ids_by_key[customer_key] = customer_id

        self.customers_by_id[customer_id] = {
            "id": customer_id,
            "customerName": customer_name,
            "customerPhone": customer_phone,
        }

        order_id = f"order-{uuid4().hex[:12]}"
        order = {
            "id": order_id,
            "customerId": customer_id,
            "customerName": customer_name,
            "customerPhone": customer_phone,
            "status": "draft",
            "createdAt": _utc_now_iso(),
            "paidAt": "",
        }
        self.orders_by_id[order_id] = order
        self.items_by_order_id[order_id] = []
        return _build_order_response(order, [])

    async def get_order(self, order_id: str) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")

        items = deepcopy(self.items_by_order_id.get(order_id, []))
        return _build_order_response(deepcopy(order), items)

    async def add_item(self, order_id: str, payload: OrderItemCreate) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if order["status"] == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        item = {
            "id": f"item-{uuid4().hex[:12]}",
            "orderId": order_id,
            "customerId": order["customerId"],
            **payload.model_dump(),
        }
        self.items_by_order_id.setdefault(order_id, []).append(item)
        return await self.get_order(order_id)

    async def delete_item(self, order_id: str, item_id: str) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if order["status"] == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        items = self.items_by_order_id.get(order_id, [])
        next_items = [item for item in items if item["id"] != item_id]
        if len(next_items) == len(items):
            raise HTTPException(status_code=404, detail="Order item not found")

        self.items_by_order_id[order_id] = next_items
        return await self.get_order(order_id)

    async def pay_order(self, order_id: str) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")

        items = self.items_by_order_id.get(order_id, [])
        if not items:
            raise HTTPException(status_code=400, detail="Order has no items")

        if order["status"] != "paid":
            order["status"] = "paid"
            order["paidAt"] = _utc_now_iso()

        return await self.get_order(order_id)


class AirtableStorage:
    def __init__(self) -> None:
        self.base_url = f"https://api.airtable.com/v0/{settings.airtable_base_id}"
        self.headers = {
            "Authorization": f"Bearer {settings.airtable_token}",
            "Content-Type": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}/{path}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(method, url, headers=self.headers, params=params, json=json)

        if response.is_success:
            if response.content:
                return response.json()
            return {}

        try:
            detail = response.json()
        except ValueError:
            detail = response.text
        raise HTTPException(status_code=response.status_code, detail=detail)

    async def _list_records(
        self,
        table_name: str,
        *,
        filter_formula: str | None = None,
        fields: list[str] | None = None,
        sort_field: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if filter_formula:
            params["filterByFormula"] = filter_formula
        if fields:
            params["fields[]"] = fields
        if sort_field:
            params["sort[0][field]"] = sort_field
            params["sort[0][direction]"] = "asc"

        payload = await self._request("GET", _quote_table_name(table_name), params=params)
        return payload.get("records", [])

    async def _find_first_record(
        self,
        table_name: str,
        *,
        filter_formula: str,
    ) -> dict[str, Any] | None:
        records = await self._list_records(table_name, filter_formula=filter_formula)
        return records[0] if records else None

    async def _create_record(self, table_name: str, fields: dict[str, Any]) -> dict[str, Any]:
        payload = {"records": [{"fields": fields}]}
        response = await self._request("POST", _quote_table_name(table_name), json=payload)
        return response["records"][0]

    async def _update_record(self, table_name: str, record_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        payload = {"fields": fields}
        return await self._request("PATCH", f"{_quote_table_name(table_name)}/{record_id}", json=payload)

    async def _delete_record(self, table_name: str, record_id: str) -> None:
        await self._request("DELETE", f"{_quote_table_name(table_name)}/{record_id}")

    async def _upsert_customer(self, customer_name: str, customer_phone: str) -> dict[str, Any]:
        escaped_phone = _escape_formula(customer_phone)
        escaped_name = _escape_formula(customer_name)
        filter_formula = (
            f'AND({{Customer Name}}="{escaped_name}",{{Customer Phone}}="{escaped_phone}")'
        )
        existing = await self._find_first_record(
            settings.airtable_customers_table_name,
            filter_formula=filter_formula,
        )
        if existing:
            fields = existing.get("fields", {})
            customer_id = fields.get("Customer ID")
            await self._update_record(
                settings.airtable_customers_table_name,
                existing["id"],
                {"Last Visit At": _utc_now_iso()},
            )
            return {
                "airtableRecordId": existing["id"],
                "customerId": customer_id,
                "customerName": fields.get("Customer Name", customer_name),
                "customerPhone": fields.get("Customer Phone", customer_phone),
            }

        customer_id = f"cust-{uuid4().hex[:12]}"
        created = await self._create_record(
            settings.airtable_customers_table_name,
            {
                "Customer ID": customer_id,
                "Customer Name": customer_name,
                "Customer Phone": customer_phone,
                "Last Visit At": _utc_now_iso(),
            },
        )
        return {
            "airtableRecordId": created["id"],
            "customerId": customer_id,
            "customerName": customer_name,
            "customerPhone": customer_phone,
        }

    async def _find_order_record(self, order_id: str) -> dict[str, Any]:
        escaped_order_id = _escape_formula(order_id)
        record = await self._find_first_record(
            settings.airtable_orders_table_name,
            filter_formula=f'{{Order ID}}="{escaped_order_id}"',
        )
        if not record:
            raise HTTPException(status_code=404, detail="Order not found")
        return record

    async def _list_order_item_records(self, order_id: str) -> list[dict[str, Any]]:
        escaped_order_id = _escape_formula(order_id)
        return await self._list_records(
            settings.airtable_items_table_name,
            filter_formula=f'{{Order ID}}="{escaped_order_id}"',
            sort_field="Saved At",
        )

    def _map_order_response(
        self,
        order_record: dict[str, Any],
        item_records: list[dict[str, Any]],
    ) -> OrderResponse:
        order_fields = order_record.get("fields", {})
        items = []
        for item_record in item_records:
            fields = item_record.get("fields", {})
            items.append(
                {
                    "id": fields["Item ID"],
                    "orderId": fields["Order ID"],
                    "customerId": fields["Customer ID"],
                    "customerName": fields.get("Customer Name", ""),
                    "customerPhone": fields.get("Customer Phone", ""),
                    "savedAt": fields["Saved At"],
                    "ruleName": fields["Rule Name"],
                    "ruleConstant": fields["Rule Constant"],
                    "waterWeight": fields["Water Weight"],
                    "dryWeight": fields["Dry Weight"],
                    "taxRate": fields["Tax Rate"],
                    "intlGoldPrice": fields["International Gold Price"],
                    "purity": fields["Purity"],
                    "perGramPrice": fields["Per Gram Price"],
                    "finalPrice": fields["Final Price"],
                    "totalPrice": fields["Line Total"],
                }
            )

        return OrderResponse(
            id=order_fields["Order ID"],
            customerId=order_fields["Customer ID"],
            customerName=order_fields["Customer Name"],
            customerPhone=order_fields["Customer Phone"],
            status=order_fields.get("Status", "draft"),
            createdAt=order_fields["Created At"],
            paidAt=order_fields.get("Paid At", ""),
            items=[OrderItemResponse(**item) for item in items],
            summary=_order_summary(items),
        )

    async def _refresh_order_totals(self, order_record: dict[str, Any]) -> None:
        order_fields = order_record.get("fields", {})
        order_id = order_fields["Order ID"]
        items = self._map_order_response(order_record, await self._list_order_item_records(order_id)).items
        total_amount = sum(item.totalPrice for item in items)
        await self._update_record(
            settings.airtable_orders_table_name,
            order_record["id"],
            {"Total Items": len(items), "Total Amount": total_amount},
        )

    async def create_order(self, payload: CreateOrderRequest) -> OrderResponse:
        customer = await self._upsert_customer(payload.customerName.strip(), payload.customerPhone.strip())
        order_id = f"order-{uuid4().hex[:12]}"
        created = await self._create_record(
            settings.airtable_orders_table_name,
            {
                "Order ID": order_id,
                "Customer ID": customer["customerId"],
                "Customer Name": customer["customerName"],
                "Customer Phone": customer["customerPhone"],
                "Status": "draft",
                "Created At": _utc_now_iso(),
                "Total Items": 0,
                "Total Amount": 0,
            },
        )
        return self._map_order_response(created, [])

    async def get_order(self, order_id: str) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        item_records = await self._list_order_item_records(order_id)
        return self._map_order_response(order_record, item_records)

    async def add_item(self, order_id: str, payload: OrderItemCreate) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        order_fields = order_record.get("fields", {})
        if order_fields.get("Status") == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        item_id = f"item-{uuid4().hex[:12]}"
        await self._create_record(
            settings.airtable_items_table_name,
            {
                "Item ID": item_id,
                "Order ID": order_id,
                "Customer ID": order_fields["Customer ID"],
                "Customer Name": order_fields["Customer Name"],
                "Customer Phone": order_fields["Customer Phone"],
                "Saved At": _normalize_datetime_value(payload.savedAt),
                "Rule Name": payload.ruleName,
                "Rule Constant": payload.ruleConstant,
                "Water Weight": payload.waterWeight,
                "Dry Weight": payload.dryWeight,
                "Tax Rate": payload.taxRate,
                "International Gold Price": payload.intlGoldPrice,
                "Purity": payload.purity,
                "Per Gram Price": payload.perGramPrice,
                "Final Price": payload.finalPrice,
                "Line Total": payload.totalPrice,
            },
        )
        await self._refresh_order_totals(order_record)
        return await self.get_order(order_id)

    async def delete_item(self, order_id: str, item_id: str) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        order_fields = order_record.get("fields", {})
        if order_fields.get("Status") == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        escaped_item_id = _escape_formula(item_id)
        item_record = await self._find_first_record(
            settings.airtable_items_table_name,
            filter_formula=f'AND({{Order ID}}="{_escape_formula(order_id)}",{{Item ID}}="{escaped_item_id}")',
        )
        if not item_record:
            raise HTTPException(status_code=404, detail="Order item not found")

        await self._delete_record(settings.airtable_items_table_name, item_record["id"])
        await self._refresh_order_totals(order_record)
        return await self.get_order(order_id)

    async def pay_order(self, order_id: str) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        response = await self.get_order(order_id)
        if not response.items:
            raise HTTPException(status_code=400, detail="Order has no items")

        if response.status != "paid":
            await self._update_record(
                settings.airtable_orders_table_name,
                order_record["id"],
                {"Status": "paid", "Paid At": _utc_now_iso()},
            )
        return await self.get_order(order_id)


memory_storage = MemoryStorage()
airtable_storage = AirtableStorage() if airtable_is_configured() else None


def get_storage() -> MemoryStorage | AirtableStorage:
    return airtable_storage if airtable_storage else memory_storage
