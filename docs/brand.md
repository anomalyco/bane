# Brand

The bane logo is the **Stamp** mark next to the word **bane**. The word is always lowercase.

## Files

| file | use |
| --- | --- |
| `app/public/brand/bane-lockup-light.svg`, `bane-lockup-dark.svg` | mark and word, for light and dark backgrounds |
| `app/public/brand/bane-mark.svg`, `bane-mark-dark.svg` | mark alone |
| `app/src/components/BaneLogo.tsx` | the same paths in the dashboard: `BaneWordmark` (lockup) and `BaneMark`. They follow the theme. |
| `app/public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-*.png`, `og.png` | browser icons and the link-preview card. `node scripts/brand-assets.mjs` in `app/` rebuilds the PNG and ICO files from the SVGs. |

Everything is outlined, so no font is needed to render the files. Use the PNGs in email, because many mail clients don't show SVG.

## Colour

| token | light | dark | used for |
| --- | --- | --- | --- |
| `--color-brand` | `oklch(0.54 0.2 266)` · `#3761E1` | `oklch(0.608 0.166 266)` · `#537BE5` | the mark |
| `--color-text` | `#161616` | `#FAFAFA` | the word |

The dark value keeps the light value's hue and its share of the available chroma. Its lightness is set so the mark has the same contrast (5.1:1) on the dark background `--color-deep` as it has on the light one. The mark meets the 3:1 floor for graphics on every background layer in both themes. On a photo or a coloured background, use the one-colour mark in `--color-text`.

## Construction

- **Type:** Inter 600 at its display optical size (32), tracked −2%.
- **Mark:** as tall as the cap height, sitting on the baseline. Inter's ascenders also reach the cap height, so the top of the “b” lines up with the top of the mark.
- **Gap:** 0.35× the mark's width, measured to the stem of the “b”.
- **Mark weight:** the outer frame is as thick as the letters' stems (17% of the cap height). The inner ring, centre square and perforations follow the original Stamp design.

## Clear space and size

- **Clear space:** keep at least half the mark's height clear on every side.
- **Minimum size:** the mark at 16 px tall, whether alone or in the lockup. Below that the perforations fill in. The dashboard sidebar uses 18 px.
- **Favicon:** the mark alone, with its inner squares snapped to whole pixels at 16, 32 and 48 px (`favicon.svg` is on the 16 px grid), so the frame and rings stay sharp in a browser tab.

## Don't

- Change the gap, the alignment or the tracking, or reset the word in another typeface.
- Recolour the mark outside `--color-brand` and `--color-text`, or give the word the brand colour.
- Add gradients, outlines, shadows or glows, or put the mark in a container shape. The square app icons are the one exception.
- Stretch, rotate or crop the mark, or write the word in capitals.
