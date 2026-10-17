# Bundled libraries (web version)

Copied into the site (never loaded from another website) and pinned to exact versions,
each at least two weeks old when added. Approved by the owner on 2026-10-17.

| Library | Version | File | From | npm integrity (sha512) | License |
|---|---|---|---|---|---|
| docx | 9.8.1 (2026-09-28) | `docx-9.8.1/docx.iife.js` | `dist/index.iife.js` of the npm package | `bv4yDxgiV9aRyh327HG+V36wG0f23wk32SDhXGQpUhnykVtIPaR1K4ISi8E+DYJ7OcRQRkR8Y70QYlSS08V1cA==` | MIT |

To update one: download the new version's npm package, check its integrity against the
npm registry, copy the browser build here under a new versioned folder, update the path in
`web/js/`, and test every export.
