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

export const OFFICIAL_BOOSTER_MODELS = {
  // ─── Magic: The Gathering | Star Trek (TRK) — releases 2026-11-13 ───
  // Source: magic.wizards.com/en/news/feature/collecting-star-trek
  // Scryfall numbering: TRK 1-306 main set (81 C + 10 common Planet duals,
  // 110 U, 80 R, 25 M), 307-316 full-art holodeck/away team basics,
  // 317-326 default basics, 332-337 borderless lands, 338-362 scene cards,
  // 363-391 LCARS frame, 392-401 LCARS shock lands, 402-425 classic
  // Enterprise, 426-435 Klingon frame, 436-445 Klingon script (foil only),
  // 446-481 extended art, 482-486 surge away team basics, 487-496 surge LCARS
  // shocks, 497-525 surge LCARS, 526-549 surge classic Enterprise.
  // SDS 1-30 Stardates (mythic). TRC 1-4 borderless commanders, 180-191 Scene
  // Box cards, 202-211 borderless new-to-Magic commander cards, 212-417
  // extended-art commander cards. Signed headliners (7 cards, <250 copies
  // each) are left out: their pull rate is far too small to move EV.
  trk: {
    label: 'Star Trek',
    source: "Wizards' Collecting Magic: The Gathering | Star Trek (Oct 2026)",
    sets: ['trk', 'sds', 'trc'],
    pools: {
      mainC:    { set: 'trk', cn: [1, 306], rarity: 'common', notType: 'Land — Planet' },
      dualC:    { set: 'trk', cn: [1, 306], rarity: 'common', type: 'Land — Planet' },
      mainU:    { set: 'trk', cn: [1, 306], rarity: 'uncommon' },
      mainR:    { set: 'trk', cn: [1, 306], rarity: 'rare' },
      mainM:    { set: 'trk', cn: [1, 306], rarity: 'mythic' },
      fullArtBasic: { set: 'trk', cn: [307, 316] },
      defaultBasic: { set: 'trk', cn: [317, 326] },
      blLandR:  { set: 'trk', cn: [332, 337], rarity: 'rare' },
      blLandM:  { set: 'trk', cn: [332, 337], rarity: 'mythic' },
      sceneU:   { set: 'trk', cn: [338, 362], rarity: 'uncommon' },
      sceneR:   { set: 'trk', cn: [338, 362], rarity: 'rare' },
      sceneM:   { set: 'trk', cn: [338, 362], rarity: 'mythic' },
      lcarsU:   { set: 'trk', cn: [363, 391], rarity: 'uncommon' },
      lcarsR:   { set: 'trk', cn: [363, 391], rarity: 'rare' },
      lcarsM:   { set: 'trk', cn: [363, 391], rarity: 'mythic' },
      lcarsShock: { set: 'trk', cn: [392, 401] },
      ceU:      { set: 'trk', cn: [402, 425], rarity: 'uncommon' },
      ceR:      { set: 'trk', cn: [402, 425], rarity: 'rare' },
      ceM:      { set: 'trk', cn: [402, 425], rarity: 'mythic' },
      klingonC: { set: 'trk', cn: [426, 435], rarity: 'common' },
      klingonU: { set: 'trk', cn: [426, 435], rarity: 'uncommon' },
      klingonR: { set: 'trk', cn: [426, 435], rarity: 'rare' },
      scriptC:  { set: 'trk', cn: [436, 445], rarity: 'common' },
      scriptU:  { set: 'trk', cn: [436, 445], rarity: 'uncommon' },
      scriptR:  { set: 'trk', cn: [436, 445], rarity: 'rare' },
      extR:     { set: 'trk', cn: [446, 481], rarity: 'rare' },
      extM:     { set: 'trk', cn: [446, 481], rarity: 'mythic' },
      surgeAwayTeam:   { set: 'trk', cn: [482, 486] },
      surgeLcarsShock: { set: 'trk', cn: [487, 496] },
      surgeLcarsU: { set: 'trk', cn: [497, 525], rarity: 'uncommon' },
      surgeLcarsR: { set: 'trk', cn: [497, 525], rarity: 'rare' },
      surgeLcarsM: { set: 'trk', cn: [497, 525], rarity: 'mythic' },
      surgeCeU:    { set: 'trk', cn: [526, 549], rarity: 'uncommon' },
      surgeCeR:    { set: 'trk', cn: [526, 549], rarity: 'rare' },
      surgeCeM:    { set: 'trk', cn: [526, 549], rarity: 'mythic' },
      stardates:   { set: 'sds', cn: [1, 30] },
      trcBlCommander: { set: 'trc', cn: [1, 4] },
      trcSceneBox:    { set: 'trc', cn: [180, 191] },
      trcBlNewR:      { set: 'trc', cn: [202, 211], rarity: 'rare' },
      trcBlNewM:      { set: 'trc', cn: [202, 211], rarity: 'mythic' },
      trcExtR:        { set: 'trc', cn: [212, 417], rarity: 'rare' },
      trcExtM:        { set: 'trc', cn: [212, 417], rarity: 'mythic' }
    },
    sheets: {
      // ── Play Booster ──
      // 6-7 commons: Klingon frame common shows up in 2.9% of packs (7 picks).
      common: { foil: false, items: [
        ['klingonC', 2.9 / 7],
        ['mainC', 'rest']
      ] },
      // 3 uncommons: per-pack chances below, divided across the 3 picks.
      uncommon: { foil: false, items: [
        ['sceneU', 7.7 / 3],
        ['lcarsU', 4.6 / 3],
        ['ceU', 4.6 / 3],
        ['klingonU', 5 / 3],
        ['mainU', 'rest']
      ] },
      wildcard: { foil: false, items: [
        ['mainC', 20.8], ['mainU', 54.1], ['mainR', 16.7], ['mainM', 2.6],
        ['klingonC', null], ['klingonU', 1], ['klingonR', null],
        ['sceneU', 1.5], ['sceneR', null], ['sceneM', null],
        ['lcarsU', 1], ['lcarsR', null], ['lcarsM', null],
        ['ceR', null], ['ceM', null],
        ['blLandR', null], ['blLandM', null],
        ['lcarsShock', null]
      ] },
      rareMythic: { foil: false, items: [
        ['mainR', 80.1], ['mainM', 12.4],
        ['klingonR', null],
        ['sceneR', 1], ['sceneM', null],
        ['lcarsR', 1.8], ['lcarsM', null],
        ['ceR', 1.5], ['ceM', null],
        ['blLandR', 1], ['blLandM', null],
        ['lcarsShock', 1.4]
      ] },
      foil: { foil: true, items: [
        ['mainC', 51.2], ['mainU', 34.7], ['mainR', 6.3], ['mainM', 1],
        ['klingonC', null], ['klingonU', 1], ['klingonR', null],
        ['sceneU', 1.6], ['sceneR', null], ['sceneM', null],
        ['lcarsU', 1.1], ['lcarsR', null], ['lcarsM', null],
        ['ceR', null], ['ceM', null],
        ['blLandR', null], ['blLandM', null],
        ['lcarsShock', null]
      ] },
      // Land slot: 50% common dual, 33.3% default basic, 16.7% holodeck/away
      // team (full-art) basic. 20% of packs have the land in traditional foil.
      nonFoilLand: { foil: false, items: [
        ['dualC', 50], ['defaultBasic', 33.3], ['fullArtBasic', 16.7]
      ] },
      foilLand: { foil: true, items: [
        ['dualC', 50], ['defaultBasic', 33.3], ['fullArtBasic', 16.7]
      ] },
      // Replaces a common in 1 of 25 Play Boosters.
      stardatesPlay: { foil: false, items: [['stardates', 100]] },

      // ── Collector Booster ──
      cbFoilCommon: { foil: true, items: [['mainC', 89], ['dualC', 11]] },
      cbFoilUncommon: { foil: true, items: [['mainU', 100]] },
      cbFoilCUBoosterFun: { foil: true, items: [
        ['klingonC', 2.7], ['klingonU', 16.1],
        ['scriptC', 1.4], ['scriptU', 8.1],
        ['sceneU', 26.9],
        ['lcarsU', 18.9], ['ceU', 13.5],
        ['surgeLcarsU', 7.3], ['surgeCeU', 5.2]
      ] },
      cbFoilLand: { foil: true, items: [
        ['fullArtBasic', 66.7], ['surgeAwayTeam', 33.3]
      ] },
      cbFoilRareMythic: { foil: true, items: [['mainR', 86.5], ['mainM', 13.5]] },
      cbCommanderBoosterFun: { foil: false, items: [
        ['trcExtR', 93.1], ['trcExtM', 2.1],
        ['trcBlCommander', 1],
        ['trcBlNewR', 2.8], ['trcBlNewM', 1]
      ] },
      cbBoosterFun: { foil: false, items: [
        ['klingonR', 1.9],
        ['sceneR', 4.2], ['sceneM', 1.7],
        ['trcSceneBox', 4.6],
        ['lcarsR', 10.4], ['lcarsM', 2.3],
        ['lcarsShock', 7.7],
        ['blLandR', 3.5], ['blLandM', null],
        ['ceR', 8.5], ['ceM', 2.1],
        ['extR', 21.5], ['extM', 3.1],
        ['stardates', 23.1],
        ['stardates', 5, { foil: true }]
      ] },
      // Wizards' published lines for this slot add up to 96%; the sheet is
      // renormalized, so each listed pool is scaled up proportionally.
      cbFoilBoosterFun: { foil: true, items: [
        ['klingonR', 2.2], ['scriptR', 2.7],
        ['sceneR', 4.9], ['sceneM', 2],
        ['lcarsR', 12], ['lcarsM', 2.7],
        ['lcarsShock', 8.9],
        ['surgeLcarsR', 3.2], ['surgeLcarsM', 1],
        ['surgeLcarsShock', 4.6],
        ['ceR', 9.8], ['ceM', 2.4],
        ['surgeCeR', 3], ['surgeCeM', 1],
        ['extR', 24.9], ['extM', 3.6],
        ['trcBlNewR', 5.3], ['trcBlNewM', 1.8]
      ] }
    },
    boosters: {
      play: [
        // 24/25 packs: 7 commons. 1/25: 6 commons + a Stardates card.
        // 4/5 packs: non-foil land. 1/5: traditional foil land.
        { weight: 96, contents: { common: 7, uncommon: 3, wildcard: 1, rareMythic: 1, foil: 1, nonFoilLand: 1 } },
        { weight: 24, contents: { common: 7, uncommon: 3, wildcard: 1, rareMythic: 1, foil: 1, foilLand: 1 } },
        { weight: 4,  contents: { common: 6, stardatesPlay: 1, uncommon: 3, wildcard: 1, rareMythic: 1, foil: 1, nonFoilLand: 1 } },
        { weight: 1,  contents: { common: 6, stardatesPlay: 1, uncommon: 3, wildcard: 1, rareMythic: 1, foil: 1, foilLand: 1 } }
      ],
      collector: [
        { weight: 1, contents: {
          cbFoilCommon: 5, cbFoilUncommon: 3, cbFoilCUBoosterFun: 1, cbFoilLand: 1,
          cbFoilRareMythic: 1, cbCommanderBoosterFun: 1, cbBoosterFun: 2, cbFoilBoosterFun: 1
        } }
      ]
    }
  }
};

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
