const UNQUOTED = 1;
const SINGLE = 2;
const DOUBLE = 4;

function isUnquoted(byte) {
  return byte === 43 || byte === 45 || byte === 46 || byte === 47 || byte === 58
    || byte === 64 || byte === 93 || byte === 95
    || (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
    || (byte >= 97 && byte <= 122);
}

function strategy(bytes, start) {
  let allowed = bytes[start] === 94 ? SINGLE : UNQUOTED | SINGLE | DOUBLE;
  let end = start + (bytes[start] === 94 ? 1 : 0);
  while (end < bytes.length) {
    const byte = bytes[end];
    let current = allowed;
    if (byte >= 128) current &= ~UNQUOTED;
    else {
      if (!isUnquoted(byte)) current &= ~UNQUOTED;
      if (byte === 39 || byte === 94 || byte === 92) current &= ~SINGLE;
      if (byte === 96 || byte === 36 || byte === 33 || byte === 94) current &= ~DOUBLE;
    }
    if (current === 0) break;
    allowed = current;
    end += 1;
  }
  if (allowed & UNQUOTED) return [end, UNQUOTED];
  if (allowed & SINGLE) return [end, SINGLE];
  return [end, DOUBLE];
}

function quote(word) {
  if (word.includes("\0")) throw new Error("NUL is not allowed");
  const bytes = Buffer.from(word, "utf8");
  if (bytes.length === 0) return "''";
  const parts = [];
  for (let offset = 0; offset < bytes.length;) {
    const [end, mode] = strategy(bytes, offset);
    const chunk = bytes.subarray(offset, end);
    if (mode === UNQUOTED) parts.push(chunk.toString("utf8"));
    else if (mode === SINGLE) parts.push(`'${chunk.toString("utf8")}'`);
    else {
      let encoded = "";
      for (const byte of chunk) {
        if ([36, 96, 34, 92].includes(byte)) encoded += "\\";
        encoded += String.fromCharCode(byte);
      }
      parts.push(`"${encoded}"`);
    }
    offset = end;
  }
  return parts.join("");
}

export function shlexJoin13(words) {
  return words.map(quote).join(" ");
}

export function shlexSplit13(input) {
  const bytes = Buffer.from(input, "utf8");
  const words = [];
  let index = 0;
  const next = () => (index < bytes.length ? bytes[index++] : null);
  while (index < bytes.length) {
    let byte = next();
    while (byte !== null) {
      if (byte === 32 || byte === 9 || byte === 10) byte = next();
      else if (byte === 35) {
        while ((byte = next()) !== null && byte !== 10) {}
        byte = next();
      } else break;
    }
    if (byte === null) break;
    const word = [];
    while (byte !== null && byte !== 32 && byte !== 9 && byte !== 10) {
      if (byte === 39) {
        let closed = false;
        while ((byte = next()) !== null) {
          if (byte === 39) { closed = true; break; }
          word.push(byte);
        }
        if (!closed) return null;
      } else if (byte === 34) {
        let closed = false;
        while ((byte = next()) !== null) {
          if (byte === 34) { closed = true; break; }
          if (byte === 92) {
            const escaped = next();
            if (escaped === null) return null;
            if ([36, 96, 34, 92].includes(escaped)) word.push(escaped);
            else if (escaped !== 10) word.push(92, escaped);
          } else word.push(byte);
        }
        if (!closed) return null;
      } else if (byte === 92) {
        const escaped = next();
        if (escaped === null) return null;
        if (escaped !== 10) word.push(escaped);
      } else word.push(byte);
      byte = next();
    }
    words.push(Buffer.from(word).toString("utf8"));
  }
  return words;
}

export function decodeCanonicalShlex13(input) {
  if (typeof input !== "string" || input.includes("\0") || input.includes("[REDACTED_SECRET]")) return null;
  const words = shlexSplit13(input);
  if (!words) return null;
  try { return shlexJoin13(words) === input ? words : null; } catch { return null; }
}
