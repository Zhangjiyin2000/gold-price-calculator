import { FORMULA_RULES, truncateNumber } from './calculator.js';

export function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function calculateFineGoldWeight(dryWeight, purity) {
  return truncateNumber(dryWeight * (purity / 100), 4);
}

export function buildInventoryBatchesFromOrders(existingBatches, orders) {
  const existingById = new Map(existingBatches.map((batch) => [batch.id, batch]));
  const importedIds = new Set();
  const nextBatches = [...existingBatches];

  orders.forEach((order) => {
    (order.items || []).forEach((item, index) => {
      const batchId = `raw-${item.id}`;
      importedIds.add(batchId);
      const nextRawBatch = {
        id: batchId,
        sourceType: 'order_item',
        sourceId: item.id,
        label: `${order.customerName} · 第 ${index + 1} 块`,
        customerName: order.customerName,
        orderId: order.id,
        createdAt: item.savedAt || order.createdAt,
        dryWeight: item.dryWeight,
        waterWeight: item.waterWeight,
        purity: item.effectivePurity || item.purity,
        fineGoldWeight: calculateFineGoldWeight(item.dryWeight, item.effectivePurity || item.purity),
        totalCostUsd: item.totalPrice,
        referenceIntlGoldPrice: Number(item.intlGoldPrice || 0),
        referenceIntlGoldPriceLabel: '我方收入国际金价',
        remainingFineGoldWeight: calculateFineGoldWeight(item.dryWeight, item.effectivePurity || item.purity),
        status: 'available',
        formulaRule: item.ruleConstant ? String(item.ruleConstant) : '2088.136',
      };
      if (existingById.has(batchId)) {
        const existingIndex = nextBatches.findIndex((batch) => batch.id === batchId);
        if (existingIndex >= 0) {
          nextBatches[existingIndex] = {
            ...nextBatches[existingIndex],
            ...nextRawBatch,
            status: nextBatches[existingIndex].status,
            soldBy: nextBatches[existingIndex].soldBy,
            consumedBy: nextBatches[existingIndex].consumedBy,
          };
        }
        return;
      }

      nextBatches.push(nextRawBatch);
    });
  });

  return nextBatches.map((batch) => {
    if (batch.sourceType !== 'order_item') {
      return batch;
    }

    if (importedIds.has(batch.id)) {
      return batch;
    }

    return batch;
  });
}

export function resolveReferenceIntlGoldPrice(batch, batchesById, visited = new Set()) {
  if (!batch || visited.has(batch.id)) {
    return { value: Number.NaN, label: '我方收入国际金价' };
  }

  if (Number.isFinite(Number(batch.referenceIntlGoldPrice)) && Number(batch.referenceIntlGoldPrice) > 0) {
    return {
      value: roundNumber(Number(batch.referenceIntlGoldPrice), 2),
      label: batch.referenceIntlGoldPriceLabel || '我方收入国际金价',
    };
  }

  if (batch.sourceType !== 'melt' || !Array.isArray(batch.sourceBatchIds) || batch.sourceBatchIds.length === 0) {
    return { value: Number.NaN, label: '我方收入国际金价' };
  }

  visited.add(batch.id);
  let weightedSum = 0;
  let totalWeight = 0;
  for (const sourceBatchId of batch.sourceBatchIds) {
    const sourceBatch = batchesById.get(sourceBatchId);
    if (!sourceBatch) {
      continue;
    }
    const resolved = resolveReferenceIntlGoldPrice(sourceBatch, batchesById, visited);
    const sourceWeight = roundNumber(Number(sourceBatch.dryWeight || 0), 2);
    if (!Number.isFinite(resolved.value) || sourceWeight <= 0) {
      continue;
    }
    weightedSum += resolved.value * sourceWeight;
    totalWeight += sourceWeight;
  }
  visited.delete(batch.id);

  if (totalWeight <= 0) {
    return { value: Number.NaN, label: '我方收入国际金价（加权平均）' };
  }

  return {
    value: roundNumber(weightedSum / totalWeight, 2),
    label: '我方收入国际金价（加权平均）',
  };
}

export function calculateMeltPreview(selectedBatches, outputDryWeight, outputWaterWeight, formulaRule) {
  const dryWeight = Number.parseFloat(outputDryWeight);
  const waterWeight = Number.parseFloat(outputWaterWeight);
  const normalizedDryWeight = roundNumber(dryWeight, 2);
  const normalizedWaterWeight = roundNumber(waterWeight, 2);
  const inputTotalDryWeight = roundNumber(
    selectedBatches.reduce((sum, batch) => sum + roundNumber(Number(batch.dryWeight || 0), 2), 0),
    2
  );
  const inputTotalCostUsd = selectedBatches.reduce((sum, batch) => sum + Number(batch.totalCostUsd || 0), 0);
  const rule = FORMULA_RULES[formulaRule] || FORMULA_RULES['2088.136'];

  if (!selectedBatches.length) {
    return { error: '请先选择要熔合的库存批次' };
  }

  if (![dryWeight, waterWeight].every(Number.isFinite) || dryWeight <= 0 || waterWeight <= 0) {
    return {
      inputTotalDryWeight,
      inputTotalCostUsd,
      error: '请先输入有效的熔后干重和水重',
    };
  }

  const purityRaw = (normalizedWaterWeight / normalizedDryWeight) * 2307.454 - rule.constant;
  const purity = truncateNumber(purityRaw, 2);
  const weightDifference = roundNumber(normalizedDryWeight - inputTotalDryWeight, 2);
  const fineGoldWeight = calculateFineGoldWeight(normalizedDryWeight, purity);
  const unitCostPerFineGram = fineGoldWeight > 0 ? roundNumber(inputTotalCostUsd / fineGoldWeight, 4) : Number.NaN;
  const weightedAverageIntlGoldPrice = inputTotalDryWeight > 0
    ? roundNumber(
        selectedBatches.reduce(
          (sum, batch) => sum + (_safeBatchIntlGoldPrice(batch) * roundNumber(Number(batch.dryWeight || 0), 2)),
          0
        ) / inputTotalDryWeight,
        2
      )
    : Number.NaN;

  return {
    inputTotalDryWeight,
    inputTotalCostUsd: roundNumber(inputTotalCostUsd, 2),
    outputDryWeight: normalizedDryWeight,
    outputWaterWeight: normalizedWaterWeight,
    purity,
    weightDifference,
    fineGoldWeight,
    unitCostPerFineGram,
    weightedAverageIntlGoldPrice,
    formulaRule,
  };
}

function _safeBatchIntlGoldPrice(batch) {
  return Number(batch.referenceIntlGoldPrice || 0);
}

export function calculateCompanySaleLinePreview(batch, input = {}) {
  const buyerDryWeight = Number.parseFloat(input.buyerDryWeight);
  const buyerPurity = Number.parseFloat(input.buyerPurity);
  const buyerPricePerGramUsd = Number.parseFloat(input.buyerPricePerGramUsd);

  if (![buyerDryWeight, buyerPurity, buyerPricePerGramUsd].every(Number.isFinite)) {
    return null;
  }

  const lineAmountRaw = buyerDryWeight * (buyerPurity / 100) * buyerPricePerGramUsd;
  const lineAmountRounded = roundNumber(lineAmountRaw, 2);
  const allocatedCostUsd = Number(batch.totalCostUsd || 0);

  return {
    batchId: batch.id,
    label: batch.label,
    ourDryWeight: batch.dryWeight,
    ourPurity: batch.purity,
    saleIntlGoldPrice: Number.parseFloat(input.saleIntlGoldPrice),
    buyerDryWeight,
    buyerPurity,
    buyerPricePerGramUsd,
    lineAmountRaw,
    lineAmountRounded,
    allocatedCostUsd,
    lineProfitUsd: lineAmountRounded - allocatedCostUsd,
  };
}

export function calculateCompanySalePreview(selectedBatches, companyInputs) {
  if (!selectedBatches.length) {
    return { error: '请先选择要卖出的库存批次' };
  }

  const lines = [];
  const missingBatchLabels = [];
  for (const batch of selectedBatches) {
    const input = companyInputs[batch.id] || {};
    const linePreview = calculateCompanySaleLinePreview(batch, input);

    if (!linePreview) {
      missingBatchLabels.push(batch.label);
      continue;
    }

    lines.push(linePreview);
  }

  if (!lines.length) {
    return {
      error: missingBatchLabels.length ? `请先完整输入 ${missingBatchLabels[0]} 的公司结算数据` : '请先输入公司结算数据',
      lines: [],
      totalRoundedBeforeInteger: Number.NaN,
      grossRevenueUsd: Number.NaN,
      inventoryCostUsd: Number.NaN,
      grossProfitUsd: Number.NaN,
      netProfitUsd: Number.NaN,
    };
  }

  const totalRoundedBeforeInteger = lines.reduce((sum, line) => sum + line.lineAmountRounded, 0);
  const grossRevenueUsd = roundNumber(totalRoundedBeforeInteger, 0);
  const inventoryCostUsd = roundNumber(lines.reduce((sum, line) => sum + line.allocatedCostUsd, 0), 2);
  const grossProfitUsd = roundNumber(grossRevenueUsd - inventoryCostUsd, 2);

  return {
    lines,
    error: missingBatchLabels.length ? `还有 ${missingBatchLabels.length} 块未填完整，暂时不能保存公司卖出` : '',
    totalRoundedBeforeInteger: roundNumber(totalRoundedBeforeInteger, 2),
    grossRevenueUsd,
    inventoryCostUsd,
    grossProfitUsd,
    netProfitUsd: grossProfitUsd,
  };
}

export function calculateXuSaleLinePreview(batch, input = {}, taxRatePercent) {
  const intlGoldPrice = Number.parseFloat(input.saleIntlGoldPrice);
  const taxRate = Number.parseFloat(taxRatePercent);
  const purityAdjustment = Number.parseFloat(input.purityAdjustmentPercent);

  if (![intlGoldPrice, taxRate, purityAdjustment].every(Number.isFinite)) {
    return null;
  }

  const adjustedPurity = roundNumber(Number(batch.purity || 0) + purityAdjustment, 2);
  const netPricePerGramUsdt = roundNumber((intlGoldPrice / 31.1035) * (1 - taxRate / 100), 4);
  const lineAmountRawUsdt = Number(batch.dryWeight || 0) * (adjustedPurity / 100) * netPricePerGramUsdt;
  const lineAmountRoundedUsdt = roundNumber(lineAmountRawUsdt, 0);

  return {
    batchId: batch.id,
    label: batch.label,
    ourDryWeight: batch.dryWeight,
    ourPurity: batch.purity,
    adjustedPurity,
    referenceIntlGoldPrice: batch.referenceIntlGoldPrice,
    referenceIntlGoldPriceLabel: batch.referenceIntlGoldPriceLabel || '我方收入国际金价',
    saleIntlGoldPrice: intlGoldPrice,
    taxRatePercent: taxRate,
    purityAdjustmentPercent: purityAdjustment,
    netPricePerGramUsdt,
    lineAmountRawUsdt,
    lineAmountRoundedUsdt,
    allocatedCostUsd: Number(batch.totalCostUsd || 0),
  };
}

export function calculateXuSalePreview(selectedBatches, xuInputs, taxRatePercent) {
  if (!selectedBatches.length) {
    return { error: '请先选择要卖出的库存批次' };
  }

  const lines = [];
  const missingBatchLabels = [];
  for (const batch of selectedBatches) {
    const linePreview = calculateXuSaleLinePreview(batch, xuInputs[batch.id] || {}, taxRatePercent);
    if (!linePreview) {
      missingBatchLabels.push(batch.label);
      continue;
    }
    lines.push(linePreview);
  }

  if (!lines.length) {
    return {
      error: missingBatchLabels.length ? `请先完整输入 ${missingBatchLabels[0]} 的国际金价和纯度加成` : '请先输入有效的卖出时国际金价、税点和纯度加成',
      lines: [],
      grossRevenueUsdt: Number.NaN,
      inventoryCostUsd: Number.NaN,
    };
  }

  return {
    lines,
    error: missingBatchLabels.length ? `还有 ${missingBatchLabels.length} 块未填完整，暂时不能保存许总卖出` : '',
    grossRevenueUsdt: roundNumber(lines.reduce((sum, line) => sum + line.lineAmountRoundedUsdt, 0), 0),
    inventoryCostUsd: roundNumber(lines.reduce((sum, line) => sum + line.allocatedCostUsd, 0), 2),
  };
}

export function calculateBrazilSaleLinePreview(batch, input = {}, taxRatePercent) {
  const rawPricePerGramUsdt = Number.parseFloat(input.rawPricePerGramUsdt);
  const settledKgCount = Number.parseFloat(input.settledKgCount);
  const taxRate = Number.parseFloat(taxRatePercent);
  const purityAdjustmentPercent = Number.parseFloat(
    input.purityAdjustmentPercent === '' || input.purityAdjustmentPercent === undefined
      ? '0.1'
      : input.purityAdjustmentPercent
  );

  if (![rawPricePerGramUsdt, settledKgCount, taxRate, purityAdjustmentPercent].every(Number.isFinite)) {
    return null;
  }

  const ourDryWeight = Number(batch.dryWeight || 0);
  const ourPurity = Number(batch.purity || 0);
  const adjustedPurity = roundNumber(ourPurity + purityAdjustmentPercent, 2);
  const fineGoldDelivered = truncateNumber(ourDryWeight * (adjustedPurity / 100), 2);
  const saleIntlGoldPrice = roundNumber(rawPricePerGramUsdt * 31.1035, 2);
  const netPricePerGramUsdt = truncateNumber(rawPricePerGramUsdt * (1 - taxRate / 100), 2);
  const lineRevenueUsdt = roundNumber(settledKgCount * 1000 * netPricePerGramUsdt, 2);

  return {
    batchId: batch.id,
    label: batch.label,
    ourDryWeight,
    ourPurity,
    adjustedPurity,
    purityAdjustmentPercent,
    fineGoldDelivered,
    referenceIntlGoldPrice: batch.referenceIntlGoldPrice,
    referenceIntlGoldPriceLabel: batch.referenceIntlGoldPriceLabel || '我方收入国际金价',
    rawPricePerGramUsdt,
    saleIntlGoldPrice,
    taxRatePercent: taxRate,
    netPricePerGramUsdt,
    settledKgCount,
    lineRevenueUsdt,
    allocatedCostUsd: Number(batch.totalCostUsd || 0),
  };
}

export function calculateBrazilSalePreview(
  selectedBatches,
  brazilInputs,
  taxRatePercent,
  usdToUsdtRate,
  fineGoldBalanceBefore = 0,
  costBalanceBeforeUsd = 0
) {
  if (!selectedBatches.length) {
    return { error: '请先选择要卖给巴西佬的库存批次' };
  }

  const lines = [];
  const missingBatchLabels = [];
  for (const batch of selectedBatches) {
    const linePreview = calculateBrazilSaleLinePreview(
      batch,
      brazilInputs[batch.id] || { purityAdjustmentPercent: '0.1' },
      taxRatePercent
    );
    if (!linePreview) {
      missingBatchLabels.push(batch.label);
      continue;
    }
    lines.push(linePreview);
  }

  if (!lines.length) {
    return {
      error: missingBatchLabels.length ? `请先完整输入 ${missingBatchLabels[0]} 的每克报价和结算公斤数` : '请先输入有效的每克报价和结算公斤数',
      lines: [],
    };
  }

  const deliveredCostUsd = roundNumber(lines.reduce((sum, line) => sum + line.allocatedCostUsd, 0), 2);
  const deliveredFineGold = roundNumber(lines.reduce((sum, line) => sum + line.fineGoldDelivered, 0), 2);
  const settledFineGold = roundNumber(lines.reduce((sum, line) => sum + line.settledKgCount * 1000, 0), 2);
  const grossRevenueUsdt = roundNumber(lines.reduce((sum, line) => sum + line.lineRevenueUsdt, 0), 2);
  const fineGoldAvailable = roundNumber(fineGoldBalanceBefore + deliveredFineGold, 2);
  const costAvailableUsd = roundNumber(costBalanceBeforeUsd + deliveredCostUsd, 2);
  const averageCostPerFineGramUsd =
    fineGoldAvailable !== 0 ? roundNumber(costAvailableUsd / fineGoldAvailable, 4) : Number.NaN;
  const settledCostUsd =
    Number.isFinite(averageCostPerFineGramUsd) ? roundNumber(averageCostPerFineGramUsd * settledFineGold, 2) : Number.NaN;
  const fineGoldBalanceAfter = roundNumber(fineGoldAvailable - settledFineGold, 2);
  const costBalanceAfterUsd =
    Number.isFinite(settledCostUsd) ? roundNumber(costAvailableUsd - settledCostUsd, 2) : Number.NaN;
  const rate = Number.parseFloat(usdToUsdtRate);
  const grossRevenueUsdConverted =
    Number.isFinite(rate) && rate > 0 ? roundNumber(grossRevenueUsdt / rate, 2) : Number.NaN;
  const grossProfitUsdConverted =
    Number.isFinite(grossRevenueUsdConverted) && Number.isFinite(settledCostUsd)
      ? roundNumber(grossRevenueUsdConverted - settledCostUsd, 2)
      : Number.NaN;

  return {
    lines,
    error: missingBatchLabels.length ? `还有 ${missingBatchLabels.length} 块未填完整，暂时不能保存巴西佬卖出` : '',
    grossRevenueUsdt,
    grossRevenueUsdConverted,
    inventoryCostUsd: deliveredCostUsd,
    settledCostUsd,
    grossProfitUsdConverted,
    fineGoldDelivered: deliveredFineGold,
    fineGoldSettled: settledFineGold,
    fineGoldBalanceBefore: roundNumber(fineGoldBalanceBefore, 2),
    fineGoldBalanceAfter,
    costBalanceBeforeUsd: roundNumber(costBalanceBeforeUsd, 2),
    costBalanceAfterUsd,
    averageCostPerFineGramUsd,
    costAvailableUsd,
    fineGoldAvailable,
  };
}
