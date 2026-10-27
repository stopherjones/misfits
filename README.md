# Misfits

Season scheduling for the Misfits board game team, hosted on GitHub Pages.

## Pages
- `index.html`: home page with a season summary and links.
- `scheduler.html`: the scheduler. Full screen. On touch tablets the holding area sits under the grid; on desktop with a mouse it sits beside it.
- `settings.html`: sheet links, season rules (games per round, team size, stability penalty), and players (away weeks, games caps, country codes).

## Data
- `data/sources.json`: the published Google Sheets CSV links for preferences and the schedule. Edit this file to point at a different sheet.

## Files
- `common.js`: shared state, CSV parsing (preferences and schedule, including the Stage A layout), settings and season storage.
- `solver.js`: the allocation engine (exact flow solver, objective modes, proposal paths).
- `scheduler.js`: scheduler page logic.
- `styles.css`: shared styles.

Settings and season state are kept in this browser's local storage, so each device keeps its own.
Published sheets are public to anyone with the link.
