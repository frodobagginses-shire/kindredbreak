/**
 * Simulation & EV Engine — Kindred Break edition (formerly "Tribal" — WotC renamed in 2024).
 *
 * Spots are user-defined text labels with a rich matching expression:
 *   - "Snake/Snail"                     → OR (claim either tribe)
 *   - "White Human"                     → AND (color + creature subtype)
 *   - "Legendary Enchantment"           → AND (supertype + card type)
 *   - "Enchantment excluding creature and legendary" → AND + NOT
 *   - "Equipment !Aura !Legendary"      → terse exclusion syntax
 *
 * Cards are assigned to spots in PRIORITY ORDER (top-down): the first
 * matching spot in the user's list claims the card. R/M cards that match
 * no defined spot go to the Last Spot. All C/U go to Bulk regardless.
 */

import { getCardPrice } from './scryfall.js';
import {
  simulateProduct,
  getRareMythicDistribution,
  getRareMythicDistributionFromMtgjson,
  getAllCardDistributionFromMtgjson,
  buildGenericBoosterModel
} from './collation.js';

// ─── Expression parser ───
//
// A parsed spot is an array of OR-clauses. Each clause has `includes` (all
// must match) and `excludes` (none may match).
// Example: "Enchantment excluding creature and legendary"
//   → [{ includes: ["enchantment"], excludes: ["creature", "legendary"] }]

const COLOR_TERMS = {
  white: 'W', w: 'W',
  blue:  'U', u: 'U',
  black: 'B', b: 'B',
  red:   'R', r: 'R',
  green: 'G', g: 'G'
};
const COLOR_NAMES = new Set(['white','blue','black','red','green','colorless','multicolor','multicolored','monocolor','monocolored']);
// 'tribal' and 'kindred' both kept — WotC renamed the supertype/card-type in 2024;
// old cards still print "Tribal", new cards print "Kindred". Scryfall returns whichever
// the printing has, so we accept either spelling.
const SUPERTYPES  = new Set(['legendary','basic','snow','world','tribal','kindred']);
const CARD_TYPES  = new Set(['creature','artifact','enchantment','instant','sorcery','land','planeswalker','battle','tribal','kindred']);

// Tokens that look like subtypes in mis-parsed MDFC / aggregate type lines
// but aren't real creature subtypes — supertypes, card types, separators.
// Used by seedCategoryLabels to filter junk out of the tribe seed.
const NON_TRIBE_TOKENS = new Set([
  ...SUPERTYPES, ...CARD_TYPES,
  '//', '—', '-', '|', 'a-', '?',
  'token', 'summon',  // older card-text artifacts
]);

/**
 * Parse a spot label into an OR-array of clauses.
 * @returns {Array<{includes: string[], excludes: string[]}>}
 */
export function parseSpotLabel(label) {
  if (!label || !label.trim()) return [];
  const orClauses = label.split('/').map(c => c.trim()).filter(Boolean);
  return orClauses.map(parseClause);
}

function parseClause(clause) {
  // Strip parentheses entirely — they're cosmetic ("Land (excluding Creature)" reads
  // better but parses the same as "Land excluding Creature").
  let s = clause.toLowerCase().trim().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  // Collapse the two-word color modifiers so "Mono Colored Creature" parses as
  // a single `monocolored` term + `creature`, not three separate tokens.
  s = s.replace(/\bmono[\s-]?colored?\b/g, 'monocolored');
  s = s.replace(/\bmulti[\s-]?colored?\b/g, 'multicolored');
  // Detect "excluding"/"except" — everything after becomes excludes
  const exclMatch = s.match(/\b(excluding|except)\b/);
  let includesText = s;
  let excludesText = '';
  if (exclMatch) {
    includesText = s.slice(0, exclMatch.index).trim();
    excludesText = s.slice(exclMatch.index + exclMatch[0].length).trim();
  }

  const includes = [];
  const excludes = [];

  // Includes: whitespace-separated, also strip inline `!`/`-` exclusions
  for (const raw of includesText.split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith('!')) excludes.push(raw.slice(1));
    else if (raw.startsWith('-') && raw.length > 1) excludes.push(raw.slice(1));
    else includes.push(raw);
  }
  // Excludes from "excluding" tail: split on whitespace/commas/'and'
  if (excludesText) {
    const parts = excludesText
      .split(/\s*,\s*|\s+and\s+|\s+/)
      .map(t => t.replace(/^[!\-]/, '').trim())
      .filter(Boolean);
    for (const p of parts) excludes.push(p);
  }

  return { includes, excludes };
}

// ─── Card property helpers ───

function cardColors(card) {
  if (Array.isArray(card.colors) && card.colors.length) return card.colors;
  if (Array.isArray(card.card_faces)) {
    const set = new Set();
    for (const f of card.card_faces) {
      if (Array.isArray(f.colors)) for (const c of f.colors) set.add(c);
    }
    return [...set];
  }
  return [];
}

function fullTypeLine(card) {
  if (card.type_line) return card.type_line.toLowerCase();
  if (Array.isArray(card.card_faces)) {
    return card.card_faces.map(f => f.type_line || '').join(' // ').toLowerCase();
  }
  return '';
}

// FRONT face's type_line — used for card-identity routing. Cards default to
// their front face's type for spot matching: a DFC like "Emeritus of Woe //
// Demonic Tutor" (front=Creature, back=Sorcery) is a Creature card, not a
// Sorcery card. Same applies to MDFC, Adventure, Omen, and any other layout
// where Scryfall's aggregate type_line straddles two card types. For
// single-face cards this is identical to fullTypeLine.
function frontFaceTypeLine(card) {
  if (Array.isArray(card.card_faces) && card.card_faces.length > 0 && card.card_faces[0].type_line) {
    return card.card_faces[0].type_line.toLowerCase();
  }
  if (card.type_line) return card.type_line.toLowerCase();
  return '';
}

function cardSubtypes(card) {
  const out = [];
  const lines = [];
  if (card.type_line) lines.push(card.type_line);
  if (Array.isArray(card.card_faces)) for (const f of card.card_faces) if (f.type_line) lines.push(f.type_line);
  for (const tl of lines) {
    const dash = tl.indexOf('—');
    if (dash >= 0) {
      const subs = tl.substring(dash + 1).trim().split(/\s+/).filter(Boolean);
      for (const s of subs) out.push(s.toLowerCase());
    }
  }
  return out;
}

// Subtypes that LOOK like creature subtypes when they appear after the `—`
// but actually aren't real tribes (they're enchantment/artifact subtypes that
// happen to share the position). Cards like "Enchantment Creature — Saga
// Dragon" have "saga" first but their real tribe is Dragon. Skip these and
// pick the next valid token.
const NON_TRIBE_PRIMARIES = new Set([
  'saga', 'aura', 'class', 'case', 'equipment', 'vehicle',
]);
function primaryCreatureSubtype(card) {
  // Use FRONT face only — a Prepared DFC like "Emeritus of Woe // Demonic
  // Tutor" has aggregate type_line "Creature — Vampire Warlock // Sorcery";
  // we want "vampire" from the front face, not the back face's "sorcery" or
  // tokens leaking across the // separator.
  const tl = frontFaceTypeLine(card);
  if (!tl.includes('creature')) return null;
  const dash = tl.indexOf('—');
  if (dash < 0) return null;
  const after = tl.substring(dash + 1).trim();
  const tokens = after.split(/\s+/).map(t => t.toLowerCase()).filter(Boolean);
  for (const t of tokens) {
    // Skip junk separators and enchantment/artifact subtypes — find the real tribe.
    if (NON_TRIBE_TOKENS.has(t) || NON_TRIBE_PRIMARIES.has(t)) continue;
    return t;
  }
  return null;
}

function isCreature(card) {
  return frontFaceTypeLine(card).includes('creature');
}

/**
 * Whether a single term applies to a card. Resolution order:
 *   color → supertype → card type → subtype.
 */
export function termMatches(card, term) {
  const t = (term || '').toLowerCase();
  if (!t) return false;

  if (COLOR_NAMES.has(t)) {
    const cols = cardColors(card);
    if (t === 'colorless') return cols.length === 0;
    if (t === 'multicolor' || t === 'multicolored') return cols.length >= 2;
    if (t === 'monocolor' || t === 'monocolored') return cols.length === 1;
    return cols.includes(COLOR_TERMS[t]);
  }

  // Card identity = FRONT face. DFCs (Prepared, MDFC, Adventure, Omen,
  // transform, etc.) match their front face's card type only — a creature with
  // a stapled sorcery back is a Creature, not a Sorcery.
  const typeLine = frontFaceTypeLine(card);
  if (SUPERTYPES.has(t)) return new RegExp(`\\b${escapeRegex(t)}\\b`).test(typeLine);
  if (CARD_TYPES.has(t))  return new RegExp(`\\b${escapeRegex(t)}\\b`).test(typeLine);

  // Subtype check — creature primary type rule for creatures
  if (isCreature(card)) {
    const primary = primaryCreatureSubtype(card);
    if (primary && primary === t) return true;
    return new RegExp(`\\b${escapeRegex(t)}\\b`).test(typeLine);
  }
  const subs = cardSubtypes(card);
  if (subs.includes(t)) return true;
  return new RegExp(`\\b${escapeRegex(t)}\\b`).test(typeLine);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Whether the card matches a parsed spot expression.
 * OR across clauses, AND within (includes), NOT for excludes.
 */
export function cardMatchesSpot(card, parsedSpot) {
  if (!parsedSpot || parsedSpot.length === 0) return false;
  for (const clause of parsedSpot) {
    if (matchesClause(card, clause)) return true;
  }
  return false;
}

function matchesClause(card, clause) {
  if (!clause.includes || clause.includes.length === 0) return false;
  for (const term of clause.includes) if (!termMatches(card, term)) return false;
  for (const term of clause.excludes) if ( termMatches(card, term)) return false;
  return true;
}

// ─── Distribution function selection ───

/**
 * R/M distribution for one booster roster entry: [{ card, probability, isFoil }].
 * entry.mtgjsonBooster holds the entry's sheet model (MTGJSON, official odds
 * or generic profile). If the model lacks the requested pack type, fall back
 * to the generic profile built from the set's Scryfall cards.
 */
export function distributionForEntry(entry) {
  if (entry.mtgjsonBooster) {
    const d = getRareMythicDistributionFromMtgjson(entry.mtgjsonBooster, entry.boosterType);
    if (d && d.length) return d;
  }
  // Guard: entry may still be loading (cards null) or have no card data — return
  // empty rather than crashing. Callers `.continue` on empty distributions.
  if (!entry.cards || !Array.isArray(entry.cards)) return [];
  return getRareMythicDistribution(entry.boosterType, entry.cards, entry.subsetCards || []);
}

/** Like distributionForEntry but every rarity (for Bulk EV). */
export function allCardDistributionForEntry(entry) {
  if (entry.mtgjsonBooster) {
    const d = getAllCardDistributionFromMtgjson(entry.mtgjsonBooster, entry.boosterType);
    if (d && d.length) return d;
  }
  if (!entry.cards || !Array.isArray(entry.cards)) return [];
  const generic = buildGenericBoosterModel(entry.boosterType, entry.cards, entry.subsetCards || []);
  return (generic && getAllCardDistributionFromMtgjson(generic, entry.boosterType)) || [];
}

// ─── Sorting cards into spots (priority order) ───

export function sortCardsIntoSpots(openedCards, spots) {
  const bulk = [];
  const assigned = spots.map(() => []);
  const lastSpot = [];

  for (const opened of openedCards) {
    const r = opened.card.rarity;
    if (r === 'common' || r === 'uncommon') { bulk.push(opened); continue; }

    let claimed = false;
    for (let i = 0; i < spots.length; i++) {
      if (cardMatchesSpot(opened.card, spots[i].parsed)) {
        assigned[i].push(opened); claimed = true; break;
      }
    }
    if (!claimed) lastSpot.push(opened);
  }
  return { bulk, assigned, lastSpot };
}

// ─── Global EV ───

/**
 * Total expected value across the roster, INCLUDING Bulk (C/U). Modern Kindred
 * breaks distribute the Bulk pile evenly among all spots, so it's part of
 * the pool buyers receive.
 */
export function calculateGlobalEV(rosterEntries) {
  return calculateRMValue(rosterEntries) + calculateBulkEV(rosterEntries);
}

/** Just the Rare/Mythic expected value (used for tier ranking + analytics). */
export function calculateRMValue(rosterEntries) {
  let rmEV = 0;
  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        rmEV += getCardPrice(card, finish) * entry.quantity;
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        const isFoil = !!card.__isFoil;
        rmEV += getCardPrice(card, isFoil) * entry.quantity;
      }
      continue;
    }
    const dist = distributionForEntry(entry);
    if (!dist) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of dist) {
      rmEV += getCardPrice(card, isFoil ? 'foil' : 'nonfoil') * probability * q;
    }
  }
  return rmEV;
}

/**
 * Expected Bulk (C/U) value across the roster. Returns total dollar value
 * of commons + uncommons that will be opened. Exact for MTGJSON sheet
 * models, close for official-odds models, and a rough estimate for sets on
 * the generic profile.
 */
export function calculateBulkEV(rosterEntries) {
  let bulkEV = 0;
  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        if (card.rarity !== 'common' && card.rarity !== 'uncommon') continue;
        bulkEV += getCardPrice(card, finish) * entry.quantity;
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        if (card.rarity !== 'common' && card.rarity !== 'uncommon') continue;
        const isFoil = !!card.__isFoil;
        bulkEV += getCardPrice(card, isFoil) * entry.quantity;
      }
      continue;
    }
    // Boosters — need ALL rarities to find C/U.
    const allDist = allCardDistributionForEntry(entry);
    if (!allDist || !allDist.length) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of allDist) {
      if (card.rarity !== 'common' && card.rarity !== 'uncommon') continue;
      bulkEV += getCardPrice(card, isFoil ? 'foil' : 'nonfoil') * probability * q;
    }
  }
  return bulkEV;
}

// ─── Per-spot EV distribution (analytical) ───

/**
 * Given a roster and an ordered list of spots, compute expected EV per
 * spot, respecting priority. Cards that match no spot accumulate in
 * lastSpotEV; C/U go to bulkEV.
 *
 * @returns { spotEV: number[], spotCounts: number[], lastSpotEV: number, lastSpotCount: number, bulkEV: number, totalEV: number }
 */
export function analyzeSpotDistribution(rosterEntries, spots) {
  // spotEV[i] holds R/M expected value for spot i.
  // bulkEV is the Bulk (C/U) total — it gets distributed evenly to all spots
  // when shown to the user (bulkPerSpot = bulkEV / spots.length).
  // lastSpotEV is R/M that doesn't match any defined spot.
  const spotEV = spots.map(() => 0);
  let lastSpotEV = 0;
  // Parallel to spotEV: expected NUMBER of R/M cards landing in each spot.
  // Used by the Sort Assistant PDF to tell the sorter how big a pile to expect.
  const spotCounts = spots.map(() => 0);
  let lastSpotCount = 0;

  function assignRM(card, ev, count) {
    for (let i = 0; i < spots.length; i++) {
      if (cardMatchesSpot(card, spots[i].parsed)) { spotEV[i] += ev; spotCounts[i] += count; return; }
    }
    lastSpotEV += ev;
    lastSpotCount += count;
  }

  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        assignRM(card, getCardPrice(card, finish) * entry.quantity, entry.quantity);
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        const isFoil = !!card.__isFoil;
        assignRM(card, getCardPrice(card, isFoil) * entry.quantity, entry.quantity);
      }
      continue;
    }
    const dist = distributionForEntry(entry);
    if (!dist) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of dist) {
      assignRM(card, getCardPrice(card, isFoil ? 'foil' : 'nonfoil') * probability * q, probability * q);
    }
  }

  const bulkEV = calculateBulkEV(rosterEntries);
  const bulkPerSpot = spots.length > 0 ? bulkEV / spots.length : 0;
  const totalEV = spotEV.reduce((s, v) => s + v, 0) + lastSpotEV + bulkEV;
  return { spotEV, spotCounts, lastSpotEV, lastSpotCount, bulkEV, bulkPerSpot, totalEV };
}

// ─── Expected insurance impact ───

export function expectedInsuranceImpact(rosterEntries, spots, insuranceValue = 0) {
  if (!insuranceValue || insuranceValue <= 0 || !spots || !spots.length) {
    return { totalCost: 0, perSpotAverage: 0, expectedEmpty: 0 };
  }

  const expectedCount = spots.map(() => 0);
  const hasGuaranteed = spots.map(() => false);
  let lastExpected = 0;
  let lastGuaranteed = false;

  function pushCount(card, count, isGuaranteed) {
    if (card.rarity === 'common' || card.rarity === 'uncommon') return;
    for (let i = 0; i < spots.length; i++) {
      if (cardMatchesSpot(card, spots[i].parsed)) {
        expectedCount[i] += count;
        if (isGuaranteed) hasGuaranteed[i] = true;
        return;
      }
    }
    // Falls to Last Spot
    lastExpected += count;
    if (isGuaranteed) lastGuaranteed = true;
  }

  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        const price = getCardPrice(card, finish);
        if (price <= 0) continue;
        pushCount(card, entry.quantity, true);
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        const isFoil = !!card.__isFoil;
        const price = getCardPrice(card, isFoil);
        if (price <= 0) continue;
        pushCount(card, entry.quantity, true);
      }
      continue;
    }
    const dist = distributionForEntry(entry);
    if (!dist) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of dist) {
      const price = getCardPrice(card, isFoil ? 'foil' : 'nonfoil');
      if (price <= 0) continue;
      pushCount(card, probability * q, false);
    }
  }

  let expectedEmpty = 0;
  for (let i = 0; i < spots.length; i++) {
    if (hasGuaranteed[i]) continue;
    expectedEmpty += Math.exp(-expectedCount[i]);
  }
  // Last Spot also gets insurance if empty
  if (!lastGuaranteed) expectedEmpty += Math.exp(-lastExpected);

  const totalCost = expectedEmpty * insuranceValue;
  return { totalCost, perSpotAverage: spots.length > 0 ? totalCost / spots.length : 0, expectedEmpty };
}

// ─── Monte Carlo single break simulation ───

export function simulateBreak(rosterEntries, spots, insuranceValue = 0) {
  const allOpened = [];
  for (const entry of rosterEntries) {
    for (let i = 0; i < entry.quantity; i++) {
      allOpened.push(...simulateProduct(entry));
    }
  }
  const { bulk, assigned, lastSpot } = sortCardsIntoSpots(allOpened, spots);

  // Distribute Bulk randomly + evenly across user spots (shuffle, round-robin).
  // Last Spot is excluded — it only catches R/M that didn't match.
  const bulkAssignments = spots.map(() => []);
  if (spots.length > 0 && bulk.length > 0) {
    const shuffled = bulk.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (let i = 0; i < shuffled.length; i++) {
      bulkAssignments[i % spots.length].push(shuffled[i]);
    }
  }
  const totalBulkValue = bulk.reduce((s, o) => s + o.price, 0);

  const results = [];
  for (let i = 0; i < spots.length; i++) {
    const rmCards   = assigned[i];
    const bulkCards = bulkAssignments[i];
    const cards = [...rmCards, ...bulkCards];
    const rmValue   = rmCards.reduce((s, o) => s + o.price, 0);
    const bulkVal   = bulkCards.reduce((s, o) => s + o.price, 0);
    const rawValue  = rmValue + bulkVal;
    const isInsured = rawValue === 0 && insuranceValue > 0;
    const finalValue = isInsured ? insuranceValue : rawValue;
    results.push({
      name: spots[i].label, spotIndex: i,
      cards, rmCards, bulkCards,
      rmValue, bulkValue: bulkVal,
      rawValue, finalValue, isInsured, isBulk: false
    });
  }

  const lastValue = lastSpot.reduce((s, o) => s + o.price, 0);
  const lastInsured = lastValue === 0 && insuranceValue > 0;
  results.push({
    name: 'Last Spot (Unclaimed R/M)', cards: lastSpot,
    rawValue: lastValue,
    finalValue: lastInsured ? insuranceValue : lastValue,
    isInsured: lastInsured, isBulk: false, isLastSpot: true
  });

  // Pool value = every card opened (R/M + Bulk) summed across the user
  // spots + Last Spot. Bulk is now part of spots, so it counts toward total.
  // Excludes insurance overrides (those are streamer expense).
  let poolValue = lastValue;
  for (const r of results) if (!r.isLastSpot) poolValue += r.rawValue;

  // Total payout including insurance overrides.
  const grandPayout = results.reduce((s, r) => s + r.finalValue, 0);
  const divisor = spots.length > 0 ? spots.length : 1;
  return {
    results,
    totalOpenedCards: allOpened.length,
    grandTotal: poolValue,           // matches calculateGlobalEV (R/M + Bulk pool)
    grandPayout,                      // incl. insurance overrides
    bulkValue: totalBulkValue,        // total Bulk that got distributed
    bulkPerSpot: spots.length > 0 ? totalBulkValue / spots.length : 0,
    bulkCardsPerSpot: spots.length > 0 ? bulk.length / spots.length : 0,
    perSpot: poolValue / divisor
  };
}

// ─── Auto-tabulate: rank tribes/types by frequency × value, target 100 spots ───

const COLOR_NAME_BY_CODE = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const NON_CREATURE_FALLBACK_TYPES = ['Saga', 'Class', 'Case', 'Equipment', 'Aura', 'Vehicle', 'Background', 'Attraction', 'Contraption'];
// Card-type buckets considered as catch-all candidates. Artifact and Enchantment
// are included even though many cards of those types ALSO have a subtype (Equipment,
// Saga, Aura, Class, Case, etc.) that gets its own candidate — because "Artifact" /
// "Enchantment" are common high-value spots in any break and many cards of those
// types are vanilla (Sol Ring, Necropotence, etc.) and would otherwise fall through
// to no bucket at all. The user can manually reorder so subtypes (Equipment, Saga)
// sit above the catch-all (Artifact, Enchantment) in priority.
const CARD_TYPE_FALLBACKS = ['Sorcery', 'Instant', 'Planeswalker', 'Battle', 'Land', 'Artifact', 'Enchantment'];

/**
 * Build a rich spot list from the roster, targeting up to maxSpots entries.
 * Layers:
 *   1. Single creature tribes (top-N by score)
 *   2. Color × tribe splits for big tribes (e.g. White Human / Blue Human)
 *   3. Non-creature subtype spots (Saga, Equipment, Class, etc.)
 *   4. Legendary combos (Legendary Artifact, Legendary Enchantment)
 *   5. Card type fallbacks (Sorcery, Instant, Planeswalker, Battle, Land)
 *   6. Catch-alls (Other Creature, Other Non-Creature) — appended last
 */
export function autoTabulate(rosterEntries, maxSpots = 100) {
  // Stats: tribe → { count, value, byColor: { W: {n,v}, ... } }
  const tribeStats = new Map();
  const nonCreatureSubtypeStats = new Map();
  const cardTypeStats = new Map();
  const legendaryTypeStats = new Map();

  function getCardColorCode(card) {
    const cols = Array.isArray(card.colors) ? card.colors : [];
    if (cols.length === 1) return cols[0];
    if (cols.length === 0) return null;          // colorless
    return null;                                  // multicolored — skip color split
  }

  function addCard(card, price) {
    const r = card.rarity;
    if (r !== 'rare' && r !== 'mythic') return;
    // Front-face identity: a DFC like "Emeritus of Woe // Demonic Tutor" is a
    // Creature card, not a Sorcery card. Use front face only.
    const typeLine = frontFaceTypeLine(card);
    const isCreatureCard = typeLine.includes('creature');
    const isLegendary = /\blegendary\b/.test(typeLine);
    const colorCode = getCardColorCode(card);

    if (isCreatureCard) {
      const sub = primaryCreatureSubtype(card);
      if (sub) {
        const displayName = sub.charAt(0).toUpperCase() + sub.slice(1);
        if (!tribeStats.has(displayName)) tribeStats.set(displayName, { count: 0, totalValue: 0, byColor: {} });
        const stat = tribeStats.get(displayName);
        stat.count++; stat.totalValue += price;
        if (colorCode) {
          if (!stat.byColor[colorCode]) stat.byColor[colorCode] = { count: 0, value: 0 };
          stat.byColor[colorCode].count++;
          stat.byColor[colorCode].value += price;
        }
      }
    } else {
      // Non-creature: tally subtypes
      const subs = cardSubtypes(card);
      if (subs.length) {
        const first = subs[0];
        const dispName = first.charAt(0).toUpperCase() + first.slice(1);
        if (!nonCreatureSubtypeStats.has(dispName)) nonCreatureSubtypeStats.set(dispName, { count: 0, totalValue: 0 });
        const stat = nonCreatureSubtypeStats.get(dispName);
        stat.count++; stat.totalValue += price;
      }
      // Card-type bucket for "Legendary Artifact" etc.
      if (isLegendary) {
        for (const ct of ['Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle']) {
          if (typeLine.includes(ct.toLowerCase())) {
            const key = `Legendary ${ct}`;
            if (!legendaryTypeStats.has(key)) legendaryTypeStats.set(key, { count: 0, totalValue: 0 });
            const stat = legendaryTypeStats.get(key);
            stat.count++; stat.totalValue += price;
          }
        }
      }
      // Plain card type
      for (const ct of CARD_TYPE_FALLBACKS) {
        if (typeLine.includes(ct.toLowerCase())) {
          if (!cardTypeStats.has(ct)) cardTypeStats.set(ct, { count: 0, totalValue: 0 });
          const stat = cardTypeStats.get(ct);
          stat.count++; stat.totalValue += price;
        }
      }
    }
  }

  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) addCard(card, getCardPrice(card, finish));
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) addCard(card, getCardPrice(card, !!card.__isFoil));
      continue;
    }
    const rmCards = (entry.cards || []).filter(c => c.rarity === 'rare' || c.rarity === 'mythic');
    for (const card of rmCards) addCard(card, getCardPrice(card));
  }

  // Build candidates
  const candidates = [];
  const score = (stat) => (stat.totalValue || 0) * Math.log2((stat.count || 0) + 1);

  // 1. Single creature tribes — score each individually
  for (const [name, stat] of tribeStats.entries()) {
    candidates.push({
      name, count: stat.count, totalValue: stat.totalValue, avgValue: stat.totalValue / stat.count,
      score: score(stat), source: 'tribe'
    });
  }
  // 2. Color × tribe splits — propose if a tribe spans 2+ colors with 2+ cards each
  for (const [tribe, stat] of tribeStats.entries()) {
    const colorBreakdowns = Object.entries(stat.byColor)
      .filter(([_, c]) => c.count >= 2)
      .sort((a, b) => b[1].value - a[1].value);
    if (colorBreakdowns.length < 2) continue;
    for (const [code, c] of colorBreakdowns) {
      const colorName = COLOR_NAME_BY_CODE[code];
      if (!colorName) continue;
      candidates.push({
        name: `${colorName} ${tribe}`,
        count: c.count, totalValue: c.value, avgValue: c.value / c.count,
        score: score({ count: c.count, totalValue: c.value }) * 0.85, // slightly de-prioritize splits
        source: 'colorSplit'
      });
    }
  }
  // 3. Non-creature subtype spots
  for (const [name, stat] of nonCreatureSubtypeStats.entries()) {
    candidates.push({
      name, count: stat.count, totalValue: stat.totalValue, avgValue: stat.totalValue / stat.count,
      score: score(stat) * 0.9, source: 'nonCreatureSubtype'
    });
  }
  // 4. Legendary combos
  for (const [name, stat] of legendaryTypeStats.entries()) {
    candidates.push({
      name, count: stat.count, totalValue: stat.totalValue, avgValue: stat.totalValue / stat.count,
      score: score(stat) * 0.95, source: 'legendaryCombo'
    });
  }
  // 5. Card type fallbacks
  for (const [name, stat] of cardTypeStats.entries()) {
    candidates.push({
      name, count: stat.count, totalValue: stat.totalValue, avgValue: stat.totalValue / stat.count,
      score: score(stat) * 0.7, source: 'cardType'
    });
  }

  // Sort by score and dedupe by name
  candidates.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const filtered = [];
  for (const c of candidates) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    filtered.push(c);
    if (filtered.length >= maxSpots) break;
  }
  return filtered;
}

// ─── Interactive Spot Builder (seed + split) ────────────────────────────────
//
// seedCategoryLabels: returns the user-friendly initial categorization for the
// roster — non-creature card types in a fixed order, then every creature tribe
// present, all sorted by total R/M value descending. Used to bootstrap the
// spot list before the user starts splitting/merging.
//
// splitLabelsBy: for a given spot label + dimension (color / supertype / subtype),
// returns the resulting sub-labels that have ≥1 matching R/M card. Used by the
// per-row "Split…" menu.
//
// Both functions return arrays of { label, count, value } — count is the R/M
// card count, value is the TCGPlayer Market value summed across all matching
// R/M cards in the pool (weighted by booster probability for sealed product).

// Walk the roster's R/M cards exactly once. Calls cb(card, value) for each.
function forEachRMCard(rosterEntries, cb) {
  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        cb(card, getCardPrice(card, finish) * entry.quantity);
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        if (card.rarity === 'common' || card.rarity === 'uncommon') continue;
        const isFoil = !!card.__isFoil;
        cb(card, getCardPrice(card, isFoil) * entry.quantity);
      }
      continue;
    }
    const dist = distributionForEntry(entry);
    if (!dist) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of dist) {
      cb(card, getCardPrice(card, isFoil ? 'foil' : 'nonfoil') * probability * q);
    }
  }
}

/**
 * Initial category seed for the interactive spot builder.
 *
 * Returns an explicit list of "common Kindred Break spots" + every primary
 * creature tribe present, all sorted by EV descending. Empty buckets (no R/M
 * cards) are filtered out.
 *
 * The non-creature candidates have full exclusion clauses so the partition
 * is clean regardless of where they end up in the streamer's final spot list:
 *   - Land / Legendary Land are split (Cavern of Souls etc. are chase)
 *   - Enchantment has its named subtype variants (Aura, Class, Case, Saga)
 *     pulled out and excluded from the catch-all
 *   - Artifact has Equipment/Vehicle/Legendary pulled out
 *   - Instant/Sorcery/Battle/PW exclude !Creature to drop Adventure halves
 *
 * @returns Array<{ label, count, value, source }> sorted by value desc.
 */
export function seedCategoryLabels(rosterEntries) {
  // Candidate structure: a base label + which exclusions to CONSIDER. Each
  // exclusion is dropped if no card in the pool would actually be excluded
  // by it — so "Sorcery !Creature" collapses to just "Sorcery" when there
  // are no creature-typed Sorceries in the roster.
  // In a Kindred Break, CREATURES TRUMP EVERYTHING. So every enchantment/
  // artifact subtype label considers !Creature — a Saga Creature like
  // Mightstone's Animation goes to its creature tribe, not the Saga spot.
  // Equipment and Vehicle additionally consider !Planeswalker for cards like
  // The Aetherspark (Equipment Planeswalker) — those go to the Planeswalker
  // spot, not Equipment.
  const NC_CANDIDATES = [
    { base: 'Land',          considerEx: ['Creature', 'Legendary'] },
    { base: 'Legendary Land', considerEx: ['Creature'] },
    { base: 'Aura',           considerEx: ['Creature'] },
    { base: 'Saga',           considerEx: ['Creature'] },
    { base: 'Class',          considerEx: ['Creature'] },
    { base: 'Case',           considerEx: ['Creature'] },
    { base: 'Equipment',      considerEx: ['Creature', 'Planeswalker'] },
    { base: 'Vehicle',        considerEx: ['Creature', 'Planeswalker'] },
    { base: 'Legendary Artifact', considerEx: ['Creature', 'Equipment', 'Vehicle'] },
    { base: 'Artifact',       considerEx: ['Creature', 'Legendary', 'Equipment', 'Vehicle'] },
    { base: 'Legendary Enchantment', considerEx: ['Creature', 'Aura', 'Class', 'Case', 'Saga'] },
    { base: 'Enchantment',    considerEx: ['Creature', 'Legendary', 'Aura', 'Class', 'Case', 'Saga'] },
    { base: 'Instant',        considerEx: ['Creature'] },
    { base: 'Sorcery',        considerEx: ['Creature'] },
    { base: 'Battle',         considerEx: ['Creature'] },
    { base: 'Planeswalker',   considerEx: ['Creature'] },
  ];

  // STEP 1: for each candidate, figure out which considerEx exclusions are
  // ACTUALLY NEEDED. An exclusion is necessary iff at least one card in the
  // pool has BOTH the base term(s) AND the exclusion term on the SAME face.
  //
  // Same-face check is critical for Adventure cards: a Bonecrusher Giant has
  // "Creature — Giant" on the front face and "Instant — Adventure" on the
  // back. The aggregate type_line contains both, but the streamer wouldn't
  // call that a "Sorcery Creature" — it's a Creature with a Sorcery half.
  // So !Creature should NOT be added to "Sorcery" just because adventures
  // happen to claim it via aggregate matching.
  for (const c of NC_CANDIDATES) {
    c.basePartsParsed = c.base.toLowerCase().split(/\s+/);
    c.removedBy = {};
    for (const ex of c.considerEx) c.removedBy[ex] = 0;
    c.baseCount = 0;
  }
  forEachRMCard(rosterEntries, (card) => {
    // Build the per-face type-line list (or just the aggregate for single-face).
    const faceLines = [];
    if (Array.isArray(card.card_faces) && card.card_faces.length > 0) {
      for (const f of card.card_faces) if (f.type_line) faceLines.push(f.type_line.toLowerCase());
    } else if (card.type_line) {
      faceLines.push(card.type_line.toLowerCase());
    }
    if (faceLines.length === 0) return;
    function faceContainsAll(face, terms) {
      return terms.every(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`).test(face));
    }
    for (const c of NC_CANDIDATES) {
      // baseMatch (aggregate) — does the card match the base label at all?
      const baseMatch = c.basePartsParsed.every(t => termMatches(card, t));
      if (!baseMatch) continue;
      c.baseCount++;
      // Exclusion check: same-face only. The exclusion is NEEDED if some
      // single face contains all base terms AND the exclusion term.
      for (const ex of c.considerEx) {
        const exLower = ex.toLowerCase();
        for (const face of faceLines) {
          if (faceContainsAll(face, c.basePartsParsed) && faceContainsAll(face, [exLower])) {
            c.removedBy[ex]++;
            break;
          }
        }
      }
    }
  });

  // STEP 2: build the final candidate label list with only the needed exclusions.
  for (const c of NC_CANDIDATES) {
    const necessary = c.considerEx.filter(ex => c.removedBy[ex] > 0);
    c.finalLabel = necessary.length === 0
      ? c.base
      : `${c.base} (excluding ${necessary.join(', ')})`;
    c.parsed = parseSpotLabel(c.finalLabel);
  }

  // STEP 3: walk the pool AGAIN with the final labels to count EVs cleanly
  // using priority-order partition (first match wins).
  const tribeStats = new Map();
  function routeToNcCandidate(card, value) {
    for (const c of NC_CANDIDATES) {
      if (cardMatchesSpot(card, c.parsed)) {
        c.count = (c.count || 0) + 1;
        c.value = (c.value || 0) + value;
        return true;
      }
    }
    return false;
  }
  forEachRMCard(rosterEntries, (card, value) => {
    // Front-face identity — Prepared DFCs etc. route by front face only.
    const typeLine = frontFaceTypeLine(card);
    const isCreature = typeLine.includes('creature');
    if (isCreature) {
      // Creatures trump everything — go to the primary creature tribe.
      // Saga/Aura/Class/Case/Equipment/Vehicle creatures still route here;
      // their corresponding NC candidates exclude Creature via considerEx.
      const sub = primaryCreatureSubtype(card);
      if (sub && !NON_TRIBE_TOKENS.has(sub)) {
        const display = sub.charAt(0).toUpperCase() + sub.slice(1);
        if (!tribeStats.has(display)) tribeStats.set(display, { count: 0, value: 0 });
        const s = tribeStats.get(display);
        s.count++; s.value += value;
      }
    } else {
      routeToNcCandidate(card, value);
    }
  });

  const out = [];
  for (const c of NC_CANDIDATES) {
    if ((c.count || 0) > 0) {
      out.push({ label: c.finalLabel, count: c.count, value: c.value, source: 'cardType' });
    }
  }
  for (const [label, s] of tribeStats.entries()) {
    if (s.count > 0) out.push({ label, count: s.count, value: s.value, source: 'tribe' });
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}

/**
 * Generate the sub-labels that result from splitting a spot by a given
 * dimension. Sub-labels are filtered to those with ≥1 matching R/M card.
 *
 * @param {string} parentLabel - the original spot's label (e.g. "Instant")
 * @param {string} dimension - 'color' | 'supertype' | 'subtype'
 * @param {Object[]} rosterEntries
 * @returns Array<{ label, count, value }>
 */
export function splitLabelsBy(parentLabel, dimension, rosterEntries) {
  const rawCandidates = candidateSplitLabels(parentLabel, dimension);
  if (!rawCandidates.length) return [];

  // Normalize every candidate to clean English form — kills any `!X !Y`
  // notation that might leak through from the parent label or rest bucket.
  // Dedupe in case two raw candidates clean to the same label.
  const seenLabels = new Set();
  const candidates = [];
  for (const raw of rawCandidates) {
    const clean = cleanLabel(raw);
    if (!seenLabels.has(clean)) { seenLabels.add(clean); candidates.push(clean); }
  }

  // Score each candidate by walking the roster once. Parse the labels up front.
  const parsedCands = candidates.map(label => ({ label, parsed: parseSpotLabel(label), count: 0, value: 0 }));

  // Walk each R/M card and assign it to the FIRST matching candidate.
  // This matches how the live spot list works in priority order (the candidate
  // array's order is deliberate: Multicolored first for color splits so it
  // claims multi-color cards before the mono-color spots see them — clean
  // partition, sum equals parent EV).
  forEachRMCard(rosterEntries, (card, value) => {
    for (const c of parsedCands) {
      if (cardMatchesSpot(card, c.parsed)) {
        c.count++; c.value += value;
        break;
      }
    }
  });

  // Drop empty buckets and sort by the candidate ORDER (preserves the
  // priority-sensitive layout — Multicolored first for color splits, etc.)
  return parsedCands
    .filter(c => c.count > 0)
    .map(c => ({ label: c.label, count: c.count, value: c.value }));
}

// Render a parsed label back into clean, streamer-friendly English. Used to
// normalize labels coming out of splits/merges so they never show raw `!X`
// notation — only "X (excluding A, B)" form.
function formatLabelEnglish(parsed) {
  if (!parsed || parsed.length === 0) return '';
  const cap = s => (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  function clauseToEnglish(clause) {
    const includes = (clause.includes || []).map(cap);
    const excludes = [...new Set((clause.excludes || []).map(t => t.toLowerCase()))].map(cap);
    const base = includes.join(' ');
    if (excludes.length === 0) return base;
    return `${base} (excluding ${excludes.join(', ')})`;
  }
  return parsed.map(clauseToEnglish).join('/');
}

// Take any label (with mixed `!` and "(excluding …)" notation), reparse, and
// emit clean English. Idempotent.
function cleanLabel(label) {
  const parsed = parseSpotLabel(label);
  return parsed.length ? formatLabelEnglish(parsed) : label;
}

// Helper — generates the candidate labels for a split BEFORE filtering by
// whether they have any matching cards. Order matters: in color splits the
// Multicolored bucket sits first so it claims multi-color cards before the
// mono-color buckets see them (assuming the user keeps the order).
function candidateSplitLabels(parentLabel, dimension) {
  const parent = (parentLabel || '').trim();
  if (!parent) return [];
  if (dimension === 'color') {
    return [
      `Multicolored ${parent}`,
      `White ${parent}`,
      `Blue ${parent}`,
      `Black ${parent}`,
      `Red ${parent}`,
      `Green ${parent}`,
      `Colorless ${parent}`,
    ];
  }
  if (dimension === 'supertype') {
    // Legendary first (higher value usually), then non-legendary.
    // Snow is rare; we include it only conditionally — the empty-bucket filter
    // in splitLabelsBy will drop it if there are no snow cards.
    return [
      `Legendary ${parent}`,
      `Snow ${parent}`,
      `${parent} !Legendary !Snow`,
    ];
  }
  if (dimension === 'subtype') {
    // Only meaningful for Enchantment / Artifact (with optional !Creature).
    // The "rest" bucket inherits the parent's exclusions and adds the specific
    // subtypes to its excludes list.
    const lower = parent.toLowerCase();
    if (/\benchantment\b/.test(lower)) {
      // Generate the "rest" by appending exclusions to the parent label
      return [
        'Saga',
        'Aura',
        'Class',
        'Case',
        `${parent} !Saga !Aura !Class !Case`,
      ];
    }
    if (/\bartifact\b/.test(lower)) {
      return [
        'Equipment',
        'Vehicle',
        `${parent} !Equipment !Vehicle`,
      ];
    }
    return [];
  }
  return [];
}

/**
 * Try to find a simpler single-clause label that claims the SAME set of R/M
 * cards as a given (potentially multi-clause) label. Used after a merge so
 * "(A - B) / B" collapses to "A" when B ⊆ A.
 *
 * Compares matched counts to determine set equality (same count + matching
 * cards-per-card-id is sufficient — we use a content hash via a sorted name list).
 *
 * Returns the simpler label string, or null if no simpler equivalent exists.
 */
export function trySimplifyMergedLabel(originalLabel, rosterEntries) {
  if (!originalLabel || !originalLabel.includes('/')) return null;
  const originalParsed = parseSpotLabel(originalLabel);
  if (originalParsed.length < 2) return null;

  // Special-case: if the merged label is the five mono-color variants of a
  // single tribe / type (e.g. "White Human / Blue Human / Black Human /
  // Red Human / Green Human", or "White Creature / Blue Creature / ..."),
  // collapse it to "Mono Colored <Tribe>". This is the canonical "merge all
  // five colors of this tribe" gesture in a Kindred Break — the user wants a
  // single clean spot, not a slash-separated wall of colors.
  {
    const COLOR_WORDS = ['white', 'blue', 'black', 'red', 'green'];
    const segments = originalLabel.split('/').map(s => s.trim()).filter(Boolean);
    if (segments.length === 5) {
      const colorsFound = new Set();
      const restsFound = new Set();
      let restDisplay = null;
      let ok = true;
      for (const seg of segments) {
        const tokens = seg.split(/\s+/).filter(Boolean);
        if (tokens.length < 2) { ok = false; break; }
        const color = tokens[0].toLowerCase();
        if (!COLOR_WORDS.includes(color)) { ok = false; break; }
        colorsFound.add(color);
        const restRaw = tokens.slice(1).join(' ');
        const restKey = restRaw.toLowerCase();
        restsFound.add(restKey);
        // Preserve the first segment's original capitalization for display.
        if (restDisplay === null) restDisplay = restRaw;
      }
      if (ok && colorsFound.size === 5 && restsFound.size === 1) {
        return `Mono Colored ${restDisplay}`;
      }
    }
  }

  function cardKey(card) {
    return `${(card.set || '').toLowerCase()}_${card.collector_number || ''}_${card.name || ''}`;
  }
  function cardSet(parsed) {
    const matched = new Set();
    forEachRMCard(rosterEntries, (card) => {
      if (cardMatchesSpot(card, parsed)) matched.add(cardKey(card));
    });
    return matched;
  }

  // Match if the candidate's card set is within tolerance of the merged set.
  // Tolerance: ≤ 5% symmetric difference AND ≤ 30 cards. This catches edge
  // cases like Constellation creatures, Bestow Auras, and Saga Creatures —
  // small numbers of cards where the user's intent is clear (a clean label
  // like "Enchantment") even if the merged union isn't a perfect set match.
  // The behavior change is small: those edge-case creatures move between
  // their tribe and the enchantment bucket.
  function symDiff(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let diff = 0;
    for (const x of a) if (!b.has(x)) diff++;
    for (const x of b) if (!a.has(x)) diff++;
    return diff;
  }
  function approxEqual(a, b) {
    const diff = symDiff(a, b);
    const total = a.size + b.size;
    return diff <= 30 && (total === 0 || diff / total <= 0.05);
  }
  // Among candidates that pass the tolerance, pick the one with the SMALLEST
  // symmetric diff (best fit). Tied → simplest label (fewest exclusions) wins.
  let bestMatch = null;
  let bestDiff = Infinity;

  const targetSet = cardSet(originalParsed);
  if (targetSet.size === 0) return null;

  const baseTypes = ['Artifact', 'Enchantment', 'Land', 'Instant', 'Sorcery', 'Battle', 'Planeswalker'];
  const exclusionPool = {
    Artifact:     ['Creature', 'Legendary', 'Equipment', 'Vehicle'],
    Enchantment:  ['Creature', 'Legendary', 'Aura', 'Saga', 'Class', 'Case'],
    Land:         ['Creature', 'Legendary'],
    Instant:      ['Creature'],
    Sorcery:      ['Creature'],
    Battle:       ['Creature'],
    Planeswalker: ['Creature'],
  };

  for (const base of baseTypes) {
    const exes = exclusionPool[base] || [];
    const subsets = [];
    for (let mask = 0; mask < (1 << exes.length); mask++) {
      const subset = exes.filter((_, i) => mask & (1 << i));
      subsets.push(subset);
    }
    subsets.sort((a, b) => a.length - b.length);

    for (const subset of subsets) {
      const candLabel = subset.length === 0
        ? base
        : `${base} (excluding ${subset.join(', ')})`;
      if (candLabel === originalLabel) continue;
      const candParsed = parseSpotLabel(candLabel);
      if (!candParsed.length) continue;
      const candSet = cardSet(candParsed);
      if (!approxEqual(candSet, targetSet)) continue;
      const diff = symDiff(candSet, targetSet);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = candLabel;
      }
    }
  }

  // Also try Legendary X family
  for (const base of baseTypes) {
    const candLabel = `Legendary ${base}`;
    const candParsed = parseSpotLabel(candLabel);
    if (!candParsed.length) continue;
    const candSet = cardSet(candParsed);
    if (!approxEqual(candSet, targetSet)) continue;
    const diff = symDiff(candSet, targetSet);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMatch = candLabel;
    }
  }

  return bestMatch;
}

/**
 * Detect whether a given spot label can be split by a given dimension.
 * Returns true even if some sub-buckets would be empty (UI filters those out
 * via splitLabelsBy). Mostly used to decide which menu items to enable.
 */
export function canSplitBy(label, dimension) {
  const parent = (label || '').trim().toLowerCase();
  if (!parent) return false;
  if (dimension === 'color') {
    // Don't offer color split if the label already contains a color term
    const colorTerms = ['white', 'blue', 'black', 'red', 'green', 'colorless', 'multicolor', 'multicolored'];
    return !colorTerms.some(t => new RegExp(`\\b${t}\\b`).test(parent));
  }
  if (dimension === 'supertype') {
    // Don't offer if already split by Legendary/Snow
    if (/\blegendary\b/.test(parent) || /\bsnow\b/.test(parent)) return false;
    return true;
  }
  if (dimension === 'subtype') {
    return /\benchantment\b/.test(parent) || /\bartifact\b/.test(parent);
  }
  return false;
}

/**
 * Identify R/M cards in the roster that DON'T match any of the current spots,
 * grouped by category (primary creature subtype OR non-creature subtype OR
 * card type fallback). Used by the missing-spots suggestion panel.
 *
 * @param {Object[]} rosterEntries
 * @param {Object[]} spots - Current spots (won't include suggestions for these)
 * @param {number} limit - Max suggestions to return
 * @returns Array<{ name, count, totalValue, sample: string[] }>
 */
export function unmatchedCategories(rosterEntries, spots, limit = 12) {
  const buckets = new Map(); // name → { count, value, sample: [cardName] }

  function classify(card) {
    // Front-face identity — Prepared DFCs etc. classify by front face only.
    const typeLine = frontFaceTypeLine(card);
    const isCreatureCard = typeLine.includes('creature');
    const isLegendary = /\blegendary\b/.test(typeLine);
    if (isCreatureCard) {
      // Creatures: just the primary subtype (Legendary creatures still bucket
      // by tribe in a typical Kindred break — Liliana the Last Hope is in Human
      // tribe, not a separate "Legendary Human").
      const sub = primaryCreatureSubtype(card);
      if (sub && !NON_TRIBE_TOKENS.has(sub)) return sub.charAt(0).toUpperCase() + sub.slice(1);
    }
    const subs = cardSubtypes(card);
    if (subs.length) {
      // Skip junk tokens (//, —, supertypes, etc.) so we don't suggest those.
      const goodSub = subs.find(s => s && !NON_TRIBE_TOKENS.has(s));
      if (goodSub) return goodSub.charAt(0).toUpperCase() + goodSub.slice(1);
    }
    // No subtype found — fall through to card-type bucket. Add Legendary prefix
    // when applicable so the streamer can see WHICH variant is missing (e.g.,
    // "Legendary Enchantment" vs the generic "Enchantment" that's already in
    // the spot list).
    for (const ct of ['Sorcery', 'Instant', 'Planeswalker', 'Battle', 'Artifact', 'Enchantment', 'Land']) {
      if (typeLine.includes(ct.toLowerCase())) {
        return isLegendary ? `Legendary ${ct}` : ct;
      }
    }
    return null;
  }

  function tally(card, value) {
    if (card.rarity !== 'rare' && card.rarity !== 'mythic') return;
    // Skip if any defined spot already matches
    for (const s of spots) if (cardMatchesSpot(card, s.parsed)) return;
    const cat = classify(card);
    if (!cat) return;
    if (!buckets.has(cat)) buckets.set(cat, { count: 0, value: 0, sample: [], cards: new Set() });
    const b = buckets.get(cat);
    if (!b.cards.has(card.name)) {
      b.cards.add(card.name);
      if (b.sample.length < 3) b.sample.push(card.name);
    }
    b.count++;
    b.value += value;
  }

  for (const entry of rosterEntries) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) tally(card, getCardPrice(card, finish) * entry.quantity);
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) tally(card, getCardPrice(card, !!card.__isFoil) * entry.quantity);
      continue;
    }
    const dist = distributionForEntry(entry);
    if (!dist) continue;
    const q = entry.quantity || 1;
    for (const { card, probability, isFoil } of dist) {
      tally(card, getCardPrice(card, isFoil ? 'foil' : 'nonfoil') * probability * q);
    }
  }

  return [...buckets.entries()]
    .map(([name, b]) => ({ name, count: b.count, totalValue: b.value, sample: b.sample }))
    .sort((a, b) => b.totalValue - a.totalValue || b.count - a.count)
    .slice(0, limit);
}
