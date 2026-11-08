# Namma Paalu — mandatory release quality gate

The founder delegates UI, animation, copy, product and engineering decisions to the acting product/engineering lead. Their involvement is for approving a coherent release, not discovering basic defects.

## Round 1: CEO / product quality
- Review each visible screen: Home, Expenses, Split, People, Settle, Activity.
- Check hierarchy, concise human copy, consistent branding, contrast, spacing, typography, icons and animation usability.
- Verify no clipping, overlap or horizontal scrolling at 320, 390, 430, 768, 1366px.
- Animation should not produce layout jumps. Respect prefers-reduced-motion.

## Round 2: CTO / regression quality
- Run `node --check app.js` and `node test/smoke.mjs` before every commit/release. No syntactically invalid JS may ship.
- In a real browser test all six navigation routes, chart selection, expense add/edit/delete, empty trip, split calculations, persistence and search.
- Compare actual mobile AND desktop screenshots. Observe browser console, uncaught errors and broken assets.
- Verify original expense-engine arithmetic in the anonymized reference dataset, using paise.
- Confirm published live URL after deployment, not just GitHub source.
- A release with uncompleted browser tests is **not approved**; mark as unverified and do not claim it passed.

## Public-preview safety
- No private family names or financial records in public source.
- Clear preview/local-data disclosure; do not claim secure payments or real-time collaboration until backend checks pass.

## Incident: 2026-11-08
A copy edit introduced an unescaped apostrophe in a JavaScript single-quoted string, causing startup failure and blank screens. Syntax checks were absent before deployment. A mandatory push validation was added and must remain enabled.
