# APG&E Compare Tool: Prototype Specification

## Scope

Version 0.1 compares **one current Titanium account** against **one open APG&E EFL**. Multi-EFL comparison is intentionally out of scope until the single-plan workflow is validated.

## Core product decisions

- Rep workflow: open customer ESG page, open proposed EFL, run extension.
- Titanium is the preferred active tab, but the extension can locate it anywhere in the current Chrome window/session.
- If multiple EFL tabs are open, use the most recently active valid Artemis EFL tab.
- Keep the last completed result until the rep runs another comparison.
- Main result is dollar-based only. No percentage comparison in the customer-facing view.
- Positive result: lead with total projected savings over the proposed contract term.
- Negative result: lead with the average monthly increase and show the full term increase underneath.
- Details expand inside the same popup rather than opening a separate application page.

## Customer identifier

Preferred display:

`Customer name • Service address • Meter number`

Service address and meter number are important because one customer account may contain multiple meters/service locations.

## Data quality rules

- Minimum: 3 complete billing cycles under the current contract.
- Billing cycles that overlap the current contract start date do not count toward the minimum.
- Canceled usage rows are ignored.
- Estimated usage rows may be used but are marked in the details.
- The extension must never silently invent a missing EFL field. Failed EFL parsing triggers manual input.

## Plan classification

Automatic:

- If the EFL contains a bill-credit rule, classify it as a bill-credit plan.
- Otherwise classify it as the standard fixed-rate plan.

Current APG&E prototype scope supports those two plan structures only.

## Result detail hierarchy

### Collapsed

1. Projected savings/increase headline
2. Supporting monthly or contract-term figure
3. Suggested customer-facing wording
4. See details button

### Expanded

1. Current vs proposed monthly graph
2. Month-by-month dollar table
3. Bill-credit applied/not-applied status when relevant
4. Source inputs
5. Projection methodology
6. Exact formula
7. Prototype/compliance disclosure

## Future work

- Validate the Titanium DOM scraper against several live account layouts.
- Validate the EFL parser against additional CenterPoint and other TDU EFL variants.
- Add a representative seasonal usage model for missing calendar months.
- Add controlled outlier exclusion when the customer explicitly requests it.
- Add multi-EFL comparison only after single-EFL calculations are validated.
- Move approved sales wording into centrally versioned configuration after compliance review.
