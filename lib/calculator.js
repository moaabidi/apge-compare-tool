const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDate(value) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const match = String(value).match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} 12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isYes(value) {
  return /^y(?:es)?$/i.test(String(value || '').trim());
}

function normalizeUsageRows(rows) {
  return (rows || [])
    .map((row) => ({
      ...row,
      beginDateObj: parseDate(row.beginDate),
      endDateObj: parseDate(row.endDate),
      usageKwh: Number(row.usageKwh),
      days: Number(row.days) || null,
      chargeAmount: Number.isFinite(Number(row.chargeAmount)) ? Number(row.chargeAmount) : null,
      estimatedFlag: isYes(row.estimated),
      canceledFlag: isYes(row.canceled)
    }))
    .filter((row) =>
      row.beginDateObj &&
      row.endDateObj &&
      Number.isFinite(row.usageKwh) &&
      row.usageKwh >= 0 &&
      !row.canceledFlag
    )
    .sort((a, b) => b.endDateObj - a.endDateObj);
}

function futureProjectionMonths(contractEnd, termMonths) {
  const end = parseDate(contractEnd);
  if (!end) return [];
  const start = new Date(end.getTime() + DAY_MS);
  return Array.from({ length: termMonths }, (_, index) => addMonths(start, index));
}

function selectUsageProfile(rows, contractStart, contractEnd, termMonths) {
  const valid = normalizeUsageRows(rows);
  const start = parseDate(contractStart);
  if (!start) throw new Error('The current contract start date could not be read from Titanium.');

  const currentContractRows = valid.filter((row) => row.beginDateObj >= start);
  if (currentContractRows.length < 3) {
    throw new Error('At least 3 complete billing cycles under the current contract are required to create a projection.');
  }

  const futureMonths = futureProjectionMonths(contractEnd, termMonths);
  if (!futureMonths.length) throw new Error('The current contract expiration date could not be read from Titanium.');

  const fallbackRows = currentContractRows.slice(0, Math.min(12, currentContractRows.length));
  const averageUsage = fallbackRows.reduce((sum, row) => sum + row.usageKwh, 0) / fallbackRows.length;
  const averageDays = fallbackRows.reduce((sum, row) => sum + (row.days || 30), 0) / fallbackRows.length;

  const monthBuckets = new Map();
  for (const row of valid) {
    const month = row.endDateObj.getMonth();
    if (!monthBuckets.has(month)) monthBuckets.set(month, []);
    monthBuckets.get(month).push(row);
  }

  let estimatedMonths = 0;
  const profile = futureMonths.map((futureMonth, index) => {
    const candidates = monthBuckets.get(futureMonth.getMonth()) || [];
    const matched = candidates[0];

    if (matched) {
      return {
        index,
        projectionMonth: futureMonth,
        usageKwh: matched.usageKwh,
        sourceBeginDate: matched.beginDate,
        sourceEndDate: matched.endDate,
        sourceEstimated: matched.estimatedFlag,
        sourceType: 'season-matched historical usage',
        days: matched.days || 30
      };
    }

    estimatedMonths += 1;
    return {
      index,
      projectionMonth: futureMonth,
      usageKwh: averageUsage,
      sourceBeginDate: null,
      sourceEndDate: null,
      sourceEstimated: true,
      sourceType: `average of ${fallbackRows.length} recent complete current-contract billing cycles`,
      days: averageDays
    };
  });

  return {
    profile,
    historyCount: valid.length,
    currentContractHistoryCount: currentContractRows.length,
    fallbackHistoryCount: fallbackRows.length,
    estimatedMonths,
    averageUsage,
    currentContractRows
  };
}

function hasBillCredit(efl) {
  const amount = Number(efl.creditAmount);
  const threshold = Number(efl.creditThresholdKwh);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(threshold) && threshold >= 0;
}

export function parseCurrentBillCreditPlan(pricingPlan) {
  const original = String(pricingPlan || '').trim();
  if (!original) {
    return {
      pricingPlan: '',
      hasCredit: false,
      creditAmount: 0,
      creditThresholdKwh: null
    };
  }

  const compact = original.replace(/\s+/g, '');
  const match = compact.match(/(\d[\d,]*)_?kwh_?Usage_?Credit_?Plan_?\$([0-9]+(?:\.[0-9]+)?)/i);

  if (!match) {
    return {
      pricingPlan: original,
      hasCredit: false,
      creditAmount: 0,
      creditThresholdKwh: null
    };
  }

  const creditThresholdKwh = Number(match[1].replace(/,/g, ''));
  const creditAmount = Number(match[2]);
  const valid = Number.isFinite(creditThresholdKwh) &&
    creditThresholdKwh >= 0 &&
    Number.isFinite(creditAmount) &&
    creditAmount > 0;

  return {
    pricingPlan: original,
    hasCredit: valid,
    creditAmount: valid ? creditAmount : 0,
    creditThresholdKwh: valid ? creditThresholdKwh : null
  };
}

function calculateMonth(usageKwh, currentRate, currentPlan, efl) {
  const proposedEnergyRate = Number(efl.energyRateCents) / 100;
  const baseCharge = Number(efl.baseChargeMonthly) || 0;
  const deliveryRate = (Number(efl.deliveryPerKwhCents) || 0) / 100;
  const deliveryMonthly = Number(efl.deliveryMonthly) || 0;

  const proposedHasCredit = hasBillCredit(efl);
  const proposedCreditAmount = Number(efl.creditAmount) || 0;
  const proposedCreditThreshold = Number(efl.creditThresholdKwh);
  const proposedCreditApplied = proposedHasCredit && usageKwh >= proposedCreditThreshold;

  const currentCreditApplied = currentPlan.hasCredit && usageKwh >= currentPlan.creditThresholdKwh;
  const usesDeliveryModel = currentPlan.hasCredit || proposedHasCredit;

  const currentEnergy = usageKwh * currentRate;
  const proposedEnergyOnly = usageKwh * proposedEnergyRate;
  const proposedEnergy = proposedEnergyOnly + baseCharge;
  const deliveryUsage = usageKwh * deliveryRate;
  const delivery = deliveryUsage + deliveryMonthly;

  const commonComponents = {
    currentEnergy: roundMoney(currentEnergy),
    proposedEnergyOnly: roundMoney(proposedEnergyOnly),
    proposedBaseCharge: roundMoney(baseCharge),
    proposedEnergy: roundMoney(proposedEnergy),
    deliveryUsage: roundMoney(deliveryUsage),
    deliveryMonthly: roundMoney(deliveryMonthly),
    currentCreditApplied,
    currentCreditAmountApplied: currentCreditApplied ? currentPlan.creditAmount : 0,
    proposedCreditApplied,
    proposedCreditAmountApplied: proposedCreditApplied ? proposedCreditAmount : 0,
    creditApplied: proposedCreditApplied,
    creditAmountApplied: proposedCreditApplied ? proposedCreditAmount : 0
  };

  if (usesDeliveryModel) {
    const currentModeled = currentEnergy +
      delivery -
      (currentCreditApplied ? currentPlan.creditAmount : 0);
    const proposedModeled = proposedEnergy +
      delivery -
      (proposedCreditApplied ? proposedCreditAmount : 0);

    return {
      currentCost: roundMoney(currentModeled),
      proposedCost: roundMoney(proposedModeled),
      difference: roundMoney(currentModeled - proposedModeled),
      delivery: roundMoney(delivery),
      ...commonComponents
    };
  }

  return {
    currentCost: roundMoney(currentEnergy),
    proposedCost: roundMoney(proposedEnergy),
    difference: roundMoney(currentEnergy - proposedEnergy),
    delivery: null,
    deliveryUsage: 0,
    deliveryMonthly: 0,
    ...commonComponents
  };
}

function monthLabel(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' }).format(date);
}

function validationWarnings(currentContractRows, currentRate, currentPlan) {
  if (currentPlan.hasCredit) return [];

  const warnings = [];
  for (const row of currentContractRows) {
    if (!Number.isFinite(row.chargeAmount)) continue;
    const expected = row.usageKwh * currentRate;
    const difference = Math.abs(expected - row.chargeAmount);
    const tolerance = Math.max(1, Math.abs(row.chargeAmount) * 0.02);
    if (difference > tolerance) {
      warnings.push(
        `${row.beginDate}–${row.endDate}: Titanium Charge Amount differs from kWh × current Commodity Price by $${difference.toFixed(2)}.`
      );
    }
  }
  return warnings;
}

function creditContextPhrase(currentPlan, proposedHasCredit) {
  if (currentPlan.hasCredit && proposedHasCredit) return 'bill credits on both the current and proposed plans';
  if (currentPlan.hasCredit) return 'the bill credit on your current plan';
  if (proposedHasCredit) return 'the bill credit on the proposed plan';
  return '';
}

export function calculateComparison(customer, efl) {
  const currentRate = Number(customer.commodityPrice);
  if (!Number.isFinite(currentRate) || currentRate <= 0) {
    throw new Error('The current Commodity Price could not be read from Titanium.');
  }

  const proposedRate = Number(efl.energyRateCents);
  if (!Number.isFinite(proposedRate) || proposedRate <= 0) {
    throw new Error('The proposed EFL energy rate is missing or invalid.');
  }

  const termMonths = Math.max(1, Math.round(Number(efl.contractTermMonths) || 12));
  const selected = selectUsageProfile(customer.usageRows, customer.contractStart, customer.contractEnd, termMonths);
  const currentPlan = parseCurrentBillCreditPlan(customer.pricingPlan);
  const proposedHasCredit = hasBillCredit(efl);
  const usesDeliveryModel = currentPlan.hasCredit || proposedHasCredit;

  if (usesDeliveryModel) {
    const deliveryRate = Number(efl.deliveryPerKwhCents);
    const deliveryMonthly = Number(efl.deliveryMonthly);
    const hasDeliveryCharge = (Number.isFinite(deliveryRate) && deliveryRate > 0) ||
      (Number.isFinite(deliveryMonthly) && deliveryMonthly > 0);
    if (!hasDeliveryCharge) {
      throw new Error('TDU delivery charges are required from the proposed EFL for a bill-credit comparison.');
    }
  }

  const monthly = selected.profile.map((profileMonth) => ({
    ...profileMonth,
    month: monthLabel(profileMonth.projectionMonth),
    usageKwh: Math.round(profileMonth.usageKwh * 1000) / 1000,
    ...calculateMonth(profileMonth.usageKwh, currentRate, currentPlan, efl)
  }));

  const totalCurrent = roundMoney(monthly.reduce((sum, row) => sum + row.currentCost, 0));
  const totalProposed = roundMoney(monthly.reduce((sum, row) => sum + row.proposedCost, 0));
  const totalDifference = roundMoney(totalCurrent - totalProposed);
  const averageMonthlyDifference = roundMoney(totalDifference / termMonths);
  const savings = totalDifference >= 0;

  let headlineLabel;
  let headlineAmount;
  let subline;
  let script;

  if (savings) {
    headlineLabel = usesDeliveryModel ? 'Projected savings including bill credits' : 'Projected savings on energy';
    headlineAmount = totalDifference;
    subline = `$${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over ${termMonths} months`;

    if (usesDeliveryModel) {
      script = `Based on your usage, this plan is projected to save approximately $${totalDifference.toFixed(2)} over the ${termMonths}-month contract term after accounting for ${creditContextPhrase(currentPlan, proposedHasCredit)} at the modeled usage levels. For an apples-to-apples estimate, both plans use the current TDU delivery charges shown on the proposed EFL. Those utility delivery charges may change.`;
    } else {
      script = `Based on your usage, you would be projected to save approximately $${totalDifference.toFixed(2)} on the energy portion of your bill over this ${termMonths}-month contract term. TDU delivery charges are set by your utility, are separate from this energy-only comparison, and may change.`;
    }
  } else {
    headlineLabel = usesDeliveryModel ? 'Projected bill increase per month' : 'Projected energy charge increase per month';
    headlineAmount = Math.abs(averageMonthlyDifference);
    subline = `$${Math.abs(totalDifference).toFixed(2)} projected increase over ${termMonths} months`;

    if (usesDeliveryModel) {
      script = `Based on your usage, this plan is projected to increase your bill by approximately $${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over the ${termMonths}-month contract term after accounting for ${creditContextPhrase(currentPlan, proposedHasCredit)} at the modeled usage levels. For an apples-to-apples estimate, both plans use the current TDU delivery charges shown on the proposed EFL. Those utility delivery charges may change.`;
    } else {
      script = `Based on your usage, your energy charge would increase by approximately $${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over the ${termMonths}-month contract term. TDU delivery charges are set by your utility, are separate from this energy-only comparison, and may change.`;
    }
  }

  if (selected.estimatedMonths > 0) {
    script += ` ${selected.estimatedMonths} month${selected.estimatedMonths === 1 ? '' : 's'} of the projection use${selected.estimatedMonths === 1 ? 's' : ''} estimated usage because matching seasonal history was not available.`;
  }

  const currentCreditFormula = currentPlan.hasCredit
    ? ` Current-plan credit = $${currentPlan.creditAmount.toFixed(2)} when usage is at least ${currentPlan.creditThresholdKwh.toLocaleString()} kWh.`
    : '';
  const proposedCreditFormula = proposedHasCredit
    ? ` Proposed-plan credit = $${Number(efl.creditAmount).toFixed(2)} when usage is at least ${Number(efl.creditThresholdKwh).toLocaleString()} kWh.`
    : '';

  const formula = usesDeliveryModel
    ? `Current modeled bill = (kWh × current Commodity Price) + proposed EFL TDU delivery charges − applicable current bill credit. Proposed modeled bill = (kWh × proposed EFL Energy Rate) + proposed base charge + proposed EFL TDU delivery charges − applicable proposed bill credit. Savings = current modeled bill − proposed modeled bill.${currentCreditFormula}${proposedCreditFormula}`
    : 'Current energy charge = kWh × current Commodity Price. Proposed energy charge = (kWh × proposed EFL Energy Rate) + proposed base charge. Savings = current energy charge − proposed energy charge.';

  const { rawText: _rawText, ...storedEfl } = efl;

  return {
    generatedAt: new Date().toISOString(),
    customer: {
      name: customer.customerName || 'Customer',
      serviceAddress: customer.serviceAddress || '',
      meterNumber: customer.meterNumber || '',
      commodityPrice: currentRate,
      pricingPlan: customer.pricingPlan || '',
      contractStart: customer.contractStart || '',
      contractEnd: customer.contractEnd || ''
    },
    currentPlan,
    comparison: {
      usesDeliveryModel
    },
    efl: {
      ...storedEfl,
      contractTermMonths: termMonths,
      hasCredit: proposedHasCredit
    },
    monthly,
    totals: {
      current: totalCurrent,
      proposed: totalProposed,
      difference: totalDifference,
      averageMonthlyDifference
    },
    validationWarnings: validationWarnings(selected.currentContractRows, currentRate, currentPlan),
    projection: {
      historyCount: selected.historyCount,
      currentContractHistoryCount: selected.currentContractHistoryCount,
      fallbackHistoryCount: selected.fallbackHistoryCount,
      estimatedMonths: selected.estimatedMonths,
      methodology: selected.estimatedMonths > 0
        ? 'The proposed contract begins after the current contract expires. Equivalent calendar-month usage was used where available. Missing seasonal months were estimated from the average of the most recent complete billing cycles under the current contract. Billing cycles that began before the current contract start were excluded from the current-contract minimum.'
        : 'The proposed contract begins after the current contract expires. Each projected month was matched to the most recent available historical billing cycle from the same calendar month. Billing cycles that began before the current contract start were excluded from the current-contract minimum.'
    },
    display: {
      savings,
      headlineLabel,
      headlineAmount,
      subline,
      script,
      formula
    }
  };
}
