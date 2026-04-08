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
    CreateOrderRequest,
    OrderItemAllocation,
    OrderItemCreate,
    OrderItemResponse,
    OrderResponse,
    OrderSummary,
    ReservationCreateRequest,
    ReservationResponse,
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


def _truncate_decimal(value: float, digits: int = 4) -> float:
    factor = 10**digits
    return int(value * factor) / factor


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
            and reservation["customerPhone"] == customer_phone
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
            "remainingReservedWeight": payload.reservedWeight,
            "reservedAt": _normalize_datetime_value(payload.reservedAt),
            "status": "open",
        }
        self.reservations_by_id[reservation["id"]] = reservation
        return ReservationResponse(**deepcopy(reservation))

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
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if filter_formula:
            params["filterByFormula"] = filter_formula
        if sort_field:
            params["sort[0][field]"] = sort_field
            params["sort[0][direction]"] = "asc"

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
                "customerPhone": fields["Customer Phone"],
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

    async def list_reservations(self, customer_name: str, customer_phone: str) -> list[ReservationResponse]:
        filter_formula = (
            f'AND({{Customer Name}}="{_escape_formula(customer_name)}",{{Customer Phone}}="{_escape_formula(customer_phone)}",{{Status}}="open")'
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
                    customerPhone=fields["Customer Phone"],
                    reservedWeight=fields["Reserved Weight"],
                    lockedIntlGoldPrice=fields["Locked Intl Gold Price"],
                    remainingReservedWeight=fields["Remaining Reserved Weight"],
                    reservedAt=fields["Reserved At"],
                    status=fields.get("Status", "open"),
                )
            )
        return reservations

    async def create_reservation(self, payload: ReservationCreateRequest) -> ReservationResponse:
        customer = await self._upsert_customer(payload.customerName.strip(), payload.customerPhone.strip())
        reservation_id = f"res-{uuid4().hex[:12]}"
        created = await self._create_record(
            settings.airtable_reservations_table_name,
            {
                "Reservation ID": reservation_id,
                "Customer ID": customer["customerId"],
                "Customer Name": customer["customerName"],
                "Customer Phone": customer["customerPhone"],
                "Reserved Weight": payload.reservedWeight,
                "Locked Intl Gold Price": payload.lockedIntlGoldPrice,
                "Remaining Reserved Weight": payload.reservedWeight,
                "Reserved At": _normalize_datetime_value(payload.reservedAt),
                "Status": "open",
            },
        )
        fields = created["fields"]
        return ReservationResponse(
            id=fields["Reservation ID"],
            customerId=fields["Customer ID"],
            customerName=fields["Customer Name"],
            customerPhone=fields["Customer Phone"],
            reservedWeight=fields["Reserved Weight"],
            lockedIntlGoldPrice=fields["Locked Intl Gold Price"],
            remainingReservedWeight=fields["Remaining Reserved Weight"],
            reservedAt=fields["Reserved At"],
            status=fields["Status"],
        )

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
        return await self._build_order_response_from_record(created)

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
                pricingMode=fields["Pricing Mode"],
                label=fields["Allocation Label"],
                reservationId=fields.get("Reservation ID", ""),
                allocatedWeight=fields["Allocated Weight"],
                intlGoldPriceUsed=fields["Intl Gold Price Used"],
                perGramPrice=fields["Per Gram Price"],
                finalPrice=fields["Final Price"],
                lineTotal=fields["Line Total"],
            )
            allocations_by_item.setdefault(fields["Item ID"], []).append(allocation)
            if fields.get("Pricing Mode") == "reserved" and fields.get("Reservation ID"):
                reservation_id_by_item.setdefault(fields["Item ID"], fields["Reservation ID"])

        items = []
        for item_record in item_records:
            fields = item_record.get("fields", {})
            allocations = allocations_by_item.get(fields["Item ID"], [])
            reserved_weight_applied = sum(
                allocation.allocatedWeight for allocation in allocations if allocation.pricingMode == "reserved"
            )
            item = {
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
                "usedReservationId": fields.get("Used Reservation ID", reservation_id_by_item.get(fields["Item ID"], "")),
                "usedReservationIds": list(
                    {
                        allocation.reservationId
                        for allocation in allocations
                        if allocation.pricingMode == "reserved" and allocation.reservationId
                    }
                ),
                "reservedWeightApplied": reserved_weight_applied,
                "spotWeightApplied": max(fields["Dry Weight"] - reserved_weight_applied, 0),
                "allocations": allocations,
            }
            items.append(item)

        order_fields = order_record["fields"]
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

    async def get_order(self, order_id: str) -> OrderResponse:
        return await self._build_order_response_from_record(await self._find_order_record(order_id))

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
                "Used Reservation ID": payload.usedReservationId,
            },
        )

        for allocation in payload.allocations:
            await self._create_record(
                settings.airtable_allocations_table_name,
                {
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
                },
            )

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
