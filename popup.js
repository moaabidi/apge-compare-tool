import { calculateComparison } from './lib/calculator.js';
import { parseEflPdf } from './lib/pdf-parser.js';

const $ = (id) => document.getElementById(id);
const state = {
  customer: null,
  eflUrl: '',
  partialEfl: null,
  result: null
};

const TITANIUM_HOST = 'affordable-ep.esgglobal.net';
const EFL_HOST = 'artemis-api.apge.com';

function setStatus(message, type = 'info') {
  const element = $('status');
  if (!message) {
    element.hidden = true;
    element.textContent = '';
    element.className = 'status';
    return;
  }
  element.hidden = false;
  element.textContent = message;
  element.className = `status${type === 'error' ? ' error' : ''}`;
}

function isTitaniumTab(tab) {
  try {
    const url = new URL(tab.url || '');
    return url.hostname === TITANIUM_HOST && url.pathname.includes('/enterpriseportal/');
  } catch {
    return false;
  }
}

function isAccountDetailTab(tab) {
  try {
    const url = new URL(tab.url || '');
    return url.hostname === TITANIUM_HOST && /\/sets\/[^/]+\/accounts\/[^/?#]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isEflTab(tab) {
  try {
    const url = new URL(tab.url || '');
    return url.hostname === EFL_HOST && url.pathname.startsWith('/api/v1/document');
  } catch {
    return false;
  }
}

function mostRecent(tabs) {
  return [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function findSourceTabs() {
  const tabs = await chrome.tabs.query({});
  const activeTabs = tabs.filter((tab) => tab.active);
  const activeTitanium = activeTabs.find(isTitaniumTab);
  const titanium = activeTitanium || mostRecent(tabs.filter(isTitaniumTab));
  const efl = mostRecent(tabs.filter(isEflTab));

  if (!titanium) throw new Error('No ESG Titanium tab was found. Open the customer page and try again.');
  if (!efl) throw new Error('No APG&E EFL tab was found. Open the proposed EFL and try again.');
  return { titanium, efl };
}

async function sendTitaniumMessage(tabId, type) {
  return chrome.tabs.sendMessage(tabId, { type });
}

async function messageWithInjection(tabId, type) {
  try {
    return await sendTitaniumMessage(tabId, type);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/titanium.js'] });
    return sendTitaniumMessage(tabId, type);
  }
}

async function collectSummaryFields(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const upper = (value) => clean(value).toUpperCase();
      const datePattern = /([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/g;

      function findExactLabel(label) {
        const target = upper(label);
        for (const node of document.querySelectorAll('body *')) {
          if (node.children.length > 3) continue;
          if (upper(node.innerText || node.textContent) === target) return node;
        }
        return null;
      }

      function linesAfterLabel(label, maxLines = 4) {
        const element = findExactLabel(label);
        if (!element) return [];
        const target = upper(label);
        let current = element;

        for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
          const lines = String(current.innerText || '')
            .split(/\r?\n/)
            .map(clean)
            .filter(Boolean);
          const index = lines.findIndex((line) => upper(line) === target);
          if (index >= 0 && lines.length > index + 1) {
            return lines.slice(index + 1, index + 1 + maxLines);
          }
        }
        return [];
      }

      function firstField(label) {
        return linesAfterLabel(label, 1)[0] || '';
      }

      function serviceAddress() {
        const lines = linesAfterLabel('SERVICE ADDRESS', 2);
        return lines.join(', ');
      }

      function contractDates() {
        const label = findExactLabel('SERVICE CONTRACT');
        if (!label) return { contractStart: '', contractEnd: '' };

        let current = label;
        for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
          const text = String(current.innerText || '');
          const marker = text.toUpperCase().indexOf('SERVICE CONTRACT');
          if (marker < 0) continue;
          const nearby = text.slice(marker, marker + 350);
          const dates = [...nearby.matchAll(datePattern)].map((match) => clean(match[1]));
          if (dates.length >= 2) {
            return { contractStart: dates[0], contractEnd: dates[1] };
          }
        }
        return { contractStart: '', contractEnd: '' };
      }

      const commodityRaw = firstField('COMMODITY PRICE');
      const commodityMatch = commodityRaw.match(/[0-9]+(?:\.[0-9]+)?/);
      const { contractStart, contractEnd } = contractDates();
      const bodyText = String(document.body.innerText || '');
      const breadcrumb = bodyText.match(/Customers Search\s*>\s*([^>\r\n]+)/i);

      return {
        customerName: breadcrumb ? clean(breadcrumb[1]) : '',
        serviceAddress: serviceAddress(),
        meterNumber: firstField('METER NUMBER'),
        commodityPrice: commodityMatch ? Number(commodityMatch[0]) : null,
        contractStart,
        contractEnd,
        sourceUrl: location.href
      };
    }
  });

  return result || {};
}

async function waitForAccountDetail(tabId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (isAccountDetailTab(tab)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return chrome.tabs.get(tabId);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Titanium did not finish opening the Account page before the timeout.');
}

async function ensureAccountDetail(tab) {
  if (isAccountDetailTab(tab)) return tab;

  setStatus('Opening the customer Account page in Titanium…');
  const response = await messageWithInjection(tab.id, 'APGE_COMPARE_OPEN_ACCOUNT');
  if (!response?.ok) {
    throw new Error(response?.error || 'The Account page could not be opened in Titanium.');
  }
  if (response.alreadyOpen) return chrome.tabs.get(tab.id);
  return waitForAccountDetail(tab.id);
}

function preferSummary(summary, detail, key) {
  const value = summary?.[key];
  if (value !== undefined && value !== null && value !== '') return value;
  return detail?.[key];
}

async function collectTitanium(tab) {
  setStatus('Reading the customer summary in Titanium…');
  const summary = await collectSummaryFields(tab.id);

  const accountTab = await ensureAccountDetail(tab);
  setStatus('Opening Usage and reading billing history in Titanium…');

  const response = await messageWithInjection(accountTab.id, 'APGE_COMPARE_COLLECT_TITANIUM');
  if (!response?.ok) throw new Error(response?.error || 'Titanium data could not be read.');
  const detail = response.data || {};

  const customer = {
    ...detail,
    customerName: preferSummary(summary, detail, 'customerName'),
    serviceAddress: preferSummary(summary, detail, 'serviceAddress'),
    meterNumber: preferSummary(summary, detail, 'meterNumber'),
    commodityPrice: preferSummary(summary, detail, 'commodityPrice'),
    contractStart: preferSummary(summary, detail, 'contractStart'),
    contractEnd: preferSummary(summary, detail, 'contractEnd')
  };

  if (!Number.isFinite(Number(customer.commodityPrice))) {
    throw new Error('Commodity Price could not be read from the Titanium customer summary or account page.');
  }
  if (!customer.contractEnd) {
    throw new Error('The Service Contract date range could not be read from the Titanium customer summary.');
  }
  if (!Array.isArray(customer.usageRows) || customer.usageRows.length < 3) {
    const warning = customer.warnings?.[0] || 'At least 3 usage rows are required.';
    throw new Error(warning);
  }

  return customer;
}

async function fetchAndParseEfl(tab) {
  const response = await fetch(tab.url, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error(`EFL request failed with HTTP ${response.status}.`);
  const buffer = await response.arrayBuffer();
  return parseEflPdf(buffer, tab.url);
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatRateDollarAsCents(value) {
  return `${(Number(value || 0) * 100).toFixed(3)}¢/kWh`;
}

function formatRateCents(value) {
  return `${Number(value || 0).toFixed(3)}¢/kWh`;
}

function renderGraph(monthly) {
  const root = $('graph');
  if (!monthly?.length) {
    root.textContent = 'No monthly data available.';
    return;
  }

  const width = 470;
  const height = 180;
  const pad = { left: 42, right: 12, top: 24, bottom: 28 };
  const values = monthly.flatMap((row) => [row.currentCost, row.proposedCost]);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(0, ...values);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (monthly.length === 1 ? plotWidth / 2 : index * plotWidth / (monthly.length - 1));
  const y = (value) => pad.top + (maxValue - value) * plotHeight / (maxValue - minValue || 1);

  const points = (key) => monthly.map((row, index) => `${x(index)},${y(row[key])}`).join(' ');
  const gridValues = [0, .25, .5, .75, 1].map((ratio) => minValue + (maxValue - minValue) * ratio);

  const grid = gridValues.map((value) => {
    const yy = y(value);
    return `<line class="grid" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}"></line><text x="4" y="${yy + 3}">$${Math.round(value)}</text>`;
  }).join('');

  const labels = monthly.map((row, index) => {
    if (monthly.length > 12 && index % 2 === 1) return '';
    return `<text x="${x(index)}" y="${height - 8}" text-anchor="middle">${row.month.replace(' ', '’')}</text>`;
  }).join('');

  const currentDots = monthly.map((row, index) => `<circle class="dot-current" cx="${x(index)}" cy="${y(row.currentCost)}" r="2.7"><title>${row.month}: current ${formatMoney(row.currentCost)}</title></circle>`).join('');
  const proposedDots = monthly.map((row, index) => `<circle class="dot-proposed" cx="${x(index)}" cy="${y(row.proposedCost)}" r="2.7"><title>${row.month}: proposed ${formatMoney(row.proposedCost)}</title></circle>`).join('');

  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Current versus proposed monthly cost">
      ${grid}
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
      <polyline class="current-line" points="${points('currentCost')}"></polyline>
      <polyline class="proposed-line" points="${points('proposedCost')}"></polyline>
      ${currentDots}${proposedDots}${labels}
      <circle class="dot-current" cx="${pad.left}" cy="10" r="3"></circle><text class="legend" x="${pad.left + 8}" y="13">Current</text>
      <circle class="dot-proposed" cx="${pad.left + 75}" cy="10" r="3"></circle><text class="legend" x="${pad.left + 83}" y="13">Proposed</text>
    </svg>`;
}

function addInput(label, value) {
  const wrapper = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  wrapper.append(dt, dd);
  $('inputs').appendChild(wrapper);
}

function renderResult(result) {
  state.result = result;
  $('emptyState').hidden = true;
  $('manualEfl').hidden = true;
  $('result').hidden = false;

  $('customerName').textContent = result.customer.name || 'Customer';
  const context = [result.customer.serviceAddress, result.customer.meterNumber ? `Meter ${result.customer.meterNumber}` : ''].filter(Boolean).join(' • ');
  $('customerContext').textContent = context;
  $('headlineLabel').textContent = result.display.headlineLabel;
  $('headlineAmount').textContent = formatMoney(result.display.headlineAmount);
  $('subline').textContent = result.display.subline;
  $('salesScript').textContent = result.display.script;
  $('methodBadge').textContent = result.projection.estimatedMonths > 0 ? 'Partly estimated' : 'Season matched';
  $('methodology').textContent = result.projection.methodology;
  $('formula').textContent = result.display.formula;

  $('creditHeader').hidden = !result.efl.hasCredit;
  $('monthlyRows').innerHTML = '';
  for (const row of result.monthly) {
    const tr = document.createElement('tr');
    if (row.sourceType !== 'season-matched historical usage' || row.sourceEstimated) tr.classList.add('estimated-row');
    const differenceClass = row.difference >= 0 ? 'positive' : 'negative';
    const differenceText = row.difference >= 0 ? `Save ${formatMoney(row.difference)}` : `+${formatMoney(Math.abs(row.difference))}`;
    const credit = result.efl.hasCredit ? (row.creditApplied ? `-${formatMoney(row.creditAmountApplied)}` : 'No') : '';
    tr.innerHTML = `
      <td title="${row.sourceType}">${row.month}</td>
      <td>${Math.round(row.usageKwh).toLocaleString()}</td>
      <td>${formatMoney(row.currentCost)}</td>
      <td>${formatMoney(row.proposedCost)}</td>
      <td class="${differenceClass}">${differenceText}</td>
      ${result.efl.hasCredit ? `<td>${credit}</td>` : ''}
    `;
    $('monthlyRows').appendChild(tr);
  }

  $('inputs').innerHTML = '';
  addInput('Current Commodity Price', formatRateDollarAsCents(result.customer.commodityPrice));
  addInput('Proposed Energy Rate', formatRateCents(result.efl.energyRateCents));
  addInput('Current Contract', `${result.customer.contractStart || 'Unknown'} to ${result.customer.contractEnd || 'Unknown'}`);
  addInput('Proposed Term', `${result.efl.contractTermMonths} months`);
  addInput('Usage History Found', `${result.projection.historyCount} billing cycles`);
  addInput('Current-Contract Cycles', `${result.projection.currentContractHistoryCount} complete cycles`);
  addInput('Projection', result.projection.estimatedMonths ? `${result.projection.estimatedMonths} month(s) estimated` : 'All months season matched');
  if (result.efl.hasCredit) {
    addInput('Bill Credit', `${formatMoney(result.efl.creditAmount)} at ≥ ${Number(result.efl.creditThresholdKwh).toLocaleString()} kWh`);
    addInput('Current TDU Used', `${formatRateCents(result.efl.deliveryPerKwhCents)} + ${formatMoney(result.efl.deliveryMonthly)}/month`);
  }

  renderGraph(result.monthly);
}

function prefillManual(partial = {}) {
  $('manualEnergyRate').value = Number.isFinite(partial.energyRateCents) ? partial.energyRateCents : '';
  $('manualTerm').value = Number.isFinite(partial.contractTermMonths) ? partial.contractTermMonths : '';
  $('manualBase').value = Number.isFinite(partial.baseChargeMonthly) ? partial.baseChargeMonthly : 0;
  $('manualDeliveryRate').value = Number.isFinite(partial.deliveryPerKwhCents) ? partial.deliveryPerKwhCents : 0;
  $('manualDeliveryMonthly').value = Number.isFinite(partial.deliveryMonthly) ? partial.deliveryMonthly : 0;
  $('manualCredit').value = Number.isFinite(partial.creditAmount) ? partial.creditAmount : 0;
  $('manualThreshold').value = Number.isFinite(partial.creditThresholdKwh) ? partial.creditThresholdKwh : '';
}

function showManualEfl(error) {
  $('result').hidden = true;
  $('emptyState').hidden = true;
  $('manualEfl').hidden = false;
  $('manualReason').textContent = `The extension is having trouble looking through the EFL. Please manually enter the plan data here. ${error?.message || ''}`;
  prefillManual(error?.partial || state.partialEfl || {});
}

async function saveResult(result) {
  await chrome.storage.local.set({ lastComparison: result });
}

async function runComparison() {
  setStatus('Finding Titanium and the most recently active EFL…');
  $('runButton').disabled = true;
  $('manualEfl').hidden = true;

  try {
    const { titanium, efl } = await findSourceTabs();
    state.eflUrl = efl.url;
    state.customer = await collectTitanium(titanium);

    setStatus('Reading the proposed EFL…');
    let parsedEfl;
    try {
      parsedEfl = await fetchAndParseEfl(efl);
    } catch (error) {
      state.partialEfl = error?.partial || null;
      setStatus('Titanium data loaded. The EFL needs manual input.', 'error');
      showManualEfl(error);
      return;
    }

    const result = calculateComparison(state.customer, parsedEfl);
    await saveResult(result);
    renderResult(result);
    setStatus('Comparison updated.');
    setTimeout(() => setStatus(''), 1800);
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  } finally {
    $('runButton').disabled = false;
  }
}

async function calculateManual() {
  if (!state.customer) {
    setStatus('Run Comparison first so the Titanium account can be read.', 'error');
    return;
  }

  const efl = {
    energyRateCents: Number($('manualEnergyRate').value),
    contractTermMonths: Number($('manualTerm').value),
    baseChargeMonthly: Number($('manualBase').value) || 0,
    deliveryPerKwhCents: Number($('manualDeliveryRate').value) || 0,
    deliveryMonthly: Number($('manualDeliveryMonthly').value) || 0,
    creditAmount: Number($('manualCredit').value) || 0,
    creditThresholdKwh: $('manualThreshold').value === '' ? null : Number($('manualThreshold').value),
    sourceUrl: state.eflUrl,
    rawText: 'Manual EFL entry'
  };

  try {
    const result = calculateComparison(state.customer, efl);
    await saveResult(result);
    renderResult(result);
    setStatus('Comparison calculated from manually entered EFL data.');
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  }
}

$('runButton').addEventListener('click', runComparison);
$('manualCalculate').addEventListener('click', calculateManual);
$('detailsButton').addEventListener('click', () => {
  const open = $('details').hidden;
  $('details').hidden = !open;
  $('detailsButton').textContent = open ? 'Hide details' : 'See details';
  $('detailsButton').setAttribute('aria-expanded', String(open));
});

(async () => {
  const { lastComparison } = await chrome.storage.local.get('lastComparison');
  if (lastComparison) renderResult(lastComparison);
})();
