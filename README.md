# Bar2.000

A small server that logs the bartender shifts you work: create, read, update and delete over a clean SQLite schema, plus a live dashboard of the raw data at `/`. Income is in three groups: **tips** (the main one, entered per shift), an **estimated wage** (derived from your hours and hourly wage, never entered), and **other income** (Cash, Venmo, Paycheck, whatever types you add). There is no other analytics yet, on purpose. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the rules that keep the data clean.

Node 22.13+ only. There are no npm dependencies (built-in `http`, `node:sqlite`, `node:test`), so no install step.

## Run
```
npm start                     # http://127.0.0.1:4200, database at data/bar.db
npm run dev                   # same, restarts on file changes
npm test
```

| env var     | default        | notes |
|-------------|----------------|-------|
| `PORT`      | `4200`         | |
| `HOST`      | `127.0.0.1`    | any non-loopback host **requires** `API_TOKEN` or the server refuses to start |
| `DB_PATH`   | `data/bar.db`  | created on first run; schema migrates automatically |
| `API_TOKEN` | unset          | when set, send `Authorization: Bearer <token>` (except `GET /api/v1/health`) |

Node prints an `ExperimentalWarning` for `node:sqlite`. It's harmless; hide it with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

## Dashboard: live feed and shift form
Open **http://127.0.0.1:4200/** while the server runs. It shows the records as they are, and updates the instant anything changes:

- **Shifts:** newest first, grouped by month (each month's heading carries its shifts, hours, tips and total), **one line per shift and a column for every figure**: **Date**, **Type** (with a **Party** badge when the shift had one), **Place**, **Shift** (start–end), **Hours** (worked), **Tips**, **Tips/hr**, **Wage** (estimated), **Other**, **Total** (tips + wage + other), **Total/hr** and **Crew** (bartenders including you, with their combined hours). Nothing is stacked under anything else. On a narrow screen the table scrolls sideways with the date pinned. What doesn't fit a cell is under the row's arrow: other income by type, breaks, who worked and what each made, party, notes and tags, and **Show raw data**. Amounts and per-hour figures are **rounded to whole dollars in the table; hover any of them for the exact cents**. Every per-hour column is over hours worked (the shift's length minus its breaks). A dash means nothing was entered. Hover a row's date for its crew, tags, notes and party, or a wage or total for how it was worked out. On the right of each row are three icon buttons: **edit** (pencil), **details** (arrow) and **delete** (bin; asks twice: the first click turns it into a red *Delete?* for four seconds; it is a soft delete). Clicking elsewhere on a row does nothing. "Show deleted" reveals soft-deleted shifts, which can be edited and restored from the form.
- **Overview** (the landing page): what your shifts add up to over the last 30 or 90 days, this year or all time. Total income leads, then hours and income by week (or by month over a long range), tips per hour shift by shift (each dot coloured by Day, Night or Double, with your average drawn across), and tips per hour by shift type, weekday and place. Hover or tab to any bar or dot for the exact figures; each chart has a *View as table*.
- **Calendar:** a month grid where every shift is a chip (type, hours worked, total income) that opens it, days are shaded by how much they earned against the month's best, and an empty day starts a new shift on that date. The month's shifts, hours, tips and income sit underneath.
- **Live feed:** every create, update, delete and purge as it happens, with row counts in the header.
- **Anything that writes to the database shows up**, including the import script and `sqlite3`, not just API calls.
- With `API_TOKEN` set, the page asks for the token once and remembers it in that browser.
- It works at phone width too (the shift form fills the screen), so you can leave it open on your phone over Tailscale or a cloud host. It follows your light or dark setting.
- The look lives in [dashboard/styles.css](dashboard/styles.css): Poppins, served by the app itself (no request ever leaves your machine), with spacing, type sizes and colours as tokens at the top of the file.

**Adding and editing shifts:** click **+ New shift**, or **Edit** on any row. The form is one short page in sections, in the order you'd fill it in:

Nothing on the form is required, including the date and times: fill in as little or as much as you know right now, and come back to fill in the rest later.

1. **Date:** tap a day on a month calendar that shows the shifts you have already logged (type and tips on each day, and a note if the day you pick already holds one). You can also type the date, or leave it blank.
2. **Time:** start and end, with the length, breaks and time worked worked out beside them and the shift drawn along the clock. Then **any number of breaks** (none is fine), as a strip of tabs, one open at a time. Each break is a start and end time, or switch it to **just a length in minutes**. Breaks have to fall inside the shift, can't overlap, and together can't be longer than it. An end at or before the start means the shift ends the next day (it says so). Times are the clock on the wall, with no timezone.
3. **Type:** **Day** or **Night**, each card showing what your tips per hour has averaged on it. It's optional, and seeded for you from the start time (3:00 PM or later is Night, earlier is Day) until you pick one by hand — after that it's yours, and changing the start time again won't override it. A shift that runs day into night is just two separate shifts, logged one after the other; there is no "Double".
4. **Tips** (the primary income): a plain dollar amount (`210`, `345.50`, `$1,234.56`); add as many entries as you need.
5. **Wage:** not an input. It's worked out live from the date, times and breaks and your hourly wage: paid time (the shift's length minus its breaks, which are unpaid) × the rate in effect that day. Your **wage rates** are edited under **Lists**, not in the form; with no rate in effect on the shift's date it says so.
6. **Misc:** other income, as entries with a **type** you choose (Cash, Venmo, Paycheck…), same amount format as Tips. Add and rename the types under **Lists → Misc types**.
7. **Location:** tap one from your list, or type it (it autocompletes). A name that isn't on the list yet is added to it when you save. Add, rename and remove locations under **Lists**.
8. **Party:** tick *A party happened during this shift* if one did. Every detail is optional (name, guests, start and end, notes, and you can add more than one) and is entered in the **Party** tab, where each party is a tab that appears as soon as you tick the box; the yes or no is what shows up when you compare shifts (the **Party** badge, and `has_party` in the API).
9. **Employees on this shift:** tap the people who worked it, or type a name and press Enter (a new name is added to your employees). Each person on the shift is a tab (their name, hours and tips); open one to set their **start, end and tips they made** (all optional; times start as yours) and their **role**, which is saved as you change it. Below, the labour on the shift (bartender count and hours, staff tips, tips per bartender hour) and each person drawn against your time.
10. **Notes** and tags.

A new shift starts with the time and location of your last one. There is no venue or job to fill in.

**Two levels, and the form is the second.** Browsing is the page: tabbed navigation on the left (**Browse**: Overview, Calendar, Shifts, Live feed; **Lists**: Locations, Misc types, Wage rates) and the selected page on the right. **+ New shift** (or the edit pencil, or a Calendar chip) opens the shift as a **dialog over that page**, headed by where you are: *Shifts › New shift › Time*. **Close**, the *Shifts* crumb and Esc take you back to the page you were on; if you have typed anything, the first one turns Close into a red *Discard changes?* for four seconds, and the second discards. Inside the dialog it isn't one long scroll either: tabbed pages in section groups down the left, the selected page's input on the right.

| group | pages |
|---|---|
| **Info** | Date · Time (start, end, breaks) · Type |
| **Income** | Tips · Wage · Misc |
| **Details** | Location · Crew · Party · Notes |

Each page is its own tab with a live summary beside its name ("Mon, Sep 21", "$200", "1 person · 2 bartenders"), and a red dot when a field on it needs fixing (Save takes you to the first one). The header shows the date, type and total income so far. **Back**, **Next** and **Save shift** are in the footer, and **Delete** at its left when editing. The lists a shift draws on (locations, misc types, wage rates) are not in the form at all: edit them under **Lists** while browsing. The form keeps to the shift, with only a quiet line of figures under each input (worked hours, tips per hour against your average with an arrow, total income) and a thin timeline on Time, Crew and Party. On a phone the tabs become one scrolling row across the top and Save/Cancel a bar along the bottom.

- **Employees** (the tab beside *Shifts*) is the people you work with, as a table of their own in two tiers. The main panel is the roster, **grouped by role**, with each person's **shifts, hours and tips** and when they last worked (group rows carry the totals; hours are their own start to end, so a shift without their times adds a shift but no hours). Pick someone and the side panel shows their **profile** (name, role, notes: edit a field and press Enter or leave it to save; Escape undoes) over their **activity** (the same figures in full, first and latest shift, and their latest shifts). Add people from the bar above the table. **Role decides who counts as a bartender** in a shift's totals: blank or *Bartender* does; anything else (Barback, Server…) doesn't, though their tips still count towards the shift. Renaming a person renames them on past shifts; removing someone who worked a shift only archives them (they keep their name on those shifts, and adding the name again brings them back).
- **Lists** are edited where they are used (on Location, Misc and Wage while a shift is open) and in the **Lists** group while browsing: **Locations**, **Misc types** (the other-income kinds: Cash, Venmo, Paycheck…; tips and wage aren't types) and **Wage rates** (your hourly rate over time, shown as ranges; changing one re-estimates every shift on and after its start date).
- Editing warns you if the shift changed somewhere else while it was open.
- **Delete** asks twice and is a soft delete. Edit a deleted shift and "Save and restore" brings it back.

## Log a shift from the command line
```
B=http://127.0.0.1:4200/api/v1
curl -X POST $B/locations -d '{"name":"Main Bar"}'                     # -> id (adding the same name again returns the same entry)
curl -X POST $B/employees -d '{"name":"Ana","role":"Bartender"}'      # -> id (role and notes are optional)

# You choose the shift's UUID, so retrying the same request never duplicates it.
curl -X PUT $B/shifts/$(uuidgen | tr A-Z a-z) -d '{
  "start_at": "2026-09-18T17:00", "end_at": "2026-09-19T01:00",
  "shift_type": "night",
  "breaks": [{"start_at": "2026-09-18T21:00", "end_at": "2026-09-18T21:30"}, {"minutes": 10}],
  "location_id": "<location id>",
  "employees": [{"employee_id": "<employee id>", "start_at": "2026-09-18T18:00", "end_at": "2026-09-19T00:00", "tips_cents": 9000}],
  "parties": [{"name": "Smith 40th", "guests": 40}],
  "tags": ["busy"],
  "money_entries": [
    {"value_cents": 21000},
    {"value_cents": 34550}
  ]}'

curl "$B/shifts?from=2026-09-01&to=2026-09-30"
```
Times have no zone, and are given together or left out together (a lone `start_at` or `end_at` is rejected). `shift_type` (`day` or `night`) and `work_date` are both independently optional, and nothing about a shift is required: an empty `{}` is a valid document. There is no `double` shift type; a shift that ran a day part into a night part is just two of these documents, one after the other. `breaks` is a list (empty is fine); each break is `start_at` + `end_at` or `minutes`, not both. `location_id` points at the locations list (`GET /locations`, `PATCH` renames, `DELETE` removes or archives). `employees` says who else worked the shift: each entry is an `employee_id` (from `/employees`, a real table with `name`, `role`, `notes`) and, all optional, `start_at` + `end_at` (both or neither) and `tips_cents`. `parties` is a list where every field (`name`, `guests`, `start_at` + `end_at`, `notes`) is optional: an empty `{}` is still a party. `GET /employees/summary` gives each person's shifts, hours and tips, worked out on every read. `GET /shifts` also filters by `?employee_id=` (shifts a person worked) and `?has_party=1|0`. An income entry is `{value_cents, category_id?}`; leave `category_id` out and it is Tips. Make other types with `POST /income-categories {"name":"Cash"}` and use the id it returns. Set your wage with `POST /wage-rates {"effective_from":"2026-01-01","rate_cents":1125}`; every shift then carries a read-only `derived` block: `paid_minutes`, `wage_rate_cents`, `estimated_wage_cents` (null until a rate applies, or with no times yet), `tips_cents`, `other_income_cents`, `total_income_cents` (tips + wage when there is one + other), and `tips_per_hour_cents`, `other_per_hour_cents`, `total_per_hour_cents` (over paid time, null when there is none), plus the staffing and party figures: `bartender_count` (you plus employees whose role is blank or Bartender), `bartender_minutes` (your paid time plus their start-to-end times), `staff_tips_cents` (everyone's tips, yours included), `staff_tips_per_bartender_hour_cents`, `has_party` and `party_count`. `derived` is worked out on each read, never stored, and can't be sent back. A shift needs no `job_id`; the venue and job endpoints still exist for wage rates and the importer but the form doesn't use them. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full shape.

## Backup, schema changes and import
```
npm run backup                                             # snapshot into data/backups/ (safe while running)
npm run import:brv8 -- <path/to/brv8/data/db.json> --dry-run
npm run import:brv8 -- <path/to/brv8/data/db.json>
```
- **Schema changes.** The schema is one file (`server/schema.sql`). When it changes, the server upgrades an older `data/bar.db` in place if there is a migration for it (v4 to v5, v5 to v6 and v6 to v7 have one: your existing tips become the built-in *Tips* type, the per-job wage rates become one hourly-wage history, and your coworkers become employees with every shift link kept) and first leaves a full copy beside it as `bar.v<version>-<time>.bak`. If there is no migration, it renames the file aside (`bar.v<version>-<time>.db`, untouched) and starts a new database. Either way nothing is lost. (Moving to v4 was the set-aside kind: that v3 file is still in `data/`.)
- **The import** is idempotent (re-running adds nothing) and takes a backup first if a database already exists. It uses brv8's recorded Day/Night/Double label and break for each shift, turns brv8's location into a locations-list entry, and imports tips only (other income from brv8 isn't imported yet, though the app now has types for it) and its wage history (as your one hourly-wage history); other income is counted and reported, not imported.
