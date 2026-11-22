# Contributing to GitSphere

Thanks for helping improve GitSphere.

## Development

```bash
npm run check        # syntax check + full test suite (no network needed)
npm run publish      # regenerate pages and data from saved state (no API calls)
```

Node.js 22+ is required. The project has no runtime dependencies.

A real pipeline run needs a token with public read access:

```bash
GITHUB_TOKEN=… GITSPHERE_MAX_REQUESTS=100 npm run pipeline
```

## Generated files

Do not edit these by hand; change the generator instead:

| Files | Generator |
| :-- | :-- |
| `README.md`, `rankings/**`, `data/**` | `src/publish/*` via `npm run publish` |
| `geography/**` | `scripts/build-gazetteer.js` (`npm run sync:geography`) |
| `assets/brand/**` | `scripts/brand/build-brand.mjs` and `render-png.mjs` |
| `state/**` | the pipeline |

## Location attribution fixes

If a location is attributed wrongly or not at all:

1. Add a failing case to `tests/geo-resolver-real.test.js` (or `geo-resolver-unit.test.js`).
2. Prefer fixing the rule or the upstream data source; use `src/geo/curated.js` only for small, documented exceptions.
3. Never resolve a genuinely ambiguous location by guessing.

## Pull requests

- Keep commits focused; run `npm run check` before pushing.
- Do not commit credentials, `.env` files, temporary debugging output or downloaded datasets.
- Tests must exercise production code, not re-implement it.
