/**
 * Scryfall API Module
 * Handles all API communication with rate-limit protection and local caching.
 * Strategy: Fetch-on-Add — data is fetched when user adds a set to the roster,
 * leveraging human input speed to naturally space API calls.
 */

const API_BASE = 'https://api.scryfall.com';
const MAX_RETRIES = 3;     // total attempts for transient errors

// Scryfall's published hard limits (scryfall.com/docs/api/rate-limits):
//   /cards/search, /cards/named, /cards/random, /cards/collection → 2/second
//   everything else → 10/second
// A 429 locks the client out for 30 seconds, and repeated 429s risk a ban,
// so every request goes through one serialized gate that spaces calls per
// lane and pauses everything after a 429.
const FAST_INTERVAL_MS = 110;  // ~9 req/s
const SLOW_INTERVAL_MS = 550;  // just under 2 req/s
const RATE_LIMIT_PAUSE_MS = 30000;
const SLOW_PATHS = ['/cards/search', '/cards/named', '/cards/random', '/cards/collection'];

let lastRequestTime = 0;       // any request
let lastSlowRequestTime = 0;   // slow-lane requests only
let blockedUntil = 0;          // set after a 429
let gate = Promise.resolve();

/** Sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isSlowPath(url) {
  const path = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
  return SLOW_PATHS.some(p => path.startsWith(p));
}

/** Wait for this request's turn. Calls are serialized so parallel loads can't burst. */
function throttle(url) {
  const slow = isSlowPath(url);
  const turn = gate.then(async () => {
    let wait = Math.max(0, blockedUntil - Date.now(), lastRequestTime + FAST_INTERVAL_MS - Date.now());
    if (slow) wait = Math.max(wait, lastSlowRequestTime + SLOW_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestTime = Date.now();
    if (slow) lastSlowRequestTime = lastRequestTime;
  });
  gate = turn.catch(() => {});
  return turn;
}

/** After a 429, pause every Scryfall request (Retry-After if given, else 30s). */
function noteRateLimited(res) {
  const ra = parseFloat(res && res.headers && res.headers.get && res.headers.get('Retry-After'));
  const pause = Number.isFinite(ra) && ra > 0 ? ra * 1000 : RATE_LIMIT_PAUSE_MS;
  blockedUntil = Math.max(blockedUntil, Date.now() + pause);
  try {
    globalThis.dispatchEvent && globalThis.dispatchEvent(new CustomEvent('scryfall-ratelimit', { detail: { pauseMs: pause } }));
  } catch (_) { /* non-browser */ }
  return pause;
}

const JSON_HEADERS = { 'Accept': 'application/json' };

/**
 * Rate-limited fetch wrapper with retry/backoff.
 * Retries up to MAX_RETRIES times on:
 *   - Network-level fetch failures (Safari's "Load failed", Chrome's "Failed to fetch")
 *   - 429 rate-limit responses (after Scryfall's 30-second cool-down)
 *   - 5xx server errors
 * Doesn't retry on 4xx (real errors like 404).
 */
async function rateLimitedFetch(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle(url);

    let res;
    try {
      res = await fetch(url, { headers: JSON_HEADERS });
    } catch (e) {
      // TypeError from network failure (e.g., Safari "Load failed") — retry
      lastError = e;
      console.warn(`[Scryfall] ${url.slice(API_BASE.length)} threw "${e.message}", attempt ${attempt}/${MAX_RETRIES}`);
      if (attempt < MAX_RETRIES) await sleep(250 * Math.pow(3, attempt - 1));
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429) {
      lastError = new Error('Scryfall API error: 429');
      const pause = noteRateLimited(res);
      console.warn(`[Scryfall] ${url.slice(API_BASE.length)} → 429, pausing ${Math.round(pause / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
      continue; // the next throttle() waits out the pause
    }

    // Other 4xx are real errors (e.g. 404 for a search with no results) — don't retry
    if (res.status >= 400 && res.status < 500) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Scryfall API error ${res.status}${err.details ? `: ${err.details}` : ''}`);
    }

    // 5xx → retry with exponential backoff: 250ms, 750ms
    lastError = new Error(`Scryfall API error ${res.status}`);
    console.warn(`[Scryfall] ${url.slice(API_BASE.length)} → ${res.status}, attempt ${attempt}/${MAX_RETRIES}`);
    if (attempt < MAX_RETRIES) await sleep(250 * Math.pow(3, attempt - 1));
  }
  throw lastError || new Error('Scryfall fetch failed after retries');
}

// ─── Set Catalog Cache ───
let allSetsCache = null;
let fetchPromise = null; // Prevent duplicate concurrent fetches

/**
 * Fetch all sets from Scryfall. Cached after first call.
 * Uses a shared promise to prevent duplicate concurrent requests.
 * Returns array sorted by released_at descending.
 */
export async function fetchAllSets() {
  if (allSetsCache) return allSetsCache;

  // If a fetch is already in flight, wait for it instead of starting a new one
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const data = await rateLimitedFetch(`${API_BASE}/sets`);

      // Types to EXCLUDE (non-card sets that would just clutter results)
      const excludeTypes = new Set([
        'token', 'memorabilia', 'promo', 'vanguard', 'minigame'
      ]);

      allSetsCache = data.data
        .filter(s => {
          // Exclude non-card set types
          if (excludeTypes.has(s.set_type)) return false;
          // Exclude sets with no cards
          if (s.card_count === 0) return false;
          // Include everything else (core, expansion, masters, draft_innovation,
          // commander, funny, starter, arsenal, treasure_chest, box, alchemy,
          // masterpiece, from_the_vault, spellbook, premium_deck, duel_deck,
          // archenemy, planechase, eternal, etc.)
          return true;
        })
        .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));

      console.log(`[Scryfall] Loaded ${allSetsCache.length} sets from API`);
      return allSetsCache;
    } catch (e) {
      fetchPromise = null; // Allow retry on failure
      throw e;
    }
  })();

  return fetchPromise;
}

/**
 * Get the N most recent sets for default suggestions.
 * Filters to "major product" types that players typically buy packs from.
 */
export async function getRecentSets(count = 10) {
  const sets = await fetchAllSets();
  // For default suggestions, prioritize sets that actually have booster packs
  const boosterTypes = new Set([
    'core', 'expansion', 'draft_innovation', 'masters', 'funny', 'box', 'eternal'
  ]);
  const boosterSets = sets.filter(s => boosterTypes.has(s.set_type));
  return boosterSets.slice(0, count);
}

/**
 * Search sets by name or code. Returns all matching set types.
 */
export async function searchSets(query) {
  const sets = await fetchAllSets();
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return sets.filter(s =>
    s.name.toLowerCase().includes(q) || s.code.toLowerCase() === q || s.code.toLowerCase().startsWith(q)
  ).slice(0, 15);
}

// ─── Card Data Cache (per set code) ───
const cardCache = new Map(); // setCode -> Card[]

/**
 * Fetch ALL cards from a set using Scryfall's bulk search.
 * Handles pagination automatically.
 * Stores results in local cache keyed by set code.
 */
export async function fetchSetCards(setCode) {
  const code = setCode.toLowerCase();
  if (cardCache.has(code)) return cardCache.get(code);

  const cards = [];
  let url = `${API_BASE}/cards/search?q=e%3A${encodeURIComponent(code)}&unique=prints&order=usd&dir=desc`;

  while (url) {
    try {
      const data = await rateLimitedFetch(url);
      cards.push(...data.data);
      url = data.has_more ? data.next_page : null;
    } catch (e) {
      // If set has no cards (404), return empty
      if (e.message.includes('404')) break;
      throw e;
    }
  }

  cardCache.set(code, cards);
  console.log(`[Scryfall] Cached ${cards.length} cards for set ${code}`);
  return cards;
}

/**
 * Fetch subset cards (e.g., SPG special guests that appear in a set's packs).
 * These are fetched separately and merged.
 */
export async function fetchSubsetCards(subsetCode) {
  return fetchSetCards(subsetCode);
}

/**
 * Get cached cards for a set (returns null if not cached).
 */
export function getCachedCards(setCode) {
  return cardCache.get(setCode.toLowerCase()) || null;
}

/**
 * Get all cached set codes.
 */
export function getCachedSetCodes() {
  return [...cardCache.keys()];
}

/**
 * Get TCG Market price for a card.
 * Backward-compat: if `isFoil` is a boolean, returns nonfoil/foil price.
 * If `isFoil` is a string, treats it as a finish key:
 *   'nonfoil' → prices.usd
 *   'foil'    → prices.usd_foil
 *   'etched'  → prices.usd_etched (rainbow foil)
 * Falls back across price tiers if the requested one is missing.
 */
export function getCardPrice(card, isFoil = false) {
  if (!card || !card.prices) return 0;
  let finish;
  if (typeof isFoil === 'string') finish = isFoil;
  else finish = isFoil ? 'foil' : 'nonfoil';

  const p = card.prices;
  if (finish === 'etched') {
    return parseFloat(p.usd_etched) || parseFloat(p.usd_foil) || parseFloat(p.usd) || 0;
  }
  if (finish === 'foil') {
    return parseFloat(p.usd_foil) || parseFloat(p.usd) || 0;
  }
  return parseFloat(p.usd) || 0;
}

/**
 * Determine which booster types exist for a given set.
 * Based on set release date and type.
 */
export function getAvailableBoosterTypes(setInfo) {
  const types = [];
  const releaseDate = new Date(setInfo.released_at);
  const feb2024 = new Date('2024-02-01');
  const setType = setInfo.set_type;
  const code = String(setInfo.code || '').toLowerCase();

  // Commander precons don't have standard boosters
  if (setType === 'commander') {
    return ['Draft Booster'];
  }

  if (releaseDate >= feb2024) {
    // Post-MKM: Play Boosters replaced Draft & Set
    types.push('Play Booster');
    types.push('Collector Booster');
  } else if (releaseDate >= new Date('2020-09-01')) {
    // ZNR onward had Set Boosters alongside Draft
    types.push('Draft Booster');
    types.push('Set Booster');
    types.push('Collector Booster');
  } else if (releaseDate >= new Date('2019-01-01')) {
    types.push('Draft Booster');
    types.push('Collector Booster');
  } else {
    types.push('Draft Booster');
  }

  // Marvel Super Heroes ships Marvel Jumpstart packs alongside Play/Collector.
  // The label routes through MTGJSON_BOOSTER_KEYS to MTGJSON's 'jumpstart'
  // booster (now published); the PACK_PROFILES entry is only a fallback.
  if (code === 'msh') {
    types.push('Marvel Jumpstart Booster');
  }

  return types;
}

/**
 * Look up set info by code from the cached set list.
 */
export async function getSetInfo(setCode) {
  const sets = await fetchAllSets();
  return sets.find(s => s.code.toLowerCase() === setCode.toLowerCase()) || null;
}

// ─── Secret Lair Drop Support ───
//
// The `sld` master set contains all Secret Lair cards mixed together.
// We group cards into drops using a static collector_number → drop name
// lookup table built from MTGJSON's `subsets` field (canonical naming).
// Cards without a subset entry are grouped by source_uri / released_at
// as a fallback.

let sldDropsCache = null;
let sldNameLookup = null;       // collector_number → drop name (from sld-drops.json)
let sldNameLookupLoaded = null;  // promise

/**
 * Lazy-load the static SLD name lookup file.
 * Map of collector_number → canonical drop name (from MTGJSON subsets).
 */
async function loadSldNameLookup() {
  if (sldNameLookup) return sldNameLookup;
  if (sldNameLookupLoaded) return sldNameLookupLoaded;
  sldNameLookupLoaded = (async () => {
    // 1. Prefer inlined global (set by the bundler) — works under file:// where fetch is blocked
    if (typeof globalThis !== 'undefined' && globalThis.__SLD_DROP_LOOKUP__) {
      sldNameLookup = globalThis.__SLD_DROP_LOOKUP__;
      console.log(`[Scryfall] Using inlined SLD lookup (${Object.keys(sldNameLookup).length} entries)`);
      return sldNameLookup;
    }
    // 2. Otherwise try fetching the JSON file (works under HTTP/HTTPS)
    try {
      const res = await fetch('./js/sld-drops.json');
      if (!res.ok) throw new Error(`status ${res.status}`);
      sldNameLookup = await res.json();
      console.log(`[Scryfall] Fetched ${Object.keys(sldNameLookup).length} SLD name mappings`);
    } catch (e) {
      console.warn('[Scryfall] Could not load sld-drops.json — falling back to URL-slug names:', e.message);
      sldNameLookup = {};
    }
    return sldNameLookup;
  })();
  return sldNameLookupLoaded;
}

/**
 * Fetch and group all Secret Lair Drops.
 * Returns drops sorted by releasedAt descending.
 */
export async function fetchSecretLairDrops() {
  if (sldDropsCache) return sldDropsCache;

  const [cards, nameLookup] = await Promise.all([
    fetchSetCards('sld'),
    loadSldNameLookup()
  ]);

  const groups = new Map();

  for (const c of cards) {
    // Priority: canonical subset name → source_uri → released_at fallback
    const subsetName = nameLookup[c.collector_number];
    const sourceUri = c.preview && c.preview.source_uri ? c.preview.source_uri : null;
    const key = subsetName || sourceUri || `released:${c.released_at || 'unknown'}`;
    const name = subsetName || deriveDropNameFromUri(sourceUri) || `Drop ${c.released_at || 'unknown'}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        canonicalName: !!subsetName, // true if name came from MTGJSON subsets
        sourceUri,
        releasedAt: c.released_at || null,
        previewedAt: (c.preview && c.preview.previewed_at) || null,
        cards: []
      });
    }
    groups.get(key).cards.push(c);
  }

  const drops = [];
  for (const g of groups.values()) {
    const finishes = computeAvailableFinishes(g.cards);
    drops.push({
      ...g,
      cardCount: g.cards.length,
      hasNonfoil: finishes.has('nonfoil'),
      hasFoil: finishes.has('foil'),
      hasEtched: finishes.has('etched')
    });
  }

  drops.sort((a, b) => (b.releasedAt || '').localeCompare(a.releasedAt || ''));
  sldDropsCache = drops;
  console.log(`[Scryfall] Grouped ${cards.length} SLD cards into ${drops.length} drops (canonical names: ${drops.filter(d => d.canonicalName).length})`);
  return drops;
}

/**
 * Search Secret Lair drops by name. Case-insensitive substring match.
 */
export async function searchSecretLairDrops(query) {
  const drops = await fetchSecretLairDrops();
  const q = (query || '').toLowerCase().trim();
  if (!q) return drops.slice(0, 30);
  return drops.filter(d => d.name.toLowerCase().includes(q)).slice(0, 30);
}

/**
 * Compute which finishes are available across a group of cards.
 * Returns a Set with any of: 'nonfoil', 'foil', 'etched'.
 */
function computeAvailableFinishes(cards) {
  const set = new Set();
  for (const c of cards) {
    if (Array.isArray(c.finishes)) {
      for (const f of c.finishes) set.add(f);
    } else {
      if (c.nonfoil) set.add('nonfoil');
      if (c.foil) set.add('foil');
    }
  }
  return set;
}

/**
 * Derive a fallback drop name from a Wizards announcement URL slug.
 * Used only when the MTGJSON canonical name is missing.
 */
function deriveDropNameFromUri(sourceUri) {
  if (!sourceUri) return null;
  const m = sourceUri.replace(/\/+$/, '').match(/\/([^\/]+)$/);
  if (!m) return null;
  let slug = m[1].replace(/-decklist$/i, '').replace(/^secret-lair[-:]?/i, '');
  const pretty = slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return pretty || null;
}

// ─── Authoritative Booster Model (MTGJSON) ───
//
// MTGJSON publishes per-set booster definitions: a list of "variants" (each
// with a weight) and "sheets" (each with weighted card entries). This is the
// real WotC pack composition, including bonus-sheet slots, special guest
// rates, silverscroll/etched probabilities — none of which the simplified
// model in collation.js captures correctly.
//
// fetchMtgjsonBooster(setCode) returns:
//   { play: { variants, totalWeight, sheets: { name: { entries:[{card,weight}], totalWeight, foil } } },
//     collector: { ... }, draft: { ... }, set: { ... } }
// or null when MTGJSON has no booster data for the set.

const mtgjsonSetCache = new Map();   // upperCode → mtgjson data, or null on miss
const mtgjsonBoosterCache = new Map(); // upperCode → resolved booster model

async function fetchMtgjsonSet(code) {
  const u = code.toUpperCase();
  if (mtgjsonSetCache.has(u)) return mtgjsonSetCache.get(u);

  const url = `${MTGJSON_BASE}/${u}.json`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 404 → set just doesn't have MTGJSON data; don't retry
        if (res.status === 404) {
          mtgjsonSetCache.set(u, null);
          return null;
        }
        // Other non-OK: retry if 5xx/429, else give up
        if (res.status >= 500 || res.status === 429) {
          console.warn(`[MTGJSON] ${u} status ${res.status}, attempt ${attempt}/${MAX_RETRIES}`);
          if (attempt < MAX_RETRIES) {
            await sleep(250 * Math.pow(3, attempt - 1));
            continue;
          }
        }
        throw new Error(`status ${res.status}`);
      }
      const json = await res.json();
      mtgjsonSetCache.set(u, json.data || null);
      return mtgjsonSetCache.get(u);
    } catch (e) {
      // Network failure — retry
      console.warn(`[MTGJSON] ${u} threw "${e.message}", attempt ${attempt}/${MAX_RETRIES}`);
      if (attempt < MAX_RETRIES) {
        await sleep(250 * Math.pow(3, attempt - 1));
        continue;
      }
      // Final fallback: cache null so we don't retry forever, return null
      mtgjsonSetCache.set(u, null);
      return null;
    }
  }
  mtgjsonSetCache.set(u, null);
  return null;
}

/**
 * Booster type keys MTGJSON publishes for a set (e.g. ['play', 'collector',
 * 'box-topper']) without resolving any cards. Shares fetchMtgjsonSet's cache.
 */
export async function getMtgjsonBoosterKeys(setCode) {
  const main = await fetchMtgjsonSet(setCode);
  return main && main.booster ? Object.keys(main.booster) : [];
}

/**
 * Build a fully-resolved booster model for a set: every UUID in every sheet
 * is mapped to its Scryfall card. Returns null if MTGJSON has no booster
 * data for the set.
 */
export async function fetchMtgjsonBooster(setCode) {
  const u = setCode.toUpperCase();
  if (mtgjsonBoosterCache.has(u)) return mtgjsonBoosterCache.get(u);

  const main = await fetchMtgjsonSet(u);
  if (!main || !main.booster) {
    mtgjsonBoosterCache.set(u, null);
    return null;
  }

  // 1. UUID lookup, starting with primary set's cards
  const cardByUuid = new Map();
  for (const c of (main.cards || [])) cardByUuid.set(c.uuid, c);

  // 2. Discover unresolved UUIDs across all booster types' sheets
  const allUuids = new Set();
  for (const btKey of Object.keys(main.booster)) {
    const sheets = (main.booster[btKey] || {}).sheets || {};
    for (const sn of Object.keys(sheets)) {
      for (const uuid of Object.keys(sheets[sn].cards || {})) allUuids.add(uuid);
    }
  }
  const externalUuids = [...allUuids].filter(uuid => !cardByUuid.has(uuid));

  // 3. Resolve unknowns by fetching candidate subset sets:
  //    - Scryfall children (parent_set_code === u)
  //    - Hardcoded SPG-style outsiders
  if (externalUuids.length > 0) {
    const candidateCodes = await discoverSubsetCodes(u);
    for (const sub of candidateCodes) {
      if (externalUuids.every(id => cardByUuid.has(id))) break;
      const subData = await fetchMtgjsonSet(sub);
      if (subData) {
        for (const c of (subData.cards || [])) cardByUuid.set(c.uuid, c);
      }
    }
  }

  // 4. Collect all needed Scryfall IDs
  const sfIds = new Set();
  for (const uuid of allUuids) {
    const c = cardByUuid.get(uuid);
    const sfId = c && c.identifiers && c.identifiers.scryfallId;
    if (sfId) sfIds.add(sfId);
  }

  // 5. Batch-resolve Scryfall data
  const sfById = await fetchScryfallByIds([...sfIds]);

  // 6. Translate booster definition into a usable model
  const result = {};
  for (const btKey of Object.keys(main.booster)) {
    const def = main.booster[btKey];
    const sheets = {};
    for (const [sn, sh] of Object.entries(def.sheets || {})) {
      const entries = [];
      for (const [uuid, weight] of Object.entries(sh.cards || {})) {
        const mtgj = cardByUuid.get(uuid);
        const sfId = mtgj && mtgj.identifiers && mtgj.identifiers.scryfallId;
        const sf = sfId ? sfById.get(sfId) : null;
        if (!sf) continue;
        entries.push({ card: sf, weight: Number(weight) || 0 });
      }
      const totalWeight = sh.totalWeight || entries.reduce((s, e) => s + e.weight, 0);
      // fixed: always the same cards (echoed pairs, Jumpstart themes).
      // allowDuplicates: a card may repeat within one pack (MTGJSON default: no).
      sheets[sn] = {
        entries, totalWeight, foil: !!sh.foil,
        fixed: !!sh.fixed, allowDuplicates: !!sh.allowDuplicates
      };
    }
    const variants = (def.boosters || []).map(b => ({
      weight: Number(b.weight) || 0,
      contents: b.contents || {}
    }));
    const totalWeight = def.boostersTotalWeight || variants.reduce((s, v) => s + v.weight, 0);
    result[btKey] = { variants, totalWeight, sheets };
  }

  console.log(`[MTGJSON] Resolved booster model for ${u}: ${Object.keys(result).join(', ')}`);
  mtgjsonBoosterCache.set(u, result);
  return result;
}

/**
 * Discover candidate subset set codes for a primary set:
 * - Scryfall sets where parent_set_code === setCode (e.g. SOS → SOA, SOC)
 * - Common cross-set subsets (SPG = Special Guests)
 * - Hardcoded mappings for masterpiece-style bonus sheets that Scryfall
 *   doesn't link via parent_set_code (e.g. SPM ↔ MAR).
 */
async function discoverSubsetCodes(setCode) {
  const lower = setCode.toLowerCase();
  const codes = [];
  try {
    const sets = await fetchAllSets();
    for (const s of sets) {
      if ((s.parent_set_code || '').toLowerCase() === lower) {
        codes.push(s.code.toLowerCase());
      }
    }
  } catch (_) { /* ignore */ }
  // Always try SPG (Special Guests) as a candidate
  if (!codes.includes('spg')) codes.push('spg');
  // Cross-set bonus sheets that don't follow parent_set_code:
  for (const c of (UNPARENTED_BONUS_SETS[lower] || [])) {
    if (!codes.includes(c)) codes.push(c);
  }
  return codes;
}

// Bonus / masterpiece sets that Scryfall lists as standalone (no
// parent_set_code) even though they're tied to a host expansion.
// Add new entries here as Wizards releases more cross-set bonuses.
const UNPARENTED_BONUS_SETS = {
  'spm': ['mar'],   // Marvel's Spider-Man → Marvel Universe masterpiece
  'msh': ['mar'],   // Marvel Super Heroes → Marvel Universe masterpiece (likely)
};

// ─── Commander Precon Support ───
//
// Commander precons live in Scryfall under set_type:'commander' (one set per
// product). Newer precons have full decklists in MTGJSON; older precons may
// only have face-card data. We fetch MTGJSON's set JSON for full decks when
// available and fall back to Scryfall's set cards otherwise.

const MTGJSON_BASE = 'https://mtgjson.com/api/v5';
let preconListCache = null;

/**
 * List all known commander precon sets.
 * Returns an array of Scryfall set objects sorted by release date desc.
 */
export async function fetchCommanderPrecons() {
  if (preconListCache) return preconListCache;
  const sets = await fetchAllSets();
  preconListCache = sets
    .filter(s => s.set_type === 'commander' && (s.card_count || 0) > 0)
    .sort((a, b) => (b.released_at || '').localeCompare(a.released_at || ''));
  return preconListCache;
}

/**
 * Search commander precons by set name. Case-insensitive substring match.
 */
export async function searchCommanderPrecons(query) {
  const list = await fetchCommanderPrecons();
  const q = (query || '').toLowerCase().trim();
  if (!q) return list.slice(0, 30);
  return list.filter(s => s.name.toLowerCase().includes(q) || s.code.toLowerCase().startsWith(q)).slice(0, 30);
}

/**
 * Fetch deck contents for a commander precon set.
 *
 * Returns: { decks: [{ name, cards: [card,...] }], source: 'mtgjson'|'scryfall_fallback' }
 *
 * - Tries MTGJSON first (full 100-card decklists, including reprints).
 * - Falls back to Scryfall's set cards (typically only the new face cards) if
 *   MTGJSON has no deck data for the set.
 *
 * Card objects in returned decks have Scryfall fields where possible
 * (collector_number, prices, image_uris, name, rarity).
 */
export async function fetchPreconDecks(setCode) {
  const code = setCode.toLowerCase();

  // 1. Try MTGJSON for full decklists
  let mtgjsonDecks = null;
  try {
    const url = `${MTGJSON_BASE}/${code.toUpperCase()}.json`;
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      if (j && j.data && Array.isArray(j.data.decks) && j.data.decks.length > 0) {
        mtgjsonDecks = { setData: j.data };
      }
    }
  } catch (e) {
    console.warn(`[MTGJSON] fetch failed for ${code}:`, e.message);
  }

  if (mtgjsonDecks) {
    try {
      const decks = await resolveDecksViaMtgjson(mtgjsonDecks.setData);
      // If resolveDecksViaMtgjson succeeded but ALL decks are empty (network blip
      // resolving Scryfall card data), fall through to face-cards fallback.
      const anyCards = decks.some(d => d.cards && d.cards.length > 0);
      if (anyCards) return { decks, source: 'mtgjson' };
      console.warn(`[Precon] MTGJSON decks for ${code} resolved 0 cards — falling back to Scryfall`);
    } catch (e) {
      console.warn(`[Precon] MTGJSON resolution for ${code} threw, falling back:`, e.message);
    }
  }

  // 2. Fallback: Scryfall set cards (face cards only)
  const cards = await fetchSetCards(code);
  return {
    decks: [{ name: 'Face Cards Only (no full decklist available)', cards: cards.slice() }],
    source: 'scryfall_fallback'
  };
}

/**
 * Resolve MTGJSON deck UUIDs to Scryfall card objects (for prices/images).
 * Uses /cards/collection batch endpoint (75 IDs per call).
 */
async function resolveDecksViaMtgjson(mtgjsonSetData) {
  const cardsByUuid = new Map();
  for (const c of (mtgjsonSetData.cards || [])) {
    cardsByUuid.set(c.uuid, c);
  }

  // Collect all unique scryfallIds across all decks
  const allScryfallIds = new Set();
  const deckRequests = [];

  for (const deck of mtgjsonSetData.decks) {
    const entries = [
      ...(deck.commander || []).map(e => ({ ...e, kind: 'commander' })),
      ...(deck.mainBoard || []).map(e => ({ ...e, kind: 'main' })),
      ...(deck.sideBoard || []).map(e => ({ ...e, kind: 'side' }))
    ];
    const items = [];
    for (const entry of entries) {
      const mtgjCard = cardsByUuid.get(entry.uuid);
      if (!mtgjCard) continue;
      const sfId = mtgjCard.identifiers && mtgjCard.identifiers.scryfallId;
      if (!sfId) continue;
      allScryfallIds.add(sfId);
      items.push({ scryfallId: sfId, count: entry.count || 1, isFoil: !!entry.isFoil, mtgjCard });
    }
    deckRequests.push({ name: deck.name, items });
  }

  // Batch fetch from Scryfall's /cards/collection
  const idArray = [...allScryfallIds];
  const sfById = await fetchScryfallByIds(idArray);

  // Reassemble decks with Scryfall card data
  const decks = [];
  for (const req of deckRequests) {
    const cards = [];
    for (const item of req.items) {
      const sfCard = sfById.get(item.scryfallId);
      if (!sfCard) continue;
      // Expand by count: each copy is a separate "opened card" so the spot rule sums correctly
      for (let i = 0; i < item.count; i++) {
        cards.push(sfCard);
      }
    }
    decks.push({ name: req.name, cards });
  }
  return decks;
}

/**
 * Batch-fetch Scryfall cards by Scryfall ID using /cards/collection.
 * Accepts up to 75 IDs per request. Returns a Map<id, card>.
 */
async function fetchScryfallByIds(ids) {
  const result = new Map();
  // Most sheet cards are already cached from fetchSetCards (the roster loads
  // the set's cards before its booster model), so only ask /cards/collection
  // for the rest. That endpoint is limited to 2 requests/second.
  const known = new Map();
  for (const cards of cardCache.values()) for (const c of cards) known.set(c.id, c);
  const missing = [];
  for (const id of ids) {
    if (known.has(id)) result.set(id, known.get(id));
    else missing.push(id);
  }

  for (let i = 0; i < missing.length; i += 75) {
    const chunk = missing.slice(i, i + 75);
    const body = { identifiers: chunk.map(id => ({ id })) };
    const url = `${API_BASE}/cards/collection`;

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !success; attempt++) {
      await throttle(url);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          if (res.status === 429) {
            const pause = noteRateLimited(res);
            console.warn(`[Scryfall] /cards/collection batch ${i}-${i + chunk.length} → 429, pausing ${Math.round(pause / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`);
            continue;
          }
          if (res.status >= 400 && res.status < 500) {
            console.warn(`[Scryfall] /cards/collection batch ${i}-${i + chunk.length} failed: ${res.status}`);
            break; // don't retry 4xx
          }
          console.warn(`[Scryfall] /cards/collection batch ${i}-${i + chunk.length} status ${res.status}, attempt ${attempt}/${MAX_RETRIES}`);
          if (attempt < MAX_RETRIES) await sleep(250 * Math.pow(3, attempt - 1));
          continue;
        }
        const data = await res.json();
        for (const card of (data.data || [])) result.set(card.id, card);
        success = true;
      } catch (e) {
        console.warn(`[Scryfall] /cards/collection batch ${i}-${i + chunk.length} threw "${e.message}", attempt ${attempt}/${MAX_RETRIES}`);
        if (attempt < MAX_RETRIES) await sleep(250 * Math.pow(3, attempt - 1));
      }
    }
  }
  return result;
}
