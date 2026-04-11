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
    taxRate: float
    reservedAt: str


class ReservationResponse(BaseModel):
    id: str
    customerId: str
    customerName: str
    customerPhone: str
    reservedWeight: float
    lockedIntlGoldPrice: float
    taxRate: float
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
    pricingMode: str = "auto"
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
    calculatedPurity: float | None = None
    calculatedPerGramPrice: float | None = None
    manualPurity: float | None = None
    manualPerGramPrice: float | None = None
    effectivePurity: float | None = None
    effectivePerGramPrice: float | None = None
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


class CompanySaleLine(BaseModel):
    batchId: str
    label: str
    ourDryWeight: float
    ourPurity: float
    referenceIntlGoldPrice: float | None = None
    referenceIntlGoldPriceLabel: str = ""
    saleIntlGoldPrice: float | None = None
    buyerDryWeight: float
    buyerPurity: float
    buyerPricePerGramUsd: float
    lineAmountRaw: float
    lineAmountRounded: float
    allocatedCostUsd: float
    lineProfitUsd: float


class CompanySaleCreate(BaseModel):
    buyerType: str
    currency: str = "USD"
    createdAt: str = ""
    inventoryBatchIds: list[str]
    grossRevenueUsd: float
    inventoryCostUsd: float
    grossProfitUsd: float
    lines: list[CompanySaleLine]


class CompanySaleResponse(CompanySaleCreate):
    id: str


class XuSaleLine(BaseModel):
    batchId: str
    label: str
    ourDryWeight: float
    ourPurity: float
    adjustedPurity: float
    referenceIntlGoldPrice: float | None = None
    referenceIntlGoldPriceLabel: str = ""
    saleIntlGoldPrice: float
    taxRatePercent: float
    purityAdjustmentPercent: float
    netPricePerGramUsdt: float
    lineAmountRawUsdt: float
    lineAmountRoundedUsdt: float
    allocatedCostUsd: float


class XuSaleCreate(BaseModel):
    buyerType: str = "xuzong"
    currency: str = "USDT"
    createdAt: str = ""
    inventoryBatchIds: list[str]
    taxRatePercent: float
    usdToUsdtRate: float
    grossRevenueUsdt: float
    grossRevenueUsdConverted: float
    inventoryCostUsd: float
    grossProfitUsdConverted: float
    profitStatus: str = "待汇率换算"
    lines: list[XuSaleLine]


class XuSaleResponse(XuSaleCreate):
    id: str


class BrazilSaleLine(BaseModel):
    batchId: str
    label: str
    ourDryWeight: float
    ourPurity: float
    adjustedPurity: float
    purityAdjustmentPercent: float
    fineGoldDelivered: float
    referenceIntlGoldPrice: float | None = None
    referenceIntlGoldPriceLabel: str = ""
    rawPricePerGramUsdt: float
    saleIntlGoldPrice: float
    taxRatePercent: float
    netPricePerGramUsdt: float
    settledKgCount: float
    lineRevenueUsdt: float
    allocatedCostUsd: float


class BrazilSaleCreate(BaseModel):
    buyerType: str = "brazil"
    currency: str = "USDT"
    createdAt: str = ""
    inventoryBatchIds: list[str]
    taxRatePercent: float
    usdToUsdtRate: float
    grossRevenueUsdt: float
    grossRevenueUsdConverted: float
    inventoryCostUsd: float
    settledCostUsd: float
    grossProfitUsdConverted: float
    fineGoldDelivered: float
    fineGoldSettled: float
    fineGoldBalanceBefore: float
    fineGoldBalanceAfter: float
    costBalanceBeforeUsd: float
    costBalanceAfterUsd: float
    profitStatus: str = "已按汇率换算"
    lines: list[BrazilSaleLine]


class BrazilSaleResponse(BrazilSaleCreate):
    id: str


class BrazilBalanceResponse(BaseModel):
    fineGoldBalanceAfter: float
    costBalanceAfterUsd: float
    createdAt: str = ""


class Permissions(BaseModel):
    canIntakeGold: bool = False
    canMeltGold: bool = False
    canSellGold: bool = False
    canViewCost: bool = False
    canViewProfit: bool = False
    canViewFormula: bool = False
    canManageFinancialDefaults: bool = False
    canManageUsers: bool = False


class UserSessionResponse(BaseModel):
    username: str
    displayName: str
    role: str
    permissions: Permissions


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user: UserSessionResponse


class FinancialDefaultsResponse(BaseModel):
    usdToUsdtRate: float


class FinancialDefaultsUpdateRequest(BaseModel):
    usdToUsdtRate: float


class HealthResponse(BaseModel):
    status: str
    airtable_enabled: bool
    storage_mode: str
