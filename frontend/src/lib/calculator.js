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
  return buildRecordPayloadWithReservation(values, []);
}

function normalizeReservations(reservations) {
  if (!reservations) {
    return [];
  }

  return Array.isArray(reservations) ? reservations : [reservations];
}

export function buildRecordPayloadWithReservation(values, reservations) {
  const customerName = values.customerName.trim();
  const customerPhone = values.customerPhone.trim();
  const waterWeight = Number.parseFloat(values.waterWeight);
  const dryWeight = Number.parseFloat(values.dryWeight);
  const taxRate = Number.parseFloat(values.taxRate);
  const intlGoldPrice = Number.parseFloat(values.intlGoldPrice);
  const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];
  const normalizedReservations = normalizeReservations(reservations);

  if (![waterWeight, dryWeight, taxRate].every(Number.isFinite)) {
    return { error: '请先完整输入干重、水重和税点' };
  }

  if (dryWeight === 0) {
    return { error: '干重不能为 0' };
  }

  const purityRaw = (waterWeight / dryWeight) * 2307.454 - rule.constant;
  const purity = truncateNumber(purityRaw, 2);
  const split = calculateReservationSplit({
    dryWeight,
    purity,
    taxRate,
    spotIntlGoldPrice: intlGoldPrice,
    reservations: normalizedReservations,
  });

  if (split.error) {
    return { error: split.error };
  }

  return {
    savedAt: new Date().toISOString(),
    customerName,
    customerPhone,
    ruleName: rule.label,
    ruleConstant: rule.constant,
    waterWeight,
    dryWeight,
    taxRate,
    intlGoldPrice: split.referenceIntlGoldPrice,
    purity,
    perGramPrice: split.referencePerGramPrice,
    finalPrice: split.referenceFinalPrice,
    totalPrice: split.totalPrice,
    usedReservationId: split.usedReservationId,
    usedReservationIds: split.usedReservationIds,
    reservedWeightApplied: split.reservedWeightApplied,
    spotWeightApplied: split.spotWeightApplied,
    allocations: split.allocations,
  };
}

export function calculateResults(values) {
  return calculateResultsWithReservation(values, []);
}

export function calculateResultsWithReservation(values, reservations) {
  const waterWeight = Number.parseFloat(values.waterWeight);
  const dryWeight = Number.parseFloat(values.dryWeight);
  const taxRate = Number.parseFloat(values.taxRate);
  const intlGoldPrice = Number.parseFloat(values.intlGoldPrice);
  const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];
  const normalizedReservations = normalizeReservations(reservations);

  if (![waterWeight, dryWeight].every(Number.isFinite)) {
    return { error: '请先输入水重和干重' };
  }

  if (dryWeight === 0) {
    return { error: '干重不能为 0' };
  }

  const purityRaw = (waterWeight / dryWeight) * 2307.454 - rule.constant;
  const purity = truncateNumber(purityRaw, 2);

  if (!Number.isFinite(taxRate)) {
    return {
      ruleName: rule.label,
      ruleConstant: rule.constant,
      waterWeight,
      dryWeight,
      purity,
      perGramPrice: Number.NaN,
      finalPrice: Number.NaN,
      totalPrice: Number.NaN,
      allocations: [],
      reservedWeightApplied: 0,
      spotWeightApplied: dryWeight,
      usedReservationId: '',
      usedReservationIds: [],
      intlGoldPrice: Number.NaN,
      missingMessage: '输入税点后继续计算金价',
      missingFields: true,
    };
  }

  const split = calculateReservationSplit({
    dryWeight,
    purity,
    taxRate,
    spotIntlGoldPrice: intlGoldPrice,
    reservations: normalizedReservations,
  });

  if (split.error) {
    return {
      ruleName: rule.label,
      ruleConstant: rule.constant,
      waterWeight,
      dryWeight,
      purity,
      perGramPrice: Number.NaN,
      finalPrice: Number.NaN,
      totalPrice: Number.NaN,
      allocations: [],
      reservedWeightApplied: split.reservedWeightApplied ?? 0,
      spotWeightApplied: split.spotWeightApplied ?? dryWeight,
      usedReservationId: split.usedReservationId ?? '',
      usedReservationIds: split.usedReservationIds ?? [],
      intlGoldPrice: Number.NaN,
      missingMessage: split.error,
      missingFields: true,
    };
  }

  return {
    ruleName: rule.label,
    ruleConstant: rule.constant,
    waterWeight,
    dryWeight,
    taxRate,
    intlGoldPrice: split.referenceIntlGoldPrice,
    purity,
    perGramPrice: split.referencePerGramPrice,
    finalPrice: split.referenceFinalPrice,
    totalPrice: split.totalPrice,
    allocations: split.allocations,
    reservedWeightApplied: split.reservedWeightApplied,
    spotWeightApplied: split.spotWeightApplied,
    usedReservationId: split.usedReservationId,
    usedReservationIds: split.usedReservationIds,
    missingFields: false,
  };
}

function calculateReservationSplit({ dryWeight, purity, taxRate, spotIntlGoldPrice, reservations }) {
  const normalizedReservations = normalizeReservations(reservations).filter(
    (reservation) => reservation && Number.isFinite(Number(reservation.remainingReservedWeight))
  );
  const allocations = [];
  const usedReservationIds = [];
  let remainingWeight = dryWeight;
  let reservedWeightAppliedTotal = 0;

  normalizedReservations.forEach((reservation, index) => {
    const availableReservedWeight = Math.max(Number(reservation.remainingReservedWeight), 0);
    const reservedWeightApplied = Math.min(remainingWeight, availableReservedWeight);
    if (reservedWeightApplied <= 0) {
      return;
    }

    const lockedIntlGoldPrice = Number(reservation.lockedIntlGoldPrice);
    const lockedPerGramPrice = lockedIntlGoldPrice / 31.1035;
    const finalPriceRaw = lockedPerGramPrice * (1 - taxRate / 100) * (purity / 100);
    const finalPrice = truncateNumber(finalPriceRaw, 2);
    const isMultiReservation = normalizedReservations.length > 1;
    allocations.push({
      pricingMode: 'reserved',
      label: isMultiReservation ? `预定价部分 ${index + 1}` : '预定价部分',
      reservationId: reservation.id,
      allocatedWeight: truncateNumber(reservedWeightApplied, 4),
      intlGoldPriceUsed: lockedIntlGoldPrice,
      perGramPrice: lockedPerGramPrice,
      finalPrice,
      lineTotal: truncateNumber(reservedWeightApplied * finalPrice, 0),
    });
    usedReservationIds.push(reservation.id);
    reservedWeightAppliedTotal += reservedWeightApplied;
    remainingWeight = Math.max(remainingWeight - reservedWeightApplied, 0);
  });

  const reservedWeightApplied = truncateNumber(reservedWeightAppliedTotal, 4);
  const spotWeightApplied = truncateNumber(Math.max(remainingWeight, 0), 4);

  if (spotWeightApplied > 0 || allocations.length === 0) {
    if (!Number.isFinite(spotIntlGoldPrice)) {
      return {
        error: '只有超出预定克数的部分才需要填写当前国际金价',
        allocations,
        reservedWeightApplied,
        spotWeightApplied,
        usedReservationId: usedReservationIds[0] || '',
        usedReservationIds,
      };
    }

    const spotPerGramPrice = spotIntlGoldPrice / 31.1035;
    const finalPriceRaw = spotPerGramPrice * (1 - taxRate / 100) * (purity / 100);
    const finalPrice = truncateNumber(finalPriceRaw, 2);
    allocations.push({
      pricingMode: 'spot',
      label: allocations.length === 0 ? '实时价部分' : '超出部分实时价',
      reservationId: '',
      allocatedWeight: truncateNumber(allocations.length === 0 ? dryWeight : spotWeightApplied, 4),
      intlGoldPriceUsed: spotIntlGoldPrice,
      perGramPrice: spotPerGramPrice,
      finalPrice,
      lineTotal: truncateNumber((allocations.length === 0 ? dryWeight : spotWeightApplied) * finalPrice, 0),
    });
  }

  const totalPrice = allocations.reduce((sum, allocation) => sum + allocation.lineTotal, 0);
  const referenceAllocation = allocations[0];

  return {
    allocations,
    totalPrice,
    reservedWeightApplied,
    spotWeightApplied,
    usedReservationId: usedReservationIds[0] || '',
    usedReservationIds,
    referenceIntlGoldPrice: referenceAllocation?.intlGoldPriceUsed ?? Number.NaN,
    referencePerGramPrice: referenceAllocation?.perGramPrice ?? Number.NaN,
    referenceFinalPrice: referenceAllocation?.finalPrice ?? Number.NaN,
  };
}
