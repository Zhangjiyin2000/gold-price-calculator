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


class GoldRecord(BaseModel):
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


class HealthResponse(BaseModel):
    status: str
    airtable_enabled: bool
