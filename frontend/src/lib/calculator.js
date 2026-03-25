export const FORMULA_RULES = {
  '2088.136': { label: '标准回收规则', constant: 2088.136 },
  '2088.163': { label: '活动回收规则', constant: 2088.163 },
};

export function truncateNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  const factor = 10 ** digits;
  return Math.trunc(value * factor) / factor;
}

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function buildRecordPayload(values) {
  const customerName = values.customerName.trim();
  const customerPhone = values.customerPhone.trim();
  const waterWeight = Number.parseFloat(values.waterWeight);
  const dryWeight = Number.parseFloat(values.dryWeight);
  const taxRate = Number.parseFloat(values.taxRate);
  const intlGoldPrice = Number.parseFloat(values.intlGoldPrice);
  const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];

  if (![waterWeight, dryWeight, taxRate, intlGoldPrice].every(Number.isFinite)) {
    return { error: '请先完整输入所有数据' };
  }

  if (dryWeight === 0) {
    return { error: '干重不能为 0' };
  }

  const purityRaw = (waterWeight / dryWeight) * 2307.454 - rule.constant;
  const purity = truncateNumber(purityRaw, 2);
  const perGramPrice = intlGoldPrice / 31.1035;
  const finalPriceRaw = perGramPrice * (1 - taxRate / 100) * (purity / 100);
  const finalPrice = truncateNumber(finalPriceRaw, 2);
  const totalPriceRaw = dryWeight * finalPrice;
  const totalPrice = truncateNumber(totalPriceRaw, 0);

  return {
    savedAt: new Date().toISOString(),
    customerName,
    customerPhone,
    ruleName: rule.label,
    ruleConstant: rule.constant,
    waterWeight,
    dryWeight,
    taxRate,
    intlGoldPrice,
    purity,
    perGramPrice,
    finalPrice,
    totalPrice,
  };
}

export function calculateResults(values) {
  const waterWeight = Number.parseFloat(values.waterWeight);
  const dryWeight = Number.parseFloat(values.dryWeight);
  const taxRate = Number.parseFloat(values.taxRate);
  const intlGoldPrice = Number.parseFloat(values.intlGoldPrice);
  const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];

  if (![waterWeight, dryWeight].every(Number.isFinite)) {
    return { error: '请先输入水重和干重' };
  }

  if (dryWeight === 0) {
    return { error: '干重不能为 0' };
  }

  const purityRaw = (waterWeight / dryWeight) * 2307.454 - rule.constant;
  const purity = truncateNumber(purityRaw, 2);

  if (![taxRate, intlGoldPrice].every(Number.isFinite)) {
    return {
      ruleName: rule.label,
      ruleConstant: rule.constant,
      waterWeight,
      dryWeight,
      purity,
      perGramPrice: Number.NaN,
      finalPrice: Number.NaN,
      totalPrice: Number.NaN,
      missingFields: true,
    };
  }

  const perGramPrice = intlGoldPrice / 31.1035;
  const finalPriceRaw = perGramPrice * (1 - taxRate / 100) * (purity / 100);
  const finalPrice = truncateNumber(finalPriceRaw, 2);
  const totalPriceRaw = dryWeight * finalPrice;
  const totalPrice = truncateNumber(totalPriceRaw, 0);

  return {
    ruleName: rule.label,
    ruleConstant: rule.constant,
    waterWeight,
    dryWeight,
    taxRate,
    intlGoldPrice,
    purity,
    perGramPrice,
    finalPrice,
    totalPrice,
    missingFields: false,
  };
}
