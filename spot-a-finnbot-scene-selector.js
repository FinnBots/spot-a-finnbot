/**
 * spot-a-finnbot-scene-selector.js
 *
 * Core round-generation logic for Spot-a-FinnBot (Chat 11, Step 6).
 *
 * Responsibilities:
 *   1. Given a target Bot's traits, score every other Bot in the pool by
 *      how many trait VALUES it shares with the target (not just trait
 *      categories present).
 *   2. Select 24 decoys for a 5x5 grid (25 tiles total, including the
 *      target), weighted toward near-miss overlap so the target doesn't
 *      visually pop out.
 *   3. Derive which difficulty tier a round uses from the entry
 *      transaction's own signature — provably fair, same pattern as
 *      Pick-a-Bot's SHA-256(signature) mod 10 draw. No server-side
 *      randomness, no way to game it in advance, independently
 *      recomputable by anyone.
 *
 * Data dependency: bot_traits.json (1,612 entries — Bot #1640 and #2984
 * are excluded from the pool; they have no metadata in the Arweave
 * migration and were confirmed genuinely missing, not a naming quirk,
 * per the Chat 11 session diagnostics).
 *
 * Tier weighting locked 7 July 2026: 40% easy / 40% medium / 20% hard.
 *
 * Decoy pool locked 7 July 2026: SAME-EDITION ONLY. Cross-edition trait
 * overlap (e.g. a CryptoBot and a DrinkBot both happening to share
 * "Background": "Green") is not a genuine near-miss - those two editions
 * only share the Background category at all, so any apparent "2/3 match"
 * across editions is mostly coincidence, not real visual confusability.
 * Decoys are filtered to the target's own edition before scoring.
 */

// Edition Bot-number ranges, per Technical Specs - used to restrict the
// decoy pool to the target's own edition before trait-overlap scoring.
const EDITION_RANGES = {
  CryptoBots: [1, 1000],
  DrinkBots: [1001, 2000],
  FinnBots: [2001, 3000],
};

/**
 * Returns which edition a Bot number belongs to, based on the locked
 * numbering ranges (CryptoBots #1-1000, DrinkBots #1001-2000,
 * FinnBots #2001-3000).
 *
 * @param {string|number} botNumber
 * @returns {'CryptoBots'|'DrinkBots'|'FinnBots'}
 */
function getEdition(botNumber) {
  const n = Number(botNumber);
  for (const [edition, [min, max]] of Object.entries(EDITION_RANGES)) {
    if (n >= min && n <= max) return edition;
  }
  throw new Error(`Bot number ${botNumber} does not fall in any known edition range`);
}

// ---- Tier definitions -------------------------------------------------
// "highOverlapCount" = how many of the 24 decoys should share 2 of the
// 3 rolled traits with the target. The rest are filled with lower-overlap
// Bots (1 trait shared, or none) to round out the grid.
const TIER_CONFIG = {
  easy:   { highOverlapCount: 8,  label: 'Easy' },
  medium: { highOverlapCount: 15, label: 'Medium' },
  hard:   { highOverlapCount: 20, label: 'Hard' },
};

// Cumulative percentage bands out of 100, matching the locked 40/40/20 split.
// mod100 value 0-39 -> easy, 40-79 -> medium, 80-99 -> hard.
const TIER_BANDS = [
  { max: 40, tier: 'easy' },
  { max: 80, tier: 'medium' },
  { max: 100, tier: 'hard' },
];

/**
 * Derives the difficulty tier for a round from the entry transaction's
 * signature. Requires a SHA-256 hex digest of the signature string,
 * computed the same way Pick-a-Bot already computes its draw hash.
 *
 * @param {string} sigHashHex - SHA-256 hex digest of the entry tx signature
 * @returns {'easy'|'medium'|'hard'}
 */
function deriveTierFromSignature(sigHashHex) {
  // Take the hash as a BigInt and reduce mod 100. Using BigInt avoids
  // precision loss on the full 256-bit hash that a plain Number would hit.
  const hashInt = BigInt('0x' + sigHashHex);
  const mod100 = Number(hashInt % 100n);

  for (const band of TIER_BANDS) {
    if (mod100 < band.max) return band.tier;
  }
  return 'hard'; // defensive fallback, should never be reached
}

/**
 * Counts how many trait VALUES two Bots share, restricted to trait
 * categories that exist on both (guards against cross-edition
 * comparisons, e.g. a CryptoBot vs a FinnBot, which share only
 * "Background" as a common category).
 *
 * @param {Object} traitsA - e.g. { Background: "Green", CBotBody: "Red", ... }
 * @param {Object} traitsB
 * @returns {number} count of matching trait_type -> value pairs
 */
function countSharedTraits(traitsA, traitsB) {
  let shared = 0;
  for (const key of Object.keys(traitsA)) {
    if (key in traitsB && traitsA[key] === traitsB[key]) {
      shared++;
    }
  }
  return shared;
}

/**
 * Builds a full round: picks 24 decoys around a target Bot, respecting
 * the tier's high-overlap quota, then shuffles the final 25-tile grid
 * so the target's position isn't predictable from decoy ordering.
 *
 * @param {Object} allBotTraits - full bot_traits.json contents, keyed by Bot number string
 * @param {string} targetBotNumber - the target Bot's number, e.g. "1305"
 * @param {'easy'|'medium'|'hard'} tier
 * @returns {{ gridBotNumbers: string[], targetIndex: number, tier: string }}
 */
/**
 * Builds a full round DETERMINISTICALLY from the entry signature hash.
 * Same sigHashHex in → same target, same grid, same target position out,
 * every time, in both JS and Python. No Math.random anywhere in this path.
 *
 * @param {Object} allBotTraits - full bot_traits.json, keyed by Bot number string
 * @param {string} sigHashHex - SHA-256 hex digest of the entry tx signature
 * @param {Set<string>} excludedBotNumbers - Bots with no metadata (e.g. 1640, 2984)
 * @returns {{ gridBotNumbers: string[], targetIndex: number, tier: string, targetBotNumber: string }}
 */
function buildRoundDeterministic(allBotTraits, sigHashHex, excludedBotNumbers) {
  const rng = mulberry32(seedFromSigHash(sigHashHex));
  const tier = deriveTierFromSignature(sigHashHex);
  const config = TIER_CONFIG[tier];

  // 1. Pick the target — over the SORTED eligible list, first draw off the stream.
  const excluded = excludedBotNumbers || new Set();
  const eligible = Object.keys(allBotTraits).filter(function (n) { return !excluded.has(n); });
  const targetBotNumber = pickTargetBotNumber(eligible, rng);

  const targetTraits = allBotTraits[targetBotNumber];
  const targetEdition = getEdition(targetBotNumber);

  // 2. Score same-edition Bots. Build the list, then SORT it by Bot number
  //    so its order is identical in JS and Python before any shuffle.
  const scored = [];
  for (const botNumber of Object.keys(allBotTraits)) {
    if (botNumber === targetBotNumber) continue;
    if (excluded.has(botNumber)) continue;
    if (getEdition(botNumber) !== targetEdition) continue;
    scored.push({ botNumber: botNumber, shared: countSharedTraits(targetTraits, allBotTraits[botNumber]) });
  }
  scored.sort(function (a, b) { return Number(a.botNumber) - Number(b.botNumber); });

  let highOverlap = scored.filter(function (b) { return b.shared >= 2; });
  let lowOverlap = scored.filter(function (b) { return b.shared < 2; });

  seededShuffle(highOverlap, rng);
  seededShuffle(lowOverlap, rng);

  const decoys = [];
  const highNeeded = config.highOverlapCount;
  const lowNeeded = 24 - highNeeded;
  decoys.push.apply(decoys, highOverlap.slice(0, highNeeded).map(function (b) { return b.botNumber; }));
  decoys.push.apply(decoys, lowOverlap.slice(0, lowNeeded).map(function (b) { return b.botNumber; }));

  // Fallback top-up if a rare trait combo lacked enough high-overlap Bots.
  if (decoys.length < 24) {
    const usedSet = new Set(decoys);
    let remaining = scored.filter(function (b) { return !usedSet.has(b.botNumber); });
    seededShuffle(remaining, rng);
    decoys.push.apply(decoys, remaining.slice(0, 24 - decoys.length).map(function (b) { return b.botNumber; }));
  }

  const gridBotNumbers = decoys.concat([targetBotNumber]);
  seededShuffle(gridBotNumbers, rng);

  const targetIndex = gridBotNumbers.indexOf(targetBotNumber);
  return { gridBotNumbers: gridBotNumbers, targetIndex: targetIndex, tier: tier, targetBotNumber: targetBotNumber };
}

/**
 * LEGACY non-deterministic buildRound (Math.random). Kept temporarily for
 * reference during migration; the game now calls buildRoundDeterministic.
 * Do NOT use for anything the scanner must verify.
 */
function buildRound(allBotTraits, targetBotNumber, tier) {
  const targetTraits = allBotTraits[targetBotNumber];
  if (!targetTraits) {
    throw new Error(`Target Bot #${targetBotNumber} not found in bot_traits.json`);
  }

  const config = TIER_CONFIG[tier];
  if (!config) {
    throw new Error(`Unknown tier: ${tier}`);
  }

  const targetEdition = getEdition(targetBotNumber);

  const scored = [];
  for (const [botNumber, traits] of Object.entries(allBotTraits)) {
    if (botNumber === targetBotNumber) continue;
    if (getEdition(botNumber) !== targetEdition) continue;
    const shared = countSharedTraits(targetTraits, traits);
    scored.push({ botNumber, shared });
  }

  const highOverlap = scored.filter(b => b.shared >= 2);
  const lowOverlap = scored.filter(b => b.shared < 2);

  shuffleArray(highOverlap);
  shuffleArray(lowOverlap);

  const decoys = [];
  const highNeeded = config.highOverlapCount;
  const lowNeeded = 24 - highNeeded;

  decoys.push(...highOverlap.slice(0, highNeeded).map(b => b.botNumber));
  decoys.push(...lowOverlap.slice(0, lowNeeded).map(b => b.botNumber));

  if (decoys.length < 24) {
    const usedSet = new Set(decoys);
    const remaining = scored.filter(b => !usedSet.has(b.botNumber));
    shuffleArray(remaining);
    decoys.push(...remaining.slice(0, 24 - decoys.length).map(b => b.botNumber));
  }

  const gridBotNumbers = [...decoys, targetBotNumber];
  shuffleArray(gridBotNumbers);

  const targetIndex = gridBotNumbers.indexOf(targetBotNumber);

  return { gridBotNumbers, targetIndex, tier };
}

/**
 * DETERMINISM (added 10 July 2026, for scanner win-verification).
 *
 * The whole round — which Bot is the target, which decoys fill the grid,
 * and where the target lands — must be reproducible from the entry
 * transaction signature ALONE, with no Math.random() anywhere. This lets
 * the prize scanner independently recompute the correct tile and verify a
 * win claim on-chain (see stage_prize_scanner.py, FSFB win checks).
 *
 * The PRNG below (mulberry32) is deliberately trivial so it can be ported
 * to Python EXACTLY. Any change here MUST be mirrored in the scanner or
 * win verification silently breaks. All integer math is kept inside 32-bit
 * unsigned range so JS (>>> 0) and Python (& 0xffffffff) agree bit-for-bit.
 */

// Derive a 32-bit unsigned seed from the first 8 hex chars of the SHA-256
// signature digest. Same digest the tier derivation already uses.
function seedFromSigHash(sigHashHex) {
  return parseInt(sigHashHex.slice(0, 8), 16) >>> 0;
}

// mulberry32 — tiny, well-known, exactly portable. Returns a function
// producing floats in [0,1). State is a single 32-bit unsigned int.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded Fisher-Yates. Takes a rng function (from mulberry32) so every
// shuffle in a round advances the SAME stream deterministically.
function seededShuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Deterministically pick the target Bot number from the signature, over a
// SORTED list of eligible Bot numbers (excluded Bots removed by caller).
// Sorting makes the pick independent of object key iteration order, so JS
// and Python agree.
function pickTargetBotNumber(eligibleBotNumbers, rng) {
  const sorted = eligibleBotNumbers.slice().sort(function (a, b) {
    return Number(a) - Number(b);
  });
  const idx = Math.floor(rng() * sorted.length);
  return sorted[idx];
}

/**
 * Fisher-Yates shuffle, in place. LEGACY — retained only for any caller
 * still using Math.random(); NOT used in the deterministic round path.
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Exported for use in the game build (adjust to module system in use —
// this assumes plain <script> inclusion, matching Pick-a-Bot's vanilla
// JS, no-build-step convention).
if (typeof module !== 'undefined') {
  module.exports = {
    deriveTierFromSignature,
    countSharedTraits,
    buildRound,
    buildRoundDeterministic,
    seedFromSigHash,
    mulberry32,
    seededShuffle,
    pickTargetBotNumber,
    getEdition,
    EDITION_RANGES,
    TIER_CONFIG,
  };
}
