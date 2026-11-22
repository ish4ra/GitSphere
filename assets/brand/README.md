# GitSphere Brand

The GitSphere mark is an orbital sphere: a globe with meridian and latitude lines, crossed by an inclined orbit carrying a single node — a developer in the global network. It is original artwork and contains no GitHub logo. GitSphere is independent and not affiliated with GitHub.

| Asset | Use |
| :-- | :-- |
| `gitsphere-mark.svg` / `.png` (512×512, transparent) | Avatar, favicon, small placements |
| `gitsphere-logo-light.svg` / `.png` | Logo on light backgrounds |
| `gitsphere-logo-dark.svg` / `.png` | Logo on dark backgrounds |
| `banner-light.svg`, `banner-dark.svg` | README hero (`<picture>` with `prefers-color-scheme`) |
| `card-*-light.svg`, `card-*-dark.svg` | README entry points |
| `icon-*.svg` | Mode icons |
| `social-preview.svg` / `.png` (1280×640) | Repository social preview |

## Palette

| Token | Hex |
| :-- | :-- |
| Night (dark background) | `#080D19` |
| Primary blue | `#6395FF` |
| Cyan accent | `#38CFFF` |
| Light foreground | `#F1F5F9` |
| Ink (light-theme text) | `#0B1220` |
| Muted (dark / light) | `#94A3B8` / `#475569` |

Typography: **Inter** (SIL Open Font License), converted to outlines so the SVGs need no font. Wordmark is Inter Bold with -2.5% tracking; "Sphere" carries the blue→cyan gradient.

## Social preview upload (manual)

GitHub's API cannot set the social preview image, so a repository admin must upload it:

1. Open **Settings → General** on `ish4ra/GitSphere`.
2. Under **Social preview**, choose **Edit → Upload an image…**.
3. Select `assets/brand/social-preview.png` (1280×640 PNG, under 1 MB; GitHub requires at least 640×320 and recommends 1280×640).

## Regenerating

```bash
npm install --no-save opentype.js@1.3.4 @fontsource/inter@5.1.0
node scripts/brand/build-brand.mjs
node scripts/brand/render-png.mjs   # requires Playwright with Chromium
```
