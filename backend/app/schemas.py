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


class CreateOrderRequest(BaseModel):
    customerName: str
    customerPhone: str


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
