# APG&E Compare Tool

Internal Chrome extension prototype for APG&E sales reps. It compares a customer's current ESG Titanium energy pricing and usage history against **one proposed APG&E Electricity Facts Label (EFL)** and returns a sales-friendly projected dollar comparison with transparent supporting math.

## Intended rep workflow

1. Open the customer's ESG Titanium account page.
2. Open the proposed APG&E EFL in another Chrome tab.
3. Click the extension.
4. Click **Run Comparison**.
5. Use the headline result and suggested wording during the call.
6. Expand **See details** for the graph, month-by-month comparison, exact inputs, formula, and calculation methodology.

The prototype recognizes:

- ESG Titanium: `https://affordable-ep.esgglobal.net/enterpriseportal/...`
- APG&E EFL documents: `https://artemis-api.apge.com/api/v1/document?...`

## What the MVP reads

### From ESG Titanium

- Commodity Price, in dollars per kWh
- Service address
- Meter number
- Current service-contract start and end dates
- Monthly usage rows, including billing dates, kWh, estimated/canceled flags, days, and energy Charge Amount when present

The tool requires **at least 3 complete billing cycles under the current contract** before it will produce a projection. A billing cycle that begins before the current contract start is not counted toward that minimum.

### From the EFL

The extension fetches the open Artemis PDF directly and uses a small APG&E-specific PDF text extractor. It currently parses:

- Energy Rate
- Base Charge
- TDU/TDSP delivery charge per kWh
- TDU/TDSP monthly charge
- Contract term
- Bill-credit amount and usage threshold, when present

The parser was tested against the sample fixed-rate and `$125 at 1,000 kWh` bill-credit EFL formats used during prototype design.

If the EFL cannot be parsed reliably, the extension does **not** guess. It asks the rep to manually enter the required EFL values.

## Calculation behavior

### Standard fixed-rate plan

The headline comparison is based on the energy portion of the bill:

`Current energy charge = kWh × current Titanium Commodity Price`

`Proposed energy charge = (kWh × proposed EFL Energy Rate) + proposed Base Charge`

`Savings = current energy charge − proposed energy charge`

TDU delivery charges are not included in the standard-plan savings headline because they are utility pass-through charges and are subject to change.

### Bill-credit plan

For a bill-credit plan, the tool models both sides using the **current TDU delivery charges shown on the proposed EFL**, then applies the credit only in months where the modeled usage meets the EFL threshold.

`Current modeled bill = current energy charge + current EFL TDU charges`

`Proposed modeled bill = proposed energy charge + current EFL TDU charges − earned credit`

`Savings = current modeled bill − proposed modeled bill`

Because the same current TDU charges are used on both sides, the savings difference is driven by the energy-rate difference, base charge, and earned bill credits. The detailed screen still shows the TDU assumption so the rep can explain the model.

## Seasonal projection

The proposed plan is assumed to begin after the current contract expires.

For each month in the proposed contract term, the tool tries to use the most recent historical billing cycle from the **same calendar month**. This avoids comparing mild-weather months directly with summer-heavy months when season-matched history exists.

If a matching month is unavailable, the missing month is estimated using the average kWh from up to the 12 most recent complete billing cycles under the current contract. Estimated months are marked in the detailed table.

## Sales presentation

The collapsed result intentionally stays simple:

- Customer/service identifier
- One primary dollar result
- One short suggested script
- **See details**

Positive results lead with the larger contract-term savings number. Negative results lead with the average monthly increase while still showing the full contract-term increase underneath.

The extension does not show percentage savings in the customer-facing result.

## Install locally

This prototype has **no build step and no npm dependencies**.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder containing `manifest.json`.
6. Refresh any ESG Titanium tabs that were already open before the extension was loaded.
7. Pin **APG&E Compare Tool** to the Chrome toolbar.

## Prototype limitations

- ESG Titanium is a dynamic application. The content scraper uses field labels and table headers rather than private APIs, so DOM changes may require selector updates.
- The tool attempts to open the Usage view automatically. If Titanium exposes the Usage control only through an inaccessible icon state, open the Usage section manually and run the comparison again.
- The EFL parser is purpose-built for the APG&E PDF structure observed during prototype development. A manual-entry fallback is included by design.
- The current projection model is deliberately simple. A future version can add a broader seasonal model trained on representative account history.
- The last completed result is stored in Chrome extension local storage so it remains visible until another comparison is run.

## Compliance note

This repository is a prototype calculation aid. The customer-facing script is draft language, not a legal or regulatory determination. APG&E compliance/legal should review and approve the wording, methodology, disclosures, data handling, and deployment controls before production use.
