from math import trunc


FORMULA_RULES = {
    "2088.136": {"label": "标准回收规则", "constant": 2088.136},
    "2088.163": {"label": "活动回收规则", "constant": 2088.163},
}


def truncate_number(value: float, digits: int = 2) -> float:
    factor = 10**digits
    return trunc(value * factor) / factor


def calculate_record(
    *,
    water_weight: float,
    dry_weight: float,
    tax_rate: float,
    intl_gold_price: float,
    formula_rule: str,
) -> dict:
    rule = FORMULA_RULES.get(formula_rule, FORMULA_RULES["2088.136"])
    purity_raw = (water_weight / dry_weight) * 2307.454 - rule["constant"]
    purity = truncate_number(purity_raw, 2)
    per_gram_price = intl_gold_price / 31.1035
    final_price_raw = per_gram_price * (1 - tax_rate / 100) * (purity / 100)
    final_price = truncate_number(final_price_raw, 2)
    total_price = truncate_number(dry_weight * final_price, 0)

    return {
        "ruleName": rule["label"],
        "ruleConstant": rule["constant"],
        "purity": purity,
        "perGramPrice": per_gram_price,
        "finalPrice": final_price,
        "totalPrice": total_price,
    }
