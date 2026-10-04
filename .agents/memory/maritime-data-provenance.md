---
name: Maritime optimizer data provenance
description: User requirements for trustworthy operational data and model limitations in the maritime fuel optimizer.
---

Do not seed or reuse the uploaded model's sample fleet, training data, bunker prices, or exchange rate as operational facts. The source README labels its vessel and training records synthetic/demo and its prices illustrative.

Keep vessel storage empty until an operator enters a vessel profile with a source citation. Require dated, sourced fuel prices and pathway-specific well-to-tank inputs for optimization runs. Explain that lifecycle estimates and weather corrections are screening results, not regulatory certification; the IMO wave-resistance guidance calls for ship-specific simulation or equivalent test data.

**Why:** the user explicitly required that demo, dummy, and random data not be presented as real; the source material itself marks its example data as synthetic or illustrative.

**How to apply:** preserve provenance in forms and exports, do not restore archive seed data, and do not silently substitute missing operational or lifecycle assumptions.