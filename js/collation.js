/**
 * Pack Collation Engine
 * Defines pack profiles and generates simulated pack openings
 * based on real slot distributions for each booster type.
 *
 * Double-Digi edition: also handles Secret Lair Drop "envelopes",
 * which are deterministic (the drop's known card list is the output).
 */

import { getCardPrice } from './scryfall.js';

/**
 * Top-level product dispatcher used by simulation.js::simulateBreak.
 * Routes entries by productType:
 *   'booster'           → entry.mtgjsonBooster sheet model (MTGJSON, official odds or
 *                         generic profile — see entry.modelSource), else generic simulatePack()
 *   'secret_lair'       → simulateSecretLairDrop()
 *   'commander_precon'  → simulateCommanderPrecon()
 */
export function simulateProduct(entry) {
  if (!entry) return [];
  if (entry.productType === 'secret_lair') return simulateSecretLairDrop(entry);
  if (entry.productType === 'commander_precon') return simulateCommanderPrecon(entry);
  if (entry.mtgjsonBooster) {
    const sim = simulatePackFromMtgjson(entry.mtgjsonBooster, entry.boosterType);
    if (sim) return sim;
  }
  return simulatePack(entry.boosterType, entry.cards, entry.subsetCards || []);
}

// MTGJSON uses lower-case keys; map our user-facing pack-type names.
// Official-odds models (booster-models.js) use the same keys.
export const MTGJSON_BOOSTER_KEYS = {
  'Play Booster': 'play',
  'Collector Booster': 'collector',
  'Draft Booster': 'draft',
  'Set Booster': 'set',
  // One per sealed box (e.g. The Hobbit's foil Middle-earth classic artist
  // card). Only offered in the pack dropdown when the set's model has it.
  'Box Topper': 'box-topper',
  // Marvel Super Heroes Jumpstart packs. MTGJSON now publishes MSH's
  // 'jumpstart' booster (51 fixed 20-card themes), which this key routes to.
  // The fallback profile below only runs if that data is unavailable.
  'Marvel Jumpstart Booster': 'jumpstart'
};

function pickWeighted(items, totalWeight, weightFn) {
  if (!items || items.length === 0) return null;
  const tw = totalWeight || items.reduce((s, x) => s + weightFn(x), 0);
  if (tw <= 0) return items[0];
  let r = Math.random() * tw;
  for (const it of items) {
    const w = weightFn(it);
    if (r < w) return it;
    r -= w;
  }
  return items[items.length - 1];
}

/** Finish of one sheet entry: entries may override their sheet's finish. */
function entryIsFoil(entry, sheet) {
  return typeof entry.foil === 'boolean' ? entry.foil : !!sheet.foil;
}

/**
 * Draw `count` entries from a sheet, following MTGJSON's sheet semantics:
 *   - fixed sheets (echoed pairs, Jumpstart theme decks) always yield the same
 *     cards, each repeated `weight` times;
 *   - otherwise cards are drawn by weight, without repeating a card within one
 *     pack unless the sheet sets allowDuplicates (MTGJSON's default is no
 *     duplicates, which is how real collation works).
 */
function drawFromSheet(sheet, count) {
  const entries = sheet.entries || [];
  if (!entries.length || count <= 0) return [];
  if (sheet.fixed) {
    const out = [];
    for (const e of entries) {
      const copies = Math.max(1, Math.round(e.weight));
      for (let i = 0; i < copies && out.length < count; i++) out.push(e);
    }
    return out;
  }
  const withReplacement = sheet.allowDuplicates || count > entries.length;
  if (withReplacement) {
    const tw = entries.reduce((s, e) => s + e.weight, 0);
    const out = [];
    for (let i = 0; i < count; i++) {
      const e = pickWeighted(entries, tw, en => en.weight);
      if (e) out.push(e);
    }
    return out;
  }
  const pool = entries.slice();
  let tw = pool.reduce((s, e) => s + e.weight, 0);
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    let r = Math.random() * tw;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      if (r < pool[j].weight) { idx = j; break; }
      r -= pool[j].weight;
    }
    const [e] = pool.splice(idx, 1);
    tw -= e.weight;
    out.push(e);
  }
  return out;
}

/**
 * Simulate a pack using a sheet-based booster model (MTGJSON's authoritative
 * definition, or an official-odds model with the same shape). Picks one
 * variant by weight, then draws each (sheet, count) pair in the variant.
 *
 * Returns the same shape as simulatePack:
 *   [{ card, isFoil, slotType, price }, ...]
 * or null if the requested boosterType isn't in the model.
 */
export function simulatePackFromMtgjson(mtgjsonBooster, boosterType) {
  const key = MTGJSON_BOOSTER_KEYS[boosterType];
  if (!key) return null;
  const def = mtgjsonBooster[key];
  if (!def || !def.variants || def.variants.length === 0) return null;

  const variant = pickWeighted(def.variants, def.totalWeight, v => v.weight);
  if (!variant) return null;

  const out = [];
  for (const [sheetName, count] of Object.entries(variant.contents || {})) {
    const sheet = def.sheets[sheetName];
    if (!sheet || !sheet.entries.length) continue;
    for (const e of drawFromSheet(sheet, count)) {
      if (!e || !e.card) continue;
      const isFoil = entryIsFoil(e, sheet);
      out.push({
        card: e.card,
        isFoil,
        slotType: sheetName,
        price: getCardPrice(e.card, isFoil)
      });
    }
  }
  return out;
}

/** True when the model can produce packs of this type. */
export function boosterModelHasType(mtgjsonBooster, boosterType) {
  const key = MTGJSON_BOOSTER_KEYS[boosterType];
  const def = key && mtgjsonBooster ? mtgjsonBooster[key] : null;
  return !!(def && def.variants && def.variants.length);
}

/**
 * Expected-count distribution of every card a pack of this type can contain.
 * Returns [{ card, probability, isFoil }, ...], one row per (print, finish).
 *
 *   E[copies of card C] = Σ over sheets s: E[picks from s] × weight(C in s) / totalWeight(s)
 *   E[picks from s]     = Σ over variants v: P(v) × count_s(v)
 *
 * Aggregating per sheet first (instead of per variant) gives the identical
 * result but stays fast for sets like Reality Fracture, whose Play Booster has
 * 232 variants. `probability` is an expected count (it equals the chance of
 * at least one copy for single-pick slots), which is what EV sums need.
 *
 * Results are cached per model object; models never change after loading.
 */
const distributionCache = new WeakMap(); // def → { all, rm }

function computeDistribution(def) {
  const picks = new Map();
  const tw = def.totalWeight || def.variants.reduce((s, v) => s + v.weight, 0) || 1;
  for (const v of def.variants) {
    const pVar = v.weight / tw;
    if (pVar <= 0) continue;
    for (const [sn, count] of Object.entries(v.contents || {})) {
      picks.set(sn, (picks.get(sn) || 0) + pVar * count);
    }
  }
  const merged = new Map();
  for (const [sn, expectedPicks] of picks) {
    const sheet = def.sheets[sn];
    if (!sheet || !sheet.totalWeight || !sheet.entries) continue;
    for (const e of sheet.entries) {
      if (!e.card) continue;
      const isFoil = entryIsFoil(e, sheet);
      const probability = expectedPicks * (e.weight / sheet.totalWeight);
      if (!(probability > 0)) continue;
      const k = `${e.card.id || `${e.card.set}|${e.card.collector_number}|${e.card.name}`}|${isFoil ? 'f' : 'n'}`;
      const row = merged.get(k);
      if (row) row.probability += probability;
      else merged.set(k, { card: e.card, probability, isFoil });
    }
  }
  const all = [...merged.values()];
  const rm = all.filter(d => d.card.rarity === 'rare' || d.card.rarity === 'mythic');
  return { all, rm };
}

function distributionFor(mtgjsonBooster, boosterType) {
  const key = MTGJSON_BOOSTER_KEYS[boosterType];
  if (!key || !mtgjsonBooster) return null;
  const def = mtgjsonBooster[key];
  if (!def || !def.variants || def.variants.length === 0) return null;
  let cached = distributionCache.get(def);
  if (!cached) {
    cached = computeDistribution(def);
    distributionCache.set(def, cached);
  }
  return cached;
}

/**
 * All cards regardless of rarity. Used to compute total expected pack value
 * including Bulk (C/U). Treat the returned array as read-only (it's cached).
 */
export function getAllCardDistributionFromMtgjson(mtgjsonBooster, boosterType) {
  const d = distributionFor(mtgjsonBooster, boosterType);
  return d ? d.all : null;
}

/** Rare and mythic cards only. Treat the returned array as read-only (it's cached). */
export function getRareMythicDistributionFromMtgjson(mtgjsonBooster, boosterType) {
  const d = distributionFor(mtgjsonBooster, boosterType);
  return d ? d.rm : null;
}

/**
 * Open a Secret Lair Drop envelope.
 * Deterministic — every card listed in the drop comes out exactly once.
 * Finish ('nonfoil' | 'foil' | 'etched') is applied uniformly per the
 * user's selection. The legacy `foil` boolean is also supported for
 * backward compatibility.
 */
export function simulateSecretLairDrop(entry) {
  const cards = entry.dropCards || [];
  const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
  return cards.map(card => ({
    card,
    isFoil: finish !== 'nonfoil',
    finish,
    slotType: 'secret_lair',
    price: getCardPrice(card, finish)
  }));
}

/**
 * Open a Commander precon deck.
 * Deterministic — every card in the deck list comes out exactly once
 * per copy. Each entry carries an `isFoil` hint from MTGJSON for the
 * face-cards (commander, foil reprints).
 */
export function simulateCommanderPrecon(entry) {
  const cards = entry.deckCards || [];
  return cards.map(card => {
    const isFoil = !!card.__isFoil;
    return {
      card,
      isFoil,
      finish: isFoil ? 'foil' : 'nonfoil',
      slotType: 'commander_precon',
      price: getCardPrice(card, isFoil)
    };
  });
}

// ─── Generic fallback profiles ───
//
// Used only when a set has neither MTGJSON booster sheets nor an official-odds
// model in booster-models.js (typically a brand-new set in the days before
// MTGJSON catches up). Each profile is turned into the same sheet model the
// MTGJSON path uses (see buildGenericBoosterModel), so simulation, R/M EV and
// Bulk EV all go through one code path.
//
// Slot kinds:
//   common, uncommon            main-set C / U
//   rareMythic                  main-set R/M at 7:1
//   wildcard                    main-set card of any rarity, by `weights`
//   foilWildcard                same, traditional foil
//   land, foilLand              basic land (falls back to a common)
//   foilCommon, foilUncommon, foilRareMythic
//   boosterFun, foilBoosterFun  R/M Booster Fun print (borderless, showcase,
//                               extended art...), falls back to main-set R/M
//
// Rates are calibrated to 2026 Play/Collector Boosters (The Hobbit, Reality
// Fracture, Marvel Super Heroes, Star Trek): about 1.28 R/M per Play Booster
// and exactly 5 R/M per Collector Booster.

const PACK_PROFILES = {
  'Play Booster': {
    totalCards: 14,
    slots: [
      { kind: 'common', count: 7 },
      { kind: 'uncommon', count: 3 },
      { kind: 'wildcard', count: 1, weights: { common: 0.45, uncommon: 0.355, rare: 0.17, mythic: 0.025 } },
      { kind: 'rareMythic', count: 1 },
      { kind: 'foilWildcard', count: 1, weights: { common: 0.56, uncommon: 0.36, rare: 0.07, mythic: 0.01 } },
      { kind: 'land', count: 1 }
    ],
    // A bonus-sheet card (Special Guests etc.) replaces one common in ~2% of packs.
    subset: { chance: 0.02, replaces: 'common', foil: false }
  },

  'Draft Booster': {
    totalCards: 15,
    slots: [
      { kind: 'common', count: 10 },
      { kind: 'uncommon', count: 3 },
      { kind: 'rareMythic', count: 1 },
      { kind: 'land', count: 1 }
    ]
  },

  'Set Booster': {
    totalCards: 12,
    slots: [
      { kind: 'common', count: 3 },
      { kind: 'uncommon', count: 3 },
      { kind: 'rareMythic', count: 1 },
      { kind: 'wildcard', count: 2, weights: { common: 0.40, uncommon: 0.30, rare: 0.25, mythic: 0.05 } },
      { kind: 'foilWildcard', count: 1, weights: { common: 0.45, uncommon: 0.35, rare: 0.17, mythic: 0.03 } },
      { kind: 'land', count: 1 }
    ],
    subset: { chance: 0.04, replaces: 'common', foil: false }
  },

  'Collector Booster': {
    totalCards: 15,
    slots: [
      { kind: 'foilCommon', count: 5 },
      { kind: 'foilUncommon', count: 4 },
      { kind: 'foilLand', count: 1 },
      { kind: 'foilRareMythic', count: 2 },
      { kind: 'boosterFun', count: 2, weights: { rare: 0.8, mythic: 0.2 } },
      { kind: 'foilBoosterFun', count: 1, weights: { rare: 0.8, mythic: 0.2 } }
    ],
    subset: { chance: 0.05, replaces: 'foilCommon', foil: true }
  },

  // One foil Booster Fun card per sealed box. Only offered when a set's real
  // model has a box topper; this profile just keeps card counts sensible.
  'Box Topper': {
    totalCards: 1,
    slots: [
      { kind: 'foilBoosterFun', count: 1, weights: { rare: 0.5, mythic: 0.5 } }
    ]
  },

  // Marvel Super Heroes Jumpstart: 20-card themed packs, about 1 R/M + 4 U +
  // 15 C. MTGJSON now publishes the real theme lists (routed via
  // MTGJSON_BOOSTER_KEYS), so this only runs if that data can't be loaded.
  'Marvel Jumpstart Booster': {
    totalCards: 20,
    slots: [
      { kind: 'common', count: 15 },
      { kind: 'uncommon', count: 4 },
      { kind: 'rareMythic', count: 1 }
    ]
  }
};

/**
 * Get the pack profile for a given booster type.
 */
export function getPackProfile(boosterType) {
  return PACK_PROFILES[boosterType] || null;
}

/**
 * Get total card count for a booster type.
 */
export function getPackCardCount(boosterType) {
  const profile = PACK_PROFILES[boosterType];
  if (!profile) return 0;
  return profile.slots.reduce((sum, s) => sum + s.count, 0);
}

// Scryfall markers for prints that aren't the plain main-set version.
const BOOSTER_FUN_FRAME_EFFECTS = new Set([
  'showcase', 'extendedart', 'inverted', 'etched', 'shatteredglass', 'fullart'
]);
const NON_MAIN_PROMO_TYPES = new Set([
  'boosterfun', 'surgefoil', 'galaxyfoil', 'textured', 'halofoil', 'serialized',
  'confettifoil', 'raisedfoil', 'fracturefoil', 'gilded', 'stepandcompleat',
  'oilslick', 'neonink', 'headliner', 'boxtopper', 'bundle', 'poster',
  'gleaminggold', 'doublerainbow', 'rainbowfoil', 'silverfoil', 'ripplefoil',
  'dragonscalefoil', 'singularityfoil', 'cosmicfoil', 'manafoil', 'invisibleink',
  'embossed', 'prerelease', 'promopack', 'buyabox', 'setpromo', 'datestamped',
  'beginnerbox', 'starterdeck', 'playpromo', 'release', 'draftweekend'
]);

// Never drawn by the generic profile: serialized and headliner chase cards,
// box toppers, bundle/prerelease/promo-pack exclusives. Their odds are tiny
// or zero, so spreading a Booster Fun slot evenly over them would let one
// $1,000 card dominate the estimate.
const OUT_OF_PACK_PROMO_TYPES = new Set([
  'serialized', 'headliner', 'gleaminggold', 'doublerainbow', 'boxtopper',
  'bundle', 'prerelease', 'promopack', 'buyabox', 'setpromo', 'datestamped',
  'beginnerbox', 'starterdeck', 'playpromo', 'release', 'draftweekend'
]);

function isOutOfPackPrint(card) {
  return !!card.promo || (card.promo_types || []).some(t => OUT_OF_PACK_PROMO_TYPES.has(t));
}

function isBasicLand(card) {
  return /\bBasic\b/.test(card.type_line || '') && /\bLand\b/.test(card.type_line || '');
}

/** True for alternate prints: borderless, showcase, extended art, surge foil, non-English... */
export function isBoosterFunPrint(card) {
  if (!card) return false;
  if (card.lang && card.lang !== 'en') return true;
  if (card.promo) return true;
  if (card.border_color === 'borderless') return true;
  if ((card.frame_effects || []).some(f => BOOSTER_FUN_FRAME_EFFECTS.has(f))) return true;
  if ((card.promo_types || []).some(t => NON_MAIN_PROMO_TYPES.has(t))) return true;
  if (card.full_art && !isBasicLand(card)) return true;
  return false;
}

function cardsByRarity(cards, rarity) {
  if (!cards || !Array.isArray(cards)) return [];
  return cards.filter(c => c && c.rarity === rarity);
}

function genericPools(setCards, subsetCards) {
  const all = (setCards || []).filter(Boolean);
  const main = all.filter(c => !isBoosterFunPrint(c));
  const basics = main.filter(isBasicLand);
  const mainNonBasic = main.filter(c => !isBasicLand(c));
  const fun = all.filter(c => isBoosterFunPrint(c) && !isOutOfPackPrint(c));
  const sub = (subsetCards || []).filter(c => c && (c.rarity === 'rare' || c.rarity === 'mythic'));
  return {
    common: cardsByRarity(mainNonBasic, 'common'),
    uncommon: cardsByRarity(mainNonBasic, 'uncommon'),
    rare: cardsByRarity(mainNonBasic, 'rare'),
    mythic: cardsByRarity(mainNonBasic, 'mythic'),
    funRare: cardsByRarity(fun, 'rare'),
    funMythic: cardsByRarity(fun, 'mythic'),
    basics,
    subset: sub
  };
}

function spread(cards, share) {
  if (!cards.length || !(share > 0)) return [];
  const w = share / cards.length;
  return cards.map(card => ({ card, weight: w }));
}

function rareMythicEntries(rares, mythics, rareShare = 0.875) {
  if (!rares.length) return spread(mythics, 1);
  if (!mythics.length) return spread(rares, 1);
  return [...spread(rares, rareShare), ...spread(mythics, 1 - rareShare)];
}

function genericSheetEntries(kind, weights, pools) {
  switch (kind) {
    case 'common':
    case 'foilCommon':
      return spread(pools.common, 1);
    case 'uncommon':
    case 'foilUncommon':
      return spread(pools.uncommon, 1);
    case 'rareMythic':
    case 'foilRareMythic':
      return rareMythicEntries(pools.rare, pools.mythic);
    case 'wildcard':
    case 'foilWildcard': {
      const out = [];
      for (const [rarity, share] of Object.entries(weights || {})) out.push(...spread(pools[rarity] || [], share));
      return out;
    }
    case 'land':
    case 'foilLand':
      return spread(pools.basics.length ? pools.basics : pools.common, 1);
    case 'boosterFun':
    case 'foilBoosterFun': {
      const rShare = (weights && weights.rare) || 0.8;
      const r = pools.funRare.length ? pools.funRare : pools.rare;
      const m = pools.funMythic.length ? pools.funMythic : pools.mythic;
      return rareMythicEntries(r, m, rShare);
    }
    case 'subset':
      return spread(pools.subset, 1);
    default:
      return [];
  }
}

const FOIL_KINDS = new Set(['foilWildcard', 'foilLand', 'foilCommon', 'foilUncommon', 'foilRareMythic', 'foilBoosterFun']);

const genericModelCache = new WeakMap(); // setCards array → Map(cacheKey → model)

/**
 * Build a sheet model ({ [key]: { variants, totalWeight, sheets } }) for one
 * booster type from the generic profile and a set's Scryfall cards.
 * Returns null when the type has no profile or the set has no cards.
 */
export function buildGenericBoosterModel(boosterType, setCards, subsetCards = []) {
  const profile = PACK_PROFILES[boosterType];
  const key = MTGJSON_BOOSTER_KEYS[boosterType];
  if (!profile || !key || !Array.isArray(setCards) || !setCards.length) return null;

  const cacheKey = `${boosterType}|${(subsetCards || []).length}`;
  let perSet = genericModelCache.get(setCards);
  if (perSet && perSet.has(cacheKey)) return perSet.get(cacheKey);

  const pools = genericPools(setCards, subsetCards);
  const sheets = {};
  const contents = {};
  profile.slots.forEach((slot, i) => {
    const name = `${slot.kind}${i}`;
    const entries = genericSheetEntries(slot.kind, slot.weights, pools);
    if (!entries.length) return;
    sheets[name] = {
      entries,
      totalWeight: entries.reduce((s, e) => s + e.weight, 0),
      foil: FOIL_KINDS.has(slot.kind)
    };
    contents[name] = slot.count;
  });

  const variants = [];
  const sub = profile.subset;
  if (sub && pools.subset.length && sub.chance > 0) {
    const replacedIdx = profile.slots.findIndex(sl => sl.kind === sub.replaces);
    const replacedName = replacedIdx >= 0 ? `${sub.replaces}${replacedIdx}` : null;
    if (replacedName && contents[replacedName]) {
      const subEntries = spread(pools.subset, 1);
      sheets.subset = { entries: subEntries, totalWeight: 1, foil: !!sub.foil };
      const withSubset = { ...contents, [replacedName]: contents[replacedName] - 1, subset: 1 };
      variants.push({ weight: 1 - sub.chance, contents: { ...contents } });
      variants.push({ weight: sub.chance, contents: withSubset });
    }
  }
  if (!variants.length) variants.push({ weight: 1, contents: { ...contents } });

  const model = { [key]: { variants, totalWeight: variants.reduce((s, v) => s + v.weight, 0), sheets } };
  if (!perSet) { perSet = new Map(); genericModelCache.set(setCards, perSet); }
  perSet.set(cacheKey, model);
  return model;
}

/**
 * Simulate opening a single pack with the generic profile.
 * Returns an array of { card, isFoil, slotType, price } objects.
 */
export function simulatePack(boosterType, setCards, subsetCards = []) {
  const model = buildGenericBoosterModel(boosterType, setCards, subsetCards);
  return (model && simulatePackFromMtgjson(model, boosterType)) || [];
}

/**
 * Expected R/M cards per pack for the generic profile, as
 * [{ card, probability, isFoil }, ...]. Used for EV calculation.
 */
export function getRareMythicDistribution(boosterType, setCards, subsetCards = []) {
  const model = buildGenericBoosterModel(boosterType, setCards, subsetCards);
  return (model && getRareMythicDistributionFromMtgjson(model, boosterType)) || [];
}
