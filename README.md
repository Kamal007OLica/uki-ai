# Uki AI UI Auditor

One-click UI audits inside Figma. Select a frame, a component or a whole page and Uki scores it out of 100 across six categories, lists every issue with the layer it lives on, and fixes the common ones in one click.

Community page: https://www.figma.com/community/plugin/1484499033305449577

## What it checks

| Category | Rules |
|---|---|
| Colour scheme | WCAG AA text contrast (against the real composited background), palette sprawl, near-duplicate colours, fills not bound to styles or variables |
| Typography | Text below the minimum size, tight line height, too many families, too many sizes, text not using text styles |
| Layout | Sizes and positions off the 4/8pt grid, hand-stacked frames that should be auto layout, padding off the grid, children overflowing a non-clipping parent, siblings almost aligned |
| Interaction | Tap targets below the minimum, crowded targets, icon-only controls without a name, controls with no prototype link when the file has prototyping |
| Navigation | Default layer names, deep nesting, groups instead of frames, flat or missing type hierarchy, screens with no navigation landmark, hidden leftovers |
| Visual design | Inconsistent corner radii, stroke weights and shadow recipes |

Each category starts at 100 and loses 10 per high, 4 per medium and 1 per low issue. The overall score is a weighted average (colour 20, layout 20, typography 18, interaction 15, visual 14, navigation 13). An accessibility sub-score counts only contrast, tap target, text size and naming issues.

## One-click fixes

- **Snap** sizes, positions, padding and gaps to the grid
- **Rename** default layers from their content ("Button / Continue", "Stack", "Icon")
- **Enlarge** tap targets to the minimum, keeping them centred
- **Fix contrast** by shifting the text colour toward black or white until it passes AA
- **Enlarge text** to the minimum size
- **Auto layout** for hand-positioned rows and columns, with gap and padding inferred

After each fix the audit re-runs so the score updates live. "Fix all" applies every fixable issue in the current filter.

## Annotate, export, review

- **Annotate on canvas** drops a report card next to the audited frames with the scores and top issues.
- **Copy report** puts a Markdown summary on the clipboard for a PR, a ticket or a design review doc.
- **Ask Uki AI** (optional) sends the scores, issue list, fonts and colours to Anthropic using your own API key and returns a short prioritised review. The design itself never leaves Figma. Leave the key empty to keep everything offline.

## Development

```bash
npm install
npm run build      # compiles code.ts -> code.js
npm run watch      # rebuild on save
npm run lint
```

In Figma: Plugins → Development → Import plugin from manifest… and pick `manifest.json`.

Files:

- `code.ts` — the audit engine, fixes and canvas annotation (runs in Figma's sandbox)
- `ui.html` — the panel (overview, issues, settings, optional AI review)
- `manifest.json` — plugin manifest; network access is limited to api.anthropic.com for the optional review
