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

  // Score every other Bot in the SAME EDITION by shared-trait count against
  // the target. Cross-edition Bots are excluded entirely from the decoy
  // pool - restricted 7 July 2026 (see file header note).
  const scored = [];
  for (const [botNumber, traits] of Object.entries(allBotTraits)) {
    if (botNumber === targetBotNumber) continue;
    if (getEdition(botNumber) !== targetEdition) continue;
    const shared = countSharedTraits(targetTraits, traits);
    scored.push({ botNumber, shared });
  }

  // Bucket by overlap tier: "high" = 2+ shared traits, "low" = fewer.
  const highOverlap = scored.filter(b => b.shared >= 2);
  const lowOverlap = scored.filter(b => b.shared < 2);

  shuffleArray(highOverlap);
  shuffleArray(lowOverlap);

  const decoys = [];
  const highNeeded = config.highOverlapCount;
  const lowNeeded = 24 - highNeeded;

  decoys.push(...highOverlap.slice(0, highNeeded).map(b => b.botNumber));
  decoys.push(...lowOverlap.slice(0, lowNeeded).map(b => b.botNumber));

  // Fallback: if the pool didn't have enough high-overlap Bots for this
  // target's trait combination (possible for rare trait pairings), top
  // up from whatever's left so the grid always has 24 decoys.
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

/** Fisher-Yates shuffle, in place. */
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
    getEdition,
    EDITION_RANGES,
    TIER_CONFIG,
  };
}
