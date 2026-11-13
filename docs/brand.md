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
| `--color-brand` | `#798ABA` · `oklch(0.638 0.075 269.2)` | the same | the mark |
| `--color-text` | `#161616` | `#FAFAFA` | the word |

The mark is a muted periwinkle in both themes. It meets the 3:1 floor for graphics on every background layer the logo sits on: 3.3:1 on light `--color-deep` (`#FAFAFA`), 3.4:1 on white and 3.05:1 on `--color-layer-2` (`#F2F2F2`). In dark mode it is 5.9:1 on `--color-deep` and 4.0:1 on `--color-layer-2`. Don't place it on anything darker than `#F2F2F2` in light mode. On a photo or a coloured background, use the one-colour mark in `--color-text`.

## Construction

- **Type:** Inter 600 at its display optical size (32), tracked −2%.
- **Mark:** as tall as the x-height, sitting on the baseline, so it reads with the lowercase “ane” rather than towering to the ascender. Inter's x-height is 75% of its cap height.
- **Gap:** 0.35× the mark's width, measured to the stem of the “b”.
- **Mark weight:** the outer frame is 17% of the mark's height, the heaviest it can be before its white gaps close. The inner ring, centre square and perforations follow the original Stamp design.
- **In a layout:** `BaneWordmark`'s viewBox is Inter's own line box (ascender 1984, descender 494 of 2048 units), so the logo centres in a row and finds its baseline exactly like a line of Inter text. Align its left edge with the content edge (in the sidebar, `--sidebar-gutter` + `--sidebar-inset`, the same edge as the workspace picker's avatar and the navigation labels).

## Clear space and size

- **Clear space:** keep at least half the mark's height clear on every side.
- **Minimum size:** the mark at 15 px tall in the lockup, or 16 px alone. Below that the perforations fill in. The dashboard sidebar uses 15 px: the x-height of 27.5 px Inter, which puts the baseline on a whole pixel in the 24 px header row.
- **Favicon:** the mark alone, with its inner squares snapped to whole pixels at 16, 32 and 48 px (`favicon.svg` is on the 16 px grid), so the frame and rings stay sharp in a browser tab.

## Don't

- Change the gap, the alignment or the tracking, or reset the word in another typeface.
- Recolour the mark outside `--color-brand` and `--color-text`, or give the word the brand colour.
- Add gradients, outlines, shadows or glows, or put the mark in a container shape. The square app icons are the one exception.
- Stretch, rotate or crop the mark, or write the word in capitals.
