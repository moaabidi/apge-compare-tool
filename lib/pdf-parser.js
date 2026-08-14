function indexOfBytes(bytes, needle, from = 0) {
  outer: for (let i = from; i <= bytes.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function asciiBytes(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function latin1(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

function decodeUtf16Be(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

function decodePdfLiteral(source) {
  const out = [];
  for (let i = 0; i < source.length;) {
    const code = source.charCodeAt(i) & 0xff;
    if (code !== 92) {
      out.push(code);
      i += 1;
      continue;
    }

    i += 1;
    if (i >= source.length) break;
    const next = source.charCodeAt(i) & 0xff;

    if (next >= 48 && next <= 55) {
      let octal = '';
      let count = 0;
      while (i < source.length && count < 3) {
        const digit = source.charCodeAt(i) & 0xff;
        if (digit < 48 || digit > 55) break;
        octal += source[i];
        i += 1;
        count += 1;
      }
      out.push(parseInt(octal, 8));
      continue;
    }

    const mapped = {
      110: 10,
      114: 13,
      116: 9,
      98: 8,
      102: 12,
      40: 40,
      41: 41,
      92: 92
    }[next];

    if (mapped !== undefined) {
      out.push(mapped);
      i += 1;
      continue;
    }

    if (next === 10 || next === 13) {
      if (next === 13 && source.charCodeAt(i + 1) === 10) i += 1;
      i += 1;
      continue;
    }

    out.push(next);
    i += 1;
  }

  const bytes = Uint8Array.from(out);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Be(bytes.subarray(2));
  }

  let evenNulls = 0;
  let evenCount = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    evenCount += 1;
    if (bytes[i] === 0) evenNulls += 1;
  }

  if (evenCount && evenNulls / evenCount > 0.35) {
    return decodeUtf16Be(bytes);
  }

  return latin1(bytes);
}

function extractLiteralTextOperators(decodedStream) {
  const text = latin1(decodedStream);
  const results = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '(') continue;

    let depth = 1;
    let escaped = false;
    let j = i + 1;
    for (; j < text.length; j += 1) {
      const char = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) break;
    const after = text.slice(j + 1, j + 20);
    if (/^\s*Tj\b/.test(after)) {
      const decoded = decodePdfLiteral(text.slice(i + 1, j));
      if (decoded.trim()) results.push(decoded);
    }
    i = j;
  }

  return results;
}

async function extractPdfText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const streamNeedle = asciiBytes('stream');
  const endNeedle = asciiBytes('endstream');
  const chunks = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const streamIndex = indexOfBytes(bytes, streamNeedle, cursor);
    if (streamIndex < 0) break;

    let dataStart = streamIndex + streamNeedle.length;
    if (bytes[dataStart] === 13 && bytes[dataStart + 1] === 10) dataStart += 2;
    else if (bytes[dataStart] === 10 || bytes[dataStart] === 13) dataStart += 1;
    else {
      cursor = dataStart;
      continue;
    }

    const endIndex = indexOfBytes(bytes, endNeedle, dataStart);
    if (endIndex < 0) break;

    let dataEnd = endIndex;
    while (dataEnd > dataStart && (bytes[dataEnd - 1] === 10 || bytes[dataEnd - 1] === 13)) dataEnd -= 1;
    const raw = bytes.slice(dataStart, dataEnd);

    try {
      const decoded = await inflateZlib(raw);
      chunks.push(...extractLiteralTextOperators(decoded));
    } catch {
      chunks.push(...extractLiteralTextOperators(raw));
    }

    cursor = endIndex + endNeedle.length;
  }

  return chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function numberMatch(text, regex) {
  const match = text.match(regex);
  if (!match) return null;
  const number = Number(String(match[1]).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseEflText(text, sourceUrl = '') {
  const normalized = text.replace(/\u00a0/g, ' ');
  const energyRateCents = numberMatch(
    normalized,
    /Energy Rate\s*\(\s*¢\s*\)\s*per\s*kWh\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*¢/i
  );
  const baseChargeMonthly = numberMatch(
    normalized,
    /Base Charge\s*\(\s*\$\s*\)\s*per\s*month\s*:\s*\$\s*([0-9]+(?:\.[0-9]+)?)/i
  ) ?? 0;

  const deliveryMatch = normalized.match(
    /Energy Delivery Charges\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*¢\s*per\s*kWh\s*and\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*per\s*month/i
  );
  const deliveryPerKwhCents = deliveryMatch ? Number(deliveryMatch[1]) : 0;
  const deliveryMonthly = deliveryMatch ? Number(deliveryMatch[2]) : 0;

  const creditMatch = normalized.match(
    /\$\s*([0-9]+(?:\.[0-9]+)?)\s*credit\s*when\s*usage\s*is\s*(?:>=|≥)\s*([0-9,]+)\s*kWh/i
  );

  let creditAmount = creditMatch ? Number(creditMatch[1]) : 0;
  let creditThresholdKwh = creditMatch ? Number(creditMatch[2].replace(/,/g, '')) : null;

  if (!creditMatch) {
    const titleCredit = normalized.match(/Fixed Price\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*at\s*([0-9,]+)\s*kWh/i);
    if (titleCredit) {
      creditAmount = Number(titleCredit[1]);
      creditThresholdKwh = Number(titleCredit[2].replace(/,/g, ''));
    }
  }

  const termMatch = normalized.match(/\b(\d{1,2})\s*months\b/i);
  const contractTermMonths = termMatch ? Number(termMatch[1]) : null;

  return {
    energyRateCents,
    baseChargeMonthly,
    deliveryPerKwhCents,
    deliveryMonthly,
    creditAmount,
    creditThresholdKwh,
    contractTermMonths,
    sourceUrl,
    rawText: normalized
  };
}

export async function parseEflPdf(arrayBuffer, sourceUrl = '') {
  const text = await extractPdfText(arrayBuffer);
  const parsed = parseEflText(text, sourceUrl);

  const missing = [];
  if (!Number.isFinite(parsed.energyRateCents) || parsed.energyRateCents <= 0) missing.push('Energy Rate');
  if (!Number.isFinite(parsed.contractTermMonths) || parsed.contractTermMonths <= 0) missing.push('Contract Term');

  if (missing.length) {
    const error = new Error(`Missing required EFL field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    error.code = 'EFL_PARSE_INCOMPLETE';
    error.partial = parsed;
    throw error;
  }

  return parsed;
}
