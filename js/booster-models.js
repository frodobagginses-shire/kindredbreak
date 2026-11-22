/**
 * Official-Odds Booster Models
 *
 * MTGJSON is the primary source of pack composition, but it usually publishes
 * booster sheets a few days to a few weeks after a set releases. Breaks happen
 * on release weekend, so for brand-new sets we build the same sheet model
 * from the odds Wizards publishes in its "Collecting <set>" article.
 *
 * The output of buildOfficialBoosterModel() has exactly the shape that
 * scryfall.js::fetchMtgjsonBooster() returns:
 *   { play: { variants, totalWeight, sheets: { name: { entries:[{card,weight,foil?}], totalWeight, foil } } },
 *     collector: { ... } }
 * so every EV, simulation, bulk and top-hit code path works unchanged.
 * Entries may carry their own `foil` flag when one slot mixes finishes
 * (e.g. Star Trek's Booster Fun slot holds both non-foil and foil Stardates).
 *
 * Precedence in app.js: MTGJSON (when it has booster data) > official model
 * here > generic PACK_PROFILES fallback. Once MTGJSON ships a set's sheets the
 * entry below stops being used automatically; it's safe to leave it in place.
 *
 * ── Spec format ──
 * pools:   name → { set, cn:[lo,hi], rarity?, lang?, type?, notType? }
 *          Cards are matched against Scryfall prints by collector number range
 *          (numeric prefix), plus optional rarity / language / type-line filters.
 * sheets:  name → { foil, items: [[poolName, pct, opts?], ...] }
 *          pct is the published chance (in %) that one pick from this sheet is
 *          a card from that pool. Use 'rest' for the main pool that absorbs
 *          whatever the listed treatments don't, and null for Wizards' "<1%"
 *          entries (see estimateUnknown below). For multi-pick slots Wizards
 *          quotes per-pack chances, so those are divided by the pick count in
 *          the spec. opts.foil overrides the sheet's finish for that pool.
 * boosters: name → [{ weight, contents: { sheetName: picks } }, ...]
 */

import { fetchSetCards } from './scryfall.js';

// Wizards lists many Booster Fun pools as "<1%". We split whatever share of
// the sheet the published numbers leave over among those pools, in proportion
// to card count, with mythic pools counting half per card (mythics are printed
// at roughly half the rate of rares). Each estimate is capped just under 1%.
const UNKNOWN_CAP_PCT = 0.95;
const UNKNOWN_FLOOR_PCT = 0.05;

// Empty while MTGJSON covers every new release. To add a set, follow the
// spec format above. The Star Trek (trk) entry is a full worked example (Play and
// Collector Booster, bonus sheet, Commander Booster Fun, mixed-finish slot);
// it was retired once MTGJSON published TRK and can be read with
//   git show d06bd4b:js/booster-models.js
export const OFFICIAL_BOOSTER_MODELS = {};

/** True when a hand-built official model exists for this set code. */
export function hasOfficialBoosterModel(setCode) {
  return !!OFFICIAL_BOOSTER_MODELS[String(setCode || '').toLowerCase()];
}

function collectorNumberValue(card) {
  const m = String(card.collector_number || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

function cardInPool(card, pool) {
  const n = collectorNumberValue(card);
  if (!(n >= pool.cn[0] && n <= pool.cn[1])) return false;
  if (pool.rarity && card.rarity !== pool.rarity) return false;
  if (pool.lang && card.lang !== pool.lang) return false;
  const tl = card.type_line || '';
  if (pool.type && !tl.includes(pool.type)) return false;
  if (pool.notType && tl.includes(pool.notType)) return false;
  return true;
}

function rarityFactorForPool(cards) {
  if (!cards.length) return 1;
  return cards[0].rarity === 'mythic' ? 0.5 : 1;
}

/**
 * Turn one sheet spec into concrete percentages per pool, filling 'rest' and
 * estimating null ("<1%") items. Pools that resolve to zero cards are dropped
 * and the sheet is renormalized, so a missing Scryfall range can't silently
 * inflate the others' share beyond their published odds by much.
 */
function resolveSheetPercents(items, poolCards) {
  const rows = items.map(([pool, pct, opts]) => ({
    pool, pct, opts: opts || {}, cards: poolCards[pool] || []
  })).filter(r => r.cards.length > 0);

  const known = rows.filter(r => typeof r.pct === 'number');
  const knownSum = known.reduce((s, r) => s + r.pct, 0);
  const rest = rows.filter(r => r.pct === 'rest');
  const unknown = rows.filter(r => r.pct === null);

  if (rest.length) {
    const share = Math.max(0, 100 - knownSum) / rest.length;
    for (const r of rest) r.pct = share;
    // Unknown items in a sheet with a 'rest' pool get the floor estimate.
    for (const r of unknown) r.pct = UNKNOWN_FLOOR_PCT;
  } else if (unknown.length) {
    const remainder = Math.max(0, 100 - knownSum);
    const units = unknown.map(r => r.cards.length * rarityFactorForPool(r.cards));
    const totalUnits = units.reduce((s, u) => s + u, 0) || 1;
    unknown.forEach((r, i) => {
      const est = remainder * units[i] / totalUnits;
      r.pct = Math.min(UNKNOWN_CAP_PCT, Math.max(UNKNOWN_FLOOR_PCT, est));
      r.estimated = true;
    });
  }
  return rows;
}

/**
 * Build a sheet model for `setCode` from OFFICIAL_BOOSTER_MODELS, resolving
 * pools against Scryfall card data. Resolves to null when no spec exists or
 * when the main set returned no cards. Cached per set for the session.
 */
const officialModelCache = new Map(); // code → Promise<model|null>

export function buildOfficialBoosterModel(setCode) {
  const code = String(setCode || '').toLowerCase();
  if (!OFFICIAL_BOOSTER_MODELS[code]) return Promise.resolve(null);
  if (!officialModelCache.has(code)) {
    const p = resolveOfficialModel(code).then(m => {
      if (!m) officialModelCache.delete(code); // let a later add retry
      return m;
    }, e => { officialModelCache.delete(code); throw e; });
    officialModelCache.set(code, p);
  }
  return officialModelCache.get(code);
}

async function resolveOfficialModel(code) {
  const spec = OFFICIAL_BOOSTER_MODELS[code];

  const cardsBySet = {};
  for (const s of spec.sets) {
    try {
      cardsBySet[s] = await fetchSetCards(s);
    } catch (e) {
      console.warn(`[OfficialModel] ${code}: could not load ${s}:`, e.message);
      cardsBySet[s] = [];
    }
  }
  if (!(cardsBySet[code] || []).length) return null;

  const poolCards = {};
  for (const [name, pool] of Object.entries(spec.pools)) {
    const list = (cardsBySet[pool.set] || []).filter(c => cardInPool(c, pool));
    // Same print can appear once per search page boundary; dedupe by id.
    const seen = new Set();
    poolCards[name] = list.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    if (!poolCards[name].length) console.warn(`[OfficialModel] ${code}: pool ${name} matched 0 cards`);
  }

  const sheets = {};
  for (const [sheetName, sheetSpec] of Object.entries(spec.sheets)) {
    const rows = resolveSheetPercents(sheetSpec.items, poolCards);
    const entries = [];
    for (const r of rows) {
      const perCard = r.pct / r.cards.length;
      const foil = r.opts.foil;
      for (const card of r.cards) {
        const e = { card, weight: perCard };
        if (typeof foil === 'boolean' && foil !== !!sheetSpec.foil) e.foil = foil;
        entries.push(e);
      }
    }
    const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
    sheets[sheetName] = { entries, totalWeight, foil: !!sheetSpec.foil };
  }

  const model = {};
  for (const [key, variants] of Object.entries(spec.boosters)) {
    const usedSheets = {};
    for (const v of variants) {
      for (const sn of Object.keys(v.contents)) usedSheets[sn] = sheets[sn];
    }
    model[key] = {
      variants: variants.map(v => ({ weight: v.weight, contents: { ...v.contents } })),
      totalWeight: variants.reduce((s, v) => s + v.weight, 0),
      sheets: usedSheets
    };
  }
  console.log(`[OfficialModel] Built ${spec.label} model from published odds: ${Object.keys(model).join(', ')}`);
  return model;
}

/** Short description of where a set's official model came from (for tooltips). */
export function officialModelSource(setCode) {
  const spec = OFFICIAL_BOOSTER_MODELS[String(setCode || '').toLowerCase()];
  return spec ? spec.source : null;
}
