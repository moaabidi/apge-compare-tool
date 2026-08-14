(() => {
  if (window.__apgeCompareTitaniumLoaded) return;
  window.__apgeCompareTitaniumLoaded = true;

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const upper = (value) => clean(value).toUpperCase();

  function findExactLabelElement(label) {
    const target = upper(label);
    const nodes = document.querySelectorAll('body *');
    let best = null;
    for (const node of nodes) {
      if (node.children.length > 3) continue;
      const text = upper(node.innerText || node.textContent);
      if (text === target) {
        best = node;
        break;
      }
    }
    return best;
  }

  function blockLinesForLabel(label) {
    const element = findExactLabelElement(label);
    if (!element) return [];
    const target = upper(label);

    let current = element;
    for (let depth = 0; depth < 4 && current; depth += 1, current = current.parentElement) {
      const lines = String(current.innerText || '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      const index = lines.findIndex((line) => upper(line) === target);
      if (index >= 0 && lines.length > index + 1 && lines.length <= 8) {
        return lines.slice(index + 1);
      }
    }
    return [];
  }

  function firstFieldValue(label) {
    const lines = blockLinesForLabel(label);
    return lines[0] || '';
  }

  function serviceAddress() {
    const lines = blockLinesForLabel('SERVICE ADDRESS');
    if (!lines.length) return '';
    return lines.slice(0, 2).join(', ');
  }

  function contractDates() {
    const label = findExactLabelElement('SERVICE CONTRACT');
    if (!label) return { contractStart: '', contractEnd: '' };

    let current = label;
    for (let depth = 0; depth < 5 && current; depth += 1, current = current.parentElement) {
      const text = String(current.innerText || '');
      const dates = [...text.matchAll(/([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/g)].map((match) => match[1]);
      if (dates.length >= 2) {
        return { contractStart: dates[0], contractEnd: dates[1] };
      }
    }
    return { contractStart: '', contractEnd: '' };
  }

  function customerName() {
    for (const label of ['CUSTOMER NAME', 'CUSTOMER', 'NAME']) {
      const value = firstFieldValue(label);
      if (value && value.length < 100) return value;
    }
    return '';
  }

  function normalizedHeader(text) {
    return upper(text).replace(/[^A-Z0-9]+/g, ' ').trim();
  }

  function parseMoney(value) {
    const number = Number(String(value || '').replace(/[$,]/g, '').trim());
    return Number.isFinite(number) ? number : null;
  }

  function parseUsageTableFromRows(rowElements) {
    const rows = [...rowElements];
    if (!rows.length) return [];

    let headerIndex = -1;
    let headers = [];
    for (let i = 0; i < rows.length; i += 1) {
      const cells = [...rows[i].querySelectorAll('th, td, [role="columnheader"], [role="gridcell"], [role="cell"]')];
      const candidateHeaders = cells.map((cell) => normalizedHeader(cell.innerText || cell.textContent));
      if (candidateHeaders.includes('BEGIN DATE') && candidateHeaders.includes('END DATE') && candidateHeaders.includes('USAGE')) {
        headerIndex = i;
        headers = candidateHeaders;
        break;
      }
    }

    if (headerIndex < 0) return [];

    const indexOf = (...names) => headers.findIndex((header) => names.includes(header));
    const idx = {
      begin: indexOf('BEGIN DATE'),
      end: indexOf('END DATE'),
      usage: indexOf('USAGE'),
      units: indexOf('UNITS'),
      processed: indexOf('PROCESSED'),
      historical: indexOf('HISTORICAL'),
      canceled: indexOf('CANCELED'),
      final: indexOf('FINAL'),
      estimated: indexOf('ESTIMATED'),
      days: indexOf('DAYS'),
      charge: indexOf('CHARGE AMOUNT')
    };

    const output = [];
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = [...row.querySelectorAll('td, [role="gridcell"], [role="cell"]')];
      if (!cells.length) continue;
      const values = cells.map((cell) => clean(cell.innerText || cell.textContent));
      const get = (index) => index >= 0 ? values[index] || '' : '';
      const usage = Number(get(idx.usage).replace(/,/g, ''));
      const units = get(idx.units).toUpperCase();
      if (!Number.isFinite(usage) || (units && units !== 'KWH')) continue;

      output.push({
        beginDate: get(idx.begin),
        endDate: get(idx.end),
        usageKwh: usage,
        units: units || 'KWH',
        processed: get(idx.processed),
        historical: get(idx.historical),
        canceled: get(idx.canceled),
        final: get(idx.final),
        estimated: get(idx.estimated),
        days: Number(get(idx.days)) || null,
        chargeAmount: parseMoney(get(idx.charge))
      });
    }
    return output;
  }

  function extractUsageRows() {
    for (const table of document.querySelectorAll('table')) {
      const text = upper(table.innerText);
      if (text.includes('BEGIN DATE') && text.includes('END DATE') && text.includes('USAGE')) {
        const parsed = parseUsageTableFromRows(table.querySelectorAll('tr'));
        if (parsed.length) return parsed;
      }
    }

    const roleRows = document.querySelectorAll('[role="row"]');
    const parsedRoleRows = parseUsageTableFromRows(roleRows);
    if (parsedRoleRows.length) return parsedRoleRows;

    return [];
  }

  function findUsageControl() {
    const selectors = [
      '[aria-label="Usage"]',
      '[aria-label*="usage" i]',
      '[title="Usage"]',
      '[title*="usage" i]',
      '[data-title="Usage"]',
      'a[href*="usage" i]'
    ];
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }

    const candidates = document.querySelectorAll('button, a, [role="button"], [role="tab"]');
    for (const candidate of candidates) {
      if (upper(candidate.innerText || candidate.textContent) === 'USAGE') return candidate;
    }
    return null;
  }

  async function waitForUsageRows(timeoutMs = 7000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rows = extractUsageRows();
      if (rows.length) return rows;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return [];
  }

  async function collectTitaniumData() {
    const commodityPriceRaw = firstFieldValue('COMMODITY PRICE');
    const commodityPriceMatch = commodityPriceRaw.match(/[0-9]+(?:\.[0-9]+)?/);
    const commodityPrice = commodityPriceMatch ? Number(commodityPriceMatch[0]) : null;
    const { contractStart, contractEnd } = contractDates();

    const account = {
      customerName: customerName(),
      serviceAddress: serviceAddress(),
      meterNumber: firstFieldValue('METER NUMBER'),
      commodityPrice,
      contractStart,
      contractEnd,
      sourceUrl: location.href
    };

    let usageRows = extractUsageRows();
    if (!usageRows.length) {
      const usageControl = findUsageControl();
      if (usageControl) {
        usageControl.click();
        usageRows = await waitForUsageRows();
      }
    }

    return {
      ...account,
      usageRows,
      warnings: usageRows.length ? [] : [
        'The Usage table could not be read automatically. Open the Usage section in Titanium, wait for the rows to load, and run the comparison again.'
      ]
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'APGE_COMPARE_COLLECT_TITANIUM') return false;
    collectTitaniumData()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
