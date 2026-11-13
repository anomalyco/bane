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
- **In the dashboard:** `BaneWordmark` sets “bane” as live Inter 600 text at 14 px with the 16 px mark beside it, 6 px apart, the mark centred on the word. The mark's left edge sits on the sidebar's content edge (`--sidebar-gutter`), the same x as the workspace picker's border and the navigation pills. The outlined files in `app/public/brand/` are for use outside the app.

## Clear space and size

- **Clear space:** keep at least half the mark's height clear on every side.
- **Minimum size:** the mark at 16 px tall, whether alone or in the lockup. Below that the perforations fill in.
- **Favicon:** the mark alone, with its inner squares snapped to whole pixels at 16, 32 and 48 px (`favicon.svg` is on the 16 px grid), so the frame and rings stay sharp in a browser tab.

## Don't

- Change the gap, the alignment or the tracking, or reset the word in another typeface.
- Recolour the mark outside `--color-brand` and `--color-text`, or give the word the brand colour.
- Add gradients, outlines, shadows or glows, or put the mark in a container shape. The square app icons are the one exception.
- Stretch, rotate or crop the mark, or write the word in capitals.
