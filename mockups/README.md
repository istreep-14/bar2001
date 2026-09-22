# Mockups

Static HTML pictures of UI that does not exist yet, for deciding what is worth building. They are not part of
the app: the server serves a fixed list of files (`STATIC` in `server/index.js`) and none of these are on it,
so nothing here can reach a running dashboard, and no file under `dashboard/` or `server/` has been changed.

Each mockup links `dashboard/styles.css` and uses the app's real components, so what you see is what the page
would look like. The figures are made up.

## Shift log

- **[shift-log/index.html](shift-log/index.html)** — nine improvement blocks for **Shift › Log**, one at a
  time, each with what the page does today, what would change, why, and what it would cost.
- **[shift-log/assembled.html](shift-log/assembled.html)** — blocks 01–08 together on one page, inside the
  app's own rail and topbar, so the whole thing can be read at a glance.
- **[shift-log/proposed.css](shift-log/proposed.css)** — the CSS those blocks would add to
  `dashboard/styles.css`, kept apart so it is obvious what is new. It uses only the tokens at the top of that
  file.

## Viewing them

Opening the files straight off disk works, with one flaw: a browser refuses to load a font over `file://`, so
the type falls back to the system stack instead of Poppins. Serving the repo fixes it:

```
python3 -m http.server 8080        # from the repo root
# then http://localhost:8080/mockups/shift-log/index.html
```

Both pages have a light / dark / auto switch, since the app follows the OS setting and the blocks have to work
in both. Nothing else on them clicks, apart from the density switch on the shift table.

## Writing one

- Link `../../dashboard/styles.css` first, then `../mockup.css` (the review chrome: the sheet, the block
  frames, the notes), then whatever CSS the proposal itself needs.
- Reuse the app's components — `.panel`, `.tiles`/`.tile`, `.seg.tabs`, `.pill`, `.btn`, `.icon-btn`,
  `.colsort`, `.ratechip`, `.mixbar`, `.empty` — and reach for new CSS only where there is nothing to reuse.
- Keep new icons as plain `<path>` elements, the way `ICONS` in `dashboard/index.html` is, so one can be
  pasted straight into it.
- Say which parts are real and which are pictures. A mockup that looks interactive and isn't wastes the
  reviewer's time.
