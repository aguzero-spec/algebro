# Bundled libraries (web version)

Copied into the site (never loaded from another website) and pinned to exact versions,
each at least two weeks old when added. Approved by the owner on 2026-10-17.

| Library | Version | File | From | npm integrity (sha512) | License |
|---|---|---|---|---|---|
| docx | 9.8.1 (2026-09-28) | `docx-9.8.1/docx.iife.js` | `dist/index.iife.js` of the npm package | `bv4yDxgiV9aRyh327HG+V36wG0f23wk32SDhXGQpUhnykVtIPaR1K4ISi8E+DYJ7OcRQRkR8Y70QYlSS08V1cA==` | MIT |
| pptxgenjs | 4.0.1 (2025-06-26) | `pptxgenjs-4.0.1/pptxgen.bundle.js` | `dist/pptxgen.bundle.js` of the npm package | `TeJISr8wouAuXw4C1F/mC33xbZs/FuEG6nH9FG1Zj+nuPcGMP5YRHl6X+j3HSUnS1f3at6k75ZZXPMZlA5Lj9A==` | MIT |
| pdfmake | 0.3.11 (2026-06-12) | `pdfmake-0.3.11/pdfmake.min.js` | `build/pdfmake.min.js` of the npm package | `Uc49J9hUMyuqJk+U+PxlpBpPr96A4HOOfesGx609EPr2ue82+5/Smq/KTAkEqh0/jUGSi1fumvqZ5yAWijJTJg==` | MIT |
| mammoth | 1.13.0 (2026-09-26) | `mammoth-1.13.0/mammoth.browser.min.js` | `mammoth.browser.min.js` of the npm package | `2cawcYFcP7ISfXbBcL9lmVgTNWo88v/52ND1gnywHtVT/pX0//puPnf0iMPV9ZgmuvNOE+zkIhDgZ9M2c2dDDg==` | BSD-2-Clause |
| pdfjs-dist | 6.4.299 (2026-10-03) | `pdfjs-6.4.299/pdf.min.mjs`, `pdf.worker.min.mjs` | `build/` of the npm package | `AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==` | Apache-2.0 |
| Arimo font | git commit 4a6255f269 (2026-04-27) | `arimo-4a6255f/*.ttf` | `fonts/ttf/` of github.com/googlefonts/arimo | (pinned by commit) | SIL OFL 1.1 |

To update one: download the new version's npm package, check its integrity against the
npm registry, copy the browser build here under a new versioned folder, update the path in
`web/js/`, and test every export.
