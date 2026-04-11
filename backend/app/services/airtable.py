from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app.config import settings
from app.schemas import (
    BrazilBalanceResponse,
    BrazilSaleCreate,
    BrazilSaleLine,
    BrazilSaleResponse,
    CompanySaleCreate,
    CompanySaleLine,
    CompanySaleResponse,
    CreateOrderRequest,
    OrderItemAllocation,
    OrderItemCreate,
    OrderItemResponse,
    OrderResponse,
    OrderSummary,
    ReservationCreateRequest,
    ReservationResponse,
    XuSaleCreate,
    XuSaleLine,
    XuSaleResponse,
)


def _table_names_available() -> bool:
    return bool(
        settings.airtable_customers_table_name
        and settings.airtable_reservations_table_name
        and settings.airtable_orders_table_name
        and settings.airtable_items_table_name
        and settings.airtable_allocations_table_name
    )


def airtable_is_configured() -> bool:
    return bool(settings.airtable_token and settings.airtable_base_id and _table_names_available())


def _company_sales_tables_configured() -> bool:
    return bool(
        settings.airtable_company_sales_table_name and settings.airtable_company_sale_lines_table_name
    )


def _xu_sales_tables_configured() -> bool:
    return bool(
        settings.airtable_xu_sales_table_name and settings.airtable_xu_sale_lines_table_name
    )


def _brazil_sales_tables_configured() -> bool:
    return bool(
        settings.airtable_brazil_sales_table_name
        and settings.airtable_brazil_sale_lines_table_name
        and settings.airtable_brazil_balance_ledger_table_name
    )


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


def _normalize_date_value(value: str) -> str:
    normalized_datetime = _normalize_datetime_value(value)
    return normalized_datetime[:10]


def _escape_formula(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _truncate_decimal(value: float, digits: int = 4) -> float:
    factor = 10**digits
    return int(value * factor) / factor


def _safe_number(value: Any, default: float = 0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed


def _order_summary(items: list[dict[str, Any]]) -> OrderSummary:
    return OrderSummary(
        itemCount=len(items),
        totalAmount=sum(float(item["totalPrice"]) for item in items),
    )


def _build_order_response(order: dict[str, Any], items: list[dict[str, Any]]) -> OrderResponse:
    return OrderResponse(
        id=order["id"],
        customerId=order["customerId"],
        customerName=order["customerName"],
        customerPhone=order["customerPhone"],
        status=order["status"],
        createdAt=order["createdAt"],
        paidAt=order.get("paidAt", ""),
        items=[OrderItemResponse(**item) for item in items],
        summary=_order_summary(items),
    )


class MemoryStorage:
    def __init__(self) -> None:
        self.customers_by_id: dict[str, dict[str, Any]] = {}
        self.customer_ids_by_key: dict[tuple[str, str], str] = {}
        self.reservations_by_id: dict[str, dict[str, Any]] = {}
        self.orders_by_id: dict[str, dict[str, Any]] = {}
        self.items_by_order_id: dict[str, list[dict[str, Any]]] = {}
        self.company_sales: list[dict[str, Any]] = []
        self.xu_sales: list[dict[str, Any]] = []
        self.brazil_sales: list[dict[str, Any]] = []

    def _get_or_create_customer(self, customer_name: str, customer_phone: str) -> dict[str, Any]:
        customer_key = (customer_name, customer_phone)
        customer_id = self.customer_ids_by_key.get(customer_key)
        if not customer_id:
            customer_id = f"cust-{uuid4().hex[:12]}"
            self.customer_ids_by_key[customer_key] = customer_id

        customer = {
            "id": customer_id,
            "customerName": customer_name,
            "customerPhone": customer_phone,
        }
        self.customers_by_id[customer_id] = customer
        return customer

    async def list_reservations(self, customer_name: str, customer_phone: str) -> list[ReservationResponse]:
        reservations = [
            ReservationResponse(**deepcopy(reservation))
            for reservation in self.reservations_by_id.values()
            if reservation["customerName"] == customer_name
            and (reservation["customerPhone"] == customer_phone if customer_phone else True)
            and reservation["status"] == "open"
        ]
        reservations.sort(key=lambda reservation: reservation.reservedAt, reverse=True)
        return reservations

    async def create_reservation(self, payload: ReservationCreateRequest) -> ReservationResponse:
        customer = self._get_or_create_customer(payload.customerName.strip(), payload.customerPhone.strip())
        reservation = {
            "id": f"res-{uuid4().hex[:12]}",
            "customerId": customer["id"],
            "customerName": customer["customerName"],
            "customerPhone": customer["customerPhone"],
            "reservedWeight": payload.reservedWeight,
            "lockedIntlGoldPrice": payload.lockedIntlGoldPrice,
            "taxRate": payload.taxRate,
            "remainingReservedWeight": payload.reservedWeight,
            "reservedAt": _normalize_datetime_value(payload.reservedAt),
            "status": "open",
        }
        self.reservations_by_id[reservation["id"]] = reservation
        return ReservationResponse(**deepcopy(reservation))

    async def delete_reservation(self, reservation_id: str) -> None:
        reservation = self.reservations_by_id.get(reservation_id)
        if not reservation:
            raise HTTPException(status_code=404, detail="Reservation not found")
        if reservation.get("status") != "open":
            raise HTTPException(status_code=409, detail="只能删除未完成的预定")
        reserved_weight = _safe_number(reservation.get("reservedWeight"), 0)
        remaining_weight = _safe_number(reservation.get("remainingReservedWeight"), 0)
        if abs(remaining_weight - reserved_weight) > 0.0001:
            raise HTTPException(status_code=409, detail="这条预定已经被部分使用，不能直接删除")
        self.reservations_by_id.pop(reservation_id, None)

    async def create_order(self, payload: CreateOrderRequest) -> OrderResponse:
        customer = self._get_or_create_customer(payload.customerName.strip(), payload.customerPhone.strip())
        order_id = f"order-{uuid4().hex[:12]}"
        order = {
            "id": order_id,
            "customerId": customer["id"],
            "customerName": customer["customerName"],
            "customerPhone": customer["customerPhone"],
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
        return _build_order_response(deepcopy(order), deepcopy(self.items_by_order_id.get(order_id, [])))

    async def list_orders(self) -> list[OrderResponse]:
        orders = sorted(self.orders_by_id.values(), key=lambda order: order["createdAt"], reverse=True)
        return [
            _build_order_response(deepcopy(order), deepcopy(self.items_by_order_id.get(order["id"], [])))
            for order in orders
        ]

    async def list_company_sales(self) -> list[CompanySaleResponse]:
        sales = sorted(self.company_sales, key=lambda sale: sale["createdAt"], reverse=True)
        return [CompanySaleResponse(**deepcopy(sale)) for sale in sales]

    async def create_company_sale(self, payload: CompanySaleCreate) -> CompanySaleResponse:
        sale = {
            "id": f"sale-{uuid4().hex[:12]}",
            **payload.model_dump(),
            "createdAt": _normalize_datetime_value(payload.createdAt),
        }
        self.company_sales.insert(0, sale)
        return CompanySaleResponse(**deepcopy(sale))

    async def list_xu_sales(self) -> list[XuSaleResponse]:
        sales = sorted(self.xu_sales, key=lambda sale: sale["createdAt"], reverse=True)
        return [XuSaleResponse(**deepcopy(sale)) for sale in sales]

    async def create_xu_sale(self, payload: XuSaleCreate) -> XuSaleResponse:
        sale = {
            "id": f"xu-sale-{uuid4().hex[:12]}",
            **payload.model_dump(),
            "createdAt": _normalize_datetime_value(payload.createdAt),
        }
        self.xu_sales.insert(0, sale)
        return XuSaleResponse(**deepcopy(sale))

    async def list_brazil_sales(self) -> list[BrazilSaleResponse]:
        sales = sorted(self.brazil_sales, key=lambda sale: sale["createdAt"], reverse=True)
        return [BrazilSaleResponse(**deepcopy(sale)) for sale in sales]

    async def get_brazil_balance(self) -> BrazilBalanceResponse:
        latest_sale = self.brazil_sales[0] if self.brazil_sales else None
        return BrazilBalanceResponse(
            fineGoldBalanceAfter=float(latest_sale["fineGoldBalanceAfter"]) if latest_sale else 0,
            costBalanceAfterUsd=float(latest_sale["costBalanceAfterUsd"]) if latest_sale else 0,
            createdAt=str(latest_sale.get("createdAt", "")) if latest_sale else "",
        )

    async def create_brazil_sale(self, payload: BrazilSaleCreate) -> BrazilSaleResponse:
        sale = {
            "id": f"brazil-sale-{uuid4().hex[:12]}",
            **payload.model_dump(),
            "createdAt": _normalize_datetime_value(payload.createdAt),
        }
        self.brazil_sales.insert(0, sale)
        return BrazilSaleResponse(**deepcopy(sale))

    async def add_item(self, order_id: str, payload: OrderItemCreate) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if order["status"] == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        reserved_allocations_by_id: dict[str, float] = {}
        for allocation in payload.allocations:
            if allocation.pricingMode == "reserved" and allocation.reservationId:
                reserved_allocations_by_id[allocation.reservationId] = (
                    reserved_allocations_by_id.get(allocation.reservationId, 0) + allocation.allocatedWeight
                )

        for reservation_id, allocated_weight in reserved_allocations_by_id.items():
            reservation = self.reservations_by_id.get(reservation_id)
            if not reservation:
                raise HTTPException(status_code=404, detail="Reservation not found")

            reservation["remainingReservedWeight"] = max(
                _truncate_decimal(reservation["remainingReservedWeight"] - allocated_weight, 4),
                0,
            )
            if reservation["remainingReservedWeight"] == 0:
                reservation["status"] = "fully_used"

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
        target_item = next((item for item in items if item["id"] == item_id), None)
        if not target_item:
            raise HTTPException(status_code=404, detail="Order item not found")

        reserved_allocations_by_id: dict[str, float] = {}
        for allocation in target_item.get("allocations", []):
            reservation_id = allocation.get("reservationId", "")
            if allocation.get("pricingMode") == "reserved" and reservation_id:
                reserved_allocations_by_id[reservation_id] = (
                    reserved_allocations_by_id.get(reservation_id, 0) + allocation.get("allocatedWeight", 0)
                )

        for reservation_id, allocated_weight in reserved_allocations_by_id.items():
            reservation = self.reservations_by_id.get(reservation_id)
            if reservation:
                reservation["remainingReservedWeight"] = _truncate_decimal(
                    reservation["remainingReservedWeight"] + allocated_weight,
                    4,
                )
                reservation["status"] = "open"

        self.items_by_order_id[order_id] = [item for item in items if item["id"] != item_id]
        return await self.get_order(order_id)

    async def pay_order(self, order_id: str) -> OrderResponse:
        order = self.orders_by_id.get(order_id)
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if not self.items_by_order_id.get(order_id):
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
        sort_field: str | None = None,
        max_records: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if filter_formula:
            params["filterByFormula"] = filter_formula
        if sort_field:
            params["sort[0][field]"] = sort_field
            params["sort[0][direction]"] = "asc"
        if max_records is not None:
            params["maxRecords"] = max_records

        payload = await self._request("GET", _quote_table_name(table_name), params=params)
        return payload.get("records", [])

    async def _find_first_record(self, table_name: str, *, filter_formula: str) -> dict[str, Any] | None:
        records = await self._list_records(table_name, filter_formula=filter_formula)
        return records[0] if records else None

    async def _create_record(self, table_name: str, fields: dict[str, Any]) -> dict[str, Any]:
        payload = {"records": [{"fields": fields}]}
        response = await self._request("POST", _quote_table_name(table_name), json=payload)
        return response["records"][0]

    async def _update_record(self, table_name: str, record_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        return await self._request("PATCH", f"{_quote_table_name(table_name)}/{record_id}", json={"fields": fields})

    async def _delete_record(self, table_name: str, record_id: str) -> None:
        await self._request("DELETE", f"{_quote_table_name(table_name)}/{record_id}")

    async def _upsert_customer(self, customer_name: str, customer_phone: str) -> dict[str, Any]:
        filter_formula = (
            f'AND({{Customer Name}}="{_escape_formula(customer_name)}",{{Customer Phone}}="{_escape_formula(customer_phone)}")'
        )
        existing = await self._find_first_record(settings.airtable_customers_table_name, filter_formula=filter_formula)
        if existing:
            fields = existing.get("fields", {})
            await self._update_record(
                settings.airtable_customers_table_name,
                existing["id"],
                {"Last Visit At": _utc_now_iso()},
            )
            return {
                "customerId": fields["Customer ID"],
                "customerName": fields["Customer Name"],
                "customerPhone": fields.get("Customer Phone", ""),
            }

        customer_id = f"cust-{uuid4().hex[:12]}"
        await self._create_record(
            settings.airtable_customers_table_name,
            {
                "Customer ID": customer_id,
                "Customer Name": customer_name,
                "Customer Phone": customer_phone,
                "Last Visit At": _utc_now_iso(),
            },
        )
        return {
            "customerId": customer_id,
            "customerName": customer_name,
            "customerPhone": customer_phone,
        }

    async def list_company_sales(self) -> list[CompanySaleResponse]:
        if not _company_sales_tables_configured():
            return []

        sale_records = await self._list_records(settings.airtable_company_sales_table_name, sort_field="Created At")
        line_records = await self._list_records(settings.airtable_company_sale_lines_table_name, sort_field="Created At")
        lines_by_sale_id: dict[str, list[CompanySaleLine]] = {}
        for line_record in line_records:
            fields = line_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            lines_by_sale_id.setdefault(sale_id, []).append(
                CompanySaleLine(
                    batchId=fields.get("Batch ID", ""),
                    label=fields.get("Batch Label", ""),
                    ourDryWeight=_safe_number(fields.get("Our Dry Weight"), 0),
                    ourPurity=_safe_number(fields.get("Our Purity"), 0),
                    referenceIntlGoldPrice=_safe_number(
                        fields.get("Source Ave Intl Gold Price"),
                        _safe_number(fields.get("Reference Intl Gold Price"), 0),
                    ),
                    referenceIntlGoldPriceLabel=fields.get(
                        "Source Ave Intl Gold Price Label",
                        fields.get("Reference Intl Gold Price Label", ""),
                    ),
                    saleIntlGoldPrice=_safe_number(fields.get("Sale Intl Gold Price"), 0),
                    buyerDryWeight=_safe_number(fields.get("Buyer Dry Weight"), 0),
                    buyerPurity=_safe_number(fields.get("Buyer Purity"), 0),
                    buyerPricePerGramUsd=_safe_number(fields.get("Buyer Price Per Gram USD"), 0),
                    lineAmountRaw=_safe_number(fields.get("Line Amount Raw"), 0),
                    lineAmountRounded=_safe_number(fields.get("Line Amount Rounded"), 0),
                    allocatedCostUsd=_safe_number(fields.get("Allocated Cost USD"), 0),
                    lineProfitUsd=_safe_number(fields.get("Line Profit USD"), 0),
                )
            )

        sales: list[CompanySaleResponse] = []
        for sale_record in reversed(sale_records):
            fields = sale_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            inventory_batch_ids = [
                batch_id.strip()
                for batch_id in str(fields.get("Inventory Batch IDs", "")).split(",")
                if batch_id.strip()
            ]
            sales.append(
                CompanySaleResponse(
                    id=sale_id,
                    buyerType=fields.get("Buyer Type", "company"),
                    currency=fields.get("Currency", "USD"),
                    createdAt=fields.get("Created At", _utc_now_iso()),
                    inventoryBatchIds=inventory_batch_ids,
                    grossRevenueUsd=_safe_number(fields.get("Gross Revenue USD"), 0),
                    inventoryCostUsd=_safe_number(fields.get("Inventory Cost USD"), 0),
                    grossProfitUsd=_safe_number(fields.get("Gross Profit USD"), 0),
                    lines=lines_by_sale_id.get(sale_id, []),
                )
            )
        return sales

    async def list_xu_sales(self) -> list[XuSaleResponse]:
        if not _xu_sales_tables_configured():
            return []

        sale_records = await self._list_records(settings.airtable_xu_sales_table_name, sort_field="Created At")
        line_records = await self._list_records(settings.airtable_xu_sale_lines_table_name, sort_field="Created At")
        lines_by_sale_id: dict[str, list[XuSaleLine]] = {}
        for line_record in line_records:
            fields = line_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            lines_by_sale_id.setdefault(sale_id, []).append(
                XuSaleLine(
                    batchId=fields.get("Batch ID", ""),
                    label=fields.get("Batch Label", ""),
                    ourDryWeight=_safe_number(fields.get("Our Dry Weight"), 0),
                    ourPurity=_safe_number(fields.get("Our Purity"), 0),
                    adjustedPurity=_safe_number(fields.get("Adjusted Purity"), 0),
                    referenceIntlGoldPrice=_safe_number(
                        fields.get("Source Ave Intl Gold Price"),
                        _safe_number(fields.get("Reference Intl Gold Price"), 0),
                    ),
                    referenceIntlGoldPriceLabel=fields.get(
                        "Source Ave Intl Gold Price Label",
                        fields.get("Reference Intl Gold Price Label", ""),
                    ),
                    saleIntlGoldPrice=_safe_number(fields.get("Sale Intl Gold Price"), 0),
                    taxRatePercent=_safe_number(fields.get("Tax Rate Percent"), 0),
                    purityAdjustmentPercent=_safe_number(fields.get("Purity Adjustment Percent"), 0),
                    netPricePerGramUsdt=_safe_number(fields.get("Net Price Per Gram USDT"), 0),
                    lineAmountRawUsdt=_safe_number(fields.get("Line Amount Raw USDT"), 0),
                    lineAmountRoundedUsdt=_safe_number(fields.get("Line Amount Rounded USDT"), 0),
                    allocatedCostUsd=_safe_number(fields.get("Allocated Cost USD"), 0),
                )
            )

        sales: list[XuSaleResponse] = []
        for sale_record in reversed(sale_records):
            fields = sale_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            inventory_batch_ids = [
                batch_id.strip()
                for batch_id in str(fields.get("Inventory Batch IDs", "")).split(",")
                if batch_id.strip()
            ]
            sales.append(
                XuSaleResponse(
                    id=sale_id,
                    buyerType=fields.get("Buyer Type", "xuzong"),
                    currency=fields.get("Currency", "USDT"),
                    createdAt=fields.get("Created At", _utc_now_iso()),
                    inventoryBatchIds=inventory_batch_ids,
                    taxRatePercent=_safe_number(fields.get("Tax Rate Percent"), 7.5),
                    usdToUsdtRate=_safe_number(fields.get("USD to USDT Rate"), _safe_number(fields.get("USDT to USD Rate"), 0)),
                    grossRevenueUsdt=_safe_number(fields.get("Gross Revenue USDT"), 0),
                    grossRevenueUsdConverted=_safe_number(fields.get("Gross Revenue USD Converted"), 0),
                    inventoryCostUsd=_safe_number(fields.get("Inventory Cost USD"), 0),
                    grossProfitUsdConverted=_safe_number(fields.get("Gross Profit USD Converted"), 0),
                    profitStatus=fields.get("Profit Status", "待汇率换算"),
                    lines=lines_by_sale_id.get(sale_id, []),
                )
            )
        return sales

    async def list_brazil_sales(self) -> list[BrazilSaleResponse]:
        if not _brazil_sales_tables_configured():
            return []

        sale_records = await self._list_records(settings.airtable_brazil_sales_table_name, sort_field="Created At")
        line_records = await self._list_records(settings.airtable_brazil_sale_lines_table_name, sort_field="Created At")
        lines_by_sale_id: dict[str, list[BrazilSaleLine]] = {}
        for line_record in line_records:
            fields = line_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            lines_by_sale_id.setdefault(sale_id, []).append(
                BrazilSaleLine(
                    batchId=fields.get("Batch ID", ""),
                    label=fields.get("Batch Label", ""),
                    ourDryWeight=_safe_number(fields.get("Our Dry Weight"), 0),
                    ourPurity=_safe_number(fields.get("Our Purity"), 0),
                    adjustedPurity=_safe_number(fields.get("Adjusted Purity"), 0),
                    purityAdjustmentPercent=_safe_number(fields.get("Purity Adjustment Percent"), 0),
                    fineGoldDelivered=_safe_number(fields.get("Fine Gold Delivered"), 0),
                    referenceIntlGoldPrice=_safe_number(
                        fields.get("Source Ave Intl Gold Price"),
                        _safe_number(fields.get("Reference Intl Gold Price"), 0),
                    ),
                    referenceIntlGoldPriceLabel=fields.get(
                        "Source Ave Intl Gold Price Label",
                        fields.get("Reference Intl Gold Price Label", ""),
                    ),
                    rawPricePerGramUsdt=_safe_number(fields.get("Raw Price Per Gram USDT"), 0),
                    saleIntlGoldPrice=_safe_number(fields.get("Sale Intl Gold Price"), 0),
                    taxRatePercent=_safe_number(fields.get("Tax Rate Percent"), 0),
                    netPricePerGramUsdt=_safe_number(fields.get("Net Price Per Gram USDT"), 0),
                    settledKgCount=_safe_number(fields.get("Settled Kg Count"), 0),
                    lineRevenueUsdt=_safe_number(fields.get("Line Revenue USDT"), 0),
                    allocatedCostUsd=_safe_number(fields.get("Allocated Cost USD"), 0),
                )
            )

        sales: list[BrazilSaleResponse] = []
        for sale_record in reversed(sale_records):
            fields = sale_record.get("fields", {})
            sale_id = fields.get("Sale ID")
            if not sale_id:
                continue
            inventory_batch_ids = [
                batch_id.strip()
                for batch_id in str(fields.get("Inventory Batch IDs", "")).split(",")
                if batch_id.strip()
            ]
            sales.append(
                BrazilSaleResponse(
                    id=sale_id,
                    buyerType=fields.get("Buyer Type", "brazil"),
                    currency=fields.get("Currency", "USDT"),
                    createdAt=fields.get("Created At", _utc_now_iso()),
                    inventoryBatchIds=inventory_batch_ids,
                    taxRatePercent=_safe_number(fields.get("Tax Rate Percent"), 7.5),
                    usdToUsdtRate=_safe_number(fields.get("USD to USDT Rate"), 0),
                    grossRevenueUsdt=_safe_number(fields.get("Gross Revenue USDT"), 0),
                    grossRevenueUsdConverted=_safe_number(fields.get("Gross Revenue USD Converted"), 0),
                    inventoryCostUsd=_safe_number(fields.get("Inventory Cost USD"), 0),
                    settledCostUsd=_safe_number(fields.get("Settled Cost USD"), 0),
                    grossProfitUsdConverted=_safe_number(fields.get("Gross Profit USD Converted"), 0),
                    fineGoldDelivered=_safe_number(fields.get("Fine Gold Delivered"), 0),
                    fineGoldSettled=_safe_number(fields.get("Fine Gold Settled"), 0),
                    fineGoldBalanceBefore=_safe_number(fields.get("Fine Gold Balance Before"), 0),
                    fineGoldBalanceAfter=_safe_number(fields.get("Fine Gold Balance After"), 0),
                    costBalanceBeforeUsd=_safe_number(fields.get("Cost Balance Before USD"), 0),
                    costBalanceAfterUsd=_safe_number(fields.get("Cost Balance After USD"), 0),
                    profitStatus=fields.get("Profit Status", "已按汇率换算"),
                    lines=lines_by_sale_id.get(sale_id, []),
                )
            )
        return sales

    async def get_brazil_balance(self) -> BrazilBalanceResponse:
        if not _brazil_sales_tables_configured():
            return BrazilBalanceResponse(fineGoldBalanceAfter=0, costBalanceAfterUsd=0, createdAt="")

        sales = await self.list_brazil_sales()
        if not sales:
            return BrazilBalanceResponse(fineGoldBalanceAfter=0, costBalanceAfterUsd=0, createdAt="")

        latest_sale = sales[0]
        return BrazilBalanceResponse(
            fineGoldBalanceAfter=latest_sale.fineGoldBalanceAfter,
            costBalanceAfterUsd=latest_sale.costBalanceAfterUsd,
            createdAt=latest_sale.createdAt,
        )

    async def create_company_sale(self, payload: CompanySaleCreate) -> CompanySaleResponse:
        if not _company_sales_tables_configured():
            raise HTTPException(
                status_code=400,
                detail="请先在 Airtable 建立 Company Sales 和 Company Sale Lines 两张表，再保存公司卖出记录",
            )

        sale_id = f"sale-{uuid4().hex[:12]}"
        created_at = _normalize_date_value(payload.createdAt)
        await self._create_record(
            settings.airtable_company_sales_table_name,
            {
                "Sale ID": sale_id,
                "Buyer Type": payload.buyerType,
                "Currency": payload.currency,
                "Created At": created_at,
                "Inventory Batch IDs": ", ".join(payload.inventoryBatchIds),
                "Batch Count": len(payload.inventoryBatchIds),
                "Gross Revenue USD": payload.grossRevenueUsd,
                "Inventory Cost USD": payload.inventoryCostUsd,
                "Gross Profit USD": payload.grossProfitUsd,
            },
        )

        for line in payload.lines:
            base_line_fields = {
                "Company Sale Line ID": f"sale-line-{uuid4().hex[:12]}",
                "Sale ID": sale_id,
                "Batch ID": line.batchId,
                "Batch Label": line.label,
                "Our Dry Weight": line.ourDryWeight,
                "Our Purity": line.ourPurity,
                "Sale Intl Gold Price": line.saleIntlGoldPrice,
                "Buyer Dry Weight": line.buyerDryWeight,
                "Buyer Purity": line.buyerPurity,
                "Buyer Price Per Gram USD": line.buyerPricePerGramUsd,
                "Line Amount Raw": line.lineAmountRaw,
                "Line Amount Rounded": line.lineAmountRounded,
                "Allocated Cost USD": line.allocatedCostUsd,
                "Line Profit USD": line.lineProfitUsd,
                "Created At": created_at,
            }
            extended_line_fields = {
                **base_line_fields,
                "Source Ave Intl Gold Price": line.referenceIntlGoldPrice,
                "Source Ave Intl Gold Price Label": line.referenceIntlGoldPriceLabel,
            }
            try:
                await self._create_record(
                    settings.airtable_company_sale_lines_table_name,
                    extended_line_fields,
                )
            except HTTPException as error:
                detail = error.detail
                unknown_field_error = False
                if isinstance(detail, dict):
                    nested_error = detail.get("error", {})
                    unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
                if not unknown_field_error:
                    raise
                await self._create_record(settings.airtable_company_sale_lines_table_name, base_line_fields)

        return CompanySaleResponse(
            id=sale_id,
            buyerType=payload.buyerType,
            currency=payload.currency,
            createdAt=created_at,
            inventoryBatchIds=payload.inventoryBatchIds,
            grossRevenueUsd=payload.grossRevenueUsd,
            inventoryCostUsd=payload.inventoryCostUsd,
            grossProfitUsd=payload.grossProfitUsd,
            lines=payload.lines,
        )

    async def create_xu_sale(self, payload: XuSaleCreate) -> XuSaleResponse:
        if not _xu_sales_tables_configured():
            raise HTTPException(
                status_code=400,
                detail="请先在 Airtable 建立 Xu Sales 和 Xu Sale Lines 两张表，再保存许总卖出记录",
            )

        sale_id = f"xu-sale-{uuid4().hex[:12]}"
        created_at = _normalize_date_value(payload.createdAt)
        await self._create_record(
            settings.airtable_xu_sales_table_name,
            {
                "Sale ID": sale_id,
                "Buyer Type": payload.buyerType,
                "Currency": payload.currency,
                "Created At": created_at,
                "Inventory Batch IDs": ", ".join(payload.inventoryBatchIds),
                "Batch Count": len(payload.inventoryBatchIds),
                "Tax Rate Percent": payload.taxRatePercent,
                "USD to USDT Rate": payload.usdToUsdtRate,
                "Gross Revenue USDT": payload.grossRevenueUsdt,
                "Gross Revenue USD Converted": payload.grossRevenueUsdConverted,
                "Inventory Cost USD": payload.inventoryCostUsd,
                "Gross Profit USD Converted": payload.grossProfitUsdConverted,
                "Profit Status": payload.profitStatus,
            },
        )

        for line in payload.lines:
            base_line_fields = {
                "Xu Sale Line ID": f"xu-sale-line-{uuid4().hex[:12]}",
                "Sale ID": sale_id,
                "Batch ID": line.batchId,
                "Batch Label": line.label,
                "Our Dry Weight": line.ourDryWeight,
                "Our Purity": line.ourPurity,
                "Adjusted Purity": line.adjustedPurity,
                "Sale Intl Gold Price": line.saleIntlGoldPrice,
                "Tax Rate Percent": line.taxRatePercent,
                "Purity Adjustment Percent": line.purityAdjustmentPercent,
                "Net Price Per Gram USDT": line.netPricePerGramUsdt,
                "Line Amount Raw USDT": line.lineAmountRawUsdt,
                "Line Amount Rounded USDT": line.lineAmountRoundedUsdt,
                "Allocated Cost USD": line.allocatedCostUsd,
                "Created At": created_at,
            }
            extended_line_fields = {
                **base_line_fields,
                "Source Ave Intl Gold Price": line.referenceIntlGoldPrice,
                "Source Ave Intl Gold Price Label": line.referenceIntlGoldPriceLabel,
            }
            try:
                await self._create_record(
                    settings.airtable_xu_sale_lines_table_name,
                    extended_line_fields,
                )
            except HTTPException as error:
                detail = error.detail
                unknown_field_error = False
                if isinstance(detail, dict):
                    nested_error = detail.get("error", {})
                    unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
                if not unknown_field_error:
                    raise
                await self._create_record(settings.airtable_xu_sale_lines_table_name, base_line_fields)

        return XuSaleResponse(
            id=sale_id,
            buyerType=payload.buyerType,
            currency=payload.currency,
            createdAt=created_at,
            inventoryBatchIds=payload.inventoryBatchIds,
            taxRatePercent=payload.taxRatePercent,
            usdToUsdtRate=payload.usdToUsdtRate,
            grossRevenueUsdt=payload.grossRevenueUsdt,
            grossRevenueUsdConverted=payload.grossRevenueUsdConverted,
            inventoryCostUsd=payload.inventoryCostUsd,
            grossProfitUsdConverted=payload.grossProfitUsdConverted,
            profitStatus=payload.profitStatus,
            lines=payload.lines,
        )

    async def create_brazil_sale(self, payload: BrazilSaleCreate) -> BrazilSaleResponse:
        if not _brazil_sales_tables_configured():
            raise HTTPException(
                status_code=400,
                detail="请先在 Airtable 建立 Brazil Sales、Brazil Sale Lines、Brazil Balance Ledger 三张表，再保存巴西佬卖出记录",
            )

        sale_id = f"brazil-sale-{uuid4().hex[:12]}"
        ledger_id = f"brazil-ledger-{uuid4().hex[:12]}"
        created_at = _normalize_date_value(payload.createdAt)
        await self._create_record(
            settings.airtable_brazil_sales_table_name,
            {
                "Sale ID": sale_id,
                "Buyer Type": payload.buyerType,
                "Currency": payload.currency,
                "Created At": created_at,
                "Inventory Batch IDs": ", ".join(payload.inventoryBatchIds),
                "Batch Count": len(payload.inventoryBatchIds),
                "Tax Rate Percent": payload.taxRatePercent,
                "USD to USDT Rate": payload.usdToUsdtRate,
                "Gross Revenue USDT": payload.grossRevenueUsdt,
                "Gross Revenue USD Converted": payload.grossRevenueUsdConverted,
                "Inventory Cost USD": payload.inventoryCostUsd,
                "Settled Cost USD": payload.settledCostUsd,
                "Gross Profit USD Converted": payload.grossProfitUsdConverted,
                "Fine Gold Delivered": payload.fineGoldDelivered,
                "Fine Gold Settled": payload.fineGoldSettled,
                "Fine Gold Balance Before": payload.fineGoldBalanceBefore,
                "Fine Gold Balance After": payload.fineGoldBalanceAfter,
                "Cost Balance Before USD": payload.costBalanceBeforeUsd,
                "Cost Balance After USD": payload.costBalanceAfterUsd,
                "Profit Status": payload.profitStatus,
            },
        )

        for line in payload.lines:
            minimal_line_fields = {
                "Brazil Sale Line ID": f"brazil-sale-line-{uuid4().hex[:12]}",
                "Sale ID": sale_id,
                "Batch ID": line.batchId,
                "Batch Label": line.label,
                "Our Dry Weight": line.ourDryWeight,
                "Our Purity": line.ourPurity,
                "Fine Gold Delivered": line.fineGoldDelivered,
                "Raw Price Per Gram USDT": line.rawPricePerGramUsdt,
                "Sale Intl Gold Price": line.saleIntlGoldPrice,
                "Tax Rate Percent": line.taxRatePercent,
                "Net Price Per Gram USDT": line.netPricePerGramUsdt,
                "Settled Kg Count": line.settledKgCount,
                "Line Revenue USDT": line.lineRevenueUsdt,
                "Allocated Cost USD": line.allocatedCostUsd,
                "Created At": created_at,
            }
            base_line_fields = {
                **minimal_line_fields,
                "Adjusted Purity": line.adjustedPurity,
                "Purity Adjustment Percent": line.purityAdjustmentPercent,
            }
            extended_line_fields = {
                **base_line_fields,
                "Source Ave Intl Gold Price": line.referenceIntlGoldPrice,
                "Source Ave Intl Gold Price Label": line.referenceIntlGoldPriceLabel,
            }
            try:
                await self._create_record(
                    settings.airtable_brazil_sale_lines_table_name,
                    extended_line_fields,
                )
            except HTTPException as error:
                detail = error.detail
                unknown_field_error = False
                if isinstance(detail, dict):
                    nested_error = detail.get("error", {})
                    unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
                if not unknown_field_error:
                    raise
                try:
                    await self._create_record(settings.airtable_brazil_sale_lines_table_name, base_line_fields)
                except HTTPException as inner_error:
                    inner_detail = inner_error.detail
                    inner_unknown_field_error = False
                    if isinstance(inner_detail, dict):
                        nested_error = inner_detail.get("error", {})
                        inner_unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
                    if not inner_unknown_field_error:
                        raise
                    await self._create_record(settings.airtable_brazil_sale_lines_table_name, minimal_line_fields)

        fine_gold_available = payload.fineGoldBalanceBefore + payload.fineGoldDelivered
        cost_available_usd = payload.costBalanceBeforeUsd + payload.inventoryCostUsd
        average_cost_per_fine_gram_usd = (
            cost_available_usd / fine_gold_available if fine_gold_available > 0 else 0
        )
        await self._create_record(
            settings.airtable_brazil_balance_ledger_table_name,
            {
                "Ledger ID": ledger_id,
                "Sale ID": sale_id,
                "Created At": created_at,
                "Fine Gold Balance Before": payload.fineGoldBalanceBefore,
                "Fine Gold Delivered": payload.fineGoldDelivered,
                "Fine Gold Available": fine_gold_available,
                "Fine Gold Settled": payload.fineGoldSettled,
                "Fine Gold Balance After": payload.fineGoldBalanceAfter,
                "Cost Balance Before USD": payload.costBalanceBeforeUsd,
                "Cost Delivered USD": payload.inventoryCostUsd,
                "Cost Available USD": cost_available_usd,
                "Average Cost Per Fine Gram USD": average_cost_per_fine_gram_usd,
                "Settled Cost USD": payload.settledCostUsd,
                "Cost Balance After USD": payload.costBalanceAfterUsd,
                "Gross Revenue USDT": payload.grossRevenueUsdt,
                "Gross Revenue USD Converted": payload.grossRevenueUsdConverted,
                "Gross Profit USD Converted": payload.grossProfitUsdConverted,
                "Notes": "",
            },
        )

        return BrazilSaleResponse(
            id=sale_id,
            buyerType=payload.buyerType,
            currency=payload.currency,
            createdAt=created_at,
            inventoryBatchIds=payload.inventoryBatchIds,
            taxRatePercent=payload.taxRatePercent,
            usdToUsdtRate=payload.usdToUsdtRate,
            grossRevenueUsdt=payload.grossRevenueUsdt,
            grossRevenueUsdConverted=payload.grossRevenueUsdConverted,
            inventoryCostUsd=payload.inventoryCostUsd,
            settledCostUsd=payload.settledCostUsd,
            grossProfitUsdConverted=payload.grossProfitUsdConverted,
            fineGoldDelivered=payload.fineGoldDelivered,
            fineGoldSettled=payload.fineGoldSettled,
            fineGoldBalanceBefore=payload.fineGoldBalanceBefore,
            fineGoldBalanceAfter=payload.fineGoldBalanceAfter,
            costBalanceBeforeUsd=payload.costBalanceBeforeUsd,
            costBalanceAfterUsd=payload.costBalanceAfterUsd,
            profitStatus=payload.profitStatus,
            lines=payload.lines,
        )

    async def list_reservations(self, customer_name: str, customer_phone: str) -> list[ReservationResponse]:
        if customer_phone:
            filter_formula = (
                f'AND({{Customer Name}}="{_escape_formula(customer_name)}",{{Customer Phone}}="{_escape_formula(customer_phone)}",{{Status}}="open")'
            )
        else:
            filter_formula = (
                f'AND({{Customer Name}}="{_escape_formula(customer_name)}",{{Status}}="open")'
            )
        records = await self._list_records(
            settings.airtable_reservations_table_name,
            filter_formula=filter_formula,
            sort_field="Reserved At",
        )
        reservations = []
        for record in records:
            fields = record.get("fields", {})
            reservations.append(
                ReservationResponse(
                    id=fields["Reservation ID"],
                    customerId=fields["Customer ID"],
                    customerName=fields["Customer Name"],
                    customerPhone=fields.get("Customer Phone", ""),
                    reservedWeight=fields["Reserved Weight"],
                    lockedIntlGoldPrice=fields["Locked Intl Gold Price"],
                    taxRate=_safe_number(fields.get("Reserved Tax Rate"), 0),
                    remainingReservedWeight=fields["Remaining Reserved Weight"],
                    reservedAt=fields["Reserved At"],
                    status=fields.get("Status", "open"),
                )
            )
        return reservations

    async def create_reservation(self, payload: ReservationCreateRequest) -> ReservationResponse:
        customer = await self._upsert_customer(payload.customerName.strip(), payload.customerPhone.strip())
        reservation_id = f"res-{uuid4().hex[:12]}"
        base_fields = {
            "Reservation ID": reservation_id,
            "Customer ID": customer["customerId"],
            "Customer Name": customer["customerName"],
            "Customer Phone": customer["customerPhone"],
            "Reserved Weight": payload.reservedWeight,
            "Locked Intl Gold Price": payload.lockedIntlGoldPrice,
            "Remaining Reserved Weight": payload.reservedWeight,
            "Reserved At": _normalize_datetime_value(payload.reservedAt),
            "Status": "open",
        }
        extended_fields = {
            **base_fields,
            "Reserved Tax Rate": payload.taxRate,
        }
        try:
            created = await self._create_record(
                settings.airtable_reservations_table_name,
                extended_fields,
            )
        except HTTPException as error:
            detail = error.detail
            unknown_field_error = False
            if isinstance(detail, dict):
                nested_error = detail.get("error", {})
                unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
            if not unknown_field_error:
                raise
            created = await self._create_record(
                settings.airtable_reservations_table_name,
                base_fields,
            )
        fields = created["fields"]
        return ReservationResponse(
            id=fields["Reservation ID"],
            customerId=fields["Customer ID"],
            customerName=fields["Customer Name"],
            customerPhone=fields.get("Customer Phone", ""),
            reservedWeight=fields["Reserved Weight"],
            lockedIntlGoldPrice=fields["Locked Intl Gold Price"],
            taxRate=_safe_number(fields.get("Reserved Tax Rate"), payload.taxRate),
            remainingReservedWeight=fields["Remaining Reserved Weight"],
            reservedAt=fields["Reserved At"],
            status=fields["Status"],
        )

    async def delete_reservation(self, reservation_id: str) -> None:
        reservation_record = await self._find_reservation_record(reservation_id)
        if not reservation_record:
            raise HTTPException(status_code=404, detail="Reservation not found")

        fields = reservation_record.get("fields", {})
        if fields.get("Status") != "open":
            raise HTTPException(status_code=409, detail="只能删除未完成的预定")

        reserved_weight = _safe_number(fields.get("Reserved Weight"), 0)
        remaining_weight = _safe_number(fields.get("Remaining Reserved Weight"), 0)
        if abs(remaining_weight - reserved_weight) > 0.0001:
            raise HTTPException(status_code=409, detail="这条预定已经被部分使用，不能直接删除")

        await self._delete_record(settings.airtable_reservations_table_name, reservation_record["id"])

    async def _find_reservation_record(self, reservation_id: str) -> dict[str, Any] | None:
        return await self._find_first_record(
            settings.airtable_reservations_table_name,
            filter_formula=f'{{Reservation ID}}="{_escape_formula(reservation_id)}"',
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
        fields = created["fields"]
        return OrderResponse(
            id=fields["Order ID"],
            customerId=fields["Customer ID"],
            customerName=fields["Customer Name"],
            customerPhone=fields.get("Customer Phone", ""),
            status=fields.get("Status", "draft"),
            createdAt=fields.get("Created At", _utc_now_iso()),
            paidAt=fields.get("Paid At", ""),
            items=[],
            summary=OrderSummary(itemCount=0, totalAmount=0),
        )

    async def _find_order_record(self, order_id: str) -> dict[str, Any]:
        record = await self._find_first_record(
            settings.airtable_orders_table_name,
            filter_formula=f'{{Order ID}}="{_escape_formula(order_id)}"',
        )
        if not record:
            raise HTTPException(status_code=404, detail="Order not found")
        return record

    async def _list_item_records(self, order_id: str) -> list[dict[str, Any]]:
        return await self._list_records(
            settings.airtable_items_table_name,
            filter_formula=f'{{Order ID}}="{_escape_formula(order_id)}"',
            sort_field="Saved At",
        )

    async def _list_allocation_records(self, order_id: str) -> list[dict[str, Any]]:
        return await self._list_records(
            settings.airtable_allocations_table_name,
            filter_formula=f'{{Order ID}}="{_escape_formula(order_id)}"',
            sort_field="Created At",
        )

    async def _build_order_response_from_record(self, order_record: dict[str, Any]) -> OrderResponse:
        item_records = await self._list_item_records(order_record["fields"]["Order ID"])
        allocation_records = await self._list_allocation_records(order_record["fields"]["Order ID"])
        allocations_by_item: dict[str, list[OrderItemAllocation]] = {}
        reservation_id_by_item: dict[str, str] = {}
        for allocation_record in allocation_records:
            fields = allocation_record.get("fields", {})
            allocation = OrderItemAllocation(
                pricingMode=fields.get("Pricing Mode", "spot"),
                label=fields.get("Allocation Label", "实时价部分"),
                reservationId=fields.get("Reservation ID", ""),
                allocatedWeight=_safe_number(fields.get("Allocated Weight"), 0),
                intlGoldPriceUsed=_safe_number(fields.get("Intl Gold Price Used"), 0),
                taxRateUsed=_safe_number(fields.get("Tax Rate Used"), 0),
                perGramPrice=_safe_number(fields.get("Per Gram Price"), 0),
                finalPrice=_safe_number(fields.get("Final Price"), 0),
                lineTotal=_safe_number(fields.get("Line Total"), 0),
            )
            item_id = fields.get("Item ID")
            if not item_id:
                continue
            allocations_by_item.setdefault(item_id, []).append(allocation)
            if fields.get("Pricing Mode") == "reserved" and fields.get("Reservation ID"):
                reservation_id_by_item.setdefault(item_id, fields["Reservation ID"])

        items = []
        for item_record in item_records:
            fields = item_record.get("fields", {})
            item_id = fields.get("Item ID")
            order_id = fields.get("Order ID")
            customer_id = fields.get("Customer ID")
            saved_at = fields.get("Saved At")
            rule_name = fields.get("Rule Name")
            rule_constant = fields.get("Rule Constant")
            if not all([item_id, order_id, customer_id, saved_at, rule_name]) or rule_constant is None:
                continue
            allocations = allocations_by_item.get(item_id, [])
            reserved_weight_applied = sum(
                allocation.allocatedWeight for allocation in allocations if allocation.pricingMode == "reserved"
            )
            dry_weight = _safe_number(fields.get("Dry Weight"), 0)
            purity = _safe_number(fields.get("Purity"), 0)
            final_price = _safe_number(fields.get("Final Price"), 0)
            item = {
                "id": item_id,
                "orderId": order_id,
                "customerId": customer_id,
                "customerName": fields.get("Customer Name", ""),
                "customerPhone": fields.get("Customer Phone", ""),
                "savedAt": saved_at,
                "pricingMode": fields.get("Pricing Mode", "auto"),
                "ruleName": rule_name,
                "ruleConstant": _safe_number(rule_constant, 0),
                "waterWeight": _safe_number(fields.get("Water Weight"), 0),
                "dryWeight": dry_weight,
                "taxRate": _safe_number(fields.get("Tax Rate"), 0),
                "intlGoldPrice": _safe_number(fields.get("International Gold Price"), 0),
                "purity": purity,
                "perGramPrice": _safe_number(fields.get("Per Gram Price"), final_price),
                "finalPrice": final_price,
                "totalPrice": _safe_number(fields.get("Line Total"), 0),
                "calculatedPurity": _safe_number(fields.get("Calculated Purity"), purity),
                "calculatedPerGramPrice": _safe_number(fields.get("Calculated Per Gram Price"), final_price),
                "manualPurity": fields.get("Manual Purity"),
                "manualPerGramPrice": fields.get("Manual Per Gram Price"),
                "effectivePurity": _safe_number(fields.get("Effective Purity"), purity),
                "effectivePerGramPrice": _safe_number(fields.get("Effective Per Gram Price"), final_price),
                "usedReservationId": fields.get("Used Reservation ID", reservation_id_by_item.get(item_id, "")),
                "usedReservationIds": list(
                    {
                        allocation.reservationId
                        for allocation in allocations
                        if allocation.pricingMode == "reserved" and allocation.reservationId
                    }
                ),
                "reservedWeightApplied": reserved_weight_applied,
                "spotWeightApplied": max(dry_weight - reserved_weight_applied, 0),
                "allocations": allocations,
            }
            items.append(item)

        order_fields = order_record["fields"]
        return OrderResponse(
            id=order_fields["Order ID"],
            customerId=order_fields["Customer ID"],
            customerName=order_fields["Customer Name"],
            customerPhone=order_fields.get("Customer Phone", ""),
            status=order_fields.get("Status", "draft"),
            createdAt=order_fields["Created At"],
            paidAt=order_fields.get("Paid At", ""),
            items=[OrderItemResponse(**item) for item in items],
            summary=_order_summary(items),
        )

    async def get_order(self, order_id: str) -> OrderResponse:
        return await self._build_order_response_from_record(await self._find_order_record(order_id))

    async def list_orders(self) -> list[OrderResponse]:
        order_records = await self._list_records(settings.airtable_orders_table_name, sort_field="Created At")
        responses = []
        for order_record in reversed(order_records):
            try:
                responses.append(await self._build_order_response_from_record(order_record))
            except Exception:
                continue
        return responses

    async def _refresh_order_totals(self, order_record: dict[str, Any]) -> None:
        response = await self._build_order_response_from_record(order_record)
        await self._update_record(
            settings.airtable_orders_table_name,
            order_record["id"],
            {"Total Items": response.summary.itemCount, "Total Amount": response.summary.totalAmount},
        )

    async def add_item(self, order_id: str, payload: OrderItemCreate) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        order_fields = order_record["fields"]
        if order_fields.get("Status") == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        reserved_allocations_by_id: dict[str, float] = {}
        for allocation in payload.allocations:
            if allocation.pricingMode == "reserved" and allocation.reservationId:
                reserved_allocations_by_id[allocation.reservationId] = (
                    reserved_allocations_by_id.get(allocation.reservationId, 0) + allocation.allocatedWeight
                )

        for reservation_id, allocated_weight in reserved_allocations_by_id.items():
            reservation_record = await self._find_reservation_record(reservation_id)
            if not reservation_record:
                raise HTTPException(status_code=404, detail="Reservation not found")
            reservation_fields = reservation_record["fields"]
            remaining_reserved_weight = max(
                _truncate_decimal(reservation_fields["Remaining Reserved Weight"] - allocated_weight, 4),
                0,
            )
            await self._update_record(
                settings.airtable_reservations_table_name,
                reservation_record["id"],
                {
                    "Remaining Reserved Weight": remaining_reserved_weight,
                    "Status": "fully_used" if remaining_reserved_weight == 0 else reservation_fields.get("Status", "open"),
                },
            )

        item_id = f"item-{uuid4().hex[:12]}"
        base_item_fields = {
            "Item ID": item_id,
            "Order ID": order_id,
            "Customer ID": order_fields["Customer ID"],
            "Customer Name": order_fields["Customer Name"],
            "Customer Phone": order_fields.get("Customer Phone", ""),
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
            "Used Reservation ID": payload.usedReservationId,
        }
        extended_item_fields = {
            **base_item_fields,
            "Pricing Mode": payload.pricingMode,
            "Calculated Purity": payload.calculatedPurity,
            "Calculated Per Gram Price": payload.calculatedPerGramPrice,
            "Manual Purity": payload.manualPurity,
            "Manual Per Gram Price": payload.manualPerGramPrice,
            "Effective Purity": payload.effectivePurity,
            "Effective Per Gram Price": payload.effectivePerGramPrice,
        }
        try:
            await self._create_record(
                settings.airtable_items_table_name,
                {key: value for key, value in extended_item_fields.items() if value is not None},
            )
        except HTTPException as error:
            detail = error.detail
            unknown_field_error = False
            if isinstance(detail, dict):
                nested_error = detail.get("error", {})
                unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
            if not unknown_field_error:
                raise
            await self._create_record(settings.airtable_items_table_name, base_item_fields)

        for allocation in payload.allocations:
            base_allocation_fields = {
                "Allocation ID": f"alloc-{uuid4().hex[:12]}",
                "Order ID": order_id,
                "Item ID": item_id,
                "Reservation ID": allocation.reservationId,
                "Pricing Mode": allocation.pricingMode,
                "Allocation Label": allocation.label,
                "Allocated Weight": allocation.allocatedWeight,
                "Intl Gold Price Used": allocation.intlGoldPriceUsed,
                "Per Gram Price": allocation.perGramPrice,
                "Final Price": allocation.finalPrice,
                "Line Total": allocation.lineTotal,
                "Created At": _utc_now_iso(),
            }
            extended_allocation_fields = {
                **base_allocation_fields,
                "Tax Rate Used": allocation.taxRateUsed,
            }
            try:
                await self._create_record(
                    settings.airtable_allocations_table_name,
                    {key: value for key, value in extended_allocation_fields.items() if value is not None},
                )
            except HTTPException as error:
                detail = error.detail
                unknown_field_error = False
                if isinstance(detail, dict):
                    nested_error = detail.get("error", {})
                    unknown_field_error = nested_error.get("type") == "UNKNOWN_FIELD_NAME"
                if not unknown_field_error:
                    raise
                await self._create_record(settings.airtable_allocations_table_name, base_allocation_fields)

        await self._refresh_order_totals(order_record)
        return await self.get_order(order_id)

    async def delete_item(self, order_id: str, item_id: str) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        if order_record["fields"].get("Status") == "paid":
            raise HTTPException(status_code=409, detail="Order is already paid")

        item_record = await self._find_first_record(
            settings.airtable_items_table_name,
            filter_formula=f'AND({{Order ID}}="{_escape_formula(order_id)}",{{Item ID}}="{_escape_formula(item_id)}")',
        )
        if not item_record:
            raise HTTPException(status_code=404, detail="Order item not found")

        item_fields = item_record["fields"]
        allocation_records = await self._list_records(
            settings.airtable_allocations_table_name,
            filter_formula=f'AND({{Order ID}}="{_escape_formula(order_id)}",{{Item ID}}="{_escape_formula(item_id)}")',
        )
        reserved_allocations_by_id: dict[str, float] = {}
        for allocation_record in allocation_records:
            fields = allocation_record["fields"]
            reservation_id = fields.get("Reservation ID", "")
            if fields.get("Pricing Mode") == "reserved" and reservation_id:
                reserved_allocations_by_id[reservation_id] = (
                    reserved_allocations_by_id.get(reservation_id, 0) + fields["Allocated Weight"]
                )

        for reservation_id, allocated_weight in reserved_allocations_by_id.items():
            reservation_record = await self._find_reservation_record(reservation_id)
            if reservation_record:
                reservation_fields = reservation_record["fields"]
                await self._update_record(
                    settings.airtable_reservations_table_name,
                    reservation_record["id"],
                    {
                        "Remaining Reserved Weight": _truncate_decimal(
                            reservation_fields["Remaining Reserved Weight"] + allocated_weight,
                            4,
                        ),
                        "Status": "open",
                    },
                )

        for allocation_record in allocation_records:
            await self._delete_record(settings.airtable_allocations_table_name, allocation_record["id"])

        await self._delete_record(settings.airtable_items_table_name, item_record["id"])
        await self._refresh_order_totals(order_record)
        return await self.get_order(order_id)

    async def pay_order(self, order_id: str) -> OrderResponse:
        order_record = await self._find_order_record(order_id)
        response = await self._build_order_response_from_record(order_record)
        if not response.items:
            raise HTTPException(status_code=400, detail="Order has no items")
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
