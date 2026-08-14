(() => {
  const TITANIUM_HOST = 'affordable-ep.esgglobal.net';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isTitanium(tab) {
    try {
      const url = new URL(tab.url || '');
      return url.hostname === TITANIUM_HOST && url.pathname.includes('/enterpriseportal/');
    } catch {
      return false;
    }
  }

  function summaryUrl(rawUrl) {
    try {
      const url = new URL(rawUrl || '');
      if (url.hostname !== TITANIUM_HOST) return '';
      const match = url.pathname.match(/^(.*\/customers\/customerSearch\/[^/?#]+)/i);
      if (!match) return '';
      url.pathname = match[1];
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function isSummaryRoute(rawUrl) {
    try {
      const url = new URL(rawUrl || '');
      return /\/customers\/customerSearch\/[^/?#]+\/?$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  async function waitForTab(tabId, predicate, timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const tab = await chrome.tabs.get(tabId);
      if (predicate(tab)) return tab;
      await sleep(200);
    }
    return null;
  }

  async function summaryIsReady(tabId) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
          const text = clean(document.body?.innerText || '');
          const hasSummary = text.includes('CUSTOMER SUMMARY');
          const hasCommodity = text.includes('COMMODITY PRICE');
          const hasContract = text.includes('SERVICE CONTRACT');
          const hasAccount = [...document.querySelectorAll('body *')].some((node) => {
            if (node.children.length > 3) return false;
            return clean(node.innerText || node.textContent) === 'ACCOUNT';
          });
          return hasSummary && hasCommodity && hasContract && hasAccount;
        }
      });
      return Boolean(result);
    } catch {
      return false;
    }
  }

  async function waitForSummaryReady(tabId, timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await summaryIsReady(tabId)) return true;
      await sleep(200);
    }
    return false;
  }

  async function clickCustomerBreadcrumb(tabId, expectedSummaryUrl) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [expectedSummaryUrl],
        func: (targetUrl) => {
          const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
          const upper = (value) => clean(value).toUpperCase();
          const visible = (node) => {
            if (!(node instanceof Element)) return false;
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };

          for (const link of document.querySelectorAll('a[href]')) {
            if (!visible(link)) continue;
            try {
              const resolved = new URL(link.href, location.href).toString();
              if (resolved === targetUrl && upper(link.innerText || link.textContent) !== 'CUSTOMERS SEARCH') {
                link.click();
                return true;
              }
            } catch {}
          }

          const bodyText = String(document.body?.innerText || '');
          const match = bodyText.match(/Customers Search\s*>\s*([^>\r\n]+)/i);
          const customerName = match ? clean(match[1]).replace(/\s*>.*$/, '') : '';
          if (!customerName) return false;

          for (const node of document.querySelectorAll('a, button, [role="link"], [role="button"], [tabindex]')) {
            if (!visible(node)) continue;
            if (upper(node.innerText || node.textContent) === upper(customerName)) {
              node.click();
              return true;
            }
          }
          return false;
        }
      });
      return Boolean(result);
    } catch {
      return false;
    }
  }

  async function normalizeTitanium() {
    const tabs = await chrome.tabs.query({});
    const titaniumTabs = tabs.filter(isTitanium);
    const active = titaniumTabs.find((tab) => tab.active);
    const tab = active || [...titaniumTabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!tab) return;

    const target = summaryUrl(tab.url);
    if (!target) return;

    if (!isSummaryRoute(tab.url) || !(await summaryIsReady(tab.id))) {
      const clicked = await clickCustomerBreadcrumb(tab.id, target);
      if (clicked) {
        await waitForTab(tab.id, (current) => isSummaryRoute(current.url) && current.status === 'complete', 10000);
      } else {
        await chrome.tabs.update(tab.id, { url: target });
        await waitForTab(tab.id, (current) => isSummaryRoute(current.url) && current.status === 'complete', 10000);
      }
    }

    const ready = await waitForSummaryReady(tab.id, 12000);
    if (!ready) {
      throw new Error('Titanium reached the customer page, but Customer Summary did not finish loading.');
    }
  }

  const runButton = document.getElementById('runButton');
  if (!runButton) return;

  let releasing = false;
  runButton.addEventListener('click', async (event) => {
    if (releasing) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    runButton.disabled = true;

    try {
      const status = document.getElementById('status');
      if (status) {
        status.hidden = false;
        status.className = 'status';
        status.textContent = 'Opening the Titanium Customer Summary…';
      }
      await normalizeTitanium();

      releasing = true;
      runButton.disabled = false;
      runButton.click();
    } catch (error) {
      runButton.disabled = false;
      const status = document.getElementById('status');
      if (status) {
        status.hidden = false;
        status.className = 'status error';
        status.textContent = error?.message || String(error);
      }
    } finally {
      releasing = false;
    }
  }, true);
})();