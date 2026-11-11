# MTG Kindred Break Calculator

Live site: https://frodobagginses-shire.github.io/kindredbreak/

A single-page tool for planning and running Kindred (formerly "Tribal") breaks: build a roster of booster packs, Secret Lair drops and Commander precons, define priority-ordered spots (`Dragon`, `White Human`, `Snake/Snail`, `Enchantment !Creature !Legendary`), and get per-spot EV, star-tier spot labels and a live break tracker.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The deployed site. HTML and CSS are edited here directly; the inline `<script>` block is generated. |
| `js/scryfall.js` | Scryfall and MTGJSON loading, rate limiting, Secret Lair and precon data. |
| `js/booster-models.js` | Official-odds pack models for sets MTGJSON hasn't published yet. |
| `js/collation.js` | Pack simulation, EV distributions, generic fallback profiles. |
| `js/simulation.js` | Spot matching, EV by spot, seeding and auto-tabulate. |
| `js/app.js` | UI. |
| `js/sld-drops.json` | Secret Lair collector number to drop name lookup (from MTGJSON). |
| `js/demo-preload.json` | Frozen data for the "Load Demo Break" button. |
| `build.py` | Bundles `js/` into `index.html`. |
| `tools/update_sld_drops.py` | Regenerates `js/sld-drops.json` from MTGJSON. |

## Building

After editing anything in `js/`:

```bash
python3 build.py          # rebuild index.html (and js/app.bundle.js)
python3 build.py --check  # exit 1 if index.html is out of date with js/
```

To test locally, serve the folder over HTTP (browsers block Scryfall and MTGJSON calls from `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Where pack odds come from

Each roster row shows a badge for its pack model:

- **MTGJSON**: MTGJSON's booster sheets, the real WotC collation. Used whenever MTGJSON has published the set.
- **Official odds**: sheets rebuilt from Wizards' "Collecting <set>" article, for sets MTGJSON hasn't covered yet. Specs live in `js/booster-models.js`; the site switches to MTGJSON automatically once it publishes the set, after which the spec can be deleted.
- **Estimate**: a generic modern pack profile (`PACK_PROFILES` in `js/collation.js`) drawn from the set's main-set cards.

To add a set before MTGJSON has it, copy the `trk` entry in `js/booster-models.js`: define pools by Scryfall collector-number range, then list each slot's published percentages (`'rest'` for the main pool, `null` for Wizards' "less than 1%" lines).

## API etiquette

Scryfall limits `/cards/search`, `/cards/named`, `/cards/random` and `/cards/collection` to 2 requests a second (everything else to 10) and locks clients out for 30 seconds after a 429. All requests go through one throttle in `js/scryfall.js`. Scripts that call Scryfall directly must send a descriptive `User-Agent` and `Accept: application/json` and respect the same limits.

## Maintenance

A weekly scheduled check (Monday mornings) looks for new and upcoming sets, adds official-odds models where MTGJSON lags, audits newly published MTGJSON sheets against Wizards' odds, retires stale official-odds models, and refreshes Secret Lair drop names. When something needs changing it opens a pull request against `main`; merging the PR updates the live site.

Not affiliated with Wizards of the Coast, Scryfall, MTGJSON or TCGplayer.
