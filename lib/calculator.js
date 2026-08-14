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
  next.setDate(15);
  next.setMonth(next.getMonth() + months);
  return next;
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
      chargeAmount: Number(row.chargeAmount) || null,
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
  if (!start) {
    throw new Error('The current contract start date could not be read from Titanium.');
  }

  const currentContractRows = valid.filter((row) => row.beginDateObj >= start);
  if (currentContractRows.length < 3) {
    throw new Error('At least 3 complete billing cycles under the current contract are required to create a projection.');
  }

  const futureMonths = futureProjectionMonths(contractEnd, termMonths);
  if (!futureMonths.length) {
    throw new Error('The current contract expiration date could not be read from Titanium.');
  }

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
    const month = futureMonth.getMonth();
    const candidates = monthBuckets.get(month) || [];
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
      sourceType: `average of ${fallbackRows.length} recent billing cycles`,
      days: averageDays
    };
  });

  return {
    profile,
    historyCount: valid.length,
    currentContractHistoryCount: currentContractRows.length,
    fallbackHistoryCount: fallbackRows.length,
    estimatedMonths,
    averageUsage
  };
}

function calculateMonth(usageKwh, currentRate, efl) {
  const proposedEnergyRate = Number(efl.energyRateCents) / 100;
  const baseCharge = Number(efl.baseChargeMonthly) || 0;
  const deliveryRate = (Number(efl.deliveryPerKwhCents) || 0) / 100;
  const deliveryMonthly = Number(efl.deliveryMonthly) || 0;
  const creditAmount = Number(efl.creditAmount) || 0;
  const creditThreshold = Number(efl.creditThresholdKwh) || null;
  const hasCredit = creditAmount > 0 && creditThreshold !== null;
  const creditApplied = hasCredit && usageKwh >= creditThreshold;

  const currentEnergy = usageKwh * currentRate;
  const proposedEnergy = usageKwh * proposedEnergyRate + baseCharge;
  const delivery = usageKwh * deliveryRate + deliveryMonthly;

  if (hasCredit) {
    const currentModeled = currentEnergy + delivery;
    const proposedModeled = proposedEnergy + delivery - (creditApplied ? creditAmount : 0);
    return {
      currentCost: money(currentModeled),
      proposedCost: money(proposedModeled),
      difference: money(currentModeled - proposedModeled),
      currentEnergy: money(currentEnergy),
      proposedEnergy: money(proposedEnergy),
      delivery: money(delivery),
      creditApplied,
      creditAmountApplied: creditApplied ? creditAmount : 0
    };
  }

  return {
    currentCost: money(currentEnergy),
    proposedCost: money(proposedEnergy),
    difference: money(currentEnergy - proposedEnergy),
    currentEnergy: money(currentEnergy),
    proposedEnergy: money(proposedEnergy),
    delivery: null,
    creditApplied: false,
    creditAmountApplied: 0
  };
}

function monthLabel(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' }).format(date);
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
  const hasCredit = Number(efl.creditAmount) > 0 && Number(efl.creditThresholdKwh) >= 0;

  const monthly = selected.profile.map((profileMonth) => {
    const calc = calculateMonth(profileMonth.usageKwh, currentRate, efl);
    return {
      ...profileMonth,
      month: monthLabel(profileMonth.projectionMonth),
      usageKwh: Math.round(profileMonth.usageKwh * 1000) / 1000,
      ...calc
    };
  });

  const totalCurrent = money(monthly.reduce((sum, row) => sum + row.currentCost, 0));
  const totalProposed = money(monthly.reduce((sum, row) => sum + row.proposedCost, 0));
  const totalDifference = money(totalCurrent - totalProposed);
  const averageMonthlyDifference = money(totalDifference / termMonths);
  const savings = totalDifference >= 0;

  const historyPhrase = selected.estimatedMonths > 0
    ? `based on ${selected.fallbackHistoryCount} recent billing cycles of available usage history`
    : 'based on season-matched historical usage';

  let headlineLabel;
  let headlineAmount;
  let subline;
  let script;

  if (savings) {
    headlineLabel = hasCredit ? 'Projected savings including bill credits' : 'Projected savings on energy';
    headlineAmount = totalDifference;
    subline = `$${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over ${termMonths} months`;

    if (hasCredit) {
      script = `Based on your usage, this plan is projected to save approximately $${totalDifference.toFixed(2)} over the ${termMonths}-month contract term, including the effect of the bill credits shown on the EFL. The modeled bills use the current TDU delivery charges shown on the EFL, and those utility delivery charges may change.`;
    } else {
      script = `Based on your usage, you would be projected to save approximately $${totalDifference.toFixed(2)} on the energy portion of your bill over this ${termMonths}-month contract term. Utility delivery charges are separate and may change.`;
    }
  } else {
    headlineLabel = hasCredit ? 'Projected bill increase per month' : 'Projected energy charge increase per month';
    headlineAmount = Math.abs(averageMonthlyDifference);
    subline = `$${Math.abs(totalDifference).toFixed(2)} projected increase over ${termMonths} months`;

    if (hasCredit) {
      script = `Based on your usage, this plan is projected to increase your bill by approximately $${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over the ${termMonths}-month contract term, including the effect of the bill credits shown on the EFL. The modeled bills use the current TDU delivery charges shown on the EFL, and those utility delivery charges may change.`;
    } else {
      script = `Based on your usage, your energy charge would increase by approximately $${Math.abs(averageMonthlyDifference).toFixed(2)} per month on average over the ${termMonths}-month contract term. Utility delivery charges are separate and may change.`;
    }
  }

  if (selected.estimatedMonths > 0) {
    script += ` This projection is ${historyPhrase}.`;
  }

  const formula = hasCredit
    ? 'Current modeled bill = (kWh × current energy rate) + current EFL TDU delivery charges. Proposed modeled bill = (kWh × proposed energy rate) + base charge + current EFL TDU delivery charges − bill credit when the usage threshold is met. Savings = current modeled bill − proposed modeled bill.'
    : 'Current energy charge = kWh × current Commodity Price. Proposed energy charge = (kWh × proposed EFL Energy Rate) + proposed base charge. Savings = current energy charge − proposed energy charge.';

  return {
    generatedAt: new Date().toISOString(),
    customer: {
      name: customer.customerName || 'Customer',
      serviceAddress: customer.serviceAddress || '',
      meterNumber: customer.meterNumber || '',
      commodityPrice: currentRate,
      contractStart: customer.contractStart || '',
      contractEnd: customer.contractEnd || ''
    },
    efl: {
      ...efl,
      contractTermMonths: termMonths,
      hasCredit
    },
    monthly,
    totals: {
      current: totalCurrent,
      proposed: totalProposed,
      difference: totalDifference,
      averageMonthlyDifference
    },
    projection: {
      historyCount: selected.historyCount,
      currentContractHistoryCount: selected.currentContractHistoryCount,
      fallbackHistoryCount: selected.fallbackHistoryCount,
      estimatedMonths: selected.estimatedMonths,
      methodology: selected.estimatedMonths > 0
        ? 'Season-matched usage was used where available. Missing calendar months were estimated using the average of the most recent available billing cycles.'
        : 'Each projected contract month was matched to the most recent available historical billing cycle from the same calendar month.'
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
