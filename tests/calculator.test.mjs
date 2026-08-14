import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateComparison } from '../lib/calculator.js';

function usage(beginDate, endDate, usageKwh, chargeAmount = null) {
  return { beginDate, endDate, usageKwh, chargeAmount, canceled: 'N', estimated: 'N', days: 30 };
}

const customer = {
  customerName: 'Test Customer',
  serviceAddress: '100 Test St, Houston TX',
  meterNumber: 'M100',
  commodityPrice: 0.10,
  contractStart: 'Jan 1, 2026',
  contractEnd: 'Jun 30, 2026',
  usageRows: [
    usage('Jan 1, 2026', 'Jan 31, 2026', 900, 90),
    usage('Feb 1, 2026', 'Feb 28, 2026', 1100, 110),
    usage('Mar 1, 2026', 'Mar 31, 2026', 1200, 120),
    usage('Apr 1, 2026', 'Apr 30, 2026', 1000, 100),
    usage('May 1, 2026', 'May 31, 2026', 1300, 130),
    usage('Jun 1, 2026', 'Jun 30, 2026', 1500, 150),
    usage('Jul 1, 2025', 'Jul 31, 2025', 1800),
    usage('Aug 1, 2025', 'Aug 31, 2025', 2000),
    usage('Sep 1, 2025', 'Sep 30, 2025', 1600),
    usage('Oct 1, 2025', 'Oct 31, 2025', 1400),
    usage('Nov 1, 2025', 'Nov 30, 2025', 1000),
    usage('Dec 1, 2025', 'Dec 31, 2025', 900)
  ]
};

test('fixed plan compares energy only across proposed contract term', () => {
  const result = calculateComparison(customer, {
    energyRateCents: 8,
    baseChargeMonthly: 0,
    deliveryPerKwhCents: 5,
    deliveryMonthly: 5,
    contractTermMonths: 6,
    creditAmount: 0,
    creditThresholdKwh: null
  });

  assert.equal(result.monthly.length, 6);
  assert.equal(result.monthly[0].month.startsWith('Jul'), true);
  assert.equal(result.monthly[0].usageKwh, 1800);
  assert.equal(result.monthly[0].currentCost, 180);
  assert.equal(result.monthly[0].proposedCost, 144);
  assert.equal(result.monthly[0].difference, 36);
  assert.equal(result.efl.hasCredit, false);
  assert.equal(result.display.savings, true);
  assert.equal(result.totals.difference, 174);
});

test('bill credit applies only in months that meet the threshold', () => {
  const result = calculateComparison(customer, {
    energyRateCents: 13,
    baseChargeMonthly: 0,
    deliveryPerKwhCents: 5,
    deliveryMonthly: 5,
    contractTermMonths: 6,
    creditAmount: 125,
    creditThresholdKwh: 1000
  });

  assert.equal(result.efl.hasCredit, true);
  assert.equal(result.monthly[0].creditApplied, true);
  assert.equal(result.monthly[4].creditApplied, true);
  assert.equal(result.monthly[5].creditApplied, false);
  assert.equal(result.monthly[5].creditAmountApplied, 0);
});

test('requires at least three complete billing cycles under current contract', () => {
  const shortCustomer = {
    ...customer,
    contractStart: 'May 1, 2026'
  };
  assert.throws(
    () => calculateComparison(shortCustomer, { energyRateCents: 8, contractTermMonths: 6 }),
    /At least 3 complete billing cycles/
  );
});

test('negative comparison leads with average monthly increase', () => {
  const result = calculateComparison(customer, {
    energyRateCents: 12,
    baseChargeMonthly: 0,
    contractTermMonths: 6,
    creditAmount: 0,
    creditThresholdKwh: null
  });
  assert.equal(result.display.savings, false);
  assert.match(result.display.headlineLabel, /increase per month/i);
  assert.equal(result.display.headlineAmount, Math.abs(result.totals.averageMonthlyDifference));
});
