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

- **Shifts:** newest first, one compact row each (about 50 px): the **date** (with the shift-type badge, a **Party** badge when the shift had one, and the location), **time worked** (the hours, leading; when the shift ran is the detail underneath), then **Tips**, **Wage** (estimated; its per-hour is your rate), **Other**, **Total income** (tips + wage + other) and **Bartenders** (you plus the employees on the shift who are bartenders: the count, their combined hours, and under it the tips made by everyone on the shift). Amounts and per-hour figures are **rounded to whole dollars in the table; hover any of them for the exact cents**. Every per-hour figure is over hours worked (the shift's length minus its breaks). A dash means nothing was entered. Hovering a row's date gives its crew, tags, notes and party. On the right of each row are three icon buttons: **edit** (pencil), **raw data** (`<>`) and **delete** (bin; asks twice: the first click turns it into a red *Delete?* for four seconds; it is a soft delete). Clicking elsewhere on a row does nothing. "Show deleted" reveals soft-deleted shifts, which can be edited and restored from the form.
- **Live feed:** every create, update, delete and purge as it happens, with row counts in the header.
- **Anything that writes to the database shows up**, including the import script and `sqlite3`, not just API calls.
- With `API_TOKEN` set, the page asks for the token once and remembers it in that browser.
- It works at phone width too (the shift form becomes a bottom sheet), so you can leave it open on your phone over Tailscale or a cloud host. It follows your light or dark setting.
- The look lives in [dashboard/styles.css](dashboard/styles.css): Poppins, served by the app itself (no request ever leaves your machine), with spacing, type sizes and colours as tokens at the top of the file.

**Adding and editing shifts:** click **+ New shift**, or **Edit** on any row. The form is one short page in sections, in the order you'd fill it in:

1. **Date** (with *Today* and *Yesterday* buttons).
2. **Time:** start and end, then **any number of breaks** (none is fine). Each break is a start and end time, or switch it to **just a length in minutes**. Breaks have to fall inside the shift, can't overlap, and together can't be longer than it. An end at or before the start means the shift ends the next day (it says so). Times are the clock on the wall, with no timezone.
3. **Type:** **Day**, **Night** or **Double**. It's required and never guessed, so choose one.
4. **Tips** (the primary income): a plain dollar amount (`210`, `345.50`, `$1,234.56`); add as many entries as you need. On a Day or Night shift every entry belongs to it. On a **Double**, each entry also says **Day**, **Night**, or **Combined**.
5. **Wage:** not an input. It's worked out live from the date, times and breaks and your hourly wage: paid time (the shift's length minus its breaks, which are unpaid) × the rate in effect that day. Your **wage rates** are on the same page, as date ranges (a rate applies from its start date until the day before the next one starts), with the range that applies to this shift marked; with none set it says so.
6. **Misc:** other income, as entries with a **type** you choose (Cash, Venmo, Paycheck…), same amount format and same Day / Night / Combined choice on a double. Add and rename the types in **Misc types**, further down the same page.
7. **Location:** tap one from your list, or type it (it autocompletes). A name that isn't on the list yet is added to it when you save. Your list of locations (add, rename, remove) is on the same page.
8. **Party:** tick *A party happened during this shift* if one did. Every detail is optional (name, guests, start and end, notes, and you can add more than one) and is entered in the **Party** tab, where each party's block appears as soon as you tick the box; the yes or no is what shows up when you compare shifts (the **Party** badge, and `has_party` in the API).
9. **Employees on this shift:** tap the people who worked it, or type a name and press Enter (a new name is added to your employees). Each person on the shift gets a one-line row on the form (their times and tips in a few words); tap it and the **Crew** tab shows, beside the list, their **start, end and tips they made** (all optional; times start as yours) and their **role**, which is saved as you change it. Under the rows, a live line shows the bartender count and hours and the staff tips total.
10. **Notes** and tags.

A new shift starts with the time and location of your last one. There is no venue or job to fill in.

**Nothing pops up, and it isn't one long scroll.** The page is two panels. On the left is tabbed navigation in section groups; on the right is the full input for the page you picked. While browsing, the groups are **Browse** (Shifts, Live feed) and **Lists** (Locations, Misc types, Wage rates), where the same three lists can be edited without opening a shift. While a shift is open they are:

| group | pages |
|---|---|
| **Info** | Date · Time (start, end, breaks) · Type |
| **Income** | Tips · Wage · Misc |
| **Details** | Location · Crew · Party · Notes |

Each page is its own tab with a live summary beside its name ("Mon, Sep 21", "$200", "1 person · 2 bartenders"), and a red dot when a field on it needs fixing (Save takes you to the first one). Every page also has **Back** and **Next** to walk through the shift in order. **Save shift**, **Cancel** and **Delete** stay at the foot of the left panel. The lists a shift draws on are not a group of their own while you edit: each is on the page it feeds (locations on Location, misc types on Misc, wage rates on Wage), so adding one mid-shift loses nothing. On a phone the tabs become one scrolling row across the top and Save/Cancel a bar along the bottom.

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
  "start_at": "2026-09-18T11:00", "end_at": "2026-09-18T21:30",
  "shift_type": "double",
  "breaks": [{"start_at": "2026-09-18T15:00", "end_at": "2026-09-18T15:30"}, {"minutes": 10}],
  "location_id": "<location id>",
  "employees": [{"employee_id": "<employee id>", "start_at": "2026-09-18T12:00", "end_at": "2026-09-18T20:00", "tips_cents": 9000}],
  "parties": [{"name": "Smith 40th", "guests": 40}],
  "tags": ["busy"],
  "money_entries": [
    {"value_cents": 21000, "part": "day"},
    {"value_cents": 34550, "part": "night"}
  ]}'

curl "$B/shifts?from=2026-09-01&to=2026-09-30"
```
Times have no zone. `shift_type` (`day`, `night` or `double`) is required. `breaks` is a list (empty is fine); each break is `start_at` + `end_at` or `minutes`, not both. `location_id` points at the locations list (`GET /locations`, `PATCH` renames, `DELETE` removes or archives). `employees` says who else worked the shift: each entry is an `employee_id` (from `/employees`, a real table with `name`, `role`, `notes`) and, all optional, `start_at` + `end_at` (both or neither) and `tips_cents`. `parties` is a list where every field (`name`, `guests`, `start_at` + `end_at`, `notes`) is optional: an empty `{}` is still a party. `GET /employees/summary` gives each person's shifts, hours and tips, worked out on every read. `GET /shifts` also filters by `?employee_id=` (shifts a person worked) and `?has_party=1|0`. An income entry is `{value_cents, category_id?, part?}`; leave `category_id` out and it is Tips. Make other types with `POST /income-categories {"name":"Cash"}` and use the id it returns. Set your wage with `POST /wage-rates {"effective_from":"2026-01-01","rate_cents":1125}`; every shift then carries a read-only `derived` block: `paid_minutes`, `wage_rate_cents`, `estimated_wage_cents` (null until a rate applies), `tips_cents`, `other_income_cents`, `total_income_cents` (tips + wage when there is one + other), and `tips_per_hour_cents`, `other_per_hour_cents`, `total_per_hour_cents` (over paid time, null when there is none), plus the staffing and party figures: `bartender_count` (you plus employees whose role is blank or Bartender), `bartender_minutes` (your paid time plus their start-to-end times), `staff_tips_cents` (everyone's tips, yours included), `staff_tips_per_bartender_hour_cents`, `has_party` and `party_count`. `derived` is worked out on each read, never stored, and can't be sent back. A shift needs no `job_id`; the venue and job endpoints still exist for wage rates and the importer but the form doesn't use them. On a double, a tips entry's `part` is `day`, `night`, or `null` for combined / not sure; on a day or night shift leave it out. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full shape.

## Backup, schema changes and import
```
npm run backup                                             # snapshot into data/backups/ (safe while running)
npm run import:brv8 -- <path/to/brv8/data/db.json> --dry-run
npm run import:brv8 -- <path/to/brv8/data/db.json>
```
- **Schema changes.** The schema is one file (`server/schema.sql`). When it changes, the server upgrades an older `data/bar.db` in place if there is a migration for it (v4 to v5, v5 to v6 and v6 to v7 have one: your existing tips become the built-in *Tips* type, the per-job wage rates become one hourly-wage history, and your coworkers become employees with every shift link kept) and first leaves a full copy beside it as `bar.v<version>-<time>.bak`. If there is no migration, it renames the file aside (`bar.v<version>-<time>.db`, untouched) and starts a new database. Either way nothing is lost. (Moving to v4 was the set-aside kind: that v3 file is still in `data/`.)
- **The import** is idempotent (re-running adds nothing) and takes a backup first if a database already exists. It uses brv8's recorded Day/Night/Double label and break for each shift, turns brv8's location into a locations-list entry, and imports tips only (other income from brv8 isn't imported yet, though the app now has types for it) and its wage history (as your one hourly-wage history); other income is counted and reported, not imported.
