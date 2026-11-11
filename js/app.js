/**
 * MTG Kindred Break Calculator — Main Application
 *
 * Cards are sorted into user-defined named kindred/type spots using a
 * priority-ordered expression matcher (combined OR, multi-condition AND,
 * exclusions). The roster supports boosters, Secret Lair Drops, and
 * Commander Precons side-by-side.
 */

import {
  fetchAllSets, getRecentSets, searchSets,
  fetchSetCards, fetchSubsetCards, getAvailableBoosterTypes,
  getCardPrice, getSetInfo,
  fetchSecretLairDrops, searchSecretLairDrops,
  fetchCommanderPrecons, searchCommanderPrecons, fetchPreconDecks,
  fetchMtgjsonBooster, getMtgjsonBoosterKeys
} from './scryfall.js';

import { getPackCardCount, boosterModelHasType, buildGenericBoosterModel } from './collation.js';

import { buildOfficialBoosterModel, hasOfficialBoosterModel, officialModelSource } from './booster-models.js';

import {
  parseSpotLabel, cardMatchesSpot, calculateGlobalEV, calculateBulkEV, distributionForEntry,
  simulateBreak, analyzeSpotDistribution, expectedInsuranceImpact,
  autoTabulate, unmatchedCategories,
  seedCategoryLabels, splitLabelsBy, canSplitBy, trySimplifyMergedLabel
} from './simulation.js';

// ─── State ───
const state = {
  roster: [],
  spots: [],               // [{ id, label, parsed }] — user-defined, priority-ordered
  viewMode: 'builder',     // 'buyer' (Break Tracker) | 'builder' (Break Builder, default)
  starTiers: { three: 10, two: 20, one: 30, notable: 20 },
  starLabels: { three: '⭐⭐⭐', two: '⭐⭐', one: '⭐' },
  hitSpots: new Set(),     // Set of spot IDs marked as already pulled
  selectedSpotIds: new Set(), // Set of spot IDs currently checked for Merge Selected
  rosterLocked: false,     // Toggled by Lock Roster button. While locked, roster controls are disabled.
  lastDistribution: null,  // cached analyzeSpotDistribution result
  productType: 'booster',  // 'booster' | 'secret_lair' | 'commander_precon'
  selectedSet: null,
  selectedDrop: null,
  selectedPrecon: null,
  selectedPreconDeck: null,
  preconDecks: null,
  setsLoaded: false,
  sldDropsLoaded: false,
  preconsLoaded: false,
  nextRosterId: 1,
  nextSpotId: 1,
  showNotesEdited: false   // true once user types into the show-notes textarea; refreshBuilderView won't overwrite
};

// ─── DOM References ───
const $ = id => document.getElementById(id);

const dom = {
  // Product type toggle
  productBoosterBtn: $('product-booster-btn'),
  productSldBtn: $('product-sld-btn'),
  productPreconBtn: $('product-precon-btn'),
  boosterControls: $('booster-controls'),
  sldControls: $('sld-controls'),
  preconControls: $('precon-controls'),

  // Booster roster inputs
  rosterQty: $('roster-qty'),
  rosterSet: $('roster-set'),
  rosterPack: $('roster-pack'),
  setSuggestions: $('set-suggestions'),
  addRosterBtn: $('add-roster-btn'),

  // SLD roster inputs
  sldQty: $('sld-qty'),
  sldDrop: $('sld-drop'),
  dropSuggestions: $('drop-suggestions'),
  sldFinishRadios: () => document.querySelectorAll('input[name="sld-finish"]'),
  sldFinishGroup: $('sld-finish-group'),
  addSldBtn: $('add-sld-btn'),

  // Precon roster inputs
  preconQty: $('precon-qty'),
  preconSet: $('precon-set'),
  preconSuggestions: $('precon-suggestions'),
  preconDeck: $('precon-deck'),
  addPreconBtn: $('add-precon-btn'),

  // Roster table
  rosterTbody: $('roster-tbody'),
  rosterEmpty: $('roster-empty'),
  totalPacks: $('total-packs'),
  totalCardsEst: $('total-cards-est'),

  // Spot definition
  spotName: $('spot-name'),
  addSpotBtn: $('add-spot-btn'),
  massEntry: $('mass-entry'),
  parseMassBtn: $('parse-mass-btn'),
  autoTabulateBtn: $('auto-tabulate-btn'),
  lockRosterBtn:     $('lock-roster-btn'),
  lockRosterStatus:  $('lock-roster-status'),
  mergeSpotsBtn:     $('merge-spots-btn'),
  sortSpotsEvBtn:    $('sort-spots-ev-btn'),
  sortSpotsAlphaBtn: $('sort-spots-alpha-btn'),
  sortSpotsTypeBtn:  $('sort-spots-type-btn'),
  spotsList: $('spots-list'),
  spotsCount: $('spots-count'),
  clearSpotsBtn: $('clear-spots-btn'),
  spotsHelpBtn: $('spots-help-btn'),

  // Distribution & EV (tracker)
  analyzeBtn: $('analyze-btn'),
  clearHitsBtn: $('clear-hits-btn'),
  hitCountDisplay: $('hit-count-display'),
  spotTableWrapper: $('spot-table-wrapper'),
  trackerTbody: $('tracker-tbody'),
  heatmapSummary: $('heatmap-summary'),
  packInsurance: $('pack-insurance'),
  calcEvBtn: $('calc-ev-btn'),
  simulateBtn: $('simulate-btn'),
  globalEvDisplay: $('global-ev-display'),
  totalEv: $('total-ev'),
  perSpotEv: $('per-spot-ev'),

  // Simulation results
  simResults: $('sim-results'),
  simSpotsGrid: $('sim-spots-grid'),

  // Tabs + panels
  tabBuyerBtn: $('tab-buyer-btn'),
  tabBuilderBtn: $('tab-builder-btn'),
  buyerPanel: $('buyer-panel'),
  builderPanel: $('builder-panel'),

  // Builder controls
  demoBtn: $('demo-btn'),
  builderInsurance: $('builder-insurance'),
  builderTotalCost: $('builder-total-cost'),
  builderInsuranceCost: $('builder-insurance-cost'),
  builderInsuranceDetail: $('builder-insurance-detail'),
  builderPerSpotCost: $('builder-per-spot-cost'),
  builderTotalEv: $('builder-total-ev'),
  tierThree: $('tier-three'),
  tierTwo: $('tier-two'),
  tierOne: $('tier-one'),
  notableThreshold: $('notable-threshold'),
  rebuildLabelsBtn: $('rebuild-labels-btn'),
  builderTbody: $('builder-tbody'),
  builderEmpty: $('builder-empty'),
  copyAllLabelsBtn: $('copy-all-labels-btn'),
  sortAssistantBtn: $('download-sort-assistant-btn'),
  showNotesText: $('shownotes-text'),
  regenShowNotesBtn: $('regen-shownotes-btn'),
  copyShowNotesBtn: $('copy-shownotes-btn'),

  // Misc
  loadingOverlay: $('loading-overlay'),
  loadingText: $('loading-text'),
  toastContainer: $('toast-container')
};

// ─── Utilities ───
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showLoading(text = 'Loading...') {
  dom.loadingText.textContent = text;
  dom.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  dom.loadingOverlay.classList.add('hidden');
}

function formatPrice(val) {
  return '$' + (val || 0).toFixed(2);
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function rosterIsReady() {
  return state.roster.length > 0 && state.roster.every(r => r.status === 'cached');
}

function updateButtonStates() {
  const ready = rosterIsReady();
  dom.analyzeBtn.disabled = !ready;
  dom.calcEvBtn.disabled = !ready;
  dom.simulateBtn.disabled = !ready;
  if (dom.autoTabulateBtn) dom.autoTabulateBtn.disabled = !ready;
  if (dom.lockRosterBtn) dom.lockRosterBtn.disabled = !ready;
  const canSort = ready && state.spots.length >= 2;
  if (dom.sortSpotsEvBtn)    dom.sortSpotsEvBtn.disabled    = !canSort;
  if (dom.sortSpotsAlphaBtn) dom.sortSpotsAlphaBtn.disabled = !canSort;
  if (dom.sortSpotsTypeBtn)  dom.sortSpotsTypeBtn.disabled  = !canSort;
  // Refresh suggestion panel whenever roster readiness changes
  if (typeof renderMissingSpots === 'function') renderMissingSpots();
}

// ─── Product Type Toggle ───
function setProductType(type) {
  state.productType = type;
  dom.productBoosterBtn.classList.toggle('active', type === 'booster');
  dom.productSldBtn.classList.toggle('active', type === 'secret_lair');
  dom.productPreconBtn.classList.toggle('active', type === 'commander_precon');
  dom.boosterControls.classList.toggle('hidden', type !== 'booster');
  dom.sldControls.classList.toggle('hidden', type !== 'secret_lair');
  dom.preconControls.classList.toggle('hidden', type !== 'commander_precon');
}
dom.productBoosterBtn.addEventListener('click', () => setProductType('booster'));
dom.productSldBtn.addEventListener('click', () => {
  setProductType('secret_lair');
  if (!state.sldDropsLoaded) loadSldDrops();
});
dom.productPreconBtn.addEventListener('click', () => {
  setProductType('commander_precon');
  if (!state.preconsLoaded) loadPrecons();
});

async function loadSldDrops() {
  try {
    showLoading('Loading Secret Lair drops from Scryfall + MTGJSON...');
    await fetchSecretLairDrops();
    state.sldDropsLoaded = true;
    hideLoading();
    showToast('Secret Lair drops loaded — start typing to search', 'success');
  } catch (e) {
    hideLoading();
    showToast(`Failed to load Secret Lair drops: ${e.message}`, 'error');
    console.error('[SLD]', e);
  }
}

async function loadPrecons() {
  try {
    showLoading('Loading Commander precons from Scryfall...');
    await fetchCommanderPrecons();
    state.preconsLoaded = true;
    hideLoading();
    showToast('Commander precons loaded — start typing to search', 'success');
  } catch (e) {
    hideLoading();
    showToast(`Failed to load precons: ${e.message}`, 'error');
    console.error('[Precon]', e);
  }
}

// ─── Set Autocomplete (Booster path) ───
let setSuggestionsVisible = false;
let activeSetIdx = -1;
let currentSetSuggestions = [];
let setBlurTimeout = null;

async function showDefaultSetSuggestions() {
  if (!state.setsLoaded) {
    try { await fetchAllSets(); state.setsLoaded = true; }
    catch (e) { showToast('Could not load sets from Scryfall.', 'error'); return; }
  }
  try { renderSetSuggestions(await getRecentSets(10)); }
  catch (e) { console.error('[Autocomplete]', e); }
}

async function handleSetInput() {
  const query = dom.rosterSet.value.trim();
  state.selectedSet = null;
  dom.rosterPack.innerHTML = '<option value="">Select a set first</option>';
  dom.rosterPack.disabled = true;
  dom.addRosterBtn.disabled = true;
  if (!query) { await showDefaultSetSuggestions(); return; }
  try { renderSetSuggestions(await searchSets(query)); }
  catch (e) { console.error('[Autocomplete]', e); }
}
const debouncedHandleSetInput = debounce(handleSetInput, 150);

function renderSetSuggestions(sets) {
  currentSetSuggestions = sets;
  activeSetIdx = -1;
  dom.setSuggestions.innerHTML = '';
  if (!sets || !sets.length) {
    dom.setSuggestions.classList.add('hidden');
    setSuggestionsVisible = false;
    return;
  }
  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerHTML = `<span>${escHtml(s.name)} <span class="suggestion-code">(${escHtml(s.code.toLowerCase())})</span></span>`;
    div.addEventListener('mousedown', (e) => { e.preventDefault(); selectSet(s); });
    dom.setSuggestions.appendChild(div);
  }
  dom.setSuggestions.classList.remove('hidden');
  setSuggestionsVisible = true;
}

function selectSet(setData) {
  state.selectedSet = { code: setData.code, name: setData.name, setInfo: setData };
  dom.rosterSet.value = `${setData.name} (${setData.code.toLowerCase()})`;
  dom.setSuggestions.classList.add('hidden');
  setSuggestionsVisible = false;
  const types = getAvailableBoosterTypes(setData);
  dom.rosterPack.innerHTML = '';
  for (const t of types) {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    dom.rosterPack.appendChild(opt);
  }
  dom.rosterPack.disabled = false;
  dom.addRosterBtn.disabled = false;
  offerExtraPackTypes(setData.code);
}

/**
 * Some sets have extra sealed contents in their booster model (e.g. The
 * Hobbit's box topper). Check the set's MTGJSON model in the background and
 * append those pack types to the dropdown if the same set is still selected.
 */
async function offerExtraPackTypes(code) {
  try {
    const keys = await getMtgjsonBoosterKeys(code);
    if (!state.selectedSet || state.selectedSet.code !== code) return;
    if (keys.includes('box-topper')
        && ![...dom.rosterPack.options].some(o => o.value === 'Box Topper')) {
      const opt = document.createElement('option');
      opt.value = 'Box Topper';
      opt.textContent = 'Box Topper (1 per sealed box)';
      dom.rosterPack.appendChild(opt);
    }
  } catch (_) { /* optional extra; ignore */ }
}

dom.rosterSet.addEventListener('focus', () => {
  clearTimeout(setBlurTimeout);
  if (!dom.rosterSet.value.trim() || state.selectedSet) showDefaultSetSuggestions();
  else if (currentSetSuggestions.length > 0) {
    dom.setSuggestions.classList.remove('hidden');
    setSuggestionsVisible = true;
  } else handleSetInput();
});
dom.rosterSet.addEventListener('input', () => {
  state.selectedSet = null;
  dom.rosterPack.innerHTML = '<option value="">Select a set first</option>';
  dom.rosterPack.disabled = true;
  dom.addRosterBtn.disabled = true;
  debouncedHandleSetInput();
});
dom.rosterSet.addEventListener('blur', () => {
  setBlurTimeout = setTimeout(() => {
    dom.setSuggestions.classList.add('hidden');
    setSuggestionsVisible = false;
  }, 250);
});
dom.rosterSet.addEventListener('keydown', (e) => {
  if (!setSuggestionsVisible || !currentSetSuggestions.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSetIdx = Math.min(activeSetIdx + 1, currentSetSuggestions.length - 1);
    updateActiveSetSuggestion();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSetIdx = Math.max(activeSetIdx - 1, -1);
    updateActiveSetSuggestion();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSetIdx >= 0 && currentSetSuggestions[activeSetIdx]) selectSet(currentSetSuggestions[activeSetIdx]);
  } else if (e.key === 'Escape') {
    dom.setSuggestions.classList.add('hidden');
    setSuggestionsVisible = false;
  }
});

function updateActiveSetSuggestion() {
  const items = dom.setSuggestions.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => {
    item.classList.toggle('active', i === activeSetIdx);
    if (i === activeSetIdx) item.scrollIntoView({ block: 'nearest' });
  });
}

// ─── Drop Autocomplete (SLD path) ───
let dropSuggestionsVisible = false;
let activeDropIdx = -1;
let currentDropSuggestions = [];
let dropBlurTimeout = null;

async function showDefaultDropSuggestions() {
  if (!state.sldDropsLoaded) await loadSldDrops();
  try { renderDropSuggestions(await searchSecretLairDrops('')); }
  catch (e) { console.error('[SLD]', e); }
}

async function handleDropInput() {
  const query = dom.sldDrop.value.trim();
  state.selectedDrop = null;
  for (const r of dom.sldFinishRadios()) { r.checked = false; r.disabled = true; }
  dom.addSldBtn.disabled = true;
  if (!state.sldDropsLoaded) { await loadSldDrops(); }
  try { renderDropSuggestions(await searchSecretLairDrops(query)); }
  catch (e) { console.error('[SLD]', e); }
}
const debouncedHandleDropInput = debounce(handleDropInput, 150);

function renderDropSuggestions(drops) {
  currentDropSuggestions = drops;
  activeDropIdx = -1;
  dom.dropSuggestions.innerHTML = '';
  if (!drops || !drops.length) {
    dom.dropSuggestions.classList.add('hidden');
    dropSuggestionsVisible = false;
    return;
  }
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    const released = d.releasedAt ? `<span class="suggestion-code">${escHtml(d.releasedAt)} · ${d.cardCount} cards</span>` : `<span class="suggestion-code">${d.cardCount} cards</span>`;
    div.innerHTML = `<span>${escHtml(d.name)} ${released}</span>`;
    div.addEventListener('mousedown', (e) => { e.preventDefault(); selectDrop(d); });
    dom.dropSuggestions.appendChild(div);
  }
  dom.dropSuggestions.classList.remove('hidden');
  dropSuggestionsVisible = true;
}

function selectDrop(drop) {
  state.selectedDrop = drop;
  dom.sldDrop.value = drop.name;
  dom.dropSuggestions.classList.add('hidden');
  dropSuggestionsVisible = false;
  // Configure finish radios for this drop's available finishes
  applyDropFinishOptions(drop);
  dom.addSldBtn.disabled = false;
}

/**
 * Enable/disable finish radios based on the drop's available finishes.
 * Picks a sensible default (preferring Regular > Foil > Rainbow Foil).
 */
function applyDropFinishOptions(drop) {
  const radios = dom.sldFinishRadios();
  let defaultRadio = null;
  for (const r of radios) {
    let avail = false;
    if (r.value === 'nonfoil') avail = !!drop.hasNonfoil;
    else if (r.value === 'foil') avail = !!drop.hasFoil;
    else if (r.value === 'etched') avail = !!drop.hasEtched;
    r.disabled = !avail;
    r.checked = false;
    if (avail && !defaultRadio) defaultRadio = r;
  }
  if (defaultRadio) defaultRadio.checked = true;
}

function getSelectedSldFinish() {
  const radios = dom.sldFinishRadios();
  for (const r of radios) if (r.checked && !r.disabled) return r.value;
  return 'nonfoil';
}

dom.sldDrop.addEventListener('focus', () => {
  clearTimeout(dropBlurTimeout);
  if (!dom.sldDrop.value.trim() || state.selectedDrop) showDefaultDropSuggestions();
  else if (currentDropSuggestions.length > 0) {
    dom.dropSuggestions.classList.remove('hidden');
    dropSuggestionsVisible = true;
  } else handleDropInput();
});
dom.sldDrop.addEventListener('input', () => {
  state.selectedDrop = null;
  for (const r of dom.sldFinishRadios()) { r.checked = false; r.disabled = true; }
  dom.addSldBtn.disabled = true;
  debouncedHandleDropInput();
});
dom.sldDrop.addEventListener('blur', () => {
  dropBlurTimeout = setTimeout(() => {
    dom.dropSuggestions.classList.add('hidden');
    dropSuggestionsVisible = false;
  }, 250);
});
dom.sldDrop.addEventListener('keydown', (e) => {
  if (!dropSuggestionsVisible || !currentDropSuggestions.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeDropIdx = Math.min(activeDropIdx + 1, currentDropSuggestions.length - 1);
    updateActiveDropSuggestion();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeDropIdx = Math.max(activeDropIdx - 1, -1);
    updateActiveDropSuggestion();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeDropIdx >= 0 && currentDropSuggestions[activeDropIdx]) selectDrop(currentDropSuggestions[activeDropIdx]);
  } else if (e.key === 'Escape') {
    dom.dropSuggestions.classList.add('hidden');
    dropSuggestionsVisible = false;
  }
});

function updateActiveDropSuggestion() {
  const items = dom.dropSuggestions.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => {
    item.classList.toggle('active', i === activeDropIdx);
    if (i === activeDropIdx) item.scrollIntoView({ block: 'nearest' });
  });
}

// ─── Precon Autocomplete ───
let preconSuggestionsVisible = false;
let activePreconIdx = -1;
let currentPreconSuggestions = [];
let preconBlurTimeout = null;

async function showDefaultPreconSuggestions() {
  if (!state.preconsLoaded) await loadPrecons();
  try { renderPreconSuggestions(await searchCommanderPrecons('')); }
  catch (e) { console.error('[Precon]', e); }
}

async function handlePreconInput() {
  const query = dom.preconSet.value.trim();
  state.selectedPrecon = null;
  state.selectedPreconDeck = null;
  state.preconDecks = null;
  dom.preconDeck.innerHTML = '<option value="">Select a precon first</option>';
  dom.preconDeck.disabled = true;
  dom.addPreconBtn.disabled = true;
  if (!state.preconsLoaded) await loadPrecons();
  try { renderPreconSuggestions(await searchCommanderPrecons(query)); }
  catch (e) { console.error('[Precon]', e); }
}
const debouncedHandlePreconInput = debounce(handlePreconInput, 150);

function renderPreconSuggestions(precons) {
  currentPreconSuggestions = precons;
  activePreconIdx = -1;
  dom.preconSuggestions.innerHTML = '';
  if (!precons || !precons.length) {
    dom.preconSuggestions.classList.add('hidden');
    preconSuggestionsVisible = false;
    return;
  }
  for (let i = 0; i < precons.length; i++) {
    const p = precons[i];
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerHTML = `<span>${escHtml(p.name)} <span class="suggestion-code">(${escHtml(p.code.toLowerCase())}) · ${escHtml(p.released_at || '')}</span></span>`;
    div.addEventListener('mousedown', (e) => { e.preventDefault(); selectPrecon(p); });
    dom.preconSuggestions.appendChild(div);
  }
  dom.preconSuggestions.classList.remove('hidden');
  preconSuggestionsVisible = true;
}

async function selectPrecon(precon) {
  state.selectedPrecon = { setCode: precon.code, setName: precon.name };
  dom.preconSet.value = `${precon.name} (${precon.code.toLowerCase()})`;
  dom.preconSuggestions.classList.add('hidden');
  preconSuggestionsVisible = false;
  // Fetch deck list for this precon
  showLoading(`Loading decks for ${precon.name}...`);
  try {
    const result = await fetchPreconDecks(precon.code);
    state.preconDecks = result.decks;
    populateDeckDropdown(result);
    if (result.source === 'scryfall_fallback') {
      showToast('No full decklist on MTGJSON — using face cards only', 'info');
    }
  } catch (e) {
    showToast(`Failed to load deck data: ${e.message}`, 'error');
    console.error('[Precon]', e);
  }
  hideLoading();
}

function populateDeckDropdown(result) {
  const decks = result.decks;
  dom.preconDeck.innerHTML = '';
  for (const d of decks) {
    const opt = document.createElement('option');
    opt.value = d.name;
    opt.textContent = `${d.name} (${d.cards.length} cards)`;
    dom.preconDeck.appendChild(opt);
  }
  dom.preconDeck.disabled = false;
  // Auto-select first deck
  if (decks.length > 0) {
    state.selectedPreconDeck = decks[0];
    dom.preconDeck.value = decks[0].name;
    dom.addPreconBtn.disabled = false;
  }
}

dom.preconDeck.addEventListener('change', () => {
  if (!state.preconDecks) return;
  state.selectedPreconDeck = state.preconDecks.find(d => d.name === dom.preconDeck.value) || null;
  dom.addPreconBtn.disabled = !state.selectedPreconDeck;
});

dom.preconSet.addEventListener('focus', () => {
  clearTimeout(preconBlurTimeout);
  if (!dom.preconSet.value.trim() || state.selectedPrecon) showDefaultPreconSuggestions();
  else if (currentPreconSuggestions.length > 0) {
    dom.preconSuggestions.classList.remove('hidden');
    preconSuggestionsVisible = true;
  } else handlePreconInput();
});
dom.preconSet.addEventListener('input', () => {
  state.selectedPrecon = null;
  state.selectedPreconDeck = null;
  state.preconDecks = null;
  dom.preconDeck.innerHTML = '<option value="">Select a precon first</option>';
  dom.preconDeck.disabled = true;
  dom.addPreconBtn.disabled = true;
  debouncedHandlePreconInput();
});
dom.preconSet.addEventListener('blur', () => {
  preconBlurTimeout = setTimeout(() => {
    dom.preconSuggestions.classList.add('hidden');
    preconSuggestionsVisible = false;
  }, 250);
});
dom.preconSet.addEventListener('keydown', (e) => {
  if (!preconSuggestionsVisible || !currentPreconSuggestions.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activePreconIdx = Math.min(activePreconIdx + 1, currentPreconSuggestions.length - 1);
    updateActivePreconSuggestion();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activePreconIdx = Math.max(activePreconIdx - 1, -1);
    updateActivePreconSuggestion();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activePreconIdx >= 0 && currentPreconSuggestions[activePreconIdx]) selectPrecon(currentPreconSuggestions[activePreconIdx]);
  } else if (e.key === 'Escape') {
    dom.preconSuggestions.classList.add('hidden');
    preconSuggestionsVisible = false;
  }
});
function updateActivePreconSuggestion() {
  const items = dom.preconSuggestions.querySelectorAll('.suggestion-item');
  items.forEach((item, i) => {
    item.classList.toggle('active', i === activePreconIdx);
    if (i === activePreconIdx) item.scrollIntoView({ block: 'nearest' });
  });
}

// ─── Roster Management ───
dom.addRosterBtn.addEventListener('click', addBoosterEntry);
dom.addSldBtn.addEventListener('click', addSldEntry);
dom.addPreconBtn.addEventListener('click', addPreconEntry);

/**
 * Find an existing roster entry that matches a candidate by product identity.
 * Used to consolidate quantities instead of pushing duplicate rows.
 */
function findMatchingRosterEntry(candidate) {
  for (const e of state.roster) {
    if (e.productType !== candidate.productType) continue;
    if (candidate.productType === 'booster') {
      if (e.setCode === candidate.setCode && e.boosterType === candidate.boosterType) return e;
    } else if (candidate.productType === 'secret_lair') {
      if (e.dropKey === candidate.dropKey && (e.finish || 'nonfoil') === (candidate.finish || 'nonfoil')) return e;
    } else if (candidate.productType === 'commander_precon') {
      if (e.setCode === candidate.setCode && e.deckName === candidate.deckName) return e;
    }
  }
  return null;
}

async function addBoosterEntry() {
  if (!state.selectedSet) {
    showToast('Please select a set first', 'error');
    return;
  }
  const quantity = parseInt(dom.rosterQty.value) || 1;
  const boosterType = dom.rosterPack.value;
  if (!boosterType) {
    showToast('Please select a pack type', 'error');
    return;
  }
  const { code, name } = state.selectedSet;

  // Consolidation: if an existing entry matches set + boosterType, just bump quantity
  const existing = findMatchingRosterEntry({ productType: 'booster', setCode: code, boosterType });
  if (existing) {
    existing.quantity += quantity;
    renderRoster();
    updateRosterSummary();
    updateButtonStates();
    resetBoosterInputs();
    showToast(`Updated ${name} ${boosterType} → ${existing.quantity} packs`, 'success');
    return;
  }

  const entry = {
    id: state.nextRosterId++,
    productType: 'booster',
    setCode: code,
    setName: name,
    boosterType,
    quantity,
    cards: null,
    subsetCards: [],
    status: 'loading'
  };

  state.roster.push(entry);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
  resetBoosterInputs();

  try {
    showToast(`Fetching card data for ${name}...`, 'info');
    let cards = await fetchSetCards(code);
    // Marvel Jumpstart bridge: the actual Jumpstart card pool lives in MSC
    // (Marvel Super Heroes Commander) at collector numbers 587-874 — even
    // though the parent product is MSH. Until MTGJSON publishes a dedicated
    // jumpstart booster type for MSH, swap entry.cards to that subset so
    // rarity-bucketed EV math hits the right 288 cards (49R + 16M + 117U
    // + 106C) instead of MSH's main set. Once MTGJSON ships the jumpstart
    // booster type, distributionForEntry uses the live model and this swap
    // becomes irrelevant.
    if (boosterType === 'Marvel Jumpstart Booster' && code.toLowerCase() === 'msh') {
      try {
        const mscCards = await fetchSetCards('msc');
        const jpCards = mscCards.filter(c => {
          const n = parseInt(String(c.collector_number || '0').split('-')[0], 10);
          return n >= 587 && n <= 874;
        });
        if (jpCards.length) {
          cards = jpCards;
          console.log(`[Roster] Marvel Jumpstart: using ${cards.length} MSC cards (CN 587-874) as the Jumpstart pool`);
        } else {
          console.warn('[Roster] Marvel Jumpstart: MSC CN 587-874 returned no cards — falling back to MSH pool');
        }
      } catch (e) {
        console.warn('[Roster] Failed to load MSC for Marvel Jumpstart pool:', e.message);
      }
    }
    entry.cards = cards;
    const subsets = getKnownSubsets(code);
    for (const sub of subsets) {
      try {
        const subCards = await fetchSubsetCards(sub);
        entry.subsetCards.push(...subCards);
      } catch (e) {
        console.warn(`[Roster] Subset ${sub} not found for ${code}:`, e.message);
      }
    }

    // Pick the pack model, best source first:
    //   1. MTGJSON booster sheets — the real WotC collation, incl. bonus
    //      sheets, special guests and every Booster Fun treatment.
    //   2. Official-odds model (booster-models.js) — built from Wizards'
    //      published "Collecting" article for sets MTGJSON hasn't covered yet.
    //   3. Generic profile (collation.js) — a calibrated estimate.
    // entry.mtgjsonBooster holds whichever sheet model won; entry.modelSource
    // records which one, for the roster badge.
    await assignBoosterModel(entry);

    entry.status = 'cached';
    const poolLabel = (boosterType === 'Marvel Jumpstart Booster' && code.toLowerCase() === 'msh')
      ? `${name} Jumpstart pool (MSC 587-874)`
      : name;
    showToast(`Loaded ${cards.length} cards from ${poolLabel}`, 'success');
  } catch (e) {
    entry.status = 'error';
    showToast(`Failed to load ${name}: ${e.message}`, 'error');
    console.error('[Roster]', e);
  }
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
}

// Scryfall asks clients to back off for 30s after a 429; tell the user why
// loading paused instead of letting it look frozen.
let lastRateLimitToast = 0;
globalThis.addEventListener && globalThis.addEventListener('scryfall-ratelimit', (e) => {
  if (Date.now() - lastRateLimitToast < 20000) return;
  lastRateLimitToast = Date.now();
  const secs = Math.round(((e && e.detail && e.detail.pauseMs) || 30000) / 1000);
  showToast(`Scryfall asked us to slow down. Loading resumes in about ${secs}s.`, 'info');
});

async function assignBoosterModel(entry) {
  const { setCode: code, setName: name, boosterType } = entry;
  try {
    const booster = await fetchMtgjsonBooster(code);
    if (booster && boosterModelHasType(booster, boosterType)) {
      entry.mtgjsonBooster = booster;
      entry.modelSource = 'mtgjson';
      console.log(`[Roster] ${name} ${boosterType}: using MTGJSON booster model`);
      return;
    }
  } catch (e) {
    console.warn(`[Roster] MTGJSON booster fetch failed for ${code}:`, e.message);
  }
  if (hasOfficialBoosterModel(code)) {
    try {
      const official = await buildOfficialBoosterModel(code);
      if (official && boosterModelHasType(official, boosterType)) {
        entry.mtgjsonBooster = official;
        entry.modelSource = 'official';
        console.log(`[Roster] ${name} ${boosterType}: no MTGJSON sheets yet — using official published odds`);
        return;
      }
    } catch (e) {
      console.warn(`[Roster] Official-odds model failed for ${code}:`, e.message);
    }
  }
  const generic = buildGenericBoosterModel(boosterType, entry.cards, entry.subsetCards || []);
  if (generic) {
    entry.mtgjsonBooster = generic;
    entry.modelSource = 'generic';
    console.log(`[Roster] ${name} ${boosterType}: no published sheets — using generic estimate`);
  }
}

const MODEL_SOURCE_BADGES = {
  mtgjson:  { label: 'MTGJSON', cls: 'model-mtgjson',  tip: 'Pack odds from MTGJSON booster sheets (the actual WotC collation).' },
  official: { label: 'Official odds', cls: 'model-official', tip: "Pack odds from Wizards' published Collecting article. Switches to MTGJSON sheets automatically once they're published." },
  generic:  { label: 'Estimate', cls: 'model-generic', tip: 'No published pack sheets for this set yet. EV uses a generic modern pack profile and is a rough estimate.' }
};

function modelBadgeHtml(entry) {
  const b = MODEL_SOURCE_BADGES[entry.modelSource];
  if (!b) return '';
  let tip = b.tip;
  if (entry.modelSource === 'official') {
    const src = officialModelSource(entry.setCode);
    if (src) tip = `Pack odds from ${src}. Switches to MTGJSON sheets automatically once they're published.`;
  }
  return ` <span class="model-badge ${b.cls}" title="${escHtml(tip)}">${b.label}</span>`;
}

function resetBoosterInputs() {
  dom.rosterSet.value = '';
  dom.rosterPack.innerHTML = '<option value="">Select a set first</option>';
  dom.rosterPack.disabled = true;
  dom.addRosterBtn.disabled = true;
  state.selectedSet = null;
}

function addSldEntry() {
  if (!state.selectedDrop) {
    showToast('Please select a Secret Lair drop first', 'error');
    return;
  }
  const drop = state.selectedDrop;
  const quantity = parseInt(dom.sldQty.value) || 1;
  const finish = getSelectedSldFinish();

  const existing = findMatchingRosterEntry({ productType: 'secret_lair', dropKey: drop.key, finish });
  if (existing) {
    existing.quantity += quantity;
    renderRoster();
    updateRosterSummary();
    updateButtonStates();
    resetSldInputs();
    showToast(`Updated ${drop.name} (${finishLabel(finish)}) → ${existing.quantity}`, 'success');
    return;
  }

  const entry = {
    id: state.nextRosterId++,
    productType: 'secret_lair',
    dropKey: drop.key,
    dropName: drop.name,
    dropCards: drop.cards,
    finish,
    quantity,
    status: 'cached'
  };
  state.roster.push(entry);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
  resetSldInputs();
  showToast(`Added ${drop.name} (${drop.cardCount} cards, ${finishLabel(finish)})`, 'success');
}

function resetSldInputs() {
  dom.sldDrop.value = '';
  for (const r of dom.sldFinishRadios()) { r.checked = false; r.disabled = true; }
  dom.addSldBtn.disabled = true;
  state.selectedDrop = null;
}

function finishLabel(f) {
  return f === 'foil' ? 'foil' : f === 'etched' ? 'rainbow foil' : 'regular';
}

async function addPreconEntry() {
  if (!state.selectedPrecon) {
    showToast('Please select a Commander precon first', 'error');
    return;
  }
  if (!state.selectedPreconDeck) {
    showToast('Please pick a deck within the precon', 'error');
    return;
  }
  const quantity = parseInt(dom.preconQty.value) || 1;
  const { setCode, setName } = state.selectedPrecon;
  const deck = state.selectedPreconDeck;

  const existing = findMatchingRosterEntry({
    productType: 'commander_precon', setCode, deckName: deck.name
  });
  if (existing) {
    existing.quantity += quantity;
    renderRoster();
    updateRosterSummary();
    updateButtonStates();
    resetPreconInputs();
    showToast(`Updated ${deck.name} → ${existing.quantity}`, 'success');
    return;
  }

  const entry = {
    id: state.nextRosterId++,
    productType: 'commander_precon',
    setCode,
    setName,
    deckName: deck.name,
    deckCards: deck.cards,   // array of resolved Scryfall cards
    quantity,
    status: 'cached'
  };
  state.roster.push(entry);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
  resetPreconInputs();
  showToast(`Added ${setName} — ${deck.name} (${deck.cards.length} cards)`, 'success');
}

function resetPreconInputs() {
  dom.preconSet.value = '';
  dom.preconDeck.innerHTML = '<option value="">Select a precon first</option>';
  dom.preconDeck.disabled = true;
  dom.addPreconBtn.disabled = true;
  state.selectedPrecon = null;
  state.selectedPreconDeck = null;
  state.preconDecks = null;
}

function getKnownSubsets(setCode) {
  // Used as a fallback when MTGJSON booster data is unavailable.
  // The MTGJSON booster path auto-discovers subsets via parent_set_code, so
  // this list only matters when MTGJSON returns no booster definition.
  const subsets = {
    'sos': ['soa', 'soc', 'spg'],  // Secrets of Strixhaven (Mystical Archive + Commander)
    'mh3': ['m3c', 'spg'], 'mkm': ['mkc', 'spg'], 'otj': ['otp', 'big', 'spg'],
    'woe': ['woc', 'spg'], 'lci': ['lcc', 'spg'], 'dsk': ['dsc', 'spg'],
    'blb': ['blc', 'spg'], 'fdn': ['spg'], 'one': ['onc'], 'mom': ['moc'],
    'mat': ['moc'], 'bro': ['brc'], 'dmu': ['dmc'], 'snc': ['ncc'],
    'neo': ['nec'], 'vow': ['voc'], 'mid': ['mic'], 'afr': ['afc'],
    'stx': ['sta', 'c21'], 'khm': ['khc'], 'znr': ['znc'], 'iko': ['c20'],
    'thb': [], 'eld': [], 'inn': ['imc'], 'tdc': ['spg'], 'fdm': ['spg'],
    'tdm': ['tdc', 'spg'], 'fdc': [],
    // 2025-2026 sets: only bonus sheets that appear in Play Boosters.
    'trk': ['sds'], 'fra': ['spg'], 'hob': [], 'msh': [], 'spm': ['mar'],
    'tla': [], 'tmt': [], 'ecl': [], 'eoe': ['spg'], 'fin': [],
  };
  return subsets[setCode.toLowerCase()] || [];
}

function removeRosterEntry(id) {
  state.roster = state.roster.filter(r => r.id !== id);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
}

function renderRoster() {
  dom.rosterTbody.innerHTML = '';
  dom.rosterEmpty.classList.toggle('hidden', state.roster.length > 0);

  for (const entry of state.roster) {
    const tr = document.createElement('tr');
    const statusClass = entry.status === 'cached' ? 'status-cached'
      : entry.status === 'loading' ? 'status-loading' : 'status-error';

    let typeLabel, packLabel, cardsLabel, statusText;
    if (entry.productType === 'secret_lair') {
      typeLabel = `<span class="product-icon" title="Secret Lair Drop">SLD</span> ${escHtml(entry.dropName)}`;
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      packLabel = `Envelope (${finishLabel(finish)})`;
      cardsLabel = `${entry.quantity * entry.dropCards.length}`;
      statusText = `✓ ${entry.dropCards.length} cards`;
    } else if (entry.productType === 'commander_precon') {
      typeLabel = `<span class="product-icon precon" title="Commander Precon">CMD</span> ${escHtml(entry.setName)} <span style="color:var(--text-muted)">(${escHtml(entry.setCode)})</span>`;
      packLabel = `Deck: ${escHtml(entry.deckName)}`;
      cardsLabel = `${entry.quantity * entry.deckCards.length}`;
      statusText = `✓ ${entry.deckCards.length} cards`;
    } else {
      typeLabel = `${escHtml(entry.setName)} <span style="color:var(--text-muted)">(${escHtml(entry.setCode)})</span>`;
      packLabel = entry.boosterType;
      cardsLabel = entry.status === 'cached'
        ? entry.quantity * getPackCardCount(entry.boosterType)
        : '—';
      statusText = entry.status === 'cached'
        ? `✓ ${entry.cards?.length || 0} cards`
        : entry.status === 'loading' ? 'Fetching...' : 'Error';
    }
    const modelBadge = entry.productType === 'booster' && entry.status === 'cached' ? modelBadgeHtml(entry) : '';

    const builderMode = state.viewMode === 'builder';
    const cost = entry.costPerUnit || 0;
    const subtotal = cost * entry.quantity;
    const costCells = builderMode
      ? `
        <td><input type="number" class="cost-input" min="0" step="0.01" value="${cost.toFixed(2)}" data-id="${entry.id}" title="Your purchase cost for one ${entry.productType === 'commander_precon' ? 'deck' : entry.productType === 'secret_lair' ? 'envelope' : 'pack'}"></td>
        <td class="cost-subtotal">${formatPrice(subtotal)}</td>`
      : `<td>${cardsLabel}</td>`;

    tr.innerHTML = `
      <td>${entry.quantity}</td>
      <td>${typeLabel}</td>
      <td>${packLabel}</td>
      ${costCells}
      <td><span class="status-badge ${statusClass}">${statusText}</span>${modelBadge}</td>
      <td><button class="btn btn-sm btn-danger remove-btn" data-id="${entry.id}">✕</button></td>
    `;
    tr.querySelector('.remove-btn').addEventListener('click', () => removeRosterEntry(entry.id));
    const costInput = tr.querySelector('.cost-input');
    if (costInput) {
      costInput.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value) || 0;
        entry.costPerUnit = v;
        const subCell = tr.querySelector('.cost-subtotal');
        if (subCell) subCell.textContent = formatPrice(v * entry.quantity);
        refreshCostSummary();
      });
    }
    dom.rosterTbody.appendChild(tr);
  }

  // Toggle header columns based on view mode
  const thead = document.querySelector('#roster-table thead tr');
  if (thead) {
    const builderMode = state.viewMode === 'builder';
    thead.innerHTML = builderMode
      ? '<th>Qty</th><th>Set/Product</th><th>Pack Type</th><th>Cost/Unit</th><th>Subtotal</th><th>Status</th><th></th>'
      : '<th>Qty</th><th>Set/Product</th><th>Pack Type</th><th>Cards (est.)</th><th>Status</th><th></th>';
  }
}

function updateRosterSummary() {
  const totalUnits = state.roster.reduce((sum, r) => sum + r.quantity, 0);
  const totalCards = state.roster.reduce((sum, r) => {
    if (r.status !== 'cached') return sum;
    if (r.productType === 'secret_lair') return sum + r.quantity * r.dropCards.length;
    if (r.productType === 'commander_precon') return sum + r.quantity * r.deckCards.length;
    return sum + r.quantity * getPackCardCount(r.boosterType);
  }, 0);
  dom.totalPacks.textContent = `Total Products: ${totalUnits}`;
  dom.totalCardsEst.textContent = `Est. Cards: ${totalCards}`;
  if (state.viewMode === 'builder') refreshBuilderView();
}

// ─── Kindred Spot Management ───

function addSpot(label) {
  const trimmed = (label || '').trim();
  if (!trimmed) return;
  const parsed = parseSpotLabel(trimmed);
  if (!parsed.length) { showToast('Invalid spot syntax', 'error'); return; }
  state.spots.push({ id: state.nextSpotId++, label: trimmed, parsed });
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
}

function removeSpot(id) {
  state.spots = state.spots.filter(s => s.id !== id);
  state.hitSpots.delete(id);
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
}

function moveSpot(id, direction) {
  const idx = state.spots.findIndex(s => s.id === id);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= state.spots.length) return;
  [state.spots[idx], state.spots[newIdx]] = [state.spots[newIdx], state.spots[idx]];
  renderSpots();
  refreshAnalysisIfReady();
}

function editSpotLabel(id, newLabel) {
  const spot = state.spots.find(s => s.id === id);
  if (!spot) return;
  const trimmed = (newLabel || '').trim();
  if (!trimmed) return;
  spot.label = trimmed;
  spot.parsed = parseSpotLabel(trimmed);
  renderSpots();
  refreshAnalysisIfReady();
}

function clearAllSpots() {
  if (!state.spots.length) return;
  if (!confirm('Remove all defined spots?')) return;
  state.spots = [];
  state.hitSpots.clear();
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
}

function parseMassEntry() {
  const text = dom.massEntry.value;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  let added = 0;
  for (const line of lines) {
    const parsed = parseSpotLabel(line);
    if (parsed.length) {
      state.spots.push({ id: state.nextSpotId++, label: line, parsed });
      added++;
    }
  }
  dom.massEntry.value = '';
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
  showToast(`Added ${added} spot${added === 1 ? '' : 's'}`, 'success');
}

function runAutoTabulate() {
  if (!rosterIsReady()) { showToast('Wait for roster to finish loading', 'error'); return; }
  const ranked = autoTabulate(state.roster, 100);
  if (!ranked.length) { showToast('No R/M cards found in roster', 'error'); return; }
  const previousCount = state.spots.length;
  // Confirm before nuking a non-empty spot list — Auto-Tabulate is a replace, not an append.
  if (previousCount > 0) {
    const ok = confirm(`Auto-Tabulate will replace your current ${previousCount} spot${previousCount === 1 ? '' : 's'} with ${ranked.length} new ones ranked by value × frequency.\n\nContinue?`);
    if (!ok) return;
  }
  state.spots = [];
  // Reset spot IDs so #1 starts at 1 again (cosmetic — keeps the spot numbers tidy).
  state.nextSpotId = 1;
  state.hitSpots.clear();
  state.selectedSpotIds.clear();
  let added = 0;
  for (const r of ranked) {
    const parsed = parseSpotLabel(r.name);
    if (parsed.length) {
      state.spots.push({ id: state.nextSpotId++, label: r.name, parsed });
      added++;
    }
  }
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
  const replacedNote = previousCount > 0 ? ` (replaced ${previousCount} previous spot${previousCount === 1 ? '' : 's'})` : '';
  showToast(`Auto-added ${added} spots ranked by value × frequency${replacedNote}`, 'success');
}

/**
 * Lock Roster — toggle action. When transitioning OFF→ON, seeds the spot list
 * from the roster (replacing any existing spots, with a confirm). While locked,
 * roster controls are disabled so the streamer doesn't accidentally edit and
 * invalidate their work. Unlock to re-enable roster editing; spots are kept.
 */
function toggleRosterLock() {
  if (!rosterIsReady()) { showToast('Wait for roster to finish loading', 'error'); return; }
  if (state.rosterLocked) {
    // Unlock — just flip the flag, keep spots intact
    state.rosterLocked = false;
    applyRosterLockUI();
    showToast('Roster unlocked. Add or remove products; re-lock when ready to refresh spots.', 'info');
    return;
  }
  // Lock — seed the spots
  const ranked = seedCategoryLabels(state.roster);
  if (!ranked.length) { showToast('No R/M cards found in roster', 'error'); return; }
  const previousCount = state.spots.length;
  if (previousCount > 0) {
    const ok = confirm(`Lock Roster & Seed Spots will REPLACE your current ${previousCount} spot${previousCount === 1 ? '' : 's'} with ${ranked.length} fresh categories ranked by EV.\n\nContinue?`);
    if (!ok) return;
  }
  state.spots = [];
  state.nextSpotId = 1;
  state.hitSpots.clear();
  state.selectedSpotIds.clear();
  for (const r of ranked) {
    const parsed = parseSpotLabel(r.label);
    if (parsed.length) state.spots.push({ id: state.nextSpotId++, label: r.label, parsed });
  }
  // Sort by ACTUAL displayed EV (priority-aware) so any tribe whose cards get
  // stolen by a higher-priority spot sinks to the bottom of the list.
  sortSpotsByDisplayedEV();
  state.rosterLocked = true;
  applyRosterLockUI();
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
  showToast(`Locked roster — ${state.spots.length} spots seeded by EV. Split or merge to dial in your target.`, 'success');
}

/**
 * Re-sort state.spots by their ACTUAL (priority-aware) displayed EV. Mutates
 * state.spots in place. Used after lock to ensure the visible order matches
 * what's shown in the EV column.
 */
function sortSpotsByDisplayedEV() {
  if (!rosterIsReady() || state.spots.length === 0) return;
  // Iterate to a stable order: compute, sort, recompute, sort, until no change
  // (or max 5 iterations as a safety cap). Each iteration may shift positions
  // because the EV of a spot depends on which spots are higher-priority.
  for (let iter = 0; iter < 5; iter++) {
    const dist = analyzeSpotDistribution(state.roster, state.spots);
    const ev = dist.spotEV;
    const indexed = state.spots.map((s, i) => ({ spot: s, ev: ev[i] || 0 }));
    const sortKey = indexed.map(x => x.ev).join('|');
    indexed.sort((a, b) => b.ev - a.ev);
    state.spots = indexed.map(x => x.spot);
    const newDist = analyzeSpotDistribution(state.roster, state.spots);
    const newKey = newDist.spotEV.join('|');
    if (sortKey === newKey) break;
  }
}

function applyRosterLockUI() {
  if (dom.lockRosterBtn) {
    if (state.rosterLocked) {
      dom.lockRosterBtn.innerHTML = '\u{1F513} Unlock Roster';
      dom.lockRosterBtn.classList.remove('btn-primary');
      dom.lockRosterBtn.classList.add('btn-accent');
    } else {
      dom.lockRosterBtn.innerHTML = '\u{1F512} Lock Roster &amp; Seed Spots';
      dom.lockRosterBtn.classList.add('btn-primary');
      dom.lockRosterBtn.classList.remove('btn-accent');
    }
  }
  if (dom.lockRosterStatus) {
    dom.lockRosterStatus.textContent = state.rosterLocked
      ? 'Roster locked. Define Your Spots is now populated. Unlock to add more products.'
      : 'Add products above, then lock the roster to auto-populate your spots.';
  }
  // Disable roster controls while locked. Apply a `.roster-locked` class on the
  // roster section's body for CSS to grey out everything inside it.
  const rosterBody = document.querySelector('#roster-section .card-body');
  if (rosterBody) rosterBody.classList.toggle('roster-locked', state.rosterLocked);
}

/**
 * Seed Categories — populate the spot list with the user-friendly initial
 * categorization (Artifact/Enchantment non-creature, Land, PW, Battle, Instant,
 * Sorcery, then every creature tribe present, all sorted by EV desc).
 * Replaces the current spot list with a confirm — same pattern as Auto-Tabulate.
 */
function seedCategoriesAction() {
  if (!rosterIsReady()) { showToast('Wait for roster to finish loading', 'error'); return; }
  const ranked = seedCategoryLabels(state.roster);
  if (!ranked.length) { showToast('No R/M cards found in roster', 'error'); return; }
  const previousCount = state.spots.length;
  if (previousCount > 0) {
    const ok = confirm(`Lock Roster & Seed Spots will REPLACE your current ${previousCount} spot${previousCount === 1 ? '' : 's'} with ${ranked.length} fresh categories ranked by EV.\n\nContinue?`);
    if (!ok) return;
  }
  state.spots = [];
  state.nextSpotId = 1;
  state.hitSpots.clear();
  state.selectedSpotIds.clear();
  for (const r of ranked) {
    const parsed = parseSpotLabel(r.label);
    if (parsed.length) state.spots.push({ id: state.nextSpotId++, label: r.label, parsed });
  }
  renderSpots();
  updateButtonStates();
  refreshAnalysisIfReady();
  showToast(`Seeded ${state.spots.length} categories — now split/merge until you hit ${state.targetSpotCount}`, 'success');
}

/**
 * Split a single spot by a dimension (color / supertype / subtype).
 * Sub-spots replace the original IN PLACE — priority order preserved.
 * Empty sub-buckets (no matching R/M cards) are dropped automatically.
 */
function splitSpot(spotId, dimension) {
  const idx = state.spots.findIndex(s => s.id === spotId);
  if (idx < 0) return;
  const parent = state.spots[idx];
  const subs = splitLabelsBy(parent.label, dimension, state.roster);
  if (!subs.length) {
    showToast(`No "${dimension}" split produced any non-empty sub-spots for ${parent.label}`, 'warning');
    return;
  }
  // Tag each child with its parent's label so a later merge of ALL siblings
  // can restore the original parent cleanly (instead of joining with `/`).
  const newSpots = subs.map(sub => {
    const parsed = parseSpotLabel(sub.label);
    return parsed.length ? {
      id: state.nextSpotId++,
      label: sub.label,
      parsed,
      parentLabel: parent.label
    } : null;
  }).filter(Boolean);
  state.spots.splice(idx, 1, ...newSpots);
  state.selectedSpotIds.delete(spotId);
  renderSpots();
  refreshAnalysisIfReady();
  showToast(`Split "${parent.label}" into ${newSpots.length} sub-spots`, 'success');
}

/**
 * Merge multiple selected spots into one using the parser's `/` OR syntax.
 * The merged spot lands at the position of the FIRST selected (in pool order),
 * so priority is preserved.
 */
function mergeSelectedSpots() {
  const selectedSpots = state.spots.filter(s => state.selectedSpotIds.has(s.id));
  if (selectedSpots.length < 2) {
    showToast('Select at least 2 spots to merge', 'warning');
    return;
  }
  const firstIdx = state.spots.findIndex(s => state.selectedSpotIds.has(s.id));

  // Smart restoration: if every selected spot shares the SAME parentLabel AND
  // those are the only spots in the list with that parentLabel (i.e. the user
  // is un-doing the whole split), restore the parent label instead of joining
  // with `/`. This makes "Split Phoenix by Color → Multicolored Phoenix +
  // Red Phoenix" → "merge them back → Phoenix" round-trip cleanly.
  const parentLabels = new Set(selectedSpots.map(s => s.parentLabel || ''));
  if (parentLabels.size === 1) {
    const parentLabel = [...parentLabels][0];
    const siblingsInList = state.spots.filter(s => (s.parentLabel || '') === parentLabel).length;
    if (parentLabel && siblingsInList === selectedSpots.length) {
      const parsed = parseSpotLabel(parentLabel);
      if (parsed.length) {
        state.spots = state.spots.filter(s => !state.selectedSpotIds.has(s.id));
        // Preserve the original parent's lineage (if it had one — multi-level split)
        const restored = { id: state.nextSpotId++, label: parentLabel, parsed };
        state.spots.splice(firstIdx, 0, restored);
        state.selectedSpotIds.clear();
        renderSpots();
        refreshAnalysisIfReady();
        showToast(`Restored "${parentLabel}" from ${selectedSpots.length} split children`, 'success');
        return;
      }
    }
  }

  // Fallback: combine the labels with `/` OR syntax.
  const verboseLabel = selectedSpots.map(s => s.label).join('/');
  // Try to find a simpler single-clause equivalent: (A - B) + B → A, etc.
  // If trySimplifyMergedLabel returns a hit, use it instead of the verbose join.
  let mergedLabel = verboseLabel;
  let simplified = false;
  try {
    const simpler = trySimplifyMergedLabel(verboseLabel, state.roster);
    if (simpler) { mergedLabel = simpler; simplified = true; }
  } catch (e) { console.warn('[merge] simplification failed:', e.message); }
  const parsed = parseSpotLabel(mergedLabel);
  if (!parsed.length) {
    showToast('Merge produced an unparseable label', 'error');
    return;
  }
  state.spots = state.spots.filter(s => !state.selectedSpotIds.has(s.id));
  state.spots.splice(firstIdx, 0, { id: state.nextSpotId++, label: mergedLabel, parsed });
  state.selectedSpotIds.clear();
  renderSpots();
  refreshAnalysisIfReady();
  const note = simplified ? ` (simplified from ${selectedSpots.length} spots)` : '';
  showToast(`Merged into "${mergedLabel}"${note}`, 'success');
}

/**
 * Reverse of merge — split a `/`-containing label back into its components,
 * IN PLACE so priority is preserved.
 */
function unmergeSpot(spotId) {
  const idx = state.spots.findIndex(s => s.id === spotId);
  if (idx < 0) return;
  const parent = state.spots[idx];
  if (!parent.label.includes('/')) return;
  const parts = parent.label.split('/').map(p => p.trim()).filter(Boolean);
  const newSpots = parts.map(part => {
    const parsed = parseSpotLabel(part);
    return parsed.length ? { id: state.nextSpotId++, label: part, parsed } : null;
  }).filter(Boolean);
  if (!newSpots.length) return;
  state.spots.splice(idx, 1, ...newSpots);
  state.selectedSpotIds.delete(spotId);
  renderSpots();
  refreshAnalysisIfReady();
  showToast(`Unmerged "${parent.label}" into ${newSpots.length} spots`, 'success');
}

// Sort the spot list by EV descending (also changes priority order).
function sortSpotsByEV() {
  if (state.spots.length < 2) return;
  sortSpotsByDisplayedEV();
  renderSpots();
  refreshAnalysisIfReady();
  showToast('Sorted spots by EV (descending)', 'info');
}

// Sort spots alphabetically by label (A–Z).
function sortSpotsAlphabetical() {
  if (state.spots.length < 2) return;
  state.spots.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  renderSpots();
  refreshAnalysisIfReady();
  showToast('Sorted spots alphabetically', 'info');
}

// Classify a spot's label into a card-type bucket for "Sort by Type". Returns
// a numeric bucket order so we can sort by it.
function spotTypeBucket(label) {
  const lower = label.toLowerCase();
  // Lands first (Magic order roughly: lands → creatures → artifacts → enchantments → planeswalkers → battles → instants → sorceries)
  if (/\bland\b/.test(lower))         return { rank: 1, name: 'Land' };
  if (/\bplaneswalker\b/.test(lower)) return { rank: 2, name: 'Planeswalker' };
  if (/\bbattle\b/.test(lower))       return { rank: 3, name: 'Battle' };
  if (/\benchantment\b/.test(lower))  return { rank: 4, name: 'Enchantment' };
  // Enchantment subtypes — group with Enchantment
  if (/\b(aura|saga|class|case)\b/.test(lower)) return { rank: 4, name: 'Enchantment' };
  if (/\bartifact\b/.test(lower))     return { rank: 5, name: 'Artifact' };
  // Artifact subtypes — group with Artifact
  if (/\b(equipment|vehicle)\b/.test(lower))    return { rank: 5, name: 'Artifact' };
  if (/\binstant\b/.test(lower))      return { rank: 6, name: 'Instant' };
  if (/\bsorcery\b/.test(lower))      return { rank: 7, name: 'Sorcery' };
  // Anything else (creature tribes, weird custom labels) goes to the Creature bucket
  return { rank: 8, name: 'Creature' };
}

// Sort spots by card-type bucket, then alphabetically within each bucket.
function sortSpotsByType() {
  if (state.spots.length < 2) return;
  state.spots.sort((a, b) => {
    const bA = spotTypeBucket(a.label);
    const bB = spotTypeBucket(b.label);
    if (bA.rank !== bB.rank) return bA.rank - bB.rank;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
  renderSpots();
  refreshAnalysisIfReady();
  showToast('Sorted spots by type (then alphabetical)', 'info');
}

function renderSpots() {
  if (!dom.spotsList) return;
  dom.spotsList.innerHTML = '';
  // Compute fresh EVs every render so the column never shows stale data.
  // Skip if the roster isn't ready yet (EVs would all be $0 anyway).
  let evArr = [];
  if (rosterIsReady() && state.spots.length > 0) {
    try {
      const dist = analyzeSpotDistribution(state.roster, state.spots);
      evArr = dist.spotEV || [];
      // Cache so other surfaces (buyer panel, sort-by-EV button) see fresh data
      state.lastDistribution = dist;
    } catch (e) {
      console.warn('[renderSpots] analyzeSpotDistribution failed:', e.message);
    }
  }
  for (let i = 0; i < state.spots.length; i++) {
    const spot = state.spots[i];
    const div = document.createElement('div');
    div.className = 'spot-item';
    div.draggable = true;
    div.dataset.id = String(spot.id);
    const isMerged = spot.label.includes('/');
    const isSelected = state.selectedSpotIds.has(spot.id);
    const canColor = canSplitBy(spot.label, 'color');
    const canSuper = canSplitBy(spot.label, 'supertype');
    const canSub   = canSplitBy(spot.label, 'subtype');
    const evVal = evArr[i] || 0;
    div.innerHTML = `
      <input type="checkbox" class="spot-check" title="Select to merge with others" ${isSelected ? 'checked' : ''}>
      <span class="drag-handle" title="Drag to reorder">≡</span>
      <span class="spot-number">#${i + 1}</span>
      <span class="spot-label${isMerged ? ' merged' : ''}">${escHtml(spot.label)}</span>
      <span class="spot-ev" data-spot-id="${spot.id}">${formatPrice(evVal)}</span>
      <div class="spot-actions">
        <select class="btn btn-sm split-menu" title="Split this spot">
          <option value="">Split…</option>
          <option value="color"${canColor ? '' : ' disabled'}>By Color</option>
          <option value="supertype"${canSuper ? '' : ' disabled'}>By Supertype</option>
          <option value="subtype"${canSub ? '' : ' disabled'}>By Subtype</option>
        </select>
        ${isMerged ? `<button class="btn btn-sm unmerge-spot" title="Split this back into its component spots">Unmerge</button>` : ''}
        <button class="btn btn-sm move-up" title="Move up">▲</button>
        <button class="btn btn-sm move-down" title="Move down">▼</button>
        <button class="btn btn-sm edit-spot" title="Edit label">✎</button>
        <button class="btn btn-sm btn-danger remove-spot" title="Remove">✕</button>
      </div>
    `;
    div.querySelector('.spot-check').addEventListener('change', e => {
      if (e.target.checked) state.selectedSpotIds.add(spot.id);
      else state.selectedSpotIds.delete(spot.id);
      updateMergeButtonState();
    });
    const splitMenu = div.querySelector('.split-menu');
    splitMenu.addEventListener('change', e => {
      const dim = e.target.value;
      e.target.value = '';
      if (dim) splitSpot(spot.id, dim);
    });
    const unmergeBtn = div.querySelector('.unmerge-spot');
    if (unmergeBtn) unmergeBtn.addEventListener('click', () => unmergeSpot(spot.id));
    div.querySelector('.move-up').addEventListener('click', () => moveSpot(spot.id, -1));
    div.querySelector('.move-down').addEventListener('click', () => moveSpot(spot.id, 1));
    div.querySelector('.remove-spot').addEventListener('click', () => removeSpot(spot.id));
    div.querySelector('.edit-spot').addEventListener('click', () => {
      const labelEl = div.querySelector('.spot-label');
      const current = spot.label;
      labelEl.innerHTML = `<input type="text" value="${escHtml(current)}">`;
      labelEl.classList.add('editing');
      const input = labelEl.querySelector('input');
      input.focus(); input.select();
      const finish = (commit) => {
        if (commit) editSpotLabel(spot.id, input.value);
        else renderSpots(); // cancel: re-render with old label
      };
      input.addEventListener('blur', () => finish(true), { once: true });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', finish); finish(false); }
      });
    });
    // Drag and drop reordering
    div.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(spot.id));
      div.style.opacity = '0.5';
    });
    div.addEventListener('dragend', () => { div.style.opacity = '1'; });
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const fromId = parseInt(e.dataTransfer.getData('text/plain'));
      if (fromId === spot.id) return;
      const fromIdx = state.spots.findIndex(s => s.id === fromId);
      const toIdx = state.spots.findIndex(s => s.id === spot.id);
      if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
        const [moved] = state.spots.splice(fromIdx, 1);
        state.spots.splice(toIdx, 0, moved);
        renderSpots();
        refreshAnalysisIfReady();
      }
    });
    dom.spotsList.appendChild(div);
  }
  if (dom.spotsCount) {
    const n = state.spots.length;
    dom.spotsCount.textContent = `${n} spot${n === 1 ? '' : 's'} defined`;
    dom.spotsCount.classList.remove('on-target', 'near-target', 'off-target');
  }
  if (dom.clearSpotsBtn) dom.clearSpotsBtn.classList.toggle('hidden', state.spots.length === 0);
  updateMergeButtonState();
}

// The toolbar Merge button doubles as an Unmerge button when exactly one
// merged spot is selected — that's a clearer affordance than asking the user
// to find the row's Unmerge button.
function updateMergeButtonState() {
  if (!dom.mergeSpotsBtn) return;
  const n = state.selectedSpotIds.size;
  if (n === 1) {
    const onlyId = [...state.selectedSpotIds][0];
    const spot = state.spots.find(s => s.id === onlyId);
    if (spot && spot.label.includes('/')) {
      dom.mergeSpotsBtn.disabled = false;
      dom.mergeSpotsBtn.textContent = 'Unmerge';
      dom.mergeSpotsBtn.dataset.mode = 'unmerge';
      return;
    }
  }
  dom.mergeSpotsBtn.disabled = n < 2;
  dom.mergeSpotsBtn.textContent = n >= 2 ? `Merge Selected (${n})` : 'Merge Selected';
  dom.mergeSpotsBtn.dataset.mode = 'merge';
}

/**
 * Render the "Missing categories" suggestion chips below the spot list.
 * Shows R/M card categories that no current spot claims, with a + button
 * to add the category as a new spot at the end of the list.
 */
function renderMissingSpots() {
  const panel = document.getElementById('missing-spots-panel');
  const list = document.getElementById('missing-spots-list');
  if (!panel || !list) return;
  if (!rosterIsReady() || state.spots.length === 0) {
    panel.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  let suggestions = [];
  try { suggestions = unmatchedCategories(state.roster, state.spots, 14); }
  catch (e) { console.warn('[Missing spots]', e.message); }
  if (!suggestions.length) {
    panel.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  for (const s of suggestions) {
    const chip = document.createElement('span');
    chip.className = 'missing-spot-chip';
    const titleParts = [];
    titleParts.push(`Add "${s.name}" as a new spot at the end of your list`);
    if (s.sample && s.sample.length) titleParts.push(`Sample: ${s.sample.join(', ')}${s.count > s.sample.length ? '...' : ''}`);
    chip.title = titleParts.join('\n');
    chip.innerHTML = `<span class="chip-add">+</span> ${escHtml(s.name)} <span class="chip-count">${s.count}× · ${formatPrice(s.totalValue)}</span>`;
    chip.addEventListener('click', () => {
      addSpot(s.name);
      renderMissingSpots(); // refresh — the added category is now matched
    });
    list.appendChild(chip);
  }
}

function refreshAnalysisIfReady() {
  // Compute the distribution whenever the roster is loaded and spots exist —
  // don't gate on a prior analysis run. The spot-builder flow needs live EVs
  // the moment Seed Categories populates the list.
  if (rosterIsReady() && state.spots.length > 0) {
    const dist = analyzeSpotDistribution(state.roster, state.spots);
    state.lastDistribution = dist;
    if (state.viewMode === 'buyer') renderTrackerTable(dist);
  } else {
    state.lastDistribution = null;
  }
  if (state.viewMode === 'builder') refreshBuilderView();
  renderMissingSpots();
}

// Wire spot UI events
if (dom.addSpotBtn) {
  dom.addSpotBtn.addEventListener('click', () => { addSpot(dom.spotName.value); dom.spotName.value = ''; });
}
if (dom.spotName) {
  dom.spotName.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); dom.addSpotBtn.click(); }
  });
}
if (dom.parseMassBtn) dom.parseMassBtn.addEventListener('click', parseMassEntry);
if (dom.autoTabulateBtn) dom.autoTabulateBtn.addEventListener('click', runAutoTabulate);
if (dom.lockRosterBtn) dom.lockRosterBtn.addEventListener('click', toggleRosterLock);
if (dom.mergeSpotsBtn) dom.mergeSpotsBtn.addEventListener('click', () => {
  // The button switches between merge and unmerge depending on selection state
  // — see updateMergeButtonState. Dispatch on data-mode.
  if (dom.mergeSpotsBtn.dataset.mode === 'unmerge') {
    const onlyId = [...state.selectedSpotIds][0];
    if (onlyId != null) unmergeSpot(onlyId);
  } else {
    mergeSelectedSpots();
  }
});
if (dom.sortSpotsEvBtn)    dom.sortSpotsEvBtn.addEventListener('click', sortSpotsByEV);
if (dom.sortSpotsAlphaBtn) dom.sortSpotsAlphaBtn.addEventListener('click', sortSpotsAlphabetical);
if (dom.sortSpotsTypeBtn)  dom.sortSpotsTypeBtn.addEventListener('click', sortSpotsByType);
if (dom.clearSpotsBtn) dom.clearSpotsBtn.addEventListener('click', clearAllSpots);

// ─── Track Break & Spot Analysis ───
dom.analyzeBtn.addEventListener('click', () => {
  if (!rosterIsReady()) return;
  if (!state.spots.length) { showToast('Define at least one spot above first', 'error'); return; }
  showLoading('Analyzing spot distribution...');
  setTimeout(() => {
    try {
      const dist = analyzeSpotDistribution(state.roster, state.spots);
      state.lastDistribution = dist;
      renderTrackerTable(dist);
      showToast('Spot distribution computed', 'success');
    } catch (e) {
      showToast(`Analysis error: ${e.message}`, 'error');
      console.error('[Analyze]', e);
    }
    hideLoading();
  }, 50);
});

function renderTrackerTable(dist) {
  state.lastDistribution = dist;
  const { spotEV, lastSpotEV, bulkEV = 0, bulkPerSpot = 0 } = dist;
  if (!dom.spotTableWrapper) return;
  dom.spotTableWrapper.classList.remove('hidden');
  const tbody = dom.trackerTbody;
  if (!tbody) return;
  tbody.innerHTML = '';

  const contrib = topCardsBySpot(state.roster, state.spots, 6);

  // Effective EV per spot = R/M EV + uniform bulk share. Rank by effective EV.
  const ranked = state.spots
    .map((s, i) => ({ idx: i, ev: spotEV[i] + bulkPerSpot }))
    .sort((a, b) => b.ev - a.ev);
  const tierByIdx = new Map();
  for (let r = 0; r < ranked.length; r++) tierByIdx.set(ranked[r].idx, getStarTier(r));

  for (let i = 0; i < state.spots.length; i++) {
    const spot = state.spots[i];
    const rmEV = spotEV[i];
    const effectiveEV = rmEV + bulkPerSpot;
    const tier = tierByIdx.get(i) || 0;
    const { top, rest } = contrib[i] || { top: [], rest: [] };
    const tr = document.createElement('tr');
    tr.className = `tier-${tier}`;
    tr.dataset.spotId = String(spot.id);
    if (state.hitSpots.has(spot.id)) tr.classList.add('hit');
    const renderContribCard = (c) => {
      const img = imageUrlForCard(c.card);
      const imgAttr = img ? ` data-image-url="${escHtml(img)}"` : '';
      const tag = c.guaranteed ? ' ⓖ' : '';
      return `<span${imgAttr} title="${escHtml(c.card.name)} • ${formatPrice(c.ev)}${c.guaranteed ? ' guaranteed' : ''}">${escHtml(c.card.name)}${tag}</span>`;
    };
    let contribHtml;
    if (top.length === 0) {
      contribHtml = '<span style="color:var(--text-muted)">—</span>';
    } else if (rest.length === 0) {
      contribHtml = top.map(renderContribCard).join(', ');
    } else {
      // Top visible + hidden "rest" span + expand toggle. The toggle button
      // sits inline at the end of the cell — clicking it reveals every
      // remaining contributor so the streamer can audit a spot in full.
      const topHtml = top.map(renderContribCard).join(', ');
      const restHtml = ', ' + rest.map(renderContribCard).join(', ');
      contribHtml = `<span class="contrib-top">${topHtml}</span><span class="contrib-rest hidden">${restHtml}</span> <button type="button" class="contrib-toggle" data-rest-count="${rest.length}" aria-expanded="false">&#x25B8; +${rest.length} more</button>`;
    }
    const evTooltip = `R/M EV: ${formatPrice(rmEV)} + avg Bulk share: ${formatPrice(bulkPerSpot)} = ${formatPrice(effectiveEV)}`;
    tr.innerHTML = `
      <td class="col-tracker-tier">${tier > 0 ? '★'.repeat(tier) : ''}</td>
      <td class="col-spot-name">${escHtml(spot.label)}</td>
      <td class="col-spot-ev" title="${escHtml(evTooltip)}">${formatPrice(effectiveEV)}</td>
      <td class="col-contrib">${contribHtml}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-image-url]')) return;
      const toggleBtn = e.target.closest('.contrib-toggle');
      if (toggleBtn) {
        e.stopPropagation();
        const td = toggleBtn.closest('.col-contrib');
        const restSpan = td && td.querySelector('.contrib-rest');
        if (!restSpan) return;
        const willExpand = restSpan.classList.contains('hidden');
        restSpan.classList.toggle('hidden');
        const restCount = toggleBtn.dataset.restCount;
        toggleBtn.innerHTML = willExpand ? '&#x25BE; Collapse' : `&#x25B8; +${restCount} more`;
        toggleBtn.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
        return;
      }
      toggleSpotHit(spot.id);
    });
    tbody.appendChild(tr);
  }

  // Last Spot + Bulk informational rows (non-clickable)
  const lastTr = document.createElement('tr');
  lastTr.className = 'last-row';
  lastTr.innerHTML = `<td class="col-tracker-tier">—</td><td class="col-spot-name">Last Spot (Unmatched R/M)</td><td class="col-spot-ev">${formatPrice(lastSpotEV)}</td><td class="col-contrib"><span style="color:var(--text-muted)">R/M cards not matching any defined spot</span></td>`;
  tbody.appendChild(lastTr);
  const bulkTr = document.createElement('tr');
  bulkTr.className = 'bulk-row';
  bulkTr.innerHTML = `<td class="col-tracker-tier">—</td><td class="col-spot-name">Bulk (C/U) — distributed</td><td class="col-spot-ev">${formatPrice(bulkEV)}</td><td class="col-contrib"><span style="color:var(--text-muted)">Spread evenly: ${formatPrice(bulkPerSpot)} per spot avg</span></td>`;
  tbody.appendChild(bulkTr);

  updateTrackerSummary();
  updateHitCountDisplay();
}

function toggleSpotHit(spotId) {
  if (state.hitSpots.has(spotId)) state.hitSpots.delete(spotId);
  else state.hitSpots.add(spotId);
  const tr = dom.trackerTbody && dom.trackerTbody.querySelector(`tr[data-spot-id="${spotId}"]`);
  if (tr) tr.classList.toggle('hit', state.hitSpots.has(spotId));
  updateTrackerSummary();
  updateHitCountDisplay();
}

function updateHitCountDisplay() {
  if (!dom.hitCountDisplay || !dom.clearHitsBtn) return;
  const n = state.hitSpots.size;
  const total = state.spots.length;
  if (n === 0) {
    dom.hitCountDisplay.classList.add('hidden');
    dom.clearHitsBtn.classList.add('hidden');
  } else {
    dom.hitCountDisplay.classList.remove('hidden');
    dom.clearHitsBtn.classList.remove('hidden');
    dom.hitCountDisplay.textContent = `${n} spot${n === 1 ? '' : 's'} marked pulled · ${total - n} remaining`;
  }
}

function updateTrackerSummary() {
  if (!state.lastDistribution) return;
  const { spotEV, lastSpotEV, bulkEV = 0, bulkPerSpot = 0 } = state.lastDistribution;
  const total = state.spots.length;
  const remainingIndices = [];
  for (let i = 0; i < total; i++) if (!state.hitSpots.has(state.spots[i].id)) remainingIndices.push(i);
  const remainingCount = remainingIndices.length;
  // R/M-only remaining total (used for hottest spot ranking)
  const remainingRMTotal = remainingIndices.reduce((s, i) => s + spotEV[i], 0);
  // Effective: R/M + bulk-per-spot share
  const remainingTotal = remainingRMTotal + bulkPerSpot * remainingCount;
  const remainingAvg = remainingCount > 0 ? remainingTotal / remainingCount : 0;

  // Rank by effective EV (R/M + uniform bulk share)
  const ranked = remainingIndices
    .map(i => ({ idx: i, v: spotEV[i] + bulkPerSpot }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5);
  const top5Sum = ranked.reduce((s, r) => s + r.v, 0);
  const top5Pct = remainingTotal > 0 ? (100 * top5Sum / remainingTotal).toFixed(1) : '0.0';

  const hasHits = state.hitSpots.size > 0;
  const remainingLabel = hasHits ? 'Remaining' : 'Total';

  dom.heatmapSummary.innerHTML = `
    <div class="ev-row"><span>${remainingLabel} Pool EV:</span> <strong>${formatPrice(remainingTotal)}</strong></div>
    <div class="ev-row"><span>Mean per ${hasHits ? 'remaining ' : ''}spot:</span> <strong>${formatPrice(remainingAvg)}</strong></div>
    ${ranked.length > 0 ? `<div class="ev-row"><span>Hottest ${hasHits ? 'remaining ' : ''}spot (<em>${escHtml(state.spots[ranked[0].idx].label)}</em>):</span> <strong>${formatPrice(ranked[0].v)}</strong></div>` : ''}
    <div class="ev-row"><span>Top 5 ${hasHits ? 'remaining ' : ''}spots capture:</span> <strong>${formatPrice(top5Sum)}</strong> (${top5Pct}% of pool)</div>
    <div class="ev-row"><span>Total Bulk Value (C/U):</span> <strong>${formatPrice(bulkEV)}</strong></div>
    <div class="ev-row"><span>Avg Bulk per Spot:</span> <strong>${formatPrice(bulkPerSpot)}</strong> <span class="spot-note">(distributed evenly across all spots)</span></div>
    ${lastSpotEV > 0 ? `<div class="ev-row"><span>Last Spot (unmatched R/M):</span> <strong>${formatPrice(lastSpotEV)}</strong></div>` : ''}
    ${hasHits ? `<div class="ev-row"><span>Spots remaining:</span> <strong>${remainingCount} / ${total}</strong></div>` : ''}
  `;
}

if (dom.clearHitsBtn) {
  dom.clearHitsBtn.addEventListener('click', () => {
    if (state.hitSpots.size === 0) return;
    state.hitSpots.clear();
    if (state.lastDistribution) renderTrackerTable(state.lastDistribution);
    showToast('Hit marks cleared', 'info');
  });
}

// ─── EV Calculation ───
dom.calcEvBtn.addEventListener('click', () => {
  if (!rosterIsReady()) return;
  showLoading('Calculating Expected Value...');
  setTimeout(() => {
    try {
      const totalEV = calculateGlobalEV(state.roster);
      const divisor = state.spots.length > 0 ? state.spots.length : 1;
      const perSpot = totalEV / divisor;
      dom.totalEv.textContent = formatPrice(totalEV);
      dom.perSpotEv.textContent = formatPrice(perSpot);
      const lbl = document.getElementById('per-spot-label');
      if (lbl) lbl.textContent = `EV Per Spot (÷${divisor})`;
      dom.globalEvDisplay.classList.remove('hidden');
      showToast('EV calculated', 'success');
    } catch (e) {
      showToast(`EV error: ${e.message}`, 'error');
      console.error('[EV]', e);
    }
    hideLoading();
  }, 50);
});

// ─── Simulation ───
dom.simulateBtn.addEventListener('click', () => {
  if (!rosterIsReady()) return;
  if (!state.spots.length) { showToast('Define at least one spot first', 'error'); return; }
  showLoading('Simulating break opening...');
  setTimeout(() => {
    try {
      const insurance = parseFloat(dom.packInsurance.value) || 0;
      const simResult = simulateBreak(state.roster, state.spots, insurance);
      renderSimulationResults(simResult);
      showToast(`Simulated ${simResult.totalOpenedCards} cards`, 'success');
    } catch (e) {
      showToast(`Simulation error: ${e.message}`, 'error');
      console.error('[Sim]', e);
    }
    hideLoading();
  }, 100);
});

function renderSimulationResults(simResult) {
  dom.simResults.classList.remove('hidden');
  dom.simSpotsGrid.innerHTML = '';

  // Sort user-defined spots high to low by simulated final value, then pin
  // Bulk and Last Spot to the end of the grid. Stable on ties via spotIndex.
  const userSpots = simResult.results
    .filter(r => !r.isBulk && !r.isLastSpot)
    .sort((a, b) => (b.finalValue || 0) - (a.finalValue || 0) || a.spotIndex - b.spotIndex);
  const bulk = simResult.results.find(r => r.isBulk);
  const last = simResult.results.find(r => r.isLastSpot);

  const ordered = [...userSpots];
  if (bulk) ordered.push(bulk);
  if (last && last.cards.length > 0) ordered.push(last);

  for (const spot of ordered) {
    ordered && dom.simSpotsGrid.appendChild(renderSimSpotCard(spot));
  }

  // grandTotal is now the R/M pool value (excludes Bulk + insurance overrides)
  // so it lines up with Calculate Global EV. Show the breakdown beneath for transparency.
  dom.totalEv.textContent = formatPrice(simResult.grandTotal);
  dom.perSpotEv.textContent = formatPrice(simResult.perSpot);
  dom.globalEvDisplay.classList.remove('hidden');

  // Drop a small breakdown line below the EV cards
  let breakdownEl = document.getElementById('sim-breakdown');
  if (!breakdownEl) {
    breakdownEl = document.createElement('p');
    breakdownEl.id = 'sim-breakdown';
    breakdownEl.className = 'spot-note';
    breakdownEl.style.marginTop = '0.5rem';
    dom.globalEvDisplay.parentNode.insertBefore(breakdownEl, dom.simResults);
  }
  const insurancePayouts = simResult.results
    .filter(r => r.isInsured)
    .reduce((s, r) => s + r.finalValue, 0);
  const bulkValue = simResult.bulkValue || (simResult.results.find(r => r.isBulk)?.rawValue || 0);
  const fullPayout = simResult.grandPayout || simResult.grandTotal;
  const bulkPerSpotSim = simResult.bulkPerSpot || 0;
  const bulkCards = simResult.bulkCardsPerSpot || 0;
  breakdownEl.innerHTML = `Sim total above = full pool value (R/M + Bulk) — matches Global EV. <strong>${formatPrice(bulkValue)}</strong> Bulk distributed evenly across spots: <strong>${formatPrice(bulkPerSpotSim)}</strong> &amp; ~<strong>${bulkCards.toFixed(1)}</strong> C/U cards per spot. Insurance overrides for empty spots: <strong>${formatPrice(insurancePayouts)}</strong>. Total streamer payout (incl. insurance): <strong>${formatPrice(fullPayout)}</strong>.`;
}

function renderSimSpotCard(spot) {
  const card = document.createElement('div');
  card.className = 'sim-spot-card';
  if (spot.isBulk) card.classList.add('sim-spot-bulk');
  if (spot.isLastSpot) card.classList.add('sim-spot-last');

  const valueClass = spot.isInsured ? 'sim-spot-value insured' : 'sim-spot-value';

  // Top hits — all spot cards are R/M (we put C/U in bulk), so just sort by price
  const topHits = spot.cards.slice().sort((a, b) => b.price - a.price).slice(0, 5);

  card.innerHTML = `
    <div class="sim-spot-header">
      <span class="sim-spot-name">${escHtml(spot.name)}</span>
      <span class="${valueClass}">
        ${formatPrice(spot.finalValue)}${spot.isInsured ? ' (insured)' : ''}
      </span>
    </div>
    ${topHits.length > 0 ? `
      <div class="sim-top-hits">
        ${topHits.map(h => {
          const imgUrl = imageUrlForCard(h.card);
          return imgUrl
            ? `<img class="sim-card-img" src="${imgUrl}" alt="${escHtml(h.card.name)}" title="${escHtml(h.card.name)} — ${formatPrice(h.price)}" loading="lazy" data-image-url="${imgUrl}">`
            : '';
        }).join('')}
      </div>
    ` : ''}
    <div class="sim-spot-cards">
      ${spot.cards.slice(0, 20).map(c => {
        const rarityClass = `rarity-${c.card.rarity || 'common'}`;
        return `<span class="sim-card-chip ${rarityClass}">
          ${escHtml(c.card.name)}
          <span class="sim-card-price">${formatPrice(c.price)}</span>
        </span>`;
      }).join('')}
      ${spot.cards.length > 20 ? `<span class="sim-card-chip">+${spot.cards.length - 20} more</span>` : ''}
    </div>
  `;
  return card;
}

// ─── View Mode (Buyer / Break Builder) ───
function setViewMode(mode) {
  state.viewMode = mode;
  dom.tabBuyerBtn.classList.toggle('active', mode === 'buyer');
  dom.tabBuyerBtn.setAttribute('aria-selected', mode === 'buyer' ? 'true' : 'false');
  dom.tabBuilderBtn.classList.toggle('active', mode === 'builder');
  dom.tabBuilderBtn.setAttribute('aria-selected', mode === 'builder' ? 'true' : 'false');
  dom.buyerPanel.classList.toggle('hidden', mode !== 'buyer');
  dom.builderPanel.classList.toggle('hidden', mode !== 'builder');
  // Re-render roster so cost columns appear/disappear
  renderRoster();
  if (mode === 'builder') refreshBuilderView();
}
dom.tabBuyerBtn.addEventListener('click', () => setViewMode('buyer'));
dom.tabBuilderBtn.addEventListener('click', () => setViewMode('builder'));

// ─── Builder: Cost Tracking ───
function calculateRosterCost() {
  return state.roster.reduce((sum, e) => sum + (parseFloat(e.costPerUnit) || 0) * e.quantity, 0);
}

function refreshCostSummary() {
  const rosterCost = calculateRosterCost();
  const insuranceValue = parseFloat(dom.builderInsurance.value) || 0;
  const spotCount = state.spots.length;

  let expInsurance = { totalCost: 0, expectedEmpty: 0 };
  if (rosterIsReady() && spotCount > 0) {
    try { expInsurance = expectedInsuranceImpact(state.roster, state.spots, insuranceValue); }
    catch (e) { console.warn('[Builder] insurance calc failed:', e.message); }
  }

  const totalCost = rosterCost + expInsurance.totalCost;
  dom.builderTotalCost.textContent = formatPrice(rosterCost);
  dom.builderInsuranceCost.textContent = formatPrice(expInsurance.totalCost);
  dom.builderInsuranceDetail.textContent =
    insuranceValue > 0 && rosterIsReady() && spotCount > 0
      ? `${expInsurance.expectedEmpty.toFixed(1)} empty spots × ${formatPrice(insuranceValue)}`
      : (insuranceValue > 0
          ? (spotCount === 0 ? 'Define spots to estimate' : 'Add product to estimate')
          : 'Insurance disabled ($0)');
  const divisor = spotCount > 0 ? spotCount : 1;
  dom.builderPerSpotCost.textContent = formatPrice(totalCost / divisor);

  if (rosterIsReady()) {
    try {
      const ev = calculateGlobalEV(state.roster);
      dom.builderTotalEv.textContent = formatPrice(ev);
      // Bulk breakdown sub-line
      const bulkEV = (typeof calculateBulkEV === 'function')
        ? calculateBulkEV(state.roster)
        : (state.lastDistribution ? state.lastDistribution.bulkEV : 0) || 0;
      const bulkPerSpot = spotCount > 0 ? bulkEV / spotCount : 0;
      const detail = document.getElementById('builder-bulk-detail');
      if (detail) {
        detail.innerHTML = `incl. <strong>${formatPrice(bulkEV)}</strong> Bulk (~${formatPrice(bulkPerSpot)}/spot distributed)`;
      }
    } catch (e) { dom.builderTotalEv.textContent = '$0.00'; }
  } else {
    dom.builderTotalEv.textContent = '$0.00';
    const detail = document.getElementById('builder-bulk-detail');
    if (detail) detail.textContent = '—';
  }
}

// Update on insurance changes (cheap path — table not affected)
if (dom.builderInsurance) {
  dom.builderInsurance.addEventListener('input', refreshCostSummary);
}

function refreshBuilderView() {
  refreshCostSummary();
  renderBuilderTable();
  if (!state.showNotesEdited) refreshShowNotes();
}

// ─── Show Notes Generator ───

/**
 * Group the roster into the four compact buckets used in WhatNot show notes:
 *   - Play: non-collector boosters, aggregated by set code ("SOS x30, DFT x6")
 *   - CBs:  collector boosters, aggregated by set code
 *   - Precons: just the deck name (no set code), each entry separately
 *   - SLDs: just the drop name, each entry separately
 */
function showNotesContentsLines() {
  const playByCode = new Map();
  const cbByCode = new Map();
  const preconEntries = [];
  const sldEntries = [];

  for (const e of state.roster) {
    const q = e.quantity || 1;
    if (e.productType === 'booster') {
      const code = (e.setCode || '').toUpperCase() || '?';
      const isCollector = String(e.boosterType || '').toLowerCase().includes('collector');
      const target = isCollector ? cbByCode : playByCode;
      target.set(code, (target.get(code) || 0) + q);
    } else if (e.productType === 'commander_precon') {
      const name = e.deckName || e.setName || (e.setCode || '').toUpperCase() || 'Precon';
      preconEntries.push({ name, q });
    } else if (e.productType === 'secret_lair') {
      const name = e.dropName || e.dropKey || 'Drop';
      sldEntries.push({ name, q });
    }
  }

  const fmtMap = (m) => [...m.entries()].map(([code, q]) => `${code} x${q}`).join(', ');
  return {
    playLine: fmtMap(playByCode),
    cbLine: fmtMap(cbByCode),
    preconEntries,
    sldEntries,
  };
}

function generateShowNotes() {
  const { playLine, cbLine, preconEntries, sldEntries } = showNotesContentsLines();
  const tiers = state.starTiers || { three: 10, two: 20, one: 30 };
  const labels = state.starLabels || { three: '⭐⭐⭐', two: '⭐⭐', one: '⭐' };

  const parts = [];
  if (playLine) {
    parts.push('Play: ');
    parts.push(playLine);
    parts.push('');
  }
  if (preconEntries.length) {
    parts.push('Precon: ');
    for (const p of preconEntries) parts.push(p.q > 1 ? `${p.name} x${p.q}` : p.name);
    parts.push('');
  }
  if (cbLine) {
    parts.push('CBs: ');
    parts.push(cbLine);
    parts.push('');
  }
  if (sldEntries.length) {
    parts.push('SLD');
    for (const s of sldEntries) parts.push(s.q > 1 ? `${s.name} x${s.q}` : s.name);
    parts.push('');
  }
  parts.push(`${labels.three} = Top ${tiers.three} spots: biggest hits & most cards 🔥`);
  parts.push(`${labels.two} = Next ${tiers.two} spots: still hits often, decent upside 📈`);
  parts.push(`${labels.one} = Next ${tiers.one} spots: outside shot, often not big value 🎯`);
  parts.push('NO STAR = Hard-to-hit spots, often insurance 🛟');
  parts.push('ANY SPOT CAN WIFF: THEY ARE PACKS! 🎲');
  parts.push('• Once all spots fill, all pictured packs are ripped LIVE 🎥');
  parts.push('• All Rares & Mythics (UNLESS LISTED OTHERWISE) are sorted by Kindred (creature type) or Card Type 🧬');
  parts.push('');
  parts.push('Kindred Rule:');
  parts.push('Creature subtype uses the FIRST word 🐾');
  parts.push('Example: Merfolk Bard Wizard → 🐟 Merfolk Kindred');
  parts.push('');
  parts.push(`Any spot with no "hits" (Typically Rares/Mythics) receives:`);
  parts.push(`👉 Play Pack Insurance 🎁`);
  parts.push('• No refunds after randomizer spins ⛔');
  parts.push('• Missed kindred / art cards go to the FINAL SPOT SOLD 🏁');
  return parts.join('\n');
}

function refreshShowNotes() {
  if (!dom.showNotesText) return;
  dom.showNotesText.value = generateShowNotes();
}

if (dom.showNotesText) {
  dom.showNotesText.addEventListener('input', () => { state.showNotesEdited = true; });
}
if (dom.regenShowNotesBtn) {
  dom.regenShowNotesBtn.addEventListener('click', () => {
    state.showNotesEdited = false;
    refreshShowNotes();
    showToast('Show notes regenerated', 'info');
  });
}
if (dom.copyShowNotesBtn) {
  dom.copyShowNotesBtn.addEventListener('click', async () => {
    const text = dom.showNotesText?.value || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast('Show notes copied to clipboard', 'success');
    } catch (e) {
      dom.showNotesText?.select();
      document.execCommand('copy');
      showToast('Show notes copied (fallback)', 'success');
    }
  });
}

// ─── Builder: Star Tiers + Guaranteed Hits ───

/**
 * Walk SLD + precon entries and tally each card's guaranteed contribution
 * to its spot. Returns Array<Map> of length 100, where each Map maps
 * "card name|cn" → { card, count, totalValue }.
 */
function computeGuaranteedHitsBySpot() {
  // Returns Array<Map> indexed by spot position (matching state.spots order)
  const perSpot = state.spots.map(() => new Map());
  const lastSpot = new Map();
  function addCard(card, isFoilHint, copies) {
    if (card.rarity === 'common' || card.rarity === 'uncommon') return;
    const finishHint = isFoilHint ? 'foil' : 'nonfoil';
    const price = getCardPrice(card, finishHint);
    const key = `${card.name}|${card.collector_number}`;
    // Find first matching spot (priority order)
    let target = null;
    for (let i = 0; i < state.spots.length; i++) {
      if (cardMatchesSpot(card, state.spots[i].parsed)) { target = perSpot[i]; break; }
    }
    if (!target) target = lastSpot;
    const existing = target.get(key);
    if (existing) {
      existing.count += copies;
      existing.totalValue += price * copies;
    } else {
      target.set(key, { card, count: copies, unitPrice: price, totalValue: price * copies });
    }
  }

  for (const entry of state.roster) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      const isFoil = finish !== 'nonfoil';
      for (const card of (entry.dropCards || [])) addCard(card, isFoil, entry.quantity);
    } else if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) addCard(card, !!card.__isFoil, entry.quantity);
    }
  }
  return { perSpot, lastSpot };
}

function getStarTier(rank) {
  const t = state.starTiers;
  if (rank < t.three) return 3;
  if (rank < t.three + t.two) return 2;
  if (rank < t.three + t.two + t.one) return 1;
  return 0;
}

/**
 * Resolve the marker string for a given tier from state.starLabels.
 * Defaults to a single ⭐ if the user clears the field.
 */
function tierMarker(tier) {
  if (tier <= 0) return '';
  const key = tier === 3 ? 'three' : tier === 2 ? 'two' : 'one';
  return (state.starLabels && state.starLabels[key]) || '⭐';
}

/**
 * Build the user-facing label for a spot. Marker is a single PREFIX — no
 * trailing mirror copy.
 * Examples (default markers):
 *   ⭐⭐⭐ Land
 *   ⭐⭐⭐ Demonic Tutor Guaranteed Hit
 *   ⭐⭐ Saga
 *   ⭐ Equipment
 *   Sorcery
 * With custom markers (e.g., "Nasty" / "Diabolical" / "Filthy"):
 *   Nasty Land
 *   Nasty Demonic Tutor Guaranteed Hit
 *   Diabolical Saga
 *   Filthy Equipment
 */
function buildSpotLabel(spotLabel, tier, guaranteedHighlight) {
  if (tier === 0) return spotLabel;
  const marker = tierMarker(tier);
  // Word-based markers get a space separator; emoji markers stay tight to the spot name.
  const sep = /[A-Za-z0-9]/.test(marker.charAt(0)) ? ' ' : '';
  if (tier === 3 && guaranteedHighlight) {
    return `${marker}${sep}${spotLabel} ${guaranteedHighlight} Guaranteed Hit`;
  }
  return `${marker}${sep}${spotLabel}`;
}

/**
 * Top-priority guaranteed-hit name for a spot (most valuable single card).
 * Used in the 3-star label suffix.
 */
function pickGuaranteedHighlight(guaranteedMap, notableThreshold) {
  let best = null;
  for (const v of guaranteedMap.values()) {
    if (v.unitPrice < notableThreshold && (!best || v.unitPrice > best.unitPrice)) continue;
    if (!best || v.unitPrice > best.unitPrice) best = v;
  }
  if (best && best.unitPrice >= notableThreshold) return best.card.name;
  return null;
}

// ─── Builder: Top Hits (probabilistic) ───
//
// Top hits per spot come from the booster R/M distribution. We compute
// expected count of each card per spot and surface those above the
// notable-value threshold sorted by expected value.

function computeTopHitsBySpot(notableThreshold) {
  // Returns Array<Map> indexed by spot position
  const perSpot = state.spots.map(() => new Map());
  for (const entry of state.roster) {
    if (entry.productType !== 'booster') continue;
    if (entry.status !== 'cached') continue;
    const dist = analyzeSpotDistributionForEntry(entry);
    for (const { card, ev, isFoil } of dist) {
      if (card.rarity !== 'rare' && card.rarity !== 'mythic') continue;
      const price = getCardPrice(card, isFoil ? 'foil' : 'nonfoil');
      if (price < notableThreshold) continue;
      let spotIdx = -1;
      for (let i = 0; i < state.spots.length; i++) {
        if (cardMatchesSpot(card, state.spots[i].parsed)) { spotIdx = i; break; }
      }
      if (spotIdx < 0) continue;
      const key = `${card.name}|${card.collector_number}`;
      const existing = perSpot[spotIdx].get(key);
      if (existing) existing.ev += ev;
      else perSpot[spotIdx].set(key, { card, ev, price });
    }
  }
  return perSpot;
}

/**
 * Per-entry per-card EV contribution, with quantity baked in.
 * Returns [{ card, ev, isFoil }, ...].
 */
function analyzeSpotDistributionForEntry(entry) {
  const q = entry.quantity || 1;
  return distributionForEntry(entry).map(({ card, probability, isFoil }) => ({
    card,
    ev: probability * q * getCardPrice(card, isFoil ? 'foil' : 'nonfoil'),
    isFoil
  }));
}

/**
 * Aggregate the top R/M cards contributing EV to each spot across the roster.
 * Returns an array of length 100, each entry `{ top: [{card, ev, guaranteed}], overflow }`
 * where `top` is sorted by EV descending and capped at `limit`, and `overflow`
 * is the count of additional cards beyond `limit`.
 *
 * Used by the heatmap hover tooltip.
 */
function topCardsBySpot(roster, spots, limit = 6) {
  const perSpot = spots.map(() => new Map());

  function place(card, ev, guaranteed) {
    if (ev <= 0) return;
    if (card.rarity === 'common' || card.rarity === 'uncommon') return;
    for (let i = 0; i < spots.length; i++) {
      if (cardMatchesSpot(card, spots[i].parsed)) {
        const key = `${card.name}|${card.collector_number}`;
        const existing = perSpot[i].get(key);
        if (existing) existing.ev += ev;
        else perSpot[i].set(key, { card, ev, guaranteed });
        return;
      }
    }
  }

  for (const entry of roster) {
    if (entry.productType === 'secret_lair') {
      const finish = entry.finish || (entry.foil ? 'foil' : 'nonfoil');
      for (const card of (entry.dropCards || [])) {
        place(card, getCardPrice(card, finish) * (entry.quantity || 1), true);
      }
      continue;
    }
    if (entry.productType === 'commander_precon') {
      for (const card of (entry.deckCards || [])) {
        const isFoil = !!card.__isFoil;
        place(card, getCardPrice(card, isFoil) * (entry.quantity || 1), true);
      }
      continue;
    }
    const dist = analyzeSpotDistributionForEntry(entry);
    for (const { card, ev } of dist) place(card, ev, false);
  }

  return perSpot.map(m => {
    const arr = [...m.values()].sort((a, b) => b.ev - a.ev);
    return { top: arr.slice(0, limit), rest: arr.slice(limit) };
  });
}

// ─── Builder: Render Table ───
function renderBuilderTable() {
  const tbody = dom.builderTbody;
  if (!tbody) return;
  tbody.innerHTML = '';
  const ready = rosterIsReady();
  const hasSpots = state.spots.length > 0;
  if (dom.builderEmpty) {
    dom.builderEmpty.classList.toggle('hidden', ready && hasSpots);
    if (!hasSpots) {
      dom.builderEmpty.textContent = 'Define spots in the Define Your Spots section above, then labels will populate here.';
    } else if (!ready) {
      dom.builderEmpty.textContent = 'Add packs/drops/decks to the roster, set their cost basis, then labels will populate here.';
    }
  }
  if (!ready || !hasSpots) return;

  const dist = analyzeSpotDistribution(state.roster, state.spots);
  const guaranteed = computeGuaranteedHitsBySpot();
  const notable = parseFloat(dom.notableThreshold.value) || 20;
  const tops = computeTopHitsBySpot(notable);

  // Rank spots by descending EV → assign star tier
  const ranked = dist.spotEV
    .map((ev, i) => ({ idx: i, ev }))
    .sort((a, b) => b.ev - a.ev || a.idx - b.idx);
  const rankByIdx = new Map();
  ranked.forEach((r, i) => rankByIdx.set(r.idx, i));

  // Render in user's priority order (matches the Spots list order)
  for (let i = 0; i < state.spots.length; i++) {
    const spot = state.spots[i];
    const ev = dist.spotEV[i];
    const tier = getStarTier(rankByIdx.get(i));
    const gMap = guaranteed.perSpot[i] || new Map();
    const tMap = tops[i] || new Map();
    const highlight = tier === 3 ? pickGuaranteedHighlight(gMap, notable) : null;
    const label = buildSpotLabel(spot.label, tier, highlight);

    // Guaranteed cell
    const gItems = [...gMap.values()].sort((a,b) => b.unitPrice - a.unitPrice);
    const gHtml = gItems.length === 0
      ? '<span style="color:var(--text-muted)">—</span>'
      : gItems.map(g => {
          const cheap = g.unitPrice < 1;
          const dispPrice = g.unitPrice >= 1 ? formatPrice(g.unitPrice) : '';
          const xN = g.count > 1 ? `&times;${g.count}` : '';
          const img = imageUrlForCard(g.card);
          const imgAttr = img ? ` data-image-url="${escHtml(img)}"` : '';
          return `<span class="guaranteed-card${cheap ? ' cheap' : ''}"${imgAttr} title="${escHtml(g.card.name)} • CN #${escHtml(g.card.collector_number)} • ${formatPrice(g.unitPrice)} each">${escHtml(g.card.name)}${xN} ${dispPrice}</span>`;
        }).join(' ');

    // Top potential hits — top 4 by ev, ≥ notable threshold
    const tItems = [...tMap.values()]
      .filter(t => t.price >= notable)
      .sort((a, b) => b.ev - a.ev)
      .slice(0, 4);
    const tHtml = tItems.length === 0
      ? '<span style="color:var(--text-muted)">—</span>'
      : tItems.map(t => {
          const img = imageUrlForCard(t.card);
          const imgAttr = img ? ` data-image-url="${escHtml(img)}"` : '';
          return `<span class="tophit-chip"${imgAttr} title="${escHtml(t.card.name)} • ${formatPrice(t.price)} • EV contribution ${formatPrice(t.ev)}">${escHtml(t.card.name)} ${formatPrice(t.price)}</span>`;
        }).join(' ');

    const description = buildSpotDescription(gItems, tItems);

    const tr = document.createElement('tr');
    tr.className = `tier-${tier}`;
    tr.dataset.spotId = String(spot.id);
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td class="col-label">${escHtml(label)}</td>
      <td class="col-copy-label"><button class="btn btn-sm copy-label-btn" title="Copy this spot label">&#x1F4CB;</button></td>
      <td class="col-ev">${formatPrice(ev)}</td>
      <td class="col-guaranteed">${gHtml}</td>
      <td class="col-tophits">${tHtml}</td>
      <td class="col-copy-desc"><button class="btn btn-sm copy-desc-btn" title="Copy item description (cards only, no prices)"${description ? '' : ' disabled'}>&#x1F4DD;</button></td>
    `;
    tr.querySelector('.copy-label-btn').addEventListener('click', () => {
      copyToClipboard(label);
      tr.classList.add('copy-toast-flash');
      setTimeout(() => tr.classList.remove('copy-toast-flash'), 700);
    });
    const descBtn = tr.querySelector('.copy-desc-btn');
    if (!descBtn.disabled) {
      descBtn.addEventListener('click', () => {
        copyToClipboard(description);
        tr.classList.add('copy-toast-flash');
        setTimeout(() => tr.classList.remove('copy-toast-flash'), 700);
      });
    }
    tbody.appendChild(tr);
  }
}

/**
 * Build the streamer's item-description text for a spot — names only,
 * no prices (auction-site TOS). Output:
 *   Guaranteed Hits: Demonic Tutor x2, Sol Ring
 *   Top Potential Hits (not guaranteed): Lightning Greaves, Skullclamp, ...
 * Either line is omitted when its source list is empty. Returns '' if both
 * are empty (so the Copy button can be disabled for that spot).
 */
function buildSpotDescription(guaranteedItems, topHitItems) {
  const lines = [];
  if (guaranteedItems && guaranteedItems.length > 0) {
    const names = guaranteedItems.map(g => {
      const xN = g.count > 1 ? ` x${g.count}` : '';
      return `${g.card.name}${xN}`;
    }).join(', ');
    lines.push(`Guaranteed Hits: ${names}`);
  }
  if (topHitItems && topHitItems.length > 0) {
    const names = topHitItems.map(t => t.card.name).join(', ');
    lines.push(`Top Potential Hits (not guaranteed): ${names}`);
  }
  return lines.join('\n');
}

// ─── Builder: Copy-to-clipboard ───
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard', 'success'),
      () => fallbackCopy(text)
    );
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('Copied (fallback)', 'success'); }
  catch (e) { showToast('Copy failed — select manually', 'error'); }
  document.body.removeChild(ta);
}

dom.copyAllLabelsBtn.addEventListener('click', () => {
  const rows = dom.builderTbody.querySelectorAll('tr');
  if (!rows.length) { showToast('No labels to copy yet', 'error'); return; }
  const lines = [...rows].map(r => r.querySelector('.col-label').textContent);
  copyToClipboard(lines.join('\n'));
});

// ─── Sort Assistant PDF ───
//
// A printable, landscape, multi-page sorting guide the streamer downloads to
// use AFTER the break, while physically distributing pulled Rare/Mythic cards
// into piles. Page 1 is a coarse-sort master (split the pile by main card type
// first); then one or more detail pages per main type (spots sorted A–Z), each
// spot getting a tall empty zone for its physical stack (the stack can hang
// below the page edge if needed); finally a catch-all page (Final Spot / Bulk /
// Misfits). Star tiers and ~expected card counts match the overlay Spot Labels.

const SORT_TYPE_ORDER = ['Land', 'Planeswalker', 'Battle', 'Enchantment', 'Artifact', 'Instant', 'Sorcery', 'Creature'];

// Color-split spots (e.g. "White Human", "Blue Human") should still alphabetize
// by their base type ("Human"), then break ties in WUBRG → Multi → Colorless
// order so the sorter flips to H once and finds every Human stack grouped.
const COLOR_RANK = { white: 0, blue: 1, black: 2, red: 3, green: 4, multicolor: 5, multicolored: 5, multi: 5, gold: 5, rainbow: 5, colorless: 6 };
function spotSortKey(label) {
  const m = label.match(/^(\S+)\s+(.+)$/);
  if (m) {
    const c = COLOR_RANK[m[1].toLowerCase()];
    if (c !== undefined) return { base: m[2].trim().toLowerCase(), rank: c };
  }
  return { base: label.toLowerCase(), rank: -1 };
}
function compareSpots(a, b) {
  const ka = spotSortKey(a.label), kb = spotSortKey(b.label);
  return ka.base.localeCompare(kb.base, undefined, { sensitivity: 'base' })
    || (ka.rank - kb.rank)
    || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

function sortAssistantData() {
  const dist = analyzeSpotDistribution(state.roster, state.spots);
  const counts = dist.spotCounts || state.spots.map(() => 0);
  // Rank by R/M EV → star tier (mirrors the overlay Spot Labels table so the
  // printed stars match what buyers saw on stream).
  const ranked = dist.spotEV
    .map((ev, i) => ({ idx: i, ev }))
    .sort((a, b) => b.ev - a.ev || a.idx - b.idx);
  const rankByIdx = new Map();
  ranked.forEach((r, i) => rankByIdx.set(r.idx, i));

  const spots = state.spots.map((s, i) => ({
    label: s.label,
    tier: getStarTier(rankByIdx.get(i)),
    count: counts[i] || 0,
    bucket: spotTypeBucket(s.label).name,
  }));

  const groups = new Map();
  for (const sp of spots) {
    if (!groups.has(sp.bucket)) groups.set(sp.bucket, []);
    groups.get(sp.bucket).push(sp);
  }
  const orderedGroups = [];
  for (const name of SORT_TYPE_ORDER) {
    if (groups.has(name)) {
      const arr = groups.get(name).sort(compareSpots);
      orderedGroups.push({ name, spots: arr });
    }
  }
  return { orderedGroups, lastSpotCount: dist.lastSpotCount || 0 };
}

// Pack groups into detail pages of `per` cells each. Creatures (usually the
// bulk) keep their own pages; the smaller non-creature types are packed
// together greedily so e.g. Land + Planeswalker + Instant can share one sheet.
// Returns [{ cells:[{sp,type}], types:[name,...] }].
function buildDetailPages(orderedGroups, per) {
  const pages = [];
  let cur = null;
  const fresh = () => { cur = { cells: [], types: [] }; pages.push(cur); return cur; };
  for (const g of orderedGroups) {
    if (g.name === 'Creature') {
      for (let i = 0; i < g.spots.length; i += per) {
        const pg = { cells: [], types: ['Creature'] };
        for (const sp of g.spots.slice(i, i + per)) pg.cells.push({ sp, type: 'Creature' });
        pages.push(pg);
      }
      cur = null; // don't let later types share a creature page
      continue;
    }
    for (const sp of g.spots) {
      if (!cur || cur.cells.length >= per) fresh();
      cur.cells.push({ sp, type: g.name });
      if (!cur.types.includes(g.name)) cur.types.push(g.name);
    }
  }
  return pages;
}

function fmtSortCount(n) {
  if (!n || n <= 0) return '0';
  if (n < 1) return '<1';
  return '~' + Math.round(n);
}

// Draw a single filled gold star centred at (cx, cy) with outer radius r.
function pdfStar(doc, cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 5;
    const rad = (i % 2 === 0) ? r : r * 0.42;
    pts.push([cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]);
  }
  const rel = [];
  for (let i = 1; i < pts.length; i++) rel.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  doc.setFillColor(245, 179, 1);
  doc.lines(rel, pts[0][0], pts[0][1], [1, 1], 'F', true);
}

// Fit text into maxW at up to 2 lines, shrinking font from maxSize to minSize.
function pdfFitTitle(doc, text, maxW, maxSize, minSize) {
  for (let fs = maxSize; fs >= minSize; fs--) {
    doc.setFontSize(fs);
    const lines = doc.splitTextToSize(text, maxW);
    if (lines.length <= 2) return { fs, lines };
  }
  doc.setFontSize(minSize);
  let lines = doc.splitTextToSize(text, maxW);
  if (lines.length > 2) {
    lines = lines.slice(0, 2);
    let last = lines[1];
    while (doc.getTextWidth(last + '…') > maxW && last.length > 1) last = last.slice(0, -1);
    lines[1] = last + '…';
  }
  return { fs: minSize, lines };
}

// A spot cell: title bar (stars + name + ~count) and a tall empty pile zone.
// On combined (multi-type) pages, pass `typeTag` to print a small uppercase
// type label above the title so every card stack is self-identifying.
function drawSpotCell(doc, x, y, w, h, sp, typeTag) {
  const titleH = typeTag ? 44 : 32;
  doc.setDrawColor(110); doc.setLineWidth(0.8);
  doc.rect(x, y, w, h);
  doc.setFillColor(243, 244, 246);
  doc.rect(x, y, w, titleH, 'F');
  doc.setDrawColor(110); doc.line(x, y + titleH, x + w, y + titleH);

  let barTop = y;
  if (typeTag) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(120, 120, 130);
    doc.text(typeTag.toUpperCase(), x + 6, y + 11);
    barTop = y + 13;
  }
  const cy = barTop + ((y + titleH) - barTop) / 2;
  const tx = x + 6;
  const starR = 4.3;
  const starBlockW = sp.tier > 0 ? sp.tier * (starR * 2 + 2) + 6 : 0;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
  const ctxt = fmtSortCount(sp.count);
  const cw = doc.getTextWidth(ctxt);
  doc.text(ctxt, x + w - 5 - cw, cy + 3);

  // Name first, then star tier to the right of the name, then ~count far right.
  doc.setFont('helvetica', 'bold'); doc.setTextColor(25, 25, 30);
  const nameMaxW = Math.max((x + w - 5 - cw - 6) - tx - starBlockW, 30);
  const fit = pdfFitTitle(doc, sp.label, nameMaxW, 11, 7);
  doc.setFontSize(fit.fs);
  const lineH = fit.fs + 1.5;
  let ty = cy - ((fit.lines.length - 1) * lineH) / 2 + fit.fs * 0.35;
  let maxLineW = 0;
  for (const ln of fit.lines) { doc.text(ln, tx, ty); const lw = doc.getTextWidth(ln); if (lw > maxLineW) maxLineW = lw; ty += lineH; }
  if (sp.tier > 0) {
    let sx = tx + maxLineW + 6 + starR;
    for (let i = 0; i < sp.tier; i++) { pdfStar(doc, sx, cy, starR); sx += starR * 2 + 2; }
  }
}

// A large staging zone (coarse-sort buckets & catch-all piles). The header band
// auto-sizes to the wrapped title + subtitle so nothing overlaps regardless of
// zone width or text length.
function drawBigZone(doc, x, y, w, h, title, subtitle) {
  const pad = 8, subFS = 8.5, subLineH = 11;
  doc.setFont('helvetica', 'bold');
  const tfit = pdfFitTitle(doc, title, w - 16, 15, 11);
  const titleLineH = tfit.fs + 3;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(subFS);
  const subLines = subtitle ? doc.splitTextToSize(subtitle, w - 16).slice(0, 2) : [];
  const titleH = pad + tfit.lines.length * titleLineH + (subLines.length ? 2 + subLines.length * subLineH : 0) + 5;

  doc.setDrawColor(110); doc.setLineWidth(1);
  doc.rect(x, y, w, h);
  doc.setFillColor(236, 239, 243);
  doc.rect(x, y, w, titleH, 'F');
  doc.setDrawColor(110); doc.line(x, y + titleH, x + w, y + titleH);

  doc.setFont('helvetica', 'bold'); doc.setTextColor(20); doc.setFontSize(tfit.fs);
  let ty = y + pad + tfit.fs;
  for (const ln of tfit.lines) { doc.text(ln, x + 8, ty); ty += titleLineH; }
  if (subLines.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(subFS); doc.setTextColor(110);
    let sy = y + pad + tfit.lines.length * titleLineH + subFS;
    for (const ln of subLines) { doc.text(ln, x + 8, sy); sy += subLineH; }
  }
}

function pdfPageHeader(doc, title, note, pageNum, totalPages) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(20);
  doc.text(title, 28, 30);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(120);
  if (note) doc.text(note, 28, 44);
  const pg = `Page ${pageNum} / ${totalPages}`;
  const pw = doc.getTextWidth(pg);
  doc.text(pg, 792 - 28 - pw, 30);
}

function generateSortAssistantPDF() {
  if (!rosterIsReady()) { showToast('Lock your roster first', 'error'); return; }
  if (!state.spots.length) { showToast('Define at least one spot first', 'error'); return; }
  const ns = window.jspdf;
  if (!ns || !ns.jsPDF) { showToast('PDF library not loaded — check your connection and retry', 'error'); return; }

  showLoading('Building Sort Assistant PDF...');
  setTimeout(() => {
    try {
      const { orderedGroups, lastSpotCount } = sortAssistantData();
      if (!orderedGroups.length) { hideLoading(); showToast('No spots to sort', 'error'); return; }

      const doc = new ns.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
      const PW = 792, PH = 612, M = 28, BOT = 16;
      // Detail pile grid: 3 across × 2 down. The bottom row is intentionally
      // pushed past the page edge (rowH is taller than would fit) so each pile
      // gets maximum height — card stacks for row 2 simply hang below the sheet.
      const COLS = 3, ROWS = 2, CGAP = 12, RGAP = 14;
      const gridTop = 62;
      const gridW = PW - 2 * M;
      const colW = (gridW - (COLS - 1) * CGAP) / COLS;
      const rowH = 300; // > (PH-gridTop)/2 on purpose → row 2 overflows the page
      const cellXY = (slot) => {
        const c = slot % COLS, r = Math.floor(slot / COLS);
        return [M + c * (colW + CGAP), gridTop + r * (rowH + RGAP)];
      };
      const per = COLS * ROWS; // 6 cells per detail page

      const detailPagesArr = buildDetailPages(orderedGroups, per);
      const totalPages = 1 + detailPagesArr.length + 1;

      let pageNum = 0, first = true;
      const newPage = () => { if (!first) doc.addPage(); first = false; pageNum++; };

      // PAGE 1 — coarse sort master (own grid; always fits one page)
      newPage();
      pdfPageHeader(doc, 'Sort Assistant — Step 1: Coarse Sort',
        'Split the whole pile into these main-type stacks first, then sort each stack using the detail pages that follow.',
        pageNum, totalPages);
      const nT = orderedGroups.length;
      const cCols = Math.min(4, nT);
      const cRows = Math.ceil(nT / cCols);
      const cColW = (gridW - (cCols - 1) * CGAP) / cCols;
      const cGridH = PH - gridTop - BOT;
      // When there are 2 rows of coarse buckets, push the bottom row past the
      // page edge too (taller zones) — same treatment as the detail pages.
      const cRowH = cRows >= 2 ? rowH : cGridH;
      orderedGroups.forEach((g, i) => {
        const c = i % cCols, r = Math.floor(i / cCols);
        const x = M + c * (cColW + CGAP), y = gridTop + r * (cRowH + RGAP);
        const tot = g.spots.reduce((s, sp) => s + sp.count, 0);
        drawBigZone(doc, x, y, cColW, cRowH, g.name, `${g.spots.length} spot${g.spots.length === 1 ? '' : 's'} · ${fmtSortCount(tot)} cards expected`);
      });

      // DETAIL PAGES — packed (small non-creature types combined per sheet)
      for (const pg of detailPagesArr) {
        newPage();
        const multi = pg.types.length > 1;
        const title = multi ? `Main Types: ${pg.types.join(', ')}` : `Main Type: ${pg.types[0]}`;
        const note = multi
          ? 'Combined to save paper — each card stack is tagged with its type · sorted A–Z within type'
          : 'Sorted A–Z · ★ tiers & ~counts match your overlay';
        pdfPageHeader(doc, title, note, pageNum, totalPages);
        pg.cells.forEach((cell, idx) => {
          const [x, y] = cellXY(idx);
          drawSpotCell(doc, x, y, colW, rowH, cell.sp, multi ? cell.type : null);
        });
      }

      // CATCH-ALL PAGE — three big piles
      newPage();
      pdfPageHeader(doc, 'Catch-All Piles',
        'Cards that do not belong to a sellable R/M spot. Keep these three piles going as you sort.',
        pageNum, totalPages);
      const c3 = 3, cg = 12;
      const cW = (gridW - (c3 - 1) * cg) / c3;
      const catchH = PH - gridTop - BOT;
      const zones = [
        ['Final Spot — Unmatched R/M', `${fmtSortCount(lastSpotCount)} cards · rares/mythics that match no defined spot (go to the last buyer)`],
        ['Bulk — Commons & Uncommons', 'Every common & uncommon, regardless of type'],
        ['Misfits — Tokens · Art · Basics · Variants', 'Anything that is not a sellable R/M spot card'],
      ];
      zones.forEach((z, i) => { const x = M + i * (cW + cg); drawBigZone(doc, x, gridTop, cW, catchH, z[0], z[1]); });

      doc.save(`sort-assistant-${new Date().toISOString().slice(0, 10)}.pdf`);
      showToast('Sort Assistant PDF downloaded', 'success');
    } catch (e) {
      console.error('[SortAssistant]', e);
      showToast(`PDF error: ${e.message}`, 'error');
    }
    hideLoading();
  }, 50);
}

if (dom.sortAssistantBtn) dom.sortAssistantBtn.addEventListener('click', generateSortAssistantPDF);

dom.rebuildLabelsBtn.addEventListener('click', () => {
  state.starTiers.three = parseInt(dom.tierThree.value) || 10;
  state.starTiers.two = parseInt(dom.tierTwo.value) || 20;
  state.starTiers.one = parseInt(dom.tierOne.value) || 30;
  state.starTiers.notable = parseFloat(dom.notableThreshold.value) || 20;
  refreshBuilderView();
});

// ─── Change Star Labels modal ───
const changeStarLabelsBtn = $('change-star-labels-btn');
if (changeStarLabelsBtn) {
  changeStarLabelsBtn.addEventListener('click', () => {
    // Pre-fill current values when opening
    $('star-label-three').value = state.starLabels.three;
    $('star-label-two').value = state.starLabels.two;
    $('star-label-one').value = state.starLabels.one;
    updateStarLabelPreview();
    openModal('star-labels-modal');
  });
}

function updateStarLabelPreview() {
  const three = $('star-label-three').value.trim() || '⭐⭐⭐';
  const two = $('star-label-two').value.trim() || '⭐⭐';
  const one = $('star-label-one').value.trim() || '⭐';
  const preview = $('star-label-preview');
  if (!preview) return;
  // Build temp labels using the same rule as buildSpotLabel
  function previewLabel(num, marker) {
    const sep = /[A-Za-z0-9]/.test(marker.charAt(0)) ? ' ' : '';
    return `${marker}${sep}${num}`;
  }
  preview.innerHTML = `Preview: <code>${escHtml(previewLabel('01', three))}</code> &middot; <code>${escHtml(previewLabel('67', two))}</code> &middot; <code>${escHtml(previewLabel('91', one))}</code>`;
}

for (const id of ['star-label-three', 'star-label-two', 'star-label-one']) {
  const el = $(id);
  if (el) el.addEventListener('input', updateStarLabelPreview);
}

const applyStarLabelsBtn = $('apply-star-labels-btn');
if (applyStarLabelsBtn) {
  applyStarLabelsBtn.addEventListener('click', () => {
    state.starLabels = {
      three: $('star-label-three').value.trim() || '⭐⭐⭐',
      two: $('star-label-two').value.trim() || '⭐⭐',
      one: $('star-label-one').value.trim() || '⭐'
    };
    closeModal('star-labels-modal');
    refreshBuilderView();
    showToast('Star labels updated', 'success');
  });
}

const resetStarLabelsBtn = $('reset-star-labels-btn');
if (resetStarLabelsBtn) {
  resetStarLabelsBtn.addEventListener('click', () => {
    state.starLabels = { three: '⭐⭐⭐', two: '⭐⭐', one: '⭐' };
    $('star-label-three').value = '⭐⭐⭐';
    $('star-label-two').value = '⭐⭐';
    $('star-label-one').value = '⭐';
    updateStarLabelPreview();
    refreshBuilderView();
    showToast('Reset to star defaults', 'success');
  });
}

// ─── Builder: Demo Loader ───
// Demo prices are per-unit costs the user specified for the streamer view.
const DEMO_BREAK = {
  boosters: [
    { setCode: 'sos', boosterType: 'Play Booster',      qty: 30, costPerUnit: 4.00 },
    { setCode: 'mh3', boosterType: 'Play Booster',      qty: 36, costPerUnit: 7.00 },
    { setCode: 'fin', boosterType: 'Play Booster',      qty: 30, costPerUnit: 6.00 },
    { setCode: 'spm', boosterType: 'Collector Booster', qty: 2,  costPerUnit: 25.00 },
    { setCode: 'sos', boosterType: 'Collector Booster', qty: 2,  costPerUnit: 35.00 },
    { setCode: 'tla', boosterType: 'Collector Booster', qty: 2,  costPerUnit: 35.00 }
  ],
  precon: { setCode: 'soc', deckName: 'Silverquill Influence', costPerUnit: 40.00 },
  slds: [
    { name: 'Artist Series: Kieran Yanner', finish: 'foil', costPerUnit: 85.00 },
    { name: 'Cool Ocean Breeze',            finish: 'foil', costPerUnit: 110.00 }
  ],
  // Demo spots — demonstrates every supported syntax feature
  spots: [
    'Dragon',
    'Phoenix',
    'Demon',
    'Angel',
    'Vampire',
    'Sphinx',
    'Hydra',
    // Color-specific Human splits (multi-condition AND)
    'White Human',
    'Blue Human',
    'Black Human',
    'Red Human',
    'Green Human',
    // Combined spots (OR with /)
    'Snake/Snail',
    'Badger/Bear',
    'Wizard/Cleric',
    'Goblin/Orc',
    'Elf/Druid',
    'Zombie/Skeleton',
    // Standard tribes
    'Spirit',
    'Knight',
    'Soldier',
    'Beast',
    'Cat',
    'Bird',
    'Merfolk',
    'Faerie',
    'Pirate',
    // Non-creature subtypes (OR combinations and singles)
    'Saga',
    'Class/Case',
    'Equipment',
    'Aura',
    'Vehicle',
    // Multi-condition: supertype + card type
    'Legendary Artifact',
    'Legendary Enchantment',
    // Exclusion examples
    'Artifact excluding legendary and equipment and vehicle',
    'Enchantment excluding creature and legendary and class and case and saga',
    // Card-type fallback spots
    'Planeswalker',
    'Battle',
    'Land',
    // Catch-all spots — keep these last so they only claim what higher spots didn't.
    // Placed at the bottom of the priority list, these catch leftovers.
    'Sorcery',
    'Instant',
    'Creature'  // any creature that didn't match a higher tribe spot
  ]
};

dom.demoBtn.addEventListener('click', loadDemoBreak);

async function loadDemoBreak() {
  if (state.roster.length > 0) {
    if (!confirm('This will replace your current roster with the demo break. Continue?')) return;
  }
  // Always start fresh
  state.roster = [];
  state.spots = [];
  state.hitSpots.clear();
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
  if (state.viewMode === 'builder') refreshBuilderView();

  // If preload data is bundled (common case), hydrate instantly with
  // theatrical "Loading…" messages for visual continuity.
  const preload = (typeof globalThis !== 'undefined') ? globalThis.__DEMO_PRELOAD__ : null;
  if (preload && preload.cards && preload.boosters) {
    await loadDemoFromPreload(preload);
    return;
  }

  const failures = [];
  showLoading('Loading demo break — fetching set data, this can take ~30s...');

  // 1. Boosters — each in its own try so one failure doesn't kill the rest
  for (const b of DEMO_BREAK.boosters) {
    dom.loadingText.textContent = `Demo: loading ${b.qty}× ${b.setCode.toUpperCase()} ${b.boosterType}...`;
    try {
      await loadDemoBooster(b);
    } catch (e) {
      console.error(`[Demo] booster ${b.setCode} ${b.boosterType} failed:`, e);
      failures.push(`${b.setCode.toUpperCase()} ${b.boosterType}: ${e.message || 'fetch failed'}`);
    }
  }

  // 2. Precon
  dom.loadingText.textContent = `Demo: loading ${DEMO_BREAK.precon.setCode.toUpperCase()} precon...`;
  try {
    await loadDemoPrecon(DEMO_BREAK.precon);
  } catch (e) {
    console.error(`[Demo] precon ${DEMO_BREAK.precon.setCode} failed:`, e);
    failures.push(`${DEMO_BREAK.precon.setCode.toUpperCase()} precon: ${e.message || 'fetch failed'}`);
  }

  // 3. SLDs
  try {
    if (!state.sldDropsLoaded) {
      dom.loadingText.textContent = `Demo: loading Secret Lair drops...`;
      await loadSldDrops();
    }
    for (const s of DEMO_BREAK.slds) {
      dom.loadingText.textContent = `Demo: adding SLD "${s.name}"...`;
      try {
        await loadDemoSld(s);
      } catch (e) {
        console.error(`[Demo] SLD ${s.name} failed:`, e);
        failures.push(`SLD ${s.name}: ${e.message || 'fetch failed'}`);
      }
    }
  } catch (e) {
    console.error('[Demo] SLD master set failed:', e);
    failures.push(`SLD master set: ${e.message || 'fetch failed'}`);
  }

  // Demo spots are NOT auto-loaded anymore — the Lock Roster button is the
  // single trigger for spot seeding. Clear any stale spots from a prior demo
  // load so the user starts with a clean slate.
  state.spots = [];
  state.hitSpots.clear();
  state.selectedSpotIds.clear();
  state.rosterLocked = false;
  renderSpots();
  applyRosterLockUI();

  hideLoading();
  updateButtonStates();
  refreshBuilderView();

  if (failures.length === 0) {
    showToast(`Demo loaded! ${state.spots.length} kindred spots defined. Switch to Break Tracker for the analytical view, or stay here for streamer labels.`, 'success');
  } else if (state.roster.length === 0) {
    showToast(`Demo failed entirely — ${failures.length} step(s) errored. Check console.`, 'error');
    console.error('[Demo] All failures:', failures);
  } else {
    showToast(`Demo partially loaded — ${state.roster.length} item(s) succeeded, ${failures.length} failed. See console for details.`, 'error');
    console.error('[Demo] Partial failures:', failures);
  }
}

/**
 * Hydrate the demo break from inlined preload data. No network calls;
 * theatrical "Loading…" messages step through for visual continuity.
 */
async function loadDemoFromPreload(preload) {
  const pool = preload.cards || {};
  const cardById = id => pool[id];
  const resolveCards = ids => (ids || []).map(cardById).filter(Boolean);

  function hydrateBoosterModel(model) {
    if (!model) return null;
    const out = {};
    for (const [key, def] of Object.entries(model)) {
      const sheets = {};
      for (const [sn, sh] of Object.entries(def.sheets || {})) {
        sheets[sn] = {
          entries: (sh.entries || []).map(e => {
                     const out = { card: cardById(e.id), weight: e.w };
                     if (typeof e.f === 'boolean') out.foil = e.f;
                     return out;
                   }).filter(e => e.card),
          totalWeight: sh.totalWeight,
          foil: !!sh.foil,
          fixed: !!sh.fixed,
          allowDuplicates: !!sh.allowDuplicates
        };
      }
      out[key] = { variants: def.variants || [], totalWeight: def.totalWeight, sheets };
    }
    return out;
  }

  const STEP_DELAY = 150; // ms between visible steps
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  showLoading('Loading demo break from cache…');
  await sleep(120);

  // 1. Boosters
  for (const b of (preload.boosters || [])) {
    dom.loadingText.textContent = `Loading ${b.qty}× ${b.setName} ${b.boosterType}…`;
    await sleep(STEP_DELAY);
    state.roster.push({
      id: state.nextRosterId++,
      productType: 'booster',
      setCode: b.setCode,
      setName: b.setName,
      boosterType: b.boosterType,
      quantity: b.qty,
      cards: resolveCards(b.cardIds),
      subsetCards: resolveCards(b.subsetCardIds),
      mtgjsonBooster: hydrateBoosterModel(b.mtgjsonBooster),
      modelSource: b.mtgjsonBooster ? 'mtgjson' : undefined,
      status: 'cached',
      costPerUnit: b.costPerUnit
    });
    renderRoster();
  }

  // 2. Precon
  if (preload.precon) {
    const p = preload.precon;
    dom.loadingText.textContent = `Loading ${p.setName} — ${p.deckName}…`;
    await sleep(STEP_DELAY);
    const deckCards = [];
    for (const e of (p.deckCardEntries || [])) {
      const base = cardById(e.id);
      if (!base) continue;
      // Tag with foil hint so simulateCommanderPrecon can apply it
      for (let i = 0; i < (e.count || 1); i++) {
        deckCards.push(e.isFoil ? { ...base, __isFoil: true } : base);
      }
    }
    state.roster.push({
      id: state.nextRosterId++,
      productType: 'commander_precon',
      setCode: p.setCode,
      setName: p.setName,
      deckName: p.deckName,
      deckCards,
      quantity: 1,
      costPerUnit: p.costPerUnit,
      status: 'cached'
    });
    renderRoster();
  }

  // 3. SLDs
  state.sldDropsLoaded = true; // pretend the master set was fetched
  for (const s of (preload.slds || [])) {
    dom.loadingText.textContent = `Adding SLD "${s.name}"…`;
    await sleep(STEP_DELAY);
    state.roster.push({
      id: state.nextRosterId++,
      productType: 'secret_lair',
      dropKey: s.key,
      dropName: s.name,
      dropCards: resolveCards(s.dropCardIds),
      finish: s.finish,
      quantity: 1,
      costPerUnit: s.costPerUnit,
      status: 'cached'
    });
    renderRoster();
  }

  // No demo spot pre-loading — Lock Roster is the single seed trigger now.
  // Reset any stale state from prior demo loads.
  state.spots = [];
  state.hitSpots.clear();
  state.selectedSpotIds.clear();
  state.rosterLocked = false;
  renderSpots();
  applyRosterLockUI();
  updateRosterSummary();
  updateButtonStates();

  // 5. Finish
  hideLoading();
  refreshBuilderView();
  const dateStr = preload.generated_at || 'an earlier date';
  showToast(`Demo loaded instantly. Prices frozen as of ${dateStr} (live data still hits Scryfall when you add your own products).`, 'success');
}

async function loadDemoBooster(spec) {
  const setInfo = await getSetInfo(spec.setCode);
  if (!setInfo) throw new Error(`Set ${spec.setCode} not found`);
  state.selectedSet = { code: setInfo.code, name: setInfo.name, setInfo };
  dom.rosterQty.value = String(spec.qty);
  dom.rosterPack.innerHTML = `<option value="${spec.boosterType}">${spec.boosterType}</option>`;
  dom.rosterPack.value = spec.boosterType;
  await addBoosterEntry();
  const last = state.roster[state.roster.length - 1];
  if (last && last.setCode === spec.setCode && last.boosterType === spec.boosterType) {
    last.costPerUnit = spec.costPerUnit;
  }
  renderRoster();
}

async function loadDemoPrecon(spec) {
  const setInfo = await getSetInfo(spec.setCode);
  if (!setInfo) throw new Error(`Precon ${spec.setCode} not found`);
  const result = await fetchPreconDecks(spec.setCode);
  if (!result.decks || !result.decks.length) throw new Error('No precon decks available');
  // If a specific deck name was requested, look it up; otherwise default to the first deck
  let deck = null;
  if (spec.deckName) {
    deck = result.decks.find(d => d.name && d.name.toLowerCase() === spec.deckName.toLowerCase());
    if (!deck) {
      console.warn(`[Demo] Precon deck "${spec.deckName}" not found in ${spec.setCode}, falling back to first deck (${result.decks[0].name})`);
      deck = result.decks[0];
    }
  } else {
    deck = result.decks[0];
  }
  const entry = {
    id: state.nextRosterId++,
    productType: 'commander_precon',
    setCode: setInfo.code,
    setName: setInfo.name,
    deckName: deck.name,
    deckCards: deck.cards,
    quantity: 1,
    costPerUnit: spec.costPerUnit,
    status: 'cached'
  };
  state.roster.push(entry);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
}

async function loadDemoSld(spec) {
  const drops = await fetchSecretLairDrops();
  const drop = drops.find(d => d.name.toLowerCase() === spec.name.toLowerCase())
    || drops.find(d => d.name.toLowerCase().includes(spec.name.toLowerCase()));
  if (!drop) {
    console.warn(`[Demo] SLD "${spec.name}" not found, skipping`);
    showToast(`Demo: SLD "${spec.name}" not found — skipping`, 'error');
    return;
  }
  const finish = drop.hasFoil && spec.finish === 'foil' ? 'foil'
    : drop.hasNonfoil ? 'nonfoil'
    : drop.hasEtched ? 'etched' : 'foil';
  const entry = {
    id: state.nextRosterId++,
    productType: 'secret_lair',
    dropKey: drop.key,
    dropName: drop.name,
    dropCards: drop.cards,
    finish,
    quantity: 1,
    costPerUnit: spec.costPerUnit,
    status: 'cached'
  };
  state.roster.push(entry);
  renderRoster();
  updateRosterSummary();
  updateButtonStates();
}

// ─── Card Image Hover Popover ───
// Any element with `data-image-url` shows a floating card preview on hover.
// Used by sim-result cards and builder chips. The popover is `position:fixed`
// so it escapes any parent overflow:hidden/auto containers.
const cardPopup = $('card-preview-popup');
const cardPopupImg = $('card-preview-img');
let cardPopupCurrentUrl = null;

function showCardPopup(url, e) {
  if (!cardPopup || !cardPopupImg) return;
  if (cardPopupCurrentUrl !== url) {
    cardPopupImg.src = url;
    cardPopupCurrentUrl = url;
  }
  cardPopup.style.display = 'block';
  positionCardPopup(e);
}
function hideCardPopup() {
  if (!cardPopup) return;
  cardPopup.style.display = 'none';
  cardPopupCurrentUrl = null;
}
function positionCardPopup(e) {
  if (!cardPopup) return;
  const w = 240, h = 336; // matches inline style + ~aspect ratio
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + w + 8 > window.innerWidth) x = e.clientX - w - pad;
  if (y + h + 8 > window.innerHeight) y = window.innerHeight - h - 8;
  if (y < 8) y = 8;
  cardPopup.style.left = x + 'px';
  cardPopup.style.top  = y + 'px';
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-image-url]');
  if (t) showCardPopup(t.getAttribute('data-image-url'), e);
});
document.addEventListener('mousemove', (e) => {
  if (cardPopup && cardPopup.style.display === 'block') positionCardPopup(e);
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest('[data-image-url]');
  if (t && !e.relatedTarget) { hideCardPopup(); return; }
  if (t && e.relatedTarget && !e.relatedTarget.closest('[data-image-url]')) hideCardPopup();
});

function imageUrlForCard(card) {
  if (!card) return '';
  if (card.image_uris && card.image_uris.normal) return card.image_uris.normal;
  if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris && card.card_faces[0].image_uris.normal)
    return card.card_faces[0].image_uris.normal;
  return '';
}

// ─── Modal Wiring ───
function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}
function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}
function wireModal(modalId, closeBtnId) {
  const overlay = $(modalId);
  const closeBtn = $(closeBtnId);
  if (closeBtn) closeBtn.addEventListener('click', () => closeModal(modalId));
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      // Click on the overlay (not the modal box) closes
      if (e.target === overlay) closeModal(modalId);
    });
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const m of document.querySelectorAll('.modal-overlay:not(.hidden)')) {
      m.classList.add('hidden');
    }
  }
});

(function wireAllModals() {
  // Open triggers
  const triggers = [
    ['what-is-tribal-btn', 'tribal-modal'],
    ['roster-help-tip',    'roster-modal'],
    ['methodology-btn',    'methodology-modal'],
    ['builder-help-btn',   'builder-modal']
  ];
  for (const [btnId, modalId] of triggers) {
    const btn = $(btnId);
    if (btn) btn.addEventListener('click', () => openModal(modalId));
  }
  // Close triggers
  wireModal('tribal-modal',      'close-tribal-modal-btn');
  wireModal('roster-modal',      'close-roster-modal-btn');
  wireModal('methodology-modal', 'close-modal-btn');
  wireModal('builder-modal',     'close-builder-modal-btn');
  wireModal('star-labels-modal', 'close-star-labels-btn');
})();

// ─── Walkthrough Tour ───
//
// Lightweight guided-tour engine. Each step targets a DOM element via CSS
// selector, highlights it with a glow ring, and shows a popover with copy,
// Next/Back, and an optional primary action that runs an app function. The
// tour is purely opt-in — the user can skip or close at any time.

const TOUR_STEPS = [
  {
    target: '#intro-section',
    title: '🎓 Welcome to the Kindred Break Calculator',
    body: 'A quick streamer-focused walkthrough — about a minute, skip anytime. We\'ll start by loading the demo so the rest of the tour has real products and spots to point at.',
    placement: 'bottom',
    primaryAction: { label: 'Load Demo & Continue ⏵', fn: 'loadDemoAndAdvance' }
  },
  {
    target: '#tab-builder-btn',
    title: 'Break Builder is your home',
    body: 'You land here by default. Break Builder is the streamer side: cost basis, break-even per spot, star tiers, and copy-paste-ready spot labels.',
    placement: 'bottom',
    onEnter: () => setViewMode('builder')
  },
  {
    target: '#tab-buyer-btn',
    title: 'Break Tracker for the live show',
    body: 'During the live break you\'ll switch here. The Tracker shows the EV per spot the way a buyer sees it, and lets you click spots to mark them pulled. We\'ll preview that tab toward the end of the tour.',
    placement: 'bottom'
  },
  {
    target: '#roster-section',
    title: 'Build your roster',
    body: 'Add boosters, Secret Lair drops, and Commander precons here. The demo already filled this in — six boosters, one precon, two SLDs. Adding products normally is type a set name, pick the pack type, click +.',
    placement: 'bottom'
  },
  {
    target: '.product-toggle',
    title: 'Three product types',
    body: 'Booster Pack, Secret Lair Drop, and Commander Precon each have their own roster controls — switch between them with these buttons.',
    placement: 'bottom'
  },
  {
    target: '#roster-table',
    title: 'Cost basis per unit',
    body: 'In Break Builder, every row has a Cost/Unit input. Type what YOU paid per pack/drop/deck and the Subtotal recalculates instantly. The demo pre-filled realistic streamer prices.',
    placement: 'top'
  },
  {
    target: '#lock-roster-btn',
    title: 'Lock Roster & Seed Spots',
    body: 'Done building your roster? Click <strong>Lock Roster &amp; Seed Spots</strong>. This computes the EV math, populates Define Your Spots with the standard Kindred categories (Land, Legendary Land, Enchantment subtypes, Artifact subtypes, Instant, Sorcery, Battle, PW) plus every creature tribe present, all sorted by EV. While locked, the roster controls grey out so you don\'t accidentally invalidate your spot work. Click again to unlock if you need to add more products.',
    placement: 'top',
    primaryAction: { label: 'Lock Roster Now ⏵', fn: 'lockRosterAndAdvance' }
  },
  {
    target: '#spots-section',
    title: 'Define your spots — the heart of a Kindred Break',
    body: 'Each spot is a tribe or type you\'re selling. Priority order matters: the top spot wins when a card matches multiple. After locking the roster, you\'ll have ~80 spots seeded by EV. The streamer\'s job from here is <strong>split</strong> the big buckets (click <em>Split…</em> → Color / Supertype / Subtype on a row) and <strong>merge</strong> the small ones (check 2+ rows, click Merge Selected — and if you select just one merged spot, the button becomes Unmerge). Drag rows to reorder, ✎ to edit a label inline, ✕ to remove. Sort by EV / A–Z / by Type whenever you want a refresh.',
    placement: 'top'
  },
  {
    target: '#builder-cost-section',
    title: 'Break-Even Per Spot',
    body: 'Your floor: <code>(Roster + Expected Insurance) ÷ spot count</code>. If your average spot price clears this number, you break even before givvies, employees, and profit. Price above it for margin.',
    placement: 'top'
  },
  {
    target: '#builder-insurance',
    title: 'Pack Insurance',
    body: 'What you pay buyers for empty spots. Expected Insurance auto-calculates how much you should reserve based on the Poisson probability each defined spot will end up with no R/M.',
    placement: 'top'
  },
  {
    target: '#builder-tiers-section',
    title: 'Tier Label Settings',
    body: 'Top 10 by EV get ⭐⭐⭐, next 20 get ⭐⭐, next 30 get ⭐, rest are plain. Click <strong>Change Star Labels</strong> to swap stars for emoji (🔥🔥🔥) or words like "Nasty" / "Diabolical" / "Filthy" — whatever fits your brand.',
    placement: 'top'
  },
  {
    target: '#builder-table',
    title: 'Pre-built spot labels',
    body: 'One row per spot in priority order. Each row has the formatted label (e.g. <code>⭐⭐⭐Dragon Demonic Tutor Guaranteed Hit ⭐⭐⭐</code>), the Guaranteed Hits from SLDs/precons that land in that spot, and Top Potential Hits ≥ the notable threshold.',
    placement: 'top'
  },
  {
    target: '#copy-all-labels-btn',
    title: 'Bulk copy for your overlay',
    body: 'Copy all spot labels at once for paste into OBS, Twitch chat, or your overlay. Each row also has its own 📋 (label) and 📝 (item description, names only — no prices, TOS-safe) buttons.',
    placement: 'left'
  },
  {
    target: '#download-sort-assistant-btn',
    title: '🗂️ Sort Assistant — sort the cards after the stream',
    body: 'When the break is done you\'ve got a giant stack of cards to split among buyers. Click <strong>Sort Assistant</strong> to download a printable landscape PDF: a <strong>coarse-sort master page</strong> to first split the pile into main-type stacks, then <strong>detail pages</strong> with a labelled spot for each pile (3 across × 2 down, the bottom row hangs off the page so stacks have room). Spots are grouped by main type and sorted A–Z, with color-split tribes kept together under their base name (all Human stacks land at "H", then W·U·B·R·G·Multi·Colorless). Each label shows its ⭐ tier and ~expected hit count so they match your overlay, and small non-creature types share sheets to save paper. A final <strong>catch-all page</strong> covers unmatched R/M, bulk commons/uncommons, and misfits.',
    placement: 'left'
  },
  {
    target: '#tab-buyer-btn',
    title: 'Switch to Break Tracker',
    body: 'When you go live, jump over here. Click Next and I\'ll switch tabs for you.',
    placement: 'bottom',
    primaryAction: { label: 'Open Break Tracker ⏵', fn: 'switchToTracker' }
  },
  {
    target: '#analyze-btn',
    title: 'Analyze Spot Distribution',
    body: 'Click this to compute expected EV per spot using the priority-order matcher. Spots with high tier markers (★★★) are statistically your hot spots; spots without contributors are filler.',
    placement: 'bottom',
    primaryAction: { label: 'Run Analysis ⏵', fn: 'runAnalyze' }
  },
  {
    target: '#tracker-table',
    title: 'Live break tracking',
    body: 'During the show, click any row once that spot gets pulled. The row dims with a strikethrough and the summary below recomputes — <strong>Remaining Pool EV</strong>, <strong>Hottest Remaining Spot</strong>, etc. — so you always know what\'s still on the table to hype.',
    placement: 'top'
  },
  {
    target: '#ev-section',
    title: 'EV & Simulation',
    body: 'Calculate Global EV gives you total expected value across the roster. Simulate Break opens every pack/drop/deck randomly and shows what a real outcome might look like — useful for previewing variance before you go live.',
    placement: 'top'
  },
  {
    target: '#intro-section',
    title: '🎬 You\'re ready',
    body: 'That\'s the streamer flow. Load Demo Break anytime to reset to the preset. Start Walkthrough to take this tour again. Reach for the ❓ next to each section header for deeper docs. Good luck with the stream!',
    placement: 'bottom',
    onEnter: () => setViewMode('builder')
  }
];

const tourState = {
  active: false,
  stepIndex: 0,
  popoverEl: null,
  currentTarget: null
};

function getTourActionFn(name) {
  const actions = {
    loadDemoAndAdvance: async () => {
      // Run the demo, then advance once it finishes
      tourEndCleanup(); // hide popover during load so it doesn't cover the loading overlay
      await loadDemoBreak();
      tourState.stepIndex++;
      renderTourStep();
    },
    switchToTracker: () => { setViewMode('buyer'); tourState.stepIndex++; renderTourStep(); },
    runAnalyze: () => {
      if (dom.analyzeBtn && !dom.analyzeBtn.disabled) dom.analyzeBtn.click();
      // Give it a beat to render, then advance
      setTimeout(() => { tourState.stepIndex++; renderTourStep(); }, 200);
    },
    lockRosterAndAdvance: () => {
      // Trigger Lock Roster (no-op if roster isn't ready or already locked)
      if (dom.lockRosterBtn && !dom.lockRosterBtn.disabled && !state.rosterLocked) {
        toggleRosterLock();
      }
      // Brief delay so the spot list renders before the next step highlights it
      setTimeout(() => { tourState.stepIndex++; renderTourStep(); }, 250);
    }
  };
  return actions[name];
}

function startTour() {
  tourState.active = true;
  tourState.stepIndex = 0;
  if (!tourState.popoverEl) {
    tourState.popoverEl = document.createElement('div');
    tourState.popoverEl.className = 'tour-popover';
    document.body.appendChild(tourState.popoverEl);
  }
  renderTourStep();
  window.addEventListener('resize', repositionTourPopover);
  window.addEventListener('scroll', repositionTourPopover, true);
  document.addEventListener('keydown', tourKeyHandler);
}

function endTour() {
  tourState.active = false;
  clearTourHighlight();
  if (tourState.popoverEl) tourState.popoverEl.style.display = 'none';
  window.removeEventListener('resize', repositionTourPopover);
  window.removeEventListener('scroll', repositionTourPopover, true);
  document.removeEventListener('keydown', tourKeyHandler);
}

function tourEndCleanup() {
  // Hide the popover and clear highlight but don't fully end the tour
  clearTourHighlight();
  if (tourState.popoverEl) tourState.popoverEl.style.display = 'none';
}

function tourKeyHandler(e) {
  if (e.key === 'Escape') { endTour(); return; }
  if (e.key === 'ArrowRight') { advanceTour(); }
  if (e.key === 'ArrowLeft') { previousTour(); }
}

function clearTourHighlight() {
  if (tourState.currentTarget) {
    tourState.currentTarget.classList.remove('tour-highlight');
    tourState.currentTarget = null;
  }
}

function advanceTour() {
  if (tourState.stepIndex < TOUR_STEPS.length - 1) {
    tourState.stepIndex++;
    renderTourStep();
  } else {
    endTour();
  }
}

function previousTour() {
  if (tourState.stepIndex > 0) {
    tourState.stepIndex--;
    renderTourStep();
  }
}

async function renderTourStep() {
  if (!tourState.active) return;
  const step = TOUR_STEPS[tourState.stepIndex];
  if (!step) { endTour(); return; }

  // Run onEnter side-effects (e.g. switch view mode)
  if (typeof step.onEnter === 'function') {
    try { await step.onEnter(); } catch (e) { console.warn('[Tour] onEnter failed', e); }
  }

  clearTourHighlight();
  const target = document.querySelector(step.target);
  if (!target) {
    // Target missing — skip this step
    console.warn(`[Tour] target missing: ${step.target}, advancing`);
    advanceTour();
    return;
  }

  // Scroll target into view if needed
  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}

  // Highlight after scroll settles
  setTimeout(() => {
    if (!tourState.active) return;
    target.classList.add('tour-highlight');
    tourState.currentTarget = target;

    // Build popover content
    const popover = tourState.popoverEl;
    const total = TOUR_STEPS.length;
    const idx = tourState.stepIndex + 1;
    const primaryBtn = step.primaryAction
      ? `<button class="btn btn-primary tour-primary">${escHtml(step.primaryAction.label)}</button>`
      : `<button class="btn btn-primary tour-next">${tourState.stepIndex === TOUR_STEPS.length - 1 ? 'Finish ✓' : 'Next ⏵'}</button>`;
    popover.innerHTML = `
      <h4>${step.title} <span class="tour-step-counter">(${idx} / ${total})</span></h4>
      <p>${step.body}</p>
      <div class="tour-controls">
        <button class="btn btn-sm tour-skip">Skip tour</button>
        <span class="tour-spacer"></span>
        ${tourState.stepIndex > 0 ? '<button class="btn btn-sm tour-prev">⏴ Back</button>' : ''}
        ${primaryBtn}
      </div>
    `;
    popover.style.display = 'block';

    // Wire buttons
    const skip = popover.querySelector('.tour-skip');
    if (skip) skip.addEventListener('click', endTour);
    const prev = popover.querySelector('.tour-prev');
    if (prev) prev.addEventListener('click', previousTour);
    const next = popover.querySelector('.tour-next');
    if (next) next.addEventListener('click', advanceTour);
    const primary = popover.querySelector('.tour-primary');
    if (primary && step.primaryAction) {
      const fn = getTourActionFn(step.primaryAction.fn);
      primary.addEventListener('click', () => { if (fn) fn(); else advanceTour(); });
    }

    repositionTourPopover();
  }, 320);
}

function repositionTourPopover() {
  if (!tourState.active || !tourState.currentTarget || !tourState.popoverEl) return;
  const popover = tourState.popoverEl;
  if (popover.style.display !== 'block') return;
  const targetRect = tourState.currentTarget.getBoundingClientRect();
  const step = TOUR_STEPS[tourState.stepIndex];
  const placement = step.placement || 'bottom';
  const gap = 16;
  const popRect = popover.getBoundingClientRect();
  const popW = popRect.width;
  const popH = popRect.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Compute candidate positions; pick the first that fits
  const candidates = [];
  // Below
  candidates.push({ name: 'bottom', top: targetRect.bottom + gap, left: targetRect.left + targetRect.width/2 - popW/2 });
  // Above
  candidates.push({ name: 'top', top: targetRect.top - popH - gap, left: targetRect.left + targetRect.width/2 - popW/2 });
  // Right
  candidates.push({ name: 'right', top: targetRect.top + targetRect.height/2 - popH/2, left: targetRect.right + gap });
  // Left
  candidates.push({ name: 'left', top: targetRect.top + targetRect.height/2 - popH/2, left: targetRect.left - popW - gap });

  // Prefer the requested placement, but fall back if it doesn't fit
  const preferred = candidates.find(c => c.name === placement);
  const ordered = preferred ? [preferred, ...candidates.filter(c => c !== preferred)] : candidates;

  let chosen = ordered[0];
  for (const c of ordered) {
    if (c.top >= 8 && c.top + popH <= vh - 8 && c.left >= 8 && c.left + popW <= vw - 8) {
      chosen = c; break;
    }
  }

  // Clamp to viewport
  let left = Math.max(8, Math.min(vw - popW - 8, chosen.left));
  let top  = Math.max(8, Math.min(vh - popH - 8, chosen.top));
  popover.style.left = left + 'px';
  popover.style.top  = top + 'px';
}

const walkthroughBtn = $('walkthrough-btn');
if (walkthroughBtn) walkthroughBtn.addEventListener('click', startTour);

// ─── Init ───
async function init() {
  console.log('[Init] Starting MTG Double-Digi Break Calculator...');
  setProductType('booster');
  setViewMode('builder');
  try {
    showLoading('Loading MTG set catalog from Scryfall...');
    await fetchAllSets();
    state.setsLoaded = true;
    hideLoading();
    showToast('Set catalog loaded — start typing to search sets', 'success');
  } catch (e) {
    hideLoading();
    state.setsLoaded = false;
    showToast('Failed to load set catalog. Click the set input to retry.', 'error');
    console.error('[Init]', e);
  }
}
init();
