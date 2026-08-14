(() => {
  if (window.__apgeCompareTitaniumLoaded) return;
  window.__apgeCompareTitaniumLoaded = true;

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const upper = (value) => clean(value).toUpperCase();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isVisible(node) {
    if (!node || !(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isClickable(node) {
    if (!node || !(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    const role = upper(node.getAttribute('role'));
    return tag === 'a' ||
      tag === 'button' ||
      role === 'BUTTON' ||
      role === 'LINK' ||
      role === 'TAB' ||
      node.hasAttribute('onclick') ||
      node.hasAttribute('tabindex') ||
      node.hasAttribute('aria-haspopup');
  }

  function clickableAncestor(node, maxDepth = 6) {
    let current = node;
    for (let depth = 0; depth < maxDepth && current; depth += 1, current = current.parentElement) {
      if (isVisible(current) && isClickable(current)) return current;
    }
    return null;
  }

  function clickElement(node) {
    if (!node) return false;
    const target = clickableAncestor(node) || node;
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  function findExactLabelElement(label, { visibleOnly = false } = {}) {
    const target = upper(label);
    const nodes = document.querySelectorAll('body *');
    for (const node of nodes) {
      if (node.children.length > 3) continue;
      if (visibleOnly && !isVisible(node)) continue;
      if (upper(node.innerText || node.textContent) === target) return node;
    }
    return null;
  }

  function findClickableExactText(text, { visibleOnly = true, allowRaw = false } = {}) {
    const target = upper(text);
    const direct = document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [tabindex], [aria-haspopup]');
    for (const node of direct) {
      if (visibleOnly && !isVisible(node)) continue;
      if (upper(node.innerText || node.textContent) === target) return node;
    }

    const exact = findExactLabelElement(text, { visibleOnly });
    if (!exact) return null;
    const interactive = clickableAncestor(exact);
    if (interactive) return interactive;
    return allowRaw && (!visibleOnly || isVisible(exact)) ? exact : null;
  }

  async function waitFor(fn, timeoutMs = 8000, intervalMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = fn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function isAccountDetailPage() {
    return /\/sets\/[^/]+\/accounts\/[^/?#]+/i.test(location.pathname);
  }

  function findAccountLink() {
    const direct = findClickableExactText('Account', { allowRaw: true });
    if (direct) return direct;

    const label = findExactLabelElement('Account', { visibleOnly: true });
    if (!label) return null;
    let current = label;
    for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
      const clickable = current.querySelector?.('a, button, [role="link"], [role="button"], [tabindex]');
      if (clickable && isVisible(clickable)) return clickable;
    }
    return label;
  }

  function openAccountDetail() {
    if (isAccountDetailPage()) return { ok: true, alreadyOpen: true, url: location.href };
    const accountLink = findAccountLink();
    if (!accountLink) {
      return {
        ok: false,
        error: 'The Account link could not be found on the Titanium customer page. Make sure the customer account card is visible.'
      };
    }

    setTimeout(() => clickElement(accountLink), 75);
    return { ok: true, navigating: true, url: location.href };
  }

  function blockLinesForLabel(label) {
    const element = findExactLabelElement(label);
    if (!element) return [];
    const target = upper(label);

    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1, current = current.parentElement) {
      const lines = String(current.innerText || '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean);
      const index = lines.findIndex((line) => upper(line) === target);
      if (index >= 0 && lines.length > index + 1 && lines.length <= 10) {
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
    for (let depth = 0; depth < 6 && current; depth += 1, current = current.parentElement) {
      const text = String(current.innerText || '');
      const dates = [...text.matchAll(/([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/g)].map((match) => match[1]);
      if (dates.length >= 2) return { contractStart: dates[0], contractEnd: dates[1] };
    }
    return { contractStart: '', contractEnd: '' };
  }

  function customerName() {
    for (const label of ['CUSTOMER NAME', 'CUSTOMER', 'NAME']) {
      const value = firstFieldValue(label);
      if (value && value !== '—' && value.length < 100) return value;
    }

    const breadcrumb = clean(document.body.innerText).match(/Customers Search\s*>\s*([^>]+?)(?:\s*>|$)/i);
    return breadcrumb ? clean(breadcrumb[1]) : '';
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

    const parsedRoleRows = parseUsageTableFromRows(document.querySelectorAll('[role="row"]'));
    if (parsedRoleRows.length) return parsedRoleRows;
    return [];
  }

  function findTabStripReference() {
    return findClickableExactText('Details', { allowRaw: true }) ||
      findClickableExactText('Service Contracts', { allowRaw: true }) ||
      findClickableExactText('Transaction', { allowRaw: true });
  }

  function uniqueElements(elements) {
    return [...new Set(elements.filter(Boolean))];
  }

  function findOverflowCandidates() {
    const reference = findTabStripReference();
    const referenceRect = reference?.getBoundingClientRect();
    const edit = findClickableExactText('Edit', { allowRaw: true });
    const editRect = edit?.getBoundingClientRect();
    const candidates = [];

    // Titanium renders the screenshot-confirmed ellipsis as plain text in some
    // builds, not as a semantic button. Search every visible element for it and
    // click its interactive ancestor (or the raw element so delegated handlers fire).
    for (const node of document.querySelectorAll('body *')) {
      if (!isVisible(node) || node.children.length > 2) continue;
      const text = clean(node.innerText || node.textContent);
      const aria = clean(node.getAttribute('aria-label'));
      const title = clean(node.getAttribute('title'));
      if (!/^(?:\.\.\.|…|⋯)$/.test(text) && !/more|overflow|additional/i.test(`${aria} ${title}`)) continue;

      const candidate = clickableAncestor(node) || node;
      const rect = candidate.getBoundingClientRect();
      const yDistance = referenceRect ? Math.abs(rect.top - referenceRect.top) : 0;
      const editDistance = editRect ? Math.abs(editRect.left - rect.right) : 0;
      candidates.push({ candidate, score: yDistance + editDistance * 0.35 });
    }

    // Strong fallback for the exact Titanium layout in the screenshots: probe the
    // pixels immediately to the left of Edit and take the element underneath the
    // ellipsis even when it has no text/role/aria metadata.
    if (editRect) {
      const y = Math.min(window.innerHeight - 1, Math.max(1, editRect.top + editRect.height / 2));
      for (const offset of [8, 14, 20, 26, 32, 40, 48, 56, 64]) {
        const x = editRect.left - offset;
        if (x <= 0) continue;
        const stack = document.elementsFromPoint(x, y);
        for (const node of stack) {
          if (!(node instanceof Element) || !isVisible(node) || node === edit || edit.contains(node)) continue;
          const candidate = clickableAncestor(node) || node;
          const rect = candidate.getBoundingClientRect();
          if (rect.right > editRect.right || rect.left >= editRect.left) continue;
          if (Math.abs((rect.top + rect.height / 2) - y) > 35) continue;
          candidates.push({ candidate, score: offset + 15 });
          break;
        }
      }
    }

    // Previous semantic-button fallback remains useful on other Titanium builds.
    for (const node of document.querySelectorAll('button, a, [role="button"], [tabindex], [aria-haspopup]')) {
      if (!isVisible(node)) continue;
      const text = clean(node.innerText || node.textContent);
      const aria = clean(node.getAttribute('aria-label'));
      const title = clean(node.getAttribute('title'));
      if (!/^(?:\.\.\.|…|⋯)$/.test(text) && !/more|overflow|additional/i.test(`${aria} ${title}`)) continue;
      const rect = node.getBoundingClientRect();
      const yDistance = referenceRect ? Math.abs(rect.top - referenceRect.top) : 0;
      const editDistance = editRect ? Math.abs(editRect.left - rect.right) : 0;
      candidates.push({ candidate: node, score: yDistance + editDistance * 0.35 + 5 });
    }

    return uniqueElements(
      candidates
        .sort((a, b) => a.score - b.score)
        .map((entry) => entry.candidate)
    );
  }

  function visibleUsageMenuItem() {
    return findClickableExactText('Usage', { visibleOnly: true, allowRaw: true });
  }

  async function openUsageView() {
    const existing = extractUsageRows();
    if (existing.length) return existing;

    // Give the account detail tab time to finish rendering its tab strip.
    const overflowCandidates = await waitFor(() => {
      const found = findOverflowCandidates();
      return found.length ? found : null;
    }, 8000, 200);

    if (!overflowCandidates) {
      throw new Error('The Titanium account overflow menu (…) could not be found after waiting for the account detail tabs to load.');
    }

    let usageItem = null;
    for (const candidate of overflowCandidates.slice(0, 8)) {
      clickElement(candidate);
      usageItem = await waitFor(() => visibleUsageMenuItem(), 900, 75);
      if (usageItem) break;
      // Clicking a wrong spatial candidate is harmless; close any accidental menu
      // by clicking the same candidate again before testing the next one.
      clickElement(candidate);
      await sleep(75);
    }

    if (!usageItem) {
      throw new Error('The three-dot area was found, but the Usage option did not appear. Titanium may be exposing the overflow trigger through a different DOM element.');
    }

    clickElement(usageItem);
    const rows = await waitFor(() => {
      const parsed = extractUsageRows();
      return parsed.length ? parsed : null;
    }, 12000, 300);

    if (!rows) {
      throw new Error('The Usage page opened, but the usage table could not be read before the timeout.');
    }
    return rows;
  }

  async function collectTitaniumData() {
    if (!isAccountDetailPage()) {
      throw new Error('Titanium is not on the account detail page yet.');
    }

    // Read the account-level fields before opening Usage because Titanium swaps the
    // account detail panel when the Usage menu item is selected.
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

    const usageRows = await openUsageView();
    return { ...account, usageRows, warnings: [] };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'APGE_COMPARE_OPEN_ACCOUNT') {
      sendResponse(openAccountDetail());
      return false;
    }

    if (message?.type === 'APGE_COMPARE_COLLECT_TITANIUM') {
      collectTitaniumData()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    return false;
  });
})();
