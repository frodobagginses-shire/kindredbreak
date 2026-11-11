#!/usr/bin/env node
/**
 * Print the pack model the site would use for each set, with expected cards,
 * rares/mythics and EV per pack. Uses the site's own modules, so the numbers
 * match what the calculator shows.
 *
 * Usage: node tools/pack_report.mjs hob fra trk
 *
 * Calls Scryfall and MTGJSON through the site's rate limiter. Node needs a
 * descriptive User-Agent for Scryfall, which the shim below adds.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => realFetch(url, {
  ...opts,
  headers: {
    'User-Agent': 'KindredBreakCalculator-maintenance/1.0 (github.com/frodobagginses-shire/kindredbreak)',
    'Accept': 'application/json',
    ...(opts.headers || {})
  }
});

const { fetchSetCards, fetchMtgjsonBooster, getMtgjsonBoosterKeys, getCardPrice } = await import('../js/scryfall.js');
const { buildOfficialBoosterModel, hasOfficialBoosterModel } = await import('../js/booster-models.js');
const {
  MTGJSON_BOOSTER_KEYS, boosterModelHasType, buildGenericBoosterModel,
  getAllCardDistributionFromMtgjson
} = await import('../js/collation.js');

const TYPES = Object.keys(MTGJSON_BOOSTER_KEYS);
const quietLog = console.log;
console.log = (...a) => { if (!String(a[0]).startsWith('[')) quietLog(...a); };

function summarize(model, type) {
  const all = getAllCardDistributionFromMtgjson(model, type) || [];
  let cards = 0, rm = 0, rmEV = 0, bulkEV = 0;
  for (const d of all) {
    const price = getCardPrice(d.card, d.isFoil ? 'foil' : 'nonfoil');
    cards += d.probability;
    if (d.card.rarity === 'rare' || d.card.rarity === 'mythic') { rm += d.probability; rmEV += d.probability * price; }
    else bulkEV += d.probability * price;
  }
  return { cards, rm, rmEV, bulkEV };
}

const codes = process.argv.slice(2).map(c => c.toLowerCase());
if (!codes.length) {
  quietLog('Usage: node tools/pack_report.mjs <set code> [...]');
  process.exit(1);
}

for (const code of codes) {
  const cards = await fetchSetCards(code);
  const keys = await getMtgjsonBoosterKeys(code);
  const mtgjson = keys.length ? await fetchMtgjsonBooster(code) : null;
  const official = hasOfficialBoosterModel(code) ? await buildOfficialBoosterModel(code) : null;
  quietLog(`\n${code.toUpperCase()}: ${cards.length} Scryfall cards; MTGJSON booster keys: ${keys.join(', ') || 'none'}; official-odds spec: ${hasOfficialBoosterModel(code) ? 'yes' : 'no'}`);
  for (const type of TYPES) {
    let model = null, source = null;
    if (mtgjson && boosterModelHasType(mtgjson, type)) { model = mtgjson; source = 'MTGJSON'; }
    else if (official && boosterModelHasType(official, type)) { model = official; source = 'Official odds'; }
    else if (type === 'Play Booster' || type === 'Collector Booster') {
      model = buildGenericBoosterModel(type, cards, []); source = 'Estimate';
    }
    if (!model) continue;
    const s = summarize(model, type);
    quietLog(`  ${type.padEnd(26)} ${source.padEnd(13)} cards/pack ${s.cards.toFixed(2).padStart(5)}  R/M ${s.rm.toFixed(3)}  R/M EV $${s.rmEV.toFixed(2)}  bulk EV $${s.bulkEV.toFixed(2)}`);
    if (source === 'MTGJSON' && official && boosterModelHasType(official, type)) {
      const o = summarize(official, type);
      quietLog(`  ${''.padEnd(26)} (official-odds spec for comparison: R/M ${o.rm.toFixed(3)}, R/M EV $${o.rmEV.toFixed(2)})`);
    }
  }
}
