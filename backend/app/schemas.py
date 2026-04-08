from pydantic import BaseModel


class CalculationRequest(BaseModel):
    waterWeight: float
    dryWeight: float
    taxRate: float
    intlGoldPrice: float
    formulaRule: str = "2088.136"


class CalculationResponse(BaseModel):
    ruleName: str
    ruleConstant: float
    purity: float
    perGramPrice: float
    finalPrice: float
    totalPrice: float


class ReservationCreateRequest(BaseModel):
    customerName: str
    customerPhone: str
    reservedWeight: float
    lockedIntlGoldPrice: float
    reservedAt: str


class ReservationResponse(BaseModel):
    id: str
    customerId: str
    customerName: str
    customerPhone: str
    reservedWeight: float
    lockedIntlGoldPrice: float
    remainingReservedWeight: float
    reservedAt: str
    status: str


class CreateOrderRequest(BaseModel):
    customerName: str
    customerPhone: str


class OrderItemAllocation(BaseModel):
    pricingMode: str
    label: str
    reservationId: str = ""
    allocatedWeight: float
    intlGoldPriceUsed: float
    perGramPrice: float
    finalPrice: float
    lineTotal: float


class OrderItemCreate(BaseModel):
    savedAt: str
    customerName: str = ""
    customerPhone: str = ""
    ruleName: str
    ruleConstant: float
    waterWeight: float
    dryWeight: float
    taxRate: float
    intlGoldPrice: float
    purity: float
    perGramPrice: float
    finalPrice: float
    totalPrice: float
    usedReservationId: str = ""
    usedReservationIds: list[str] = []
    reservedWeightApplied: float = 0
    spotWeightApplied: float = 0
    allocations: list[OrderItemAllocation] = []


class OrderItemResponse(OrderItemCreate):
    id: str
    orderId: str
    customerId: str


class OrderSummary(BaseModel):
    itemCount: int
    totalAmount: float


class OrderResponse(BaseModel):
    id: str
    customerId: str
    customerName: str
    customerPhone: str
    status: str
    createdAt: str
    paidAt: str = ""
    items: list[OrderItemResponse]
    summary: OrderSummary


class HealthResponse(BaseModel):
    status: str
    airtable_enabled: bool
    storage_mode: str
