const CONTROL_OR_BIDI = /[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const UUID_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const EPSILON = 1e-12;

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codePoints(value) {
  return [...value];
}

export function displaySessionName(value, maximum = 80) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(UUID_TEXT, "[id]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const points = codePoints(text).slice(0, maximum);
  return points.join("") || "未命名 Session";
}

export function normalizeSessionName(value) {
  const source = String(value || "");
  const points = codePoints(source);
  if (!source.trim() || points.length > 160 || CONTROL_OR_BIDI.test(source)) return null;
  const folded = source.normalize("NFKC").toLowerCase();
  const tokens = folded.split(TOKEN_SPLIT).filter(Boolean);
  const compact = tokens.join("");
  if (codePoints(compact).length < 2) return null;
  return Object.freeze({
    compact,
    tokens: Object.freeze(tokens),
    tokenKey: [...tokens].sort(ordinal).join("\u0000"),
    display: displaySessionName(source),
  });
}

export function normalizeExactSessionName(value) {
  const source = String(value || "");
  const trimmed = source.trim();
  if (!trimmed || codePoints(trimmed).length > 160 || CONTROL_OR_BIDI.test(trimmed)) return null;
  return Object.freeze({ key: trimmed.normalize("NFC").toLowerCase() });
}

function bigrams(value) {
  const points = codePoints(value);
  const counts = new Map();
  for (let index = 0; index < points.length - 1; index += 1) {
    const pair = `${points[index]}${points[index + 1]}`;
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  return { counts, total: Math.max(0, points.length - 1) };
}

function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.total + b.total === 0) return left === right ? 1 : 0;
  let intersection = 0;
  for (const [pair, count] of a.counts) intersection += Math.min(count, b.counts.get(pair) || 0);
  return (2 * intersection) / (a.total + b.total);
}

function levenshteinDistance(left, right, maximum) {
  const a = codePoints(left);
  const b = codePoints(right);
  let prior = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= b.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        prior[column] + 1,
        prior[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    prior = current;
  }
  return prior[b.length];
}

export function scoreNormalizedNames(query, candidate) {
  if (!query || !candidate) return Object.freeze({ score: 0, kind: "invalid" });
  if (query.compact === candidate.compact) return Object.freeze({ score: 1, kind: "exact" });
  if (query.tokens.length >= 2 && candidate.tokens.length >= 2 && query.tokenKey === candidate.tokenKey) {
    return Object.freeze({ score: 0.98, kind: "reordered" });
  }
  const queryLength = codePoints(query.compact).length;
  const candidateLength = codePoints(candidate.compact).length;
  if (query.compact.includes(candidate.compact) || candidate.compact.includes(query.compact)) {
    const ratio = Math.min(queryLength, candidateLength) / Math.max(queryLength, candidateLength);
    return Object.freeze({ score: 0.75 + (0.20 * ratio), kind: "contains" });
  }
  const dice = diceSimilarity(query.compact, candidate.compact);
  const maximumLength = Math.max(queryLength, candidateLength);
  let edit = 0;
  if (maximumLength <= 40 && Math.abs(queryLength - candidateLength) <= 4) {
    const maximumDistance = Math.max(1, Math.floor(maximumLength * 0.20));
    const distance = levenshteinDistance(query.compact, candidate.compact, maximumDistance);
    if (distance <= maximumDistance) edit = 1 - (distance / maximumLength);
  }
  return Object.freeze({ score: Math.max(dice, edit), kind: edit >= dice && edit > 0 ? "edit" : "dice" });
}

const KIND_PRIORITY = Object.freeze({ native_id: -2, identity_exact: -1, exact: 0, reordered: 1, contains: 2, edit: 3, dice: 4, invalid: 5 });

function identity(record) {
  return String(record.identity || record.gatewayId || record.nativeId || record.sessionId || "");
}

function scoredOrder(left, right) {
  return right.score - left.score
    || KIND_PRIORITY[left.matchKind] - KIND_PRIORITY[right.matchKind]
    || Number(right.candidate.updatedAt || 0) - Number(left.candidate.updatedAt || 0)
    || ordinal(String(left.candidate.executor || ""), String(right.candidate.executor || ""))
    || ordinal(String(left.candidate.projectAlias || "").toLowerCase(), String(right.candidate.projectAlias || "").toLowerCase())
    || ordinal(String(left.candidate.name || "").toLowerCase(), String(right.candidate.name || "").toLowerCase())
    || ordinal(identity(left.candidate), identity(right.candidate));
}

export function matchSessionName(queryValue, candidates, {
  plausibleScore = 0.70,
} = {}) {
  const queryExact = normalizeExactSessionName(queryValue);
  const query = normalizeSessionName(queryValue);
  if (!query || !queryExact) return Object.freeze({ kind: "invalid", query: null, matches: Object.freeze([]) });
  const queryUuid = String(queryValue || "").trim().match(new RegExp(`^${UUID_TEXT.source.replaceAll("\\b", "")}$`, "iu"))?.[0]?.toLowerCase() || null;
  const exactMatches = [];
  const matches = [];
  for (const candidate of candidates || []) {
    const aliases = [...new Set([candidate.name, ...(candidate.aliases || [])].filter(Boolean).map(String))];
    const nativeExact = queryUuid && String(candidate.nativeId || "").toLowerCase() === queryUuid;
    const aliasExact = aliases.some((alias) => normalizeExactSessionName(alias)?.key === queryExact.key);
    if (nativeExact || aliasExact) {
      exactMatches.push(Object.freeze({
        candidate,
        score: 1,
        matchKind: nativeExact ? "native_id" : "identity_exact",
        aliasCompact: query.compact,
      }));
      continue;
    }
    let best = null;
    for (const alias of aliases) {
      const normalized = normalizeSessionName(alias);
      if (!normalized) continue;
      const scored = scoreNormalizedNames(query, normalized);
      if (!best || scored.score > best.score + EPSILON
        || (Math.abs(scored.score - best.score) <= EPSILON
          && (KIND_PRIORITY[scored.kind] < KIND_PRIORITY[best.matchKind]
            || (KIND_PRIORITY[scored.kind] === KIND_PRIORITY[best.matchKind]
              && ordinal(normalized.compact, best.aliasCompact) < 0)))) {
        best = { score: scored.score, matchKind: scored.kind, aliasCompact: normalized.compact };
      }
    }
    if (best && best.score + EPSILON >= plausibleScore) matches.push(Object.freeze({ candidate, ...best }));
  }
  exactMatches.sort(scoredOrder);
  if (exactMatches.length === 1) {
    const frozen = Object.freeze(exactMatches);
    return Object.freeze({ kind: "selected", query, selected: exactMatches[0].candidate, match: exactMatches[0], matches: frozen });
  }
  if (exactMatches.length > 1) {
    return Object.freeze({ kind: "selection", query, exact: true, matches: Object.freeze(exactMatches) });
  }
  matches.sort(scoredOrder);
  const frozen = Object.freeze(matches);
  if (matches.length === 0) return Object.freeze({ kind: "none", query, matches: frozen });
  return Object.freeze({ kind: "selection", query, matches: frozen });
}
