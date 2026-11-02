// src/worker/index.ts
import { EmailMessage } from "cloudflare:email";

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/decode-strings.js
var textEncoder = new TextEncoder();
var isWsp = (c) => c === 32 || c === 9;
var base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var base64Lookup = new Uint8Array(256);
for (let i = 0; i < base64Chars.length; i++) {
  base64Lookup[base64Chars.charCodeAt(i)] = i;
}
function decodeBase64(base64) {
  let len = base64.length;
  while (len > 0 && base64.charAt(len - 1) === "=") {
    len--;
  }
  if (len % 4 === 1) {
    len--;
  }
  const remainder = len % 4;
  const bufferLength = Math.floor(len / 4) * 3 + (remainder ? remainder - 1 : 0);
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const bytes = new Uint8Array(arrayBuffer);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    let encoded1 = base64Lookup[base64.charCodeAt(i)];
    let encoded2 = base64Lookup[base64.charCodeAt(i + 1)];
    let encoded3 = base64Lookup[base64.charCodeAt(i + 2)];
    let encoded4 = base64Lookup[base64.charCodeAt(i + 3)];
    bytes[p++] = encoded1 << 2 | encoded2 >> 4;
    if (p < bufferLength) {
      bytes[p++] = (encoded2 & 15) << 4 | encoded3 >> 2;
    }
    if (p < bufferLength) {
      bytes[p++] = (encoded3 & 3) << 6 | encoded4 & 63;
    }
  }
  return arrayBuffer;
}
var charsetAliases = /* @__PURE__ */ new Map([
  // Hebrew. The logical and explicit ordering variants share the iso-8859-8 index.
  ["iso88598i", "iso-8859-8"],
  ["iso88598e", "iso-8859-8"],
  // Japanese. WHATWG shift_jis is the Windows-31J index, so cp932 text decodes
  // identically, including the NEC and IBM extension rows.
  ["shiftjis", "shift_jis"],
  ["windows31j", "shift_jis"],
  ["mskanji", "shift_jis"],
  ["eucjp", "euc-jp"],
  // ISO-2022-JP, including the -1 / -2 supersets. Escape sequences outside plain
  // ISO-2022-JP (JIS X 0212, the non-Japanese G2 sets, and the SO/SI katakana shifts
  // cp50222 uses) decode to replacement characters, but the Japanese text around them
  // still comes out right.
  ["iso2022jp", "iso-2022-jp"],
  ["iso2022jp1", "iso-2022-jp"],
  ["iso2022jp2", "iso-2022-jp"],
  ["junet", "iso-2022-jp"],
  // Korean. The WHATWG euc-kr index is the extended cp949 / UHC index.
  ["euckr", "euc-kr"],
  ["uhc", "euc-kr"],
  // Thai.
  ["tis620", "windows-874"]
]);
var codePageAliases = /* @__PURE__ */ new Map([
  ["932", "shift_jis"],
  ["936", "gbk"],
  ["949", "euc-kr"],
  ["950", "big5"],
  ["874", "windows-874"],
  // Microsoft's EUC-JP and ISO-2022-JP variants. euc-jp and iso-2022-jp cover
  // everything they can express.
  ["51932", "euc-jp"],
  ["50220", "iso-2022-jp"],
  ["50221", "iso-2022-jp"],
  ["50222", "iso-2022-jp"]
]);
var codePagePattern = /^(?:cp|windows|ms|ibm)(\d+)$/;
function normalizeCharset(charset) {
  return charset.replace(/^(?:x-ms-|x-|cs)/, "").replace(/[\s._-]+/g, "");
}
var ENCODING_LABELS = new Set([
  // UTF-8
  "unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8",
  // IBM866
  "866 cp866 csibm866 ibm866",
  // ISO-8859-2
  "csisolatin2 iso-8859-2 iso-ir-101 iso8859-2 iso88592 iso_8859-2 iso_8859-2:1987 l2 latin2",
  // ISO-8859-3
  "csisolatin3 iso-8859-3 iso-ir-109 iso8859-3 iso88593 iso_8859-3 iso_8859-3:1988 l3 latin3",
  // ISO-8859-4
  "csisolatin4 iso-8859-4 iso-ir-110 iso8859-4 iso88594 iso_8859-4 iso_8859-4:1988 l4 latin4",
  // ISO-8859-5
  "csisolatincyrillic cyrillic iso-8859-5 iso-ir-144 iso8859-5 iso88595 iso_8859-5 iso_8859-5:1988",
  // ISO-8859-6
  "arabic asmo-708 csiso88596e csiso88596i csisolatinarabic ecma-114 iso-8859-6 iso-8859-6-e",
  "iso-8859-6-i iso-ir-127 iso8859-6 iso88596 iso_8859-6 iso_8859-6:1987",
  // ISO-8859-7
  "csisolatingreek ecma-118 elot_928 greek greek8 iso-8859-7 iso-ir-126 iso8859-7 iso88597 iso_8859-7",
  "iso_8859-7:1987 sun_eu_greek",
  // ISO-8859-8
  "csiso88598e csisolatinhebrew hebrew iso-8859-8 iso-8859-8-e iso-ir-138 iso8859-8 iso88598 iso_8859-8",
  "iso_8859-8:1988 visual",
  // ISO-8859-8-I
  "csiso88598i iso-8859-8-i logical",
  // ISO-8859-10
  "csisolatin6 iso-8859-10 iso-ir-157 iso8859-10 iso885910 l6 latin6",
  // ISO-8859-13
  "iso-8859-13 iso8859-13 iso885913",
  // ISO-8859-14
  "iso-8859-14 iso8859-14 iso885914",
  // ISO-8859-15
  "csisolatin9 iso-8859-15 iso8859-15 iso885915 iso_8859-15 l9",
  // ISO-8859-16
  "iso-8859-16",
  // KOI8-R
  "cskoi8r koi koi8 koi8-r koi8_r",
  // KOI8-U
  "koi8-ru koi8-u",
  // macintosh
  "csmacintosh mac macintosh x-mac-roman",
  // windows-874
  "dos-874 iso-8859-11 iso8859-11 iso885911 tis-620 windows-874",
  // windows-1250
  "cp1250 windows-1250 x-cp1250",
  // windows-1251
  "cp1251 windows-1251 x-cp1251",
  // windows-1252
  "ansi_x3.4-1968 ascii cp1252 cp819 csisolatin1 ibm819 iso-8859-1 iso-ir-100 iso8859-1 iso88591",
  "iso_8859-1 iso_8859-1:1987 l1 latin1 us-ascii windows-1252 x-cp1252",
  // windows-1253
  "cp1253 windows-1253 x-cp1253",
  // windows-1254
  "cp1254 csisolatin5 iso-8859-9 iso-ir-148 iso8859-9 iso88599 iso_8859-9 iso_8859-9:1989 l5 latin5",
  "windows-1254 x-cp1254",
  // windows-1255
  "cp1255 windows-1255 x-cp1255",
  // windows-1256
  "cp1256 windows-1256 x-cp1256",
  // windows-1257
  "cp1257 windows-1257 x-cp1257",
  // windows-1258
  "cp1258 windows-1258 x-cp1258",
  // x-mac-cyrillic
  "x-mac-cyrillic x-mac-ukrainian",
  // GBK
  "chinese csgb2312 csiso58gb231280 gb2312 gb_2312 gb_2312-80 gbk iso-ir-58 x-gbk",
  // gb18030
  "gb18030",
  // Big5
  "big5 big5-hkscs cn-big5 csbig5 x-x-big5",
  // EUC-JP
  "cseucpkdfmtjapanese euc-jp x-euc-jp",
  // ISO-2022-JP
  "csiso2022jp iso-2022-jp",
  // Shift_JIS
  "csshiftjis ms932 ms_kanji shift-jis shift_jis sjis windows-31j x-sjis",
  // EUC-KR
  "cseuckr csksc56011987 euc-kr iso-ir-149 korean ks_c_5601-1987 ks_c_5601-1989 ksc5601 ksc_5601",
  "windows-949",
  // replacement
  "csiso2022kr hz-gb-2312 iso-2022-cn iso-2022-cn-ext iso-2022-kr replacement",
  // x-user-defined
  "x-user-defined"
].join(" ").split(" "));
var REPLACEMENT_LABELS = /* @__PURE__ */ new Set([
  "csiso2022kr",
  "hz-gb-2312",
  "iso-2022-cn",
  "iso-2022-cn-ext",
  "iso-2022-kr",
  "replacement"
]);
var replacementDecoder = {
  encoding: "replacement",
  decode: (input) => input && input.byteLength ? "\uFFFD" : ""
};
var UTF16_LABELS = /* @__PURE__ */ new Map([
  ["utf-16", "utf-16"],
  ["utf16", "utf-16"],
  ["utf_16", "utf-16"],
  ["utf-16le", "utf-16le"],
  ["utf-16be", "utf-16be"]
]);
function resolveLabel(charset) {
  charset = (charset || "utf8").trim().toLowerCase();
  if (ENCODING_LABELS.has(charset)) {
    return charset;
  }
  const utf16 = UTF16_LABELS.get(charset);
  if (utf16) {
    return utf16;
  }
  const normalized = normalizeCharset(charset);
  const codePage = normalized.match(codePagePattern);
  const alias = codePage && codePageAliases.get(codePage[1]) || charsetAliases.get(normalized) || normalized;
  return ENCODING_LABELS.has(alias) ? alias : null;
}
var decoders = /* @__PURE__ */ new Map();
function tryDecoder(label) {
  if (REPLACEMENT_LABELS.has(label)) {
    return replacementDecoder;
  }
  let decoder = decoders.get(label);
  if (decoder === void 0) {
    decoder = null;
    try {
      decoder = new TextDecoder(label);
    } catch {
    }
    decoders.set(label, decoder);
  }
  return decoder;
}
var utf8Decoder = new TextDecoder();
function findDecoder(charset) {
  const label = resolveLabel(charset);
  return label ? tryDecoder(label) : null;
}
function getDecoder(charset) {
  return findDecoder(charset) || tryDecoder("windows-1252") || utf8Decoder;
}
var UTF16_ENCODINGS = /* @__PURE__ */ new Set(["utf-16le", "utf-16be"]);
var UTF16_UNORDERED_LABELS = /* @__PURE__ */ new Set(["utf-16"]);
function bomByteOrder(bytes) {
  if (bytes[0] === 254 && bytes[1] === 255) {
    return "utf-16be";
  }
  if (bytes[0] === 255 && bytes[1] === 254) {
    return "utf-16le";
  }
  return null;
}
function isUtf8(bytes) {
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i];
    if (lead < 128) {
      i++;
      continue;
    }
    let count;
    if (lead >= 194 && lead <= 223) {
      count = 1;
    } else if (lead >= 224 && lead <= 239) {
      count = 2;
    } else if (lead >= 240 && lead <= 244) {
      count = 3;
    } else {
      return false;
    }
    if (i + count >= bytes.length) {
      return false;
    }
    const second = bytes[i + 1];
    const min = lead === 224 ? 160 : lead === 240 ? 144 : 128;
    const max = lead === 237 ? 159 : lead === 244 ? 143 : 191;
    if (second < min || second > max) {
      return false;
    }
    for (let k = 2; k <= count; k++) {
      if ((bytes[i + k] & 192) !== 128) {
        return false;
      }
    }
    i += count + 1;
  }
  return true;
}
function decodeUtf8OrWindows1252(bytes, utf8 = utf8Decoder) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return isUtf8(view) ? utf8.decode(view) : getDecoder("windows-1252").decode(view);
}
function decodeCharset(bytes, charset) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const label = resolveLabel(charset);
  let decoder = label ? tryDecoder(label) : null;
  if (label && UTF16_UNORDERED_LABELS.has(label)) {
    const order2 = bomByteOrder(view);
    decoder = order2 && tryDecoder(order2) || decoder;
  }
  return decoder ? decoder.decode(view) : decodeUtf8OrWindows1252(view);
}
var META_PRESCAN_BYTES = 1024;
var CHARSET_ATTRIBUTE = /charset\s*=\s*["']?\s*([^\s"';>]+)/;
function sniffHtmlCharset(bytes) {
  const head = utf8Decoder.decode(bytes.subarray(0, META_PRESCAN_BYTES)).toLowerCase();
  let pos = 0;
  while ((pos = head.indexOf("<meta", pos)) >= 0) {
    let end = head.indexOf(">", pos);
    if (end < 0) {
      end = head.length;
    }
    const match2 = CHARSET_ATTRIBUTE.exec(head.slice(pos, end));
    if (match2) {
      return match2[1];
    }
    pos = end;
  }
  return null;
}
function decodeText(bytes, charset, html) {
  const view = new Uint8Array(bytes);
  if (charset) {
    return decodeCharset(view, charset);
  }
  const sniffed = html ? sniffHtmlCharset(view) : null;
  const decoder = sniffed ? findDecoder(sniffed) : null;
  if (!decoder || UTF16_ENCODINGS.has(decoder.encoding)) {
    return decodeUtf8OrWindows1252(view);
  }
  return (decoder.encoding === "x-user-defined" ? getDecoder("windows-1252") : decoder).decode(view);
}
async function blobToArrayBuffer(blob) {
  if ("arrayBuffer" in blob) {
    return await blob.arrayBuffer();
  }
  const fr = new FileReader();
  return new Promise((resolve, reject) => {
    fr.onload = () => {
      resolve(fr.result);
    };
    fr.onerror = () => {
      reject(fr.error);
    };
    fr.readAsArrayBuffer(blob);
  });
}
function hexNibble(c) {
  if (c >= 48 && c <= 57) {
    return c - 48;
  }
  if (c >= 97 && c <= 102) {
    return c - 97 + 10;
  }
  if (c >= 65 && c <= 70) {
    return c - 65 + 10;
  }
  return -1;
}
function foldLineBreaks(str2) {
  return str2.replace(/[\r\n]+/g, " ");
}
function decodeWord(charset, encoding, str2) {
  let splitPos = charset.indexOf("*");
  if (splitPos >= 0) {
    charset = charset.slice(0, splitPos);
  }
  encoding = encoding.toUpperCase();
  let byteStr;
  if (encoding === "Q") {
    str2 = str2.replace(/=\s+([0-9a-fA-F])/g, "=$1").replace(/[_\s]/g, " ");
    let buf = textEncoder.encode(str2);
    let encodedBytes = [];
    for (let i = 0, len = buf.length; i < len; i++) {
      let c = buf[i];
      if (i <= len - 2 && c === 61) {
        let high = hexNibble(buf[i + 1]);
        let low = hexNibble(buf[i + 2]);
        if (high >= 0 && low >= 0) {
          encodedBytes.push(high << 4 | low);
          i += 2;
          continue;
        }
      }
      encodedBytes.push(c);
    }
    byteStr = new ArrayBuffer(encodedBytes.length);
    let dataView = new DataView(byteStr);
    for (let i = 0, len = encodedBytes.length; i < len; i++) {
      dataView.setUint8(i, encodedBytes[i]);
    }
  } else if (encoding === "B") {
    byteStr = decodeBase64(str2.replace(/[^a-zA-Z0-9\+\/=]+/g, ""));
  } else {
    byteStr = textEncoder.encode(str2);
  }
  return foldLineBreaks(decodeCharset(byteStr, charset));
}
var ENCODED_WORD_PATTERN = "=\\?([^?\\s]+)\\?([QqBb])\\?([^?]*)\\?=";
var ENCODED_WORD_REGEX = new RegExp(ENCODED_WORD_PATTERN, "g");
var WORD_SEPARATOR_REGEX = /^[ \t\r\n]+$/;
var ENCODED_WORDS_ONLY_REGEX = new RegExp(`^(?:${ENCODED_WORD_PATTERN}\\s*)+$`);
function isEncodedWordsOnly(str2) {
  return ENCODED_WORDS_ONLY_REGEX.test(str2);
}
function splitEncodedWords(str2) {
  const tokens = [];
  ENCODED_WORD_REGEX.lastIndex = 0;
  let pos = 0;
  let match2;
  while (match2 = ENCODED_WORD_REGEX.exec(str2)) {
    if (match2.index > pos) {
      tokens.push({ text: str2.substring(pos, match2.index) });
    }
    tokens.push({ charset: match2[1], encoding: match2[2], encodedText: match2[3] });
    pos = match2.index + match2[0].length;
  }
  if (pos < str2.length) {
    tokens.push({ text: str2.substring(pos) });
  }
  return tokens;
}
function canJoinWords(left, right) {
  const encoding = left.encoding.toUpperCase();
  if (left.charset !== right.charset || encoding !== right.encoding.toUpperCase()) {
    return false;
  }
  if (encoding === "B") {
    return left.encodedText.length % 4 === 0 && !left.padded;
  }
  return true;
}
function renderTokens(tokens, joinWords) {
  let result = "";
  let pending = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text !== void 0) {
      const nextToken = tokens[i + 1];
      if (pending && nextToken && nextToken.text === void 0 && WORD_SEPARATOR_REGEX.test(token.text)) {
        continue;
      }
      if (pending) {
        result += decodeWord(pending.charset, pending.encoding, pending.encodedText);
        pending = null;
      }
      result += token.text;
      continue;
    }
    if (pending && joinWords && canJoinWords(pending, token)) {
      pending.encodedText += token.encodedText;
      pending.padded = token.encodedText.endsWith("=");
      continue;
    }
    if (pending) {
      result += decodeWord(pending.charset, pending.encoding, pending.encodedText);
    }
    pending = {
      charset: token.charset,
      encoding: token.encoding,
      encodedText: token.encodedText,
      padded: token.encodedText.endsWith("=")
    };
  }
  if (pending) {
    result += decodeWord(pending.charset, pending.encoding, pending.encodedText);
  }
  return result;
}
function decodeWords(str2) {
  const tokens = splitEncodedWords((str2 || "").toString());
  const result = renderTokens(tokens, true);
  return result.indexOf("\uFFFD") < 0 ? result : renderTokens(tokens, false);
}
function decodeURIComponentWithCharset(encodedStr, charset) {
  charset = charset || "utf-8";
  let encodedBytes = [];
  for (let i = 0; i < encodedStr.length; i++) {
    let c = encodedStr.charAt(i);
    const high = c === "%" ? hexNibble(encodedStr.charCodeAt(i + 1)) : -1;
    const low = high >= 0 ? hexNibble(encodedStr.charCodeAt(i + 2)) : -1;
    if (low >= 0) {
      encodedBytes.push(high << 4 | low);
      i += 2;
    } else if (c.charCodeAt(0) > 126) {
      const bytes = textEncoder.encode(c);
      for (let j = 0; j < bytes.length; j++) {
        encodedBytes.push(bytes[j]);
      }
    } else {
      encodedBytes.push(c.charCodeAt(0));
    }
  }
  const byteStr = new ArrayBuffer(encodedBytes.length);
  const dataView = new DataView(byteStr);
  for (let i = 0, len = encodedBytes.length; i < len; i++) {
    dataView.setUint8(i, encodedBytes[i]);
  }
  return decodeCharset(byteStr, charset);
}
function decodeParameterValueContinuations(header) {
  let paramKeys = /* @__PURE__ */ new Map();
  Object.keys(header.params).forEach((key) => {
    let match2 = key.match(/\*((\d+)\*?)?$/);
    if (!match2) {
      return;
    }
    let actualKey = key.slice(0, match2.index).toLowerCase();
    let nr = Number(match2[2]) || 0;
    let paramVal = paramKeys.get(actualKey);
    if (!paramVal) {
      paramVal = {
        charset: null,
        values: []
      };
      paramKeys.set(actualKey, paramVal);
    }
    let value = header.params[key];
    let encoded = match2[0].charAt(match2[0].length - 1) === "*";
    if (nr === 0 && encoded && (match2 = value.match(/^([^']*)'[^']*'(.*)$/))) {
      paramVal.charset = match2[1] || "utf-8";
      value = match2[2];
    }
    paramVal.values.push({ nr, value, encoded });
    delete header.params[key];
  });
  paramKeys.forEach((paramVal, key) => {
    if (Object.prototype.hasOwnProperty.call(header.params, key)) {
      return;
    }
    let result = "";
    let pending = "";
    for (let part of paramVal.values.sort((a, b) => a.nr - b.nr)) {
      if (part.encoded) {
        pending += part.value;
        continue;
      }
      if (pending) {
        result += decodeURIComponentWithCharset(pending, paramVal.charset);
        pending = "";
      }
      result += part.value;
    }
    if (pending) {
      result += decodeURIComponentWithCharset(pending, paramVal.charset);
    }
    header.params[key] = result;
  });
}

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/pass-through-decoder.js
var PassThroughDecoder = class {
  constructor() {
    this.chunks = [];
    this.runBuffer = null;
    this.runStart = 0;
    this.runEnd = 0;
    this.pendingLineBreak = null;
  }
  // Whether the bytes sit in the run's buffer right at the end of the run
  continuesRun(bytes) {
    return bytes.buffer === this.runBuffer && bytes.byteOffset === this.runEnd;
  }
  flushRun() {
    if (this.runBuffer && this.runEnd > this.runStart) {
      this.chunks.push(new Uint8Array(this.runBuffer, this.runStart, this.runEnd - this.runStart));
    }
    this.runBuffer = null;
  }
  update(line2, lineBreak) {
    const pending = this.pendingLineBreak;
    if (pending && this.continuesRun(pending) && line2.buffer === this.runBuffer && line2.byteOffset === this.runEnd + pending.byteLength) {
      this.runEnd = line2.byteOffset + line2.byteLength;
    } else {
      this.flushRun();
      if (pending) {
        this.chunks.push(pending);
      }
      this.runBuffer = line2.buffer;
      this.runStart = line2.byteOffset;
      this.runEnd = line2.byteOffset + line2.byteLength;
    }
    this.pendingLineBreak = lineBreak;
  }
  // A part ended by the end of the message has no boundary to own its final line
  // break, so there it stays content
  finalize(boundaryEnded = false) {
    const pending = this.pendingLineBreak;
    if (!boundaryEnded && pending) {
      if (this.continuesRun(pending)) {
        this.runEnd += pending.byteLength;
      } else {
        this.flushRun();
        this.chunks.push(pending);
      }
    }
    this.flushRun();
    return blobToArrayBuffer(new Blob(this.chunks, { type: "application/octet-stream" }));
  }
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/chunk-writer.js
var ChunkWriter = class {
  constructor(maxChunkSize = 100 * 1024) {
    this.maxChunkSize = maxChunkSize;
    this.buffer = null;
    this.bufferPos = 0;
    this.chunks = [];
  }
  writeByte(byte) {
    if (!this.buffer || this.bufferPos >= this.buffer.length) {
      this.flush();
      this.buffer ??= new Uint8Array(this.maxChunkSize);
    }
    this.buffer[this.bufferPos++] = byte;
  }
  // Copied in runs rather than a byte at a time
  writeBytes(bytes, start = 0, end = bytes.length) {
    while (start < end) {
      if (!this.buffer || this.bufferPos >= this.buffer.length) {
        this.flush();
        this.buffer ??= new Uint8Array(this.maxChunkSize);
      }
      const count = Math.min(end - start, this.buffer.length - this.bufferPos);
      this.buffer.set(bytes.subarray(start, start + count), this.bufferPos);
      this.bufferPos += count;
      start += count;
    }
  }
  /**
   * Keeps a buffer the caller hands over and will not touch again. A large one is kept as
   * a chunk of its own instead of being copied, a small one is copied like any other write.
   */
  append(bytes) {
    if (bytes.length >= this.maxChunkSize / 2) {
      this.flush();
      this.chunks.push(bytes);
    } else {
      this.writeBytes(bytes);
    }
  }
  flush() {
    if (this.buffer && this.bufferPos) {
      this.chunks.push(this.buffer.slice(0, this.bufferPos));
      this.bufferPos = 0;
    }
  }
  finalize() {
    this.flush();
    return blobToArrayBuffer(new Blob(this.chunks, { type: "application/octet-stream" }));
  }
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/base64-decoder.js
var Base64Decoder = class {
  constructor(opts) {
    opts = opts || {};
    this.decoder = opts.decoder || new TextDecoder();
    this.maxChunkSize = 100 * 1024;
    this.output = new ChunkWriter();
    this.remainder = "";
  }
  pushChunk(base64Str) {
    if (base64Str.length) {
      this.output.append(new Uint8Array(decodeBase64(base64Str)));
    }
  }
  flushRemainder() {
    this.pushChunk(this.remainder);
    this.remainder = "";
  }
  update(buffer) {
    let str2 = this.decoder.decode(buffer).replace(/[^a-zA-Z0-9+/=]+/g, "");
    let start = 0;
    let end;
    while ((end = str2.indexOf("=", start)) >= 0) {
      this.remainder += str2.substring(start, end);
      this.flushRemainder();
      start = end + 1;
    }
    this.remainder += str2.substring(start);
    if (this.remainder.length >= this.maxChunkSize) {
      const alignedLength = Math.floor(this.remainder.length / 4) * 4;
      this.pushChunk(this.remainder.substring(0, alignedLength));
      this.remainder = this.remainder.substring(alignedLength);
    }
  }
  finalize() {
    this.flushRemainder();
    return this.output.finalize();
  }
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/qp-decoder.js
var CHR_EQUALS = 61;
var QPDecoder = class {
  constructor() {
    this.output = new ChunkWriter();
    this.pendingLineBreak = null;
  }
  writeLineBreak() {
    if (this.pendingLineBreak) {
      this.output.writeBytes(this.pendingLineBreak);
    }
  }
  // Quoted-printable source is 7 bit by definition, so it is decoded byte by byte and
  // the result is handed on as bytes. Running the body charset over the encoded source
  // instead corrupted every part whose charset was not ASCII compatible: the same
  // content that decoded correctly in base64 came out as mojibake in quoted-printable.
  //
  // As in PassThroughDecoder, a hard line break is only written once the next line
  // arrives, so the CRLF that belongs to a following boundary is not decoded as content,
  // and the break written is the one the line came with.
  update(line2, lineBreak) {
    this.writeLineBreak();
    let len = line2.length;
    while (len > 0 && isWsp(line2[len - 1])) {
      len--;
    }
    const softBreak = len > 0 && line2[len - 1] === CHR_EQUALS;
    if (softBreak) {
      len--;
    }
    let literalStart = 0;
    for (let i = 0; i < len; i++) {
      if (line2[i] !== CHR_EQUALS || i + 2 >= len) {
        continue;
      }
      const high = hexNibble(line2[i + 1]);
      const low = hexNibble(line2[i + 2]);
      if (high < 0 || low < 0) {
        continue;
      }
      this.output.writeBytes(line2, literalStart, i);
      this.output.writeByte(high << 4 | low);
      i += 2;
      literalStart = i + 1;
    }
    this.output.writeBytes(line2, literalStart, len);
    this.pendingLineBreak = softBreak ? null : lineBreak;
  }
  // see PassThroughDecoder.finalize
  finalize(boundaryEnded = false) {
    if (!boundaryEnded) {
      this.writeLineBreak();
    }
    return this.output.finalize();
  }
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/errors.js
var ERROR_TYPES = {
  EINVALIDOPTION: TypeError,
  EINVALIDINPUT: TypeError,
  EPARSERREUSED: Error,
  EMAXNESTINGDEPTH: Error,
  EMAXHEADERSIZE: Error,
  EMAXPARTCOUNT: Error,
  EMAXFORWARDEDADDRESSES: Error
};
function createError(code, message) {
  const error = new ERROR_TYPES[code](message);
  error.code = code;
  return error;
}

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/mime-node.js
var headerDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
var FLOWED_JOIN_INTERVAL = 4096;
var HEADER_LINE_MIN_COST = 64;
var trimWsp = (str2) => {
  let start = 0;
  let end = str2.length;
  while (start < end && isWsp(str2.charCodeAt(start))) {
    start++;
  }
  while (end > start && isWsp(str2.charCodeAt(end - 1))) {
    end--;
  }
  return str2.slice(start, end);
};
var FIELD_START = /^(?:From |[!-9;-~]*[ \t]*:)/;
var CONTENT_HEADERS = /* @__PURE__ */ new Set([
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "content-description"
]);
var MimeNode = class {
  constructor(options) {
    this.options = options;
    this.postalMime = options.postalMime;
    const limits = this.postalMime.limits;
    this.postalMime.counters.partCount++;
    if (this.postalMime.counters.partCount > limits.maxPartCount) {
      throw createError("EMAXPARTCOUNT", `Maximum MIME part count of ${limits.maxPartCount} parts exceeded`);
    }
    this.childNodes = [];
    this.finalizedChildCount = 0;
    if (options.parentNode) {
      this.parentNode = options.parentNode;
      this.depth = this.parentNode.depth + 1;
      if (this.depth > limits.maxNestingDepth) {
        throw createError("EMAXNESTINGDEPTH", `Maximum MIME nesting depth of ${limits.maxNestingDepth} levels exceeded`);
      }
      options.parentNode.childNodes.push(this);
    } else {
      this.depth = 0;
    }
    this.state = "header";
    this.headerLines = [];
    const parentMultipartType = options.parentMultipartType || null;
    const defaultContentType = parentMultipartType === "digest" ? "message/rfc822" : "text/plain";
    this.contentType = {
      value: defaultContentType,
      parsed: { value: defaultContentType, params: {} },
      multipart: false
    };
    this.contentTransferEncoding = {
      value: "8bit",
      encoding: ""
    };
    this.contentDisposition = {
      value: "",
      parsed: { value: "", params: {} }
    };
    this.headers = [];
    this.rawHeaderLines = [];
    this.contentDecoder = null;
    this.content = null;
  }
  // `transferEncoding` is the lowercased token of the header, see processHeaders. It is
  // matched whole: `x-base64` or `7bit-base64` is no encoding Python or mailparser
  // decode, and decoding it here rendered as markup a body every other reader keeps as
  // inert base64
  setupContentDecoder(transferEncoding) {
    if (transferEncoding === "base64") {
      this.contentDecoder = new Base64Decoder();
    } else if (transferEncoding === "quoted-printable") {
      this.contentDecoder = new QPDecoder();
    } else {
      this.contentDecoder = new PassThroughDecoder();
    }
  }
  // `boundaryEnded` tells that the part was ended by a multipart boundary, which owns
  // the line break after the last line of the part (RFC 2046 5.1.1)
  async finalize(boundaryEnded = false) {
    if (this.state === "finished") {
      return;
    }
    if (this.state === "header") {
      this.endHeaders();
    }
    let boundaries = this.postalMime.boundaries;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      let boundary = boundaries[i];
      if (boundary.node === this) {
        boundaries.splice(i, 1);
        break;
      }
    }
    await this.finalizeChildNodes(boundaryEnded);
    this.content = this.contentDecoder ? await this.contentDecoder.finalize(boundaryEnded) : null;
    this.contentDecoder = null;
    this.state = "finished";
  }
  async finalizeChildNodes(boundaryEnded = false) {
    while (this.finalizedChildCount < this.childNodes.length) {
      await this.childNodes[this.finalizedChildCount++].finalize(boundaryEnded);
    }
  }
  // Strip RFC 822 comments (parenthesized text) from structured header values.
  //
  // Inside an unquoted parameter value a parenthesis that continues the current token is
  // content, because `filename=Invoice(1).pdf` is a filename and not a token followed by
  // a comment, and deleting the parens silently renames the attachment.
  stripComments(str2) {
    let result = "";
    let depth = 0;
    let escaped = false;
    let inQuote = false;
    let commentStart = -1;
    let inParameterValue = false;
    let runStart = 0;
    const drop = (i) => {
      result += str2.slice(runStart, i);
      runStart = i + 1;
    };
    let keptAny = false;
    let endsWithWsp = false;
    const keep = (i) => {
      keptAny = true;
      endsWithWsp = isWsp(str2.charCodeAt(i));
    };
    const opensComment = () => !inParameterValue || !keptAny || endsWithWsp;
    for (let i = 0; i < str2.length; i++) {
      const chr = str2.charAt(i);
      if (escaped) {
        escaped = false;
      } else if (chr === "\\") {
        escaped = true;
      } else if (chr === '"' && depth === 0) {
        inQuote = !inQuote;
      } else if (!inQuote) {
        if (chr === "(" && opensComment()) {
          if (depth === 0) {
            commentStart = i;
          }
          depth++;
          drop(i);
          continue;
        }
        if (chr === ")" && depth > 0) {
          depth--;
          drop(i);
          continue;
        }
        if (depth === 0) {
          if (chr === "=") {
            inParameterValue = true;
          } else if (chr === ";") {
            inParameterValue = false;
          }
        }
      }
      if (depth === 0) {
        keep(i);
      } else {
        drop(i);
      }
    }
    if (depth === 0) {
      return result + str2.slice(runStart);
    }
    return str2.indexOf(";", commentStart) < 0 ? result + str2.slice(runStart) : str2;
  }
  parseStructuredHeader(str2) {
    str2 = this.stripComments(str2);
    let response = {
      value: "",
      params: {}
    };
    let key = false;
    let value = "";
    let stage = "value";
    let pendingSpace = "";
    let quoteClosed = false;
    let quote = false;
    let escaped = false;
    let chr;
    const flushSpace = () => {
      if (value.length) {
        value += pendingSpace;
      }
      pendingSpace = "";
    };
    let runStart = -1;
    const closeRun = (end) => {
      if (runStart >= 0) {
        value += str2.slice(runStart, end);
        runStart = -1;
      }
    };
    const addChr = (i) => {
      if (runStart < 0) {
        flushSpace();
        runStart = i;
      }
    };
    const takeValue = () => {
      const result = value;
      value = "";
      pendingSpace = "";
      quoteClosed = false;
      return result;
    };
    const storeParam = (name, result) => {
      if (name && !Object.prototype.hasOwnProperty.call(response.params, name)) {
        response.params[name] = result;
      }
    };
    const storeValue = () => {
      const result = takeValue();
      if (key === false) {
        response.value = result;
      } else {
        storeParam(key, result);
      }
    };
    const storeEmptyKey = () => {
      storeParam(takeValue().trim().toLowerCase(), "");
    };
    for (let i = 0, len = str2.length; i < len; i++) {
      chr = str2.charAt(i);
      switch (stage) {
        case "key":
          if (chr === "=") {
            closeRun(i);
            key = takeValue().trim().toLowerCase();
            stage = "value";
            break;
          }
          if (chr === ";") {
            closeRun(i);
            storeEmptyKey();
            break;
          }
          if (runStart < 0) {
            runStart = i;
          }
          break;
        case "value":
          if (quoteClosed && chr !== ";") {
            escaped = false;
            break;
          }
          if (escaped) {
            addChr(i);
          } else if (quote && chr === "\\") {
            closeRun(i);
            escaped = true;
            continue;
          } else if (quote && chr === quote) {
            closeRun(i);
            quote = false;
            quoteClosed = true;
          } else if (!quote && chr === '"') {
            closeRun(i);
            quote = chr;
            flushSpace();
          } else if (!quote && chr === ";") {
            closeRun(i);
            storeValue();
            stage = "key";
          } else if (!quote && (chr === " " || chr === "	")) {
            closeRun(i);
            pendingSpace += chr;
          } else {
            addChr(i);
          }
          escaped = false;
          break;
      }
    }
    closeRun(str2.length);
    if (stage === "value") {
      storeValue();
    } else {
      storeEmptyKey();
    }
    if (response.value) {
      response.value = response.value.toLowerCase();
    }
    decodeParameterValueContinuations(response);
    return response;
  }
  // Unfolds format=flowed text (RFC 3676 4.1). A line is read as its quote marks, one
  // space of stuffing and its content, in that order, and a line whose content ends in a
  // space is flowed: the next line of the same quote depth continues its paragraph. The
  // paragraph ends at a fixed line, at a change of quote depth and at the signature
  // separator, which is neither flowed nor fixed. Joining a quoted paragraph used to
  // leave the quote marks of the continuation lines inside the text, so a quoted reply
  // read `> one > two` instead of `> one two`.
  //
  // The quote marks and stuffing of the first line of a paragraph are kept as they were
  // written, so a fixed quoted line comes out exactly as it went in. An unquoted stuffed
  // line loses its stuffing, which is all the stuffing is for.
  decodeFlowedText(str2, delSp) {
    const chunks = [];
    let parts = [];
    let flowed = false;
    let depth = 0;
    for (let lineStart = 0; lineStart <= str2.length; ) {
      let lineEnd = str2.indexOf("\n", lineStart);
      if (lineEnd < 0) {
        lineEnd = str2.length;
      }
      const line2 = str2.slice(lineStart, lineEnd);
      let quoteDepth = 0;
      while (line2.charCodeAt(quoteDepth) === 62) {
        quoteDepth++;
      }
      const contentStart = line2.charCodeAt(quoteDepth) === 32 ? quoteDepth + 1 : quoteDepth;
      const content = line2.slice(contentStart);
      const isSignature = content === "-- ";
      if (flowed && quoteDepth === depth && !isSignature) {
        if (delSp) {
          const last = parts[parts.length - 1];
          parts[parts.length - 1] = last.slice(0, -1);
        }
        parts.push(content);
      } else {
        if (lineStart) {
          parts.push("\n");
        }
        parts.push(quoteDepth ? line2 : content);
      }
      flowed = !isSignature && content.endsWith(" ");
      depth = quoteDepth;
      if (parts.length >= FLOWED_JOIN_INTERVAL) {
        const last = parts.pop();
        chunks.push(parts.join(""));
        parts = [last];
      }
      lineStart = lineEnd + 1;
    }
    chunks.push(parts.join(""));
    return chunks.join("");
  }
  getTextContent() {
    if (!this.content) {
      return "";
    }
    let str2 = decodeText(this.content, this.contentType.parsed.params.charset, this.contentType.parsed.value === "text/html").replace(/\r\n/g, "\n");
    if (this.contentType.parsed.value === "text/plain" && /^flowed$/i.test(this.contentType.parsed.params.format)) {
      str2 = this.decodeFlowedText(str2, /^yes$/i.test(this.contentType.parsed.params.delsp));
    }
    return str2;
  }
  processHeaders() {
    let foldedLines = [];
    for (let line2 of this.headerLines) {
      if (foldedLines.length && /^[ \t]/.test(line2)) {
        foldedLines[foldedLines.length - 1].push(line2);
      } else {
        foldedLines.push([line2]);
      }
    }
    let seenContentHeaders = /* @__PURE__ */ new Set();
    for (let parts of foldedLines) {
      let rawLine = parts.join("\n");
      let sep = rawLine.indexOf(":");
      let rawKey = sep < 0 ? rawLine : rawLine.slice(0, sep);
      this.rawHeaderLines.push({
        key: rawKey.toLowerCase(),
        line: rawLine
      });
      let unfoldedLine = parts.join("");
      sep = unfoldedLine.indexOf(":");
      let key = sep < 0 ? unfoldedLine : unfoldedLine.slice(0, sep);
      let value = sep < 0 ? "" : trimWsp(foldLineBreaks(unfoldedLine.slice(sep + 1)));
      this.headers.push({ key: key.toLowerCase(), originalKey: key, value });
      const lowerKey = key.toLowerCase();
      if (CONTENT_HEADERS.has(lowerKey) && !seenContentHeaders.has(lowerKey)) {
        seenContentHeaders.add(lowerKey);
        switch (lowerKey) {
          case "content-type":
            this.contentType.value = value;
            break;
          case "content-transfer-encoding":
            this.contentTransferEncoding.value = value;
            break;
          case "content-disposition":
            this.contentDisposition.value = value;
            break;
          case "content-id":
            this.contentId = value;
            break;
          case "content-description":
            this.contentDescription = value;
            break;
        }
      }
    }
    this.contentType.parsed = this.parseStructuredHeader(this.contentType.value);
    this.contentType.multipart = /^multipart\//i.test(this.contentType.parsed.value) ? this.contentType.parsed.value.slice(this.contentType.parsed.value.indexOf("/") + 1) : false;
    let boundary = this.contentType.multipart ? (this.contentType.parsed.params.boundary || "").trimEnd() : "";
    if (/[^\x00-\x7f]/.test(boundary)) {
      boundary = "";
    }
    if (this.contentType.multipart && !boundary) {
      this.contentType.parsed.value = "text/plain";
      this.contentType.multipart = false;
    }
    if (this.contentType.multipart) {
      this.postalMime.boundaries.push({
        value: textEncoder.encode(boundary),
        node: this
      });
    }
    this.contentDisposition.parsed = this.parseStructuredHeader(this.contentDisposition.value);
    const disposition = this.contentDisposition.parsed.value;
    const dispositionEnd = disposition.search(/[ \t]/);
    if (dispositionEnd >= 0) {
      this.contentDisposition.parsed.value = disposition.slice(0, dispositionEnd);
    }
    this.contentTransferEncoding.encoding = (this.stripComments(this.contentTransferEncoding.value).toLowerCase().match(/^[ \t]*([\w-]+)/) || ["", ""])[1];
    this.setupContentDecoder(this.contentTransferEncoding.encoding);
    this.headerLines = [];
  }
  // Ends the header section and sets up the body
  endHeaders() {
    this.state = "body";
    this.processHeaders();
  }
  // Returns true when the line was not consumed: the headers ended with the line before
  // it, and the parser has to read it again, since the boundary this part declares was
  // not known yet when the line was checked for one
  feed(line2, lineBreak) {
    switch (this.state) {
      case "header": {
        if (!line2.length) {
          this.endHeaders();
          return false;
        }
        this.postalMime.counters.headerSize += Math.max(line2.length, HEADER_LINE_MIN_COST);
        const maxHeadersSize = this.postalMime.limits.maxHeadersSize;
        if (this.postalMime.counters.headerSize > maxHeadersSize) {
          throw createError("EMAXHEADERSIZE", `Maximum header size of ${maxHeadersSize} bytes exceeded`);
        }
        const text = decodeUtf8OrWindows1252(line2, headerDecoder);
        if (!isWsp(line2[0]) && !FIELD_START.test(text)) {
          this.endHeaders();
          return true;
        }
        this.headerLines.push(text);
        break;
      }
      case "body":
        if (this.contentDecoder) {
          this.contentDecoder.update(line2, lineBreak);
        }
        break;
    }
    return false;
  }
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/html-entities.js
var htmlEntities = {
  "&AElig": "\xC6",
  "&AElig;": "\xC6",
  "&AMP": "&",
  "&AMP;": "&",
  "&Aacute": "\xC1",
  "&Aacute;": "\xC1",
  "&Abreve;": "\u0102",
  "&Acirc": "\xC2",
  "&Acirc;": "\xC2",
  "&Acy;": "\u0410",
  "&Afr;": "\u{1D504}",
  "&Agrave": "\xC0",
  "&Agrave;": "\xC0",
  "&Alpha;": "\u0391",
  "&Amacr;": "\u0100",
  "&And;": "\u2A53",
  "&Aogon;": "\u0104",
  "&Aopf;": "\u{1D538}",
  "&ApplyFunction;": "\u2061",
  "&Aring": "\xC5",
  "&Aring;": "\xC5",
  "&Ascr;": "\u{1D49C}",
  "&Assign;": "\u2254",
  "&Atilde": "\xC3",
  "&Atilde;": "\xC3",
  "&Auml": "\xC4",
  "&Auml;": "\xC4",
  "&Backslash;": "\u2216",
  "&Barv;": "\u2AE7",
  "&Barwed;": "\u2306",
  "&Bcy;": "\u0411",
  "&Because;": "\u2235",
  "&Bernoullis;": "\u212C",
  "&Beta;": "\u0392",
  "&Bfr;": "\u{1D505}",
  "&Bopf;": "\u{1D539}",
  "&Breve;": "\u02D8",
  "&Bscr;": "\u212C",
  "&Bumpeq;": "\u224E",
  "&CHcy;": "\u0427",
  "&COPY": "\xA9",
  "&COPY;": "\xA9",
  "&Cacute;": "\u0106",
  "&Cap;": "\u22D2",
  "&CapitalDifferentialD;": "\u2145",
  "&Cayleys;": "\u212D",
  "&Ccaron;": "\u010C",
  "&Ccedil": "\xC7",
  "&Ccedil;": "\xC7",
  "&Ccirc;": "\u0108",
  "&Cconint;": "\u2230",
  "&Cdot;": "\u010A",
  "&Cedilla;": "\xB8",
  "&CenterDot;": "\xB7",
  "&Cfr;": "\u212D",
  "&Chi;": "\u03A7",
  "&CircleDot;": "\u2299",
  "&CircleMinus;": "\u2296",
  "&CirclePlus;": "\u2295",
  "&CircleTimes;": "\u2297",
  "&ClockwiseContourIntegral;": "\u2232",
  "&CloseCurlyDoubleQuote;": "\u201D",
  "&CloseCurlyQuote;": "\u2019",
  "&Colon;": "\u2237",
  "&Colone;": "\u2A74",
  "&Congruent;": "\u2261",
  "&Conint;": "\u222F",
  "&ContourIntegral;": "\u222E",
  "&Copf;": "\u2102",
  "&Coproduct;": "\u2210",
  "&CounterClockwiseContourIntegral;": "\u2233",
  "&Cross;": "\u2A2F",
  "&Cscr;": "\u{1D49E}",
  "&Cup;": "\u22D3",
  "&CupCap;": "\u224D",
  "&DD;": "\u2145",
  "&DDotrahd;": "\u2911",
  "&DJcy;": "\u0402",
  "&DScy;": "\u0405",
  "&DZcy;": "\u040F",
  "&Dagger;": "\u2021",
  "&Darr;": "\u21A1",
  "&Dashv;": "\u2AE4",
  "&Dcaron;": "\u010E",
  "&Dcy;": "\u0414",
  "&Del;": "\u2207",
  "&Delta;": "\u0394",
  "&Dfr;": "\u{1D507}",
  "&DiacriticalAcute;": "\xB4",
  "&DiacriticalDot;": "\u02D9",
  "&DiacriticalDoubleAcute;": "\u02DD",
  "&DiacriticalGrave;": "`",
  "&DiacriticalTilde;": "\u02DC",
  "&Diamond;": "\u22C4",
  "&DifferentialD;": "\u2146",
  "&Dopf;": "\u{1D53B}",
  "&Dot;": "\xA8",
  "&DotDot;": "\u20DC",
  "&DotEqual;": "\u2250",
  "&DoubleContourIntegral;": "\u222F",
  "&DoubleDot;": "\xA8",
  "&DoubleDownArrow;": "\u21D3",
  "&DoubleLeftArrow;": "\u21D0",
  "&DoubleLeftRightArrow;": "\u21D4",
  "&DoubleLeftTee;": "\u2AE4",
  "&DoubleLongLeftArrow;": "\u27F8",
  "&DoubleLongLeftRightArrow;": "\u27FA",
  "&DoubleLongRightArrow;": "\u27F9",
  "&DoubleRightArrow;": "\u21D2",
  "&DoubleRightTee;": "\u22A8",
  "&DoubleUpArrow;": "\u21D1",
  "&DoubleUpDownArrow;": "\u21D5",
  "&DoubleVerticalBar;": "\u2225",
  "&DownArrow;": "\u2193",
  "&DownArrowBar;": "\u2913",
  "&DownArrowUpArrow;": "\u21F5",
  "&DownBreve;": "\u0311",
  "&DownLeftRightVector;": "\u2950",
  "&DownLeftTeeVector;": "\u295E",
  "&DownLeftVector;": "\u21BD",
  "&DownLeftVectorBar;": "\u2956",
  "&DownRightTeeVector;": "\u295F",
  "&DownRightVector;": "\u21C1",
  "&DownRightVectorBar;": "\u2957",
  "&DownTee;": "\u22A4",
  "&DownTeeArrow;": "\u21A7",
  "&Downarrow;": "\u21D3",
  "&Dscr;": "\u{1D49F}",
  "&Dstrok;": "\u0110",
  "&ENG;": "\u014A",
  "&ETH": "\xD0",
  "&ETH;": "\xD0",
  "&Eacute": "\xC9",
  "&Eacute;": "\xC9",
  "&Ecaron;": "\u011A",
  "&Ecirc": "\xCA",
  "&Ecirc;": "\xCA",
  "&Ecy;": "\u042D",
  "&Edot;": "\u0116",
  "&Efr;": "\u{1D508}",
  "&Egrave": "\xC8",
  "&Egrave;": "\xC8",
  "&Element;": "\u2208",
  "&Emacr;": "\u0112",
  "&EmptySmallSquare;": "\u25FB",
  "&EmptyVerySmallSquare;": "\u25AB",
  "&Eogon;": "\u0118",
  "&Eopf;": "\u{1D53C}",
  "&Epsilon;": "\u0395",
  "&Equal;": "\u2A75",
  "&EqualTilde;": "\u2242",
  "&Equilibrium;": "\u21CC",
  "&Escr;": "\u2130",
  "&Esim;": "\u2A73",
  "&Eta;": "\u0397",
  "&Euml": "\xCB",
  "&Euml;": "\xCB",
  "&Exists;": "\u2203",
  "&ExponentialE;": "\u2147",
  "&Fcy;": "\u0424",
  "&Ffr;": "\u{1D509}",
  "&FilledSmallSquare;": "\u25FC",
  "&FilledVerySmallSquare;": "\u25AA",
  "&Fopf;": "\u{1D53D}",
  "&ForAll;": "\u2200",
  "&Fouriertrf;": "\u2131",
  "&Fscr;": "\u2131",
  "&GJcy;": "\u0403",
  "&GT": ">",
  "&GT;": ">",
  "&Gamma;": "\u0393",
  "&Gammad;": "\u03DC",
  "&Gbreve;": "\u011E",
  "&Gcedil;": "\u0122",
  "&Gcirc;": "\u011C",
  "&Gcy;": "\u0413",
  "&Gdot;": "\u0120",
  "&Gfr;": "\u{1D50A}",
  "&Gg;": "\u22D9",
  "&Gopf;": "\u{1D53E}",
  "&GreaterEqual;": "\u2265",
  "&GreaterEqualLess;": "\u22DB",
  "&GreaterFullEqual;": "\u2267",
  "&GreaterGreater;": "\u2AA2",
  "&GreaterLess;": "\u2277",
  "&GreaterSlantEqual;": "\u2A7E",
  "&GreaterTilde;": "\u2273",
  "&Gscr;": "\u{1D4A2}",
  "&Gt;": "\u226B",
  "&HARDcy;": "\u042A",
  "&Hacek;": "\u02C7",
  "&Hat;": "^",
  "&Hcirc;": "\u0124",
  "&Hfr;": "\u210C",
  "&HilbertSpace;": "\u210B",
  "&Hopf;": "\u210D",
  "&HorizontalLine;": "\u2500",
  "&Hscr;": "\u210B",
  "&Hstrok;": "\u0126",
  "&HumpDownHump;": "\u224E",
  "&HumpEqual;": "\u224F",
  "&IEcy;": "\u0415",
  "&IJlig;": "\u0132",
  "&IOcy;": "\u0401",
  "&Iacute": "\xCD",
  "&Iacute;": "\xCD",
  "&Icirc": "\xCE",
  "&Icirc;": "\xCE",
  "&Icy;": "\u0418",
  "&Idot;": "\u0130",
  "&Ifr;": "\u2111",
  "&Igrave": "\xCC",
  "&Igrave;": "\xCC",
  "&Im;": "\u2111",
  "&Imacr;": "\u012A",
  "&ImaginaryI;": "\u2148",
  "&Implies;": "\u21D2",
  "&Int;": "\u222C",
  "&Integral;": "\u222B",
  "&Intersection;": "\u22C2",
  "&InvisibleComma;": "\u2063",
  "&InvisibleTimes;": "\u2062",
  "&Iogon;": "\u012E",
  "&Iopf;": "\u{1D540}",
  "&Iota;": "\u0399",
  "&Iscr;": "\u2110",
  "&Itilde;": "\u0128",
  "&Iukcy;": "\u0406",
  "&Iuml": "\xCF",
  "&Iuml;": "\xCF",
  "&Jcirc;": "\u0134",
  "&Jcy;": "\u0419",
  "&Jfr;": "\u{1D50D}",
  "&Jopf;": "\u{1D541}",
  "&Jscr;": "\u{1D4A5}",
  "&Jsercy;": "\u0408",
  "&Jukcy;": "\u0404",
  "&KHcy;": "\u0425",
  "&KJcy;": "\u040C",
  "&Kappa;": "\u039A",
  "&Kcedil;": "\u0136",
  "&Kcy;": "\u041A",
  "&Kfr;": "\u{1D50E}",
  "&Kopf;": "\u{1D542}",
  "&Kscr;": "\u{1D4A6}",
  "&LJcy;": "\u0409",
  "&LT": "<",
  "&LT;": "<",
  "&Lacute;": "\u0139",
  "&Lambda;": "\u039B",
  "&Lang;": "\u27EA",
  "&Laplacetrf;": "\u2112",
  "&Larr;": "\u219E",
  "&Lcaron;": "\u013D",
  "&Lcedil;": "\u013B",
  "&Lcy;": "\u041B",
  "&LeftAngleBracket;": "\u27E8",
  "&LeftArrow;": "\u2190",
  "&LeftArrowBar;": "\u21E4",
  "&LeftArrowRightArrow;": "\u21C6",
  "&LeftCeiling;": "\u2308",
  "&LeftDoubleBracket;": "\u27E6",
  "&LeftDownTeeVector;": "\u2961",
  "&LeftDownVector;": "\u21C3",
  "&LeftDownVectorBar;": "\u2959",
  "&LeftFloor;": "\u230A",
  "&LeftRightArrow;": "\u2194",
  "&LeftRightVector;": "\u294E",
  "&LeftTee;": "\u22A3",
  "&LeftTeeArrow;": "\u21A4",
  "&LeftTeeVector;": "\u295A",
  "&LeftTriangle;": "\u22B2",
  "&LeftTriangleBar;": "\u29CF",
  "&LeftTriangleEqual;": "\u22B4",
  "&LeftUpDownVector;": "\u2951",
  "&LeftUpTeeVector;": "\u2960",
  "&LeftUpVector;": "\u21BF",
  "&LeftUpVectorBar;": "\u2958",
  "&LeftVector;": "\u21BC",
  "&LeftVectorBar;": "\u2952",
  "&Leftarrow;": "\u21D0",
  "&Leftrightarrow;": "\u21D4",
  "&LessEqualGreater;": "\u22DA",
  "&LessFullEqual;": "\u2266",
  "&LessGreater;": "\u2276",
  "&LessLess;": "\u2AA1",
  "&LessSlantEqual;": "\u2A7D",
  "&LessTilde;": "\u2272",
  "&Lfr;": "\u{1D50F}",
  "&Ll;": "\u22D8",
  "&Lleftarrow;": "\u21DA",
  "&Lmidot;": "\u013F",
  "&LongLeftArrow;": "\u27F5",
  "&LongLeftRightArrow;": "\u27F7",
  "&LongRightArrow;": "\u27F6",
  "&Longleftarrow;": "\u27F8",
  "&Longleftrightarrow;": "\u27FA",
  "&Longrightarrow;": "\u27F9",
  "&Lopf;": "\u{1D543}",
  "&LowerLeftArrow;": "\u2199",
  "&LowerRightArrow;": "\u2198",
  "&Lscr;": "\u2112",
  "&Lsh;": "\u21B0",
  "&Lstrok;": "\u0141",
  "&Lt;": "\u226A",
  "&Map;": "\u2905",
  "&Mcy;": "\u041C",
  "&MediumSpace;": "\u205F",
  "&Mellintrf;": "\u2133",
  "&Mfr;": "\u{1D510}",
  "&MinusPlus;": "\u2213",
  "&Mopf;": "\u{1D544}",
  "&Mscr;": "\u2133",
  "&Mu;": "\u039C",
  "&NJcy;": "\u040A",
  "&Nacute;": "\u0143",
  "&Ncaron;": "\u0147",
  "&Ncedil;": "\u0145",
  "&Ncy;": "\u041D",
  "&NegativeMediumSpace;": "\u200B",
  "&NegativeThickSpace;": "\u200B",
  "&NegativeThinSpace;": "\u200B",
  "&NegativeVeryThinSpace;": "\u200B",
  "&NestedGreaterGreater;": "\u226B",
  "&NestedLessLess;": "\u226A",
  "&NewLine;": "\n",
  "&Nfr;": "\u{1D511}",
  "&NoBreak;": "\u2060",
  "&NonBreakingSpace;": "\xA0",
  "&Nopf;": "\u2115",
  "&Not;": "\u2AEC",
  "&NotCongruent;": "\u2262",
  "&NotCupCap;": "\u226D",
  "&NotDoubleVerticalBar;": "\u2226",
  "&NotElement;": "\u2209",
  "&NotEqual;": "\u2260",
  "&NotEqualTilde;": "\u2242\u0338",
  "&NotExists;": "\u2204",
  "&NotGreater;": "\u226F",
  "&NotGreaterEqual;": "\u2271",
  "&NotGreaterFullEqual;": "\u2267\u0338",
  "&NotGreaterGreater;": "\u226B\u0338",
  "&NotGreaterLess;": "\u2279",
  "&NotGreaterSlantEqual;": "\u2A7E\u0338",
  "&NotGreaterTilde;": "\u2275",
  "&NotHumpDownHump;": "\u224E\u0338",
  "&NotHumpEqual;": "\u224F\u0338",
  "&NotLeftTriangle;": "\u22EA",
  "&NotLeftTriangleBar;": "\u29CF\u0338",
  "&NotLeftTriangleEqual;": "\u22EC",
  "&NotLess;": "\u226E",
  "&NotLessEqual;": "\u2270",
  "&NotLessGreater;": "\u2278",
  "&NotLessLess;": "\u226A\u0338",
  "&NotLessSlantEqual;": "\u2A7D\u0338",
  "&NotLessTilde;": "\u2274",
  "&NotNestedGreaterGreater;": "\u2AA2\u0338",
  "&NotNestedLessLess;": "\u2AA1\u0338",
  "&NotPrecedes;": "\u2280",
  "&NotPrecedesEqual;": "\u2AAF\u0338",
  "&NotPrecedesSlantEqual;": "\u22E0",
  "&NotReverseElement;": "\u220C",
  "&NotRightTriangle;": "\u22EB",
  "&NotRightTriangleBar;": "\u29D0\u0338",
  "&NotRightTriangleEqual;": "\u22ED",
  "&NotSquareSubset;": "\u228F\u0338",
  "&NotSquareSubsetEqual;": "\u22E2",
  "&NotSquareSuperset;": "\u2290\u0338",
  "&NotSquareSupersetEqual;": "\u22E3",
  "&NotSubset;": "\u2282\u20D2",
  "&NotSubsetEqual;": "\u2288",
  "&NotSucceeds;": "\u2281",
  "&NotSucceedsEqual;": "\u2AB0\u0338",
  "&NotSucceedsSlantEqual;": "\u22E1",
  "&NotSucceedsTilde;": "\u227F\u0338",
  "&NotSuperset;": "\u2283\u20D2",
  "&NotSupersetEqual;": "\u2289",
  "&NotTilde;": "\u2241",
  "&NotTildeEqual;": "\u2244",
  "&NotTildeFullEqual;": "\u2247",
  "&NotTildeTilde;": "\u2249",
  "&NotVerticalBar;": "\u2224",
  "&Nscr;": "\u{1D4A9}",
  "&Ntilde": "\xD1",
  "&Ntilde;": "\xD1",
  "&Nu;": "\u039D",
  "&OElig;": "\u0152",
  "&Oacute": "\xD3",
  "&Oacute;": "\xD3",
  "&Ocirc": "\xD4",
  "&Ocirc;": "\xD4",
  "&Ocy;": "\u041E",
  "&Odblac;": "\u0150",
  "&Ofr;": "\u{1D512}",
  "&Ograve": "\xD2",
  "&Ograve;": "\xD2",
  "&Omacr;": "\u014C",
  "&Omega;": "\u03A9",
  "&Omicron;": "\u039F",
  "&Oopf;": "\u{1D546}",
  "&OpenCurlyDoubleQuote;": "\u201C",
  "&OpenCurlyQuote;": "\u2018",
  "&Or;": "\u2A54",
  "&Oscr;": "\u{1D4AA}",
  "&Oslash": "\xD8",
  "&Oslash;": "\xD8",
  "&Otilde": "\xD5",
  "&Otilde;": "\xD5",
  "&Otimes;": "\u2A37",
  "&Ouml": "\xD6",
  "&Ouml;": "\xD6",
  "&OverBar;": "\u203E",
  "&OverBrace;": "\u23DE",
  "&OverBracket;": "\u23B4",
  "&OverParenthesis;": "\u23DC",
  "&PartialD;": "\u2202",
  "&Pcy;": "\u041F",
  "&Pfr;": "\u{1D513}",
  "&Phi;": "\u03A6",
  "&Pi;": "\u03A0",
  "&PlusMinus;": "\xB1",
  "&Poincareplane;": "\u210C",
  "&Popf;": "\u2119",
  "&Pr;": "\u2ABB",
  "&Precedes;": "\u227A",
  "&PrecedesEqual;": "\u2AAF",
  "&PrecedesSlantEqual;": "\u227C",
  "&PrecedesTilde;": "\u227E",
  "&Prime;": "\u2033",
  "&Product;": "\u220F",
  "&Proportion;": "\u2237",
  "&Proportional;": "\u221D",
  "&Pscr;": "\u{1D4AB}",
  "&Psi;": "\u03A8",
  "&QUOT": '"',
  "&QUOT;": '"',
  "&Qfr;": "\u{1D514}",
  "&Qopf;": "\u211A",
  "&Qscr;": "\u{1D4AC}",
  "&RBarr;": "\u2910",
  "&REG": "\xAE",
  "&REG;": "\xAE",
  "&Racute;": "\u0154",
  "&Rang;": "\u27EB",
  "&Rarr;": "\u21A0",
  "&Rarrtl;": "\u2916",
  "&Rcaron;": "\u0158",
  "&Rcedil;": "\u0156",
  "&Rcy;": "\u0420",
  "&Re;": "\u211C",
  "&ReverseElement;": "\u220B",
  "&ReverseEquilibrium;": "\u21CB",
  "&ReverseUpEquilibrium;": "\u296F",
  "&Rfr;": "\u211C",
  "&Rho;": "\u03A1",
  "&RightAngleBracket;": "\u27E9",
  "&RightArrow;": "\u2192",
  "&RightArrowBar;": "\u21E5",
  "&RightArrowLeftArrow;": "\u21C4",
  "&RightCeiling;": "\u2309",
  "&RightDoubleBracket;": "\u27E7",
  "&RightDownTeeVector;": "\u295D",
  "&RightDownVector;": "\u21C2",
  "&RightDownVectorBar;": "\u2955",
  "&RightFloor;": "\u230B",
  "&RightTee;": "\u22A2",
  "&RightTeeArrow;": "\u21A6",
  "&RightTeeVector;": "\u295B",
  "&RightTriangle;": "\u22B3",
  "&RightTriangleBar;": "\u29D0",
  "&RightTriangleEqual;": "\u22B5",
  "&RightUpDownVector;": "\u294F",
  "&RightUpTeeVector;": "\u295C",
  "&RightUpVector;": "\u21BE",
  "&RightUpVectorBar;": "\u2954",
  "&RightVector;": "\u21C0",
  "&RightVectorBar;": "\u2953",
  "&Rightarrow;": "\u21D2",
  "&Ropf;": "\u211D",
  "&RoundImplies;": "\u2970",
  "&Rrightarrow;": "\u21DB",
  "&Rscr;": "\u211B",
  "&Rsh;": "\u21B1",
  "&RuleDelayed;": "\u29F4",
  "&SHCHcy;": "\u0429",
  "&SHcy;": "\u0428",
  "&SOFTcy;": "\u042C",
  "&Sacute;": "\u015A",
  "&Sc;": "\u2ABC",
  "&Scaron;": "\u0160",
  "&Scedil;": "\u015E",
  "&Scirc;": "\u015C",
  "&Scy;": "\u0421",
  "&Sfr;": "\u{1D516}",
  "&ShortDownArrow;": "\u2193",
  "&ShortLeftArrow;": "\u2190",
  "&ShortRightArrow;": "\u2192",
  "&ShortUpArrow;": "\u2191",
  "&Sigma;": "\u03A3",
  "&SmallCircle;": "\u2218",
  "&Sopf;": "\u{1D54A}",
  "&Sqrt;": "\u221A",
  "&Square;": "\u25A1",
  "&SquareIntersection;": "\u2293",
  "&SquareSubset;": "\u228F",
  "&SquareSubsetEqual;": "\u2291",
  "&SquareSuperset;": "\u2290",
  "&SquareSupersetEqual;": "\u2292",
  "&SquareUnion;": "\u2294",
  "&Sscr;": "\u{1D4AE}",
  "&Star;": "\u22C6",
  "&Sub;": "\u22D0",
  "&Subset;": "\u22D0",
  "&SubsetEqual;": "\u2286",
  "&Succeeds;": "\u227B",
  "&SucceedsEqual;": "\u2AB0",
  "&SucceedsSlantEqual;": "\u227D",
  "&SucceedsTilde;": "\u227F",
  "&SuchThat;": "\u220B",
  "&Sum;": "\u2211",
  "&Sup;": "\u22D1",
  "&Superset;": "\u2283",
  "&SupersetEqual;": "\u2287",
  "&Supset;": "\u22D1",
  "&THORN": "\xDE",
  "&THORN;": "\xDE",
  "&TRADE;": "\u2122",
  "&TSHcy;": "\u040B",
  "&TScy;": "\u0426",
  "&Tab;": "	",
  "&Tau;": "\u03A4",
  "&Tcaron;": "\u0164",
  "&Tcedil;": "\u0162",
  "&Tcy;": "\u0422",
  "&Tfr;": "\u{1D517}",
  "&Therefore;": "\u2234",
  "&Theta;": "\u0398",
  "&ThickSpace;": "\u205F\u200A",
  "&ThinSpace;": "\u2009",
  "&Tilde;": "\u223C",
  "&TildeEqual;": "\u2243",
  "&TildeFullEqual;": "\u2245",
  "&TildeTilde;": "\u2248",
  "&Topf;": "\u{1D54B}",
  "&TripleDot;": "\u20DB",
  "&Tscr;": "\u{1D4AF}",
  "&Tstrok;": "\u0166",
  "&Uacute": "\xDA",
  "&Uacute;": "\xDA",
  "&Uarr;": "\u219F",
  "&Uarrocir;": "\u2949",
  "&Ubrcy;": "\u040E",
  "&Ubreve;": "\u016C",
  "&Ucirc": "\xDB",
  "&Ucirc;": "\xDB",
  "&Ucy;": "\u0423",
  "&Udblac;": "\u0170",
  "&Ufr;": "\u{1D518}",
  "&Ugrave": "\xD9",
  "&Ugrave;": "\xD9",
  "&Umacr;": "\u016A",
  "&UnderBar;": "_",
  "&UnderBrace;": "\u23DF",
  "&UnderBracket;": "\u23B5",
  "&UnderParenthesis;": "\u23DD",
  "&Union;": "\u22C3",
  "&UnionPlus;": "\u228E",
  "&Uogon;": "\u0172",
  "&Uopf;": "\u{1D54C}",
  "&UpArrow;": "\u2191",
  "&UpArrowBar;": "\u2912",
  "&UpArrowDownArrow;": "\u21C5",
  "&UpDownArrow;": "\u2195",
  "&UpEquilibrium;": "\u296E",
  "&UpTee;": "\u22A5",
  "&UpTeeArrow;": "\u21A5",
  "&Uparrow;": "\u21D1",
  "&Updownarrow;": "\u21D5",
  "&UpperLeftArrow;": "\u2196",
  "&UpperRightArrow;": "\u2197",
  "&Upsi;": "\u03D2",
  "&Upsilon;": "\u03A5",
  "&Uring;": "\u016E",
  "&Uscr;": "\u{1D4B0}",
  "&Utilde;": "\u0168",
  "&Uuml": "\xDC",
  "&Uuml;": "\xDC",
  "&VDash;": "\u22AB",
  "&Vbar;": "\u2AEB",
  "&Vcy;": "\u0412",
  "&Vdash;": "\u22A9",
  "&Vdashl;": "\u2AE6",
  "&Vee;": "\u22C1",
  "&Verbar;": "\u2016",
  "&Vert;": "\u2016",
  "&VerticalBar;": "\u2223",
  "&VerticalLine;": "|",
  "&VerticalSeparator;": "\u2758",
  "&VerticalTilde;": "\u2240",
  "&VeryThinSpace;": "\u200A",
  "&Vfr;": "\u{1D519}",
  "&Vopf;": "\u{1D54D}",
  "&Vscr;": "\u{1D4B1}",
  "&Vvdash;": "\u22AA",
  "&Wcirc;": "\u0174",
  "&Wedge;": "\u22C0",
  "&Wfr;": "\u{1D51A}",
  "&Wopf;": "\u{1D54E}",
  "&Wscr;": "\u{1D4B2}",
  "&Xfr;": "\u{1D51B}",
  "&Xi;": "\u039E",
  "&Xopf;": "\u{1D54F}",
  "&Xscr;": "\u{1D4B3}",
  "&YAcy;": "\u042F",
  "&YIcy;": "\u0407",
  "&YUcy;": "\u042E",
  "&Yacute": "\xDD",
  "&Yacute;": "\xDD",
  "&Ycirc;": "\u0176",
  "&Ycy;": "\u042B",
  "&Yfr;": "\u{1D51C}",
  "&Yopf;": "\u{1D550}",
  "&Yscr;": "\u{1D4B4}",
  "&Yuml;": "\u0178",
  "&ZHcy;": "\u0416",
  "&Zacute;": "\u0179",
  "&Zcaron;": "\u017D",
  "&Zcy;": "\u0417",
  "&Zdot;": "\u017B",
  "&ZeroWidthSpace;": "\u200B",
  "&Zeta;": "\u0396",
  "&Zfr;": "\u2128",
  "&Zopf;": "\u2124",
  "&Zscr;": "\u{1D4B5}",
  "&aacute": "\xE1",
  "&aacute;": "\xE1",
  "&abreve;": "\u0103",
  "&ac;": "\u223E",
  "&acE;": "\u223E\u0333",
  "&acd;": "\u223F",
  "&acirc": "\xE2",
  "&acirc;": "\xE2",
  "&acute": "\xB4",
  "&acute;": "\xB4",
  "&acy;": "\u0430",
  "&aelig": "\xE6",
  "&aelig;": "\xE6",
  "&af;": "\u2061",
  "&afr;": "\u{1D51E}",
  "&agrave": "\xE0",
  "&agrave;": "\xE0",
  "&alefsym;": "\u2135",
  "&aleph;": "\u2135",
  "&alpha;": "\u03B1",
  "&amacr;": "\u0101",
  "&amalg;": "\u2A3F",
  "&amp": "&",
  "&amp;": "&",
  "&and;": "\u2227",
  "&andand;": "\u2A55",
  "&andd;": "\u2A5C",
  "&andslope;": "\u2A58",
  "&andv;": "\u2A5A",
  "&ang;": "\u2220",
  "&ange;": "\u29A4",
  "&angle;": "\u2220",
  "&angmsd;": "\u2221",
  "&angmsdaa;": "\u29A8",
  "&angmsdab;": "\u29A9",
  "&angmsdac;": "\u29AA",
  "&angmsdad;": "\u29AB",
  "&angmsdae;": "\u29AC",
  "&angmsdaf;": "\u29AD",
  "&angmsdag;": "\u29AE",
  "&angmsdah;": "\u29AF",
  "&angrt;": "\u221F",
  "&angrtvb;": "\u22BE",
  "&angrtvbd;": "\u299D",
  "&angsph;": "\u2222",
  "&angst;": "\xC5",
  "&angzarr;": "\u237C",
  "&aogon;": "\u0105",
  "&aopf;": "\u{1D552}",
  "&ap;": "\u2248",
  "&apE;": "\u2A70",
  "&apacir;": "\u2A6F",
  "&ape;": "\u224A",
  "&apid;": "\u224B",
  "&apos;": "'",
  "&approx;": "\u2248",
  "&approxeq;": "\u224A",
  "&aring": "\xE5",
  "&aring;": "\xE5",
  "&ascr;": "\u{1D4B6}",
  "&ast;": "*",
  "&asymp;": "\u2248",
  "&asympeq;": "\u224D",
  "&atilde": "\xE3",
  "&atilde;": "\xE3",
  "&auml": "\xE4",
  "&auml;": "\xE4",
  "&awconint;": "\u2233",
  "&awint;": "\u2A11",
  "&bNot;": "\u2AED",
  "&backcong;": "\u224C",
  "&backepsilon;": "\u03F6",
  "&backprime;": "\u2035",
  "&backsim;": "\u223D",
  "&backsimeq;": "\u22CD",
  "&barvee;": "\u22BD",
  "&barwed;": "\u2305",
  "&barwedge;": "\u2305",
  "&bbrk;": "\u23B5",
  "&bbrktbrk;": "\u23B6",
  "&bcong;": "\u224C",
  "&bcy;": "\u0431",
  "&bdquo;": "\u201E",
  "&becaus;": "\u2235",
  "&because;": "\u2235",
  "&bemptyv;": "\u29B0",
  "&bepsi;": "\u03F6",
  "&bernou;": "\u212C",
  "&beta;": "\u03B2",
  "&beth;": "\u2136",
  "&between;": "\u226C",
  "&bfr;": "\u{1D51F}",
  "&bigcap;": "\u22C2",
  "&bigcirc;": "\u25EF",
  "&bigcup;": "\u22C3",
  "&bigodot;": "\u2A00",
  "&bigoplus;": "\u2A01",
  "&bigotimes;": "\u2A02",
  "&bigsqcup;": "\u2A06",
  "&bigstar;": "\u2605",
  "&bigtriangledown;": "\u25BD",
  "&bigtriangleup;": "\u25B3",
  "&biguplus;": "\u2A04",
  "&bigvee;": "\u22C1",
  "&bigwedge;": "\u22C0",
  "&bkarow;": "\u290D",
  "&blacklozenge;": "\u29EB",
  "&blacksquare;": "\u25AA",
  "&blacktriangle;": "\u25B4",
  "&blacktriangledown;": "\u25BE",
  "&blacktriangleleft;": "\u25C2",
  "&blacktriangleright;": "\u25B8",
  "&blank;": "\u2423",
  "&blk12;": "\u2592",
  "&blk14;": "\u2591",
  "&blk34;": "\u2593",
  "&block;": "\u2588",
  "&bne;": "=\u20E5",
  "&bnequiv;": "\u2261\u20E5",
  "&bnot;": "\u2310",
  "&bopf;": "\u{1D553}",
  "&bot;": "\u22A5",
  "&bottom;": "\u22A5",
  "&bowtie;": "\u22C8",
  "&boxDL;": "\u2557",
  "&boxDR;": "\u2554",
  "&boxDl;": "\u2556",
  "&boxDr;": "\u2553",
  "&boxH;": "\u2550",
  "&boxHD;": "\u2566",
  "&boxHU;": "\u2569",
  "&boxHd;": "\u2564",
  "&boxHu;": "\u2567",
  "&boxUL;": "\u255D",
  "&boxUR;": "\u255A",
  "&boxUl;": "\u255C",
  "&boxUr;": "\u2559",
  "&boxV;": "\u2551",
  "&boxVH;": "\u256C",
  "&boxVL;": "\u2563",
  "&boxVR;": "\u2560",
  "&boxVh;": "\u256B",
  "&boxVl;": "\u2562",
  "&boxVr;": "\u255F",
  "&boxbox;": "\u29C9",
  "&boxdL;": "\u2555",
  "&boxdR;": "\u2552",
  "&boxdl;": "\u2510",
  "&boxdr;": "\u250C",
  "&boxh;": "\u2500",
  "&boxhD;": "\u2565",
  "&boxhU;": "\u2568",
  "&boxhd;": "\u252C",
  "&boxhu;": "\u2534",
  "&boxminus;": "\u229F",
  "&boxplus;": "\u229E",
  "&boxtimes;": "\u22A0",
  "&boxuL;": "\u255B",
  "&boxuR;": "\u2558",
  "&boxul;": "\u2518",
  "&boxur;": "\u2514",
  "&boxv;": "\u2502",
  "&boxvH;": "\u256A",
  "&boxvL;": "\u2561",
  "&boxvR;": "\u255E",
  "&boxvh;": "\u253C",
  "&boxvl;": "\u2524",
  "&boxvr;": "\u251C",
  "&bprime;": "\u2035",
  "&breve;": "\u02D8",
  "&brvbar": "\xA6",
  "&brvbar;": "\xA6",
  "&bscr;": "\u{1D4B7}",
  "&bsemi;": "\u204F",
  "&bsim;": "\u223D",
  "&bsime;": "\u22CD",
  "&bsol;": "\\",
  "&bsolb;": "\u29C5",
  "&bsolhsub;": "\u27C8",
  "&bull;": "\u2022",
  "&bullet;": "\u2022",
  "&bump;": "\u224E",
  "&bumpE;": "\u2AAE",
  "&bumpe;": "\u224F",
  "&bumpeq;": "\u224F",
  "&cacute;": "\u0107",
  "&cap;": "\u2229",
  "&capand;": "\u2A44",
  "&capbrcup;": "\u2A49",
  "&capcap;": "\u2A4B",
  "&capcup;": "\u2A47",
  "&capdot;": "\u2A40",
  "&caps;": "\u2229\uFE00",
  "&caret;": "\u2041",
  "&caron;": "\u02C7",
  "&ccaps;": "\u2A4D",
  "&ccaron;": "\u010D",
  "&ccedil": "\xE7",
  "&ccedil;": "\xE7",
  "&ccirc;": "\u0109",
  "&ccups;": "\u2A4C",
  "&ccupssm;": "\u2A50",
  "&cdot;": "\u010B",
  "&cedil": "\xB8",
  "&cedil;": "\xB8",
  "&cemptyv;": "\u29B2",
  "&cent": "\xA2",
  "&cent;": "\xA2",
  "&centerdot;": "\xB7",
  "&cfr;": "\u{1D520}",
  "&chcy;": "\u0447",
  "&check;": "\u2713",
  "&checkmark;": "\u2713",
  "&chi;": "\u03C7",
  "&cir;": "\u25CB",
  "&cirE;": "\u29C3",
  "&circ;": "\u02C6",
  "&circeq;": "\u2257",
  "&circlearrowleft;": "\u21BA",
  "&circlearrowright;": "\u21BB",
  "&circledR;": "\xAE",
  "&circledS;": "\u24C8",
  "&circledast;": "\u229B",
  "&circledcirc;": "\u229A",
  "&circleddash;": "\u229D",
  "&cire;": "\u2257",
  "&cirfnint;": "\u2A10",
  "&cirmid;": "\u2AEF",
  "&cirscir;": "\u29C2",
  "&clubs;": "\u2663",
  "&clubsuit;": "\u2663",
  "&colon;": ":",
  "&colone;": "\u2254",
  "&coloneq;": "\u2254",
  "&comma;": ",",
  "&commat;": "@",
  "&comp;": "\u2201",
  "&compfn;": "\u2218",
  "&complement;": "\u2201",
  "&complexes;": "\u2102",
  "&cong;": "\u2245",
  "&congdot;": "\u2A6D",
  "&conint;": "\u222E",
  "&copf;": "\u{1D554}",
  "&coprod;": "\u2210",
  "&copy": "\xA9",
  "&copy;": "\xA9",
  "&copysr;": "\u2117",
  "&crarr;": "\u21B5",
  "&cross;": "\u2717",
  "&cscr;": "\u{1D4B8}",
  "&csub;": "\u2ACF",
  "&csube;": "\u2AD1",
  "&csup;": "\u2AD0",
  "&csupe;": "\u2AD2",
  "&ctdot;": "\u22EF",
  "&cudarrl;": "\u2938",
  "&cudarrr;": "\u2935",
  "&cuepr;": "\u22DE",
  "&cuesc;": "\u22DF",
  "&cularr;": "\u21B6",
  "&cularrp;": "\u293D",
  "&cup;": "\u222A",
  "&cupbrcap;": "\u2A48",
  "&cupcap;": "\u2A46",
  "&cupcup;": "\u2A4A",
  "&cupdot;": "\u228D",
  "&cupor;": "\u2A45",
  "&cups;": "\u222A\uFE00",
  "&curarr;": "\u21B7",
  "&curarrm;": "\u293C",
  "&curlyeqprec;": "\u22DE",
  "&curlyeqsucc;": "\u22DF",
  "&curlyvee;": "\u22CE",
  "&curlywedge;": "\u22CF",
  "&curren": "\xA4",
  "&curren;": "\xA4",
  "&curvearrowleft;": "\u21B6",
  "&curvearrowright;": "\u21B7",
  "&cuvee;": "\u22CE",
  "&cuwed;": "\u22CF",
  "&cwconint;": "\u2232",
  "&cwint;": "\u2231",
  "&cylcty;": "\u232D",
  "&dArr;": "\u21D3",
  "&dHar;": "\u2965",
  "&dagger;": "\u2020",
  "&daleth;": "\u2138",
  "&darr;": "\u2193",
  "&dash;": "\u2010",
  "&dashv;": "\u22A3",
  "&dbkarow;": "\u290F",
  "&dblac;": "\u02DD",
  "&dcaron;": "\u010F",
  "&dcy;": "\u0434",
  "&dd;": "\u2146",
  "&ddagger;": "\u2021",
  "&ddarr;": "\u21CA",
  "&ddotseq;": "\u2A77",
  "&deg": "\xB0",
  "&deg;": "\xB0",
  "&delta;": "\u03B4",
  "&demptyv;": "\u29B1",
  "&dfisht;": "\u297F",
  "&dfr;": "\u{1D521}",
  "&dharl;": "\u21C3",
  "&dharr;": "\u21C2",
  "&diam;": "\u22C4",
  "&diamond;": "\u22C4",
  "&diamondsuit;": "\u2666",
  "&diams;": "\u2666",
  "&die;": "\xA8",
  "&digamma;": "\u03DD",
  "&disin;": "\u22F2",
  "&div;": "\xF7",
  "&divide": "\xF7",
  "&divide;": "\xF7",
  "&divideontimes;": "\u22C7",
  "&divonx;": "\u22C7",
  "&djcy;": "\u0452",
  "&dlcorn;": "\u231E",
  "&dlcrop;": "\u230D",
  "&dollar;": "$",
  "&dopf;": "\u{1D555}",
  "&dot;": "\u02D9",
  "&doteq;": "\u2250",
  "&doteqdot;": "\u2251",
  "&dotminus;": "\u2238",
  "&dotplus;": "\u2214",
  "&dotsquare;": "\u22A1",
  "&doublebarwedge;": "\u2306",
  "&downarrow;": "\u2193",
  "&downdownarrows;": "\u21CA",
  "&downharpoonleft;": "\u21C3",
  "&downharpoonright;": "\u21C2",
  "&drbkarow;": "\u2910",
  "&drcorn;": "\u231F",
  "&drcrop;": "\u230C",
  "&dscr;": "\u{1D4B9}",
  "&dscy;": "\u0455",
  "&dsol;": "\u29F6",
  "&dstrok;": "\u0111",
  "&dtdot;": "\u22F1",
  "&dtri;": "\u25BF",
  "&dtrif;": "\u25BE",
  "&duarr;": "\u21F5",
  "&duhar;": "\u296F",
  "&dwangle;": "\u29A6",
  "&dzcy;": "\u045F",
  "&dzigrarr;": "\u27FF",
  "&eDDot;": "\u2A77",
  "&eDot;": "\u2251",
  "&eacute": "\xE9",
  "&eacute;": "\xE9",
  "&easter;": "\u2A6E",
  "&ecaron;": "\u011B",
  "&ecir;": "\u2256",
  "&ecirc": "\xEA",
  "&ecirc;": "\xEA",
  "&ecolon;": "\u2255",
  "&ecy;": "\u044D",
  "&edot;": "\u0117",
  "&ee;": "\u2147",
  "&efDot;": "\u2252",
  "&efr;": "\u{1D522}",
  "&eg;": "\u2A9A",
  "&egrave": "\xE8",
  "&egrave;": "\xE8",
  "&egs;": "\u2A96",
  "&egsdot;": "\u2A98",
  "&el;": "\u2A99",
  "&elinters;": "\u23E7",
  "&ell;": "\u2113",
  "&els;": "\u2A95",
  "&elsdot;": "\u2A97",
  "&emacr;": "\u0113",
  "&empty;": "\u2205",
  "&emptyset;": "\u2205",
  "&emptyv;": "\u2205",
  "&emsp13;": "\u2004",
  "&emsp14;": "\u2005",
  "&emsp;": "\u2003",
  "&eng;": "\u014B",
  "&ensp;": "\u2002",
  "&eogon;": "\u0119",
  "&eopf;": "\u{1D556}",
  "&epar;": "\u22D5",
  "&eparsl;": "\u29E3",
  "&eplus;": "\u2A71",
  "&epsi;": "\u03B5",
  "&epsilon;": "\u03B5",
  "&epsiv;": "\u03F5",
  "&eqcirc;": "\u2256",
  "&eqcolon;": "\u2255",
  "&eqsim;": "\u2242",
  "&eqslantgtr;": "\u2A96",
  "&eqslantless;": "\u2A95",
  "&equals;": "=",
  "&equest;": "\u225F",
  "&equiv;": "\u2261",
  "&equivDD;": "\u2A78",
  "&eqvparsl;": "\u29E5",
  "&erDot;": "\u2253",
  "&erarr;": "\u2971",
  "&escr;": "\u212F",
  "&esdot;": "\u2250",
  "&esim;": "\u2242",
  "&eta;": "\u03B7",
  "&eth": "\xF0",
  "&eth;": "\xF0",
  "&euml": "\xEB",
  "&euml;": "\xEB",
  "&euro;": "\u20AC",
  "&excl;": "!",
  "&exist;": "\u2203",
  "&expectation;": "\u2130",
  "&exponentiale;": "\u2147",
  "&fallingdotseq;": "\u2252",
  "&fcy;": "\u0444",
  "&female;": "\u2640",
  "&ffilig;": "\uFB03",
  "&fflig;": "\uFB00",
  "&ffllig;": "\uFB04",
  "&ffr;": "\u{1D523}",
  "&filig;": "\uFB01",
  "&fjlig;": "fj",
  "&flat;": "\u266D",
  "&fllig;": "\uFB02",
  "&fltns;": "\u25B1",
  "&fnof;": "\u0192",
  "&fopf;": "\u{1D557}",
  "&forall;": "\u2200",
  "&fork;": "\u22D4",
  "&forkv;": "\u2AD9",
  "&fpartint;": "\u2A0D",
  "&frac12": "\xBD",
  "&frac12;": "\xBD",
  "&frac13;": "\u2153",
  "&frac14": "\xBC",
  "&frac14;": "\xBC",
  "&frac15;": "\u2155",
  "&frac16;": "\u2159",
  "&frac18;": "\u215B",
  "&frac23;": "\u2154",
  "&frac25;": "\u2156",
  "&frac34": "\xBE",
  "&frac34;": "\xBE",
  "&frac35;": "\u2157",
  "&frac38;": "\u215C",
  "&frac45;": "\u2158",
  "&frac56;": "\u215A",
  "&frac58;": "\u215D",
  "&frac78;": "\u215E",
  "&frasl;": "\u2044",
  "&frown;": "\u2322",
  "&fscr;": "\u{1D4BB}",
  "&gE;": "\u2267",
  "&gEl;": "\u2A8C",
  "&gacute;": "\u01F5",
  "&gamma;": "\u03B3",
  "&gammad;": "\u03DD",
  "&gap;": "\u2A86",
  "&gbreve;": "\u011F",
  "&gcirc;": "\u011D",
  "&gcy;": "\u0433",
  "&gdot;": "\u0121",
  "&ge;": "\u2265",
  "&gel;": "\u22DB",
  "&geq;": "\u2265",
  "&geqq;": "\u2267",
  "&geqslant;": "\u2A7E",
  "&ges;": "\u2A7E",
  "&gescc;": "\u2AA9",
  "&gesdot;": "\u2A80",
  "&gesdoto;": "\u2A82",
  "&gesdotol;": "\u2A84",
  "&gesl;": "\u22DB\uFE00",
  "&gesles;": "\u2A94",
  "&gfr;": "\u{1D524}",
  "&gg;": "\u226B",
  "&ggg;": "\u22D9",
  "&gimel;": "\u2137",
  "&gjcy;": "\u0453",
  "&gl;": "\u2277",
  "&glE;": "\u2A92",
  "&gla;": "\u2AA5",
  "&glj;": "\u2AA4",
  "&gnE;": "\u2269",
  "&gnap;": "\u2A8A",
  "&gnapprox;": "\u2A8A",
  "&gne;": "\u2A88",
  "&gneq;": "\u2A88",
  "&gneqq;": "\u2269",
  "&gnsim;": "\u22E7",
  "&gopf;": "\u{1D558}",
  "&grave;": "`",
  "&gscr;": "\u210A",
  "&gsim;": "\u2273",
  "&gsime;": "\u2A8E",
  "&gsiml;": "\u2A90",
  "&gt": ">",
  "&gt;": ">",
  "&gtcc;": "\u2AA7",
  "&gtcir;": "\u2A7A",
  "&gtdot;": "\u22D7",
  "&gtlPar;": "\u2995",
  "&gtquest;": "\u2A7C",
  "&gtrapprox;": "\u2A86",
  "&gtrarr;": "\u2978",
  "&gtrdot;": "\u22D7",
  "&gtreqless;": "\u22DB",
  "&gtreqqless;": "\u2A8C",
  "&gtrless;": "\u2277",
  "&gtrsim;": "\u2273",
  "&gvertneqq;": "\u2269\uFE00",
  "&gvnE;": "\u2269\uFE00",
  "&hArr;": "\u21D4",
  "&hairsp;": "\u200A",
  "&half;": "\xBD",
  "&hamilt;": "\u210B",
  "&hardcy;": "\u044A",
  "&harr;": "\u2194",
  "&harrcir;": "\u2948",
  "&harrw;": "\u21AD",
  "&hbar;": "\u210F",
  "&hcirc;": "\u0125",
  "&hearts;": "\u2665",
  "&heartsuit;": "\u2665",
  "&hellip;": "\u2026",
  "&hercon;": "\u22B9",
  "&hfr;": "\u{1D525}",
  "&hksearow;": "\u2925",
  "&hkswarow;": "\u2926",
  "&hoarr;": "\u21FF",
  "&homtht;": "\u223B",
  "&hookleftarrow;": "\u21A9",
  "&hookrightarrow;": "\u21AA",
  "&hopf;": "\u{1D559}",
  "&horbar;": "\u2015",
  "&hscr;": "\u{1D4BD}",
  "&hslash;": "\u210F",
  "&hstrok;": "\u0127",
  "&hybull;": "\u2043",
  "&hyphen;": "\u2010",
  "&iacute": "\xED",
  "&iacute;": "\xED",
  "&ic;": "\u2063",
  "&icirc": "\xEE",
  "&icirc;": "\xEE",
  "&icy;": "\u0438",
  "&iecy;": "\u0435",
  "&iexcl": "\xA1",
  "&iexcl;": "\xA1",
  "&iff;": "\u21D4",
  "&ifr;": "\u{1D526}",
  "&igrave": "\xEC",
  "&igrave;": "\xEC",
  "&ii;": "\u2148",
  "&iiiint;": "\u2A0C",
  "&iiint;": "\u222D",
  "&iinfin;": "\u29DC",
  "&iiota;": "\u2129",
  "&ijlig;": "\u0133",
  "&imacr;": "\u012B",
  "&image;": "\u2111",
  "&imagline;": "\u2110",
  "&imagpart;": "\u2111",
  "&imath;": "\u0131",
  "&imof;": "\u22B7",
  "&imped;": "\u01B5",
  "&in;": "\u2208",
  "&incare;": "\u2105",
  "&infin;": "\u221E",
  "&infintie;": "\u29DD",
  "&inodot;": "\u0131",
  "&int;": "\u222B",
  "&intcal;": "\u22BA",
  "&integers;": "\u2124",
  "&intercal;": "\u22BA",
  "&intlarhk;": "\u2A17",
  "&intprod;": "\u2A3C",
  "&iocy;": "\u0451",
  "&iogon;": "\u012F",
  "&iopf;": "\u{1D55A}",
  "&iota;": "\u03B9",
  "&iprod;": "\u2A3C",
  "&iquest": "\xBF",
  "&iquest;": "\xBF",
  "&iscr;": "\u{1D4BE}",
  "&isin;": "\u2208",
  "&isinE;": "\u22F9",
  "&isindot;": "\u22F5",
  "&isins;": "\u22F4",
  "&isinsv;": "\u22F3",
  "&isinv;": "\u2208",
  "&it;": "\u2062",
  "&itilde;": "\u0129",
  "&iukcy;": "\u0456",
  "&iuml": "\xEF",
  "&iuml;": "\xEF",
  "&jcirc;": "\u0135",
  "&jcy;": "\u0439",
  "&jfr;": "\u{1D527}",
  "&jmath;": "\u0237",
  "&jopf;": "\u{1D55B}",
  "&jscr;": "\u{1D4BF}",
  "&jsercy;": "\u0458",
  "&jukcy;": "\u0454",
  "&kappa;": "\u03BA",
  "&kappav;": "\u03F0",
  "&kcedil;": "\u0137",
  "&kcy;": "\u043A",
  "&kfr;": "\u{1D528}",
  "&kgreen;": "\u0138",
  "&khcy;": "\u0445",
  "&kjcy;": "\u045C",
  "&kopf;": "\u{1D55C}",
  "&kscr;": "\u{1D4C0}",
  "&lAarr;": "\u21DA",
  "&lArr;": "\u21D0",
  "&lAtail;": "\u291B",
  "&lBarr;": "\u290E",
  "&lE;": "\u2266",
  "&lEg;": "\u2A8B",
  "&lHar;": "\u2962",
  "&lacute;": "\u013A",
  "&laemptyv;": "\u29B4",
  "&lagran;": "\u2112",
  "&lambda;": "\u03BB",
  "&lang;": "\u27E8",
  "&langd;": "\u2991",
  "&langle;": "\u27E8",
  "&lap;": "\u2A85",
  "&laquo": "\xAB",
  "&laquo;": "\xAB",
  "&larr;": "\u2190",
  "&larrb;": "\u21E4",
  "&larrbfs;": "\u291F",
  "&larrfs;": "\u291D",
  "&larrhk;": "\u21A9",
  "&larrlp;": "\u21AB",
  "&larrpl;": "\u2939",
  "&larrsim;": "\u2973",
  "&larrtl;": "\u21A2",
  "&lat;": "\u2AAB",
  "&latail;": "\u2919",
  "&late;": "\u2AAD",
  "&lates;": "\u2AAD\uFE00",
  "&lbarr;": "\u290C",
  "&lbbrk;": "\u2772",
  "&lbrace;": "{",
  "&lbrack;": "[",
  "&lbrke;": "\u298B",
  "&lbrksld;": "\u298F",
  "&lbrkslu;": "\u298D",
  "&lcaron;": "\u013E",
  "&lcedil;": "\u013C",
  "&lceil;": "\u2308",
  "&lcub;": "{",
  "&lcy;": "\u043B",
  "&ldca;": "\u2936",
  "&ldquo;": "\u201C",
  "&ldquor;": "\u201E",
  "&ldrdhar;": "\u2967",
  "&ldrushar;": "\u294B",
  "&ldsh;": "\u21B2",
  "&le;": "\u2264",
  "&leftarrow;": "\u2190",
  "&leftarrowtail;": "\u21A2",
  "&leftharpoondown;": "\u21BD",
  "&leftharpoonup;": "\u21BC",
  "&leftleftarrows;": "\u21C7",
  "&leftrightarrow;": "\u2194",
  "&leftrightarrows;": "\u21C6",
  "&leftrightharpoons;": "\u21CB",
  "&leftrightsquigarrow;": "\u21AD",
  "&leftthreetimes;": "\u22CB",
  "&leg;": "\u22DA",
  "&leq;": "\u2264",
  "&leqq;": "\u2266",
  "&leqslant;": "\u2A7D",
  "&les;": "\u2A7D",
  "&lescc;": "\u2AA8",
  "&lesdot;": "\u2A7F",
  "&lesdoto;": "\u2A81",
  "&lesdotor;": "\u2A83",
  "&lesg;": "\u22DA\uFE00",
  "&lesges;": "\u2A93",
  "&lessapprox;": "\u2A85",
  "&lessdot;": "\u22D6",
  "&lesseqgtr;": "\u22DA",
  "&lesseqqgtr;": "\u2A8B",
  "&lessgtr;": "\u2276",
  "&lesssim;": "\u2272",
  "&lfisht;": "\u297C",
  "&lfloor;": "\u230A",
  "&lfr;": "\u{1D529}",
  "&lg;": "\u2276",
  "&lgE;": "\u2A91",
  "&lhard;": "\u21BD",
  "&lharu;": "\u21BC",
  "&lharul;": "\u296A",
  "&lhblk;": "\u2584",
  "&ljcy;": "\u0459",
  "&ll;": "\u226A",
  "&llarr;": "\u21C7",
  "&llcorner;": "\u231E",
  "&llhard;": "\u296B",
  "&lltri;": "\u25FA",
  "&lmidot;": "\u0140",
  "&lmoust;": "\u23B0",
  "&lmoustache;": "\u23B0",
  "&lnE;": "\u2268",
  "&lnap;": "\u2A89",
  "&lnapprox;": "\u2A89",
  "&lne;": "\u2A87",
  "&lneq;": "\u2A87",
  "&lneqq;": "\u2268",
  "&lnsim;": "\u22E6",
  "&loang;": "\u27EC",
  "&loarr;": "\u21FD",
  "&lobrk;": "\u27E6",
  "&longleftarrow;": "\u27F5",
  "&longleftrightarrow;": "\u27F7",
  "&longmapsto;": "\u27FC",
  "&longrightarrow;": "\u27F6",
  "&looparrowleft;": "\u21AB",
  "&looparrowright;": "\u21AC",
  "&lopar;": "\u2985",
  "&lopf;": "\u{1D55D}",
  "&loplus;": "\u2A2D",
  "&lotimes;": "\u2A34",
  "&lowast;": "\u2217",
  "&lowbar;": "_",
  "&loz;": "\u25CA",
  "&lozenge;": "\u25CA",
  "&lozf;": "\u29EB",
  "&lpar;": "(",
  "&lparlt;": "\u2993",
  "&lrarr;": "\u21C6",
  "&lrcorner;": "\u231F",
  "&lrhar;": "\u21CB",
  "&lrhard;": "\u296D",
  "&lrm;": "\u200E",
  "&lrtri;": "\u22BF",
  "&lsaquo;": "\u2039",
  "&lscr;": "\u{1D4C1}",
  "&lsh;": "\u21B0",
  "&lsim;": "\u2272",
  "&lsime;": "\u2A8D",
  "&lsimg;": "\u2A8F",
  "&lsqb;": "[",
  "&lsquo;": "\u2018",
  "&lsquor;": "\u201A",
  "&lstrok;": "\u0142",
  "&lt": "<",
  "&lt;": "<",
  "&ltcc;": "\u2AA6",
  "&ltcir;": "\u2A79",
  "&ltdot;": "\u22D6",
  "&lthree;": "\u22CB",
  "&ltimes;": "\u22C9",
  "&ltlarr;": "\u2976",
  "&ltquest;": "\u2A7B",
  "&ltrPar;": "\u2996",
  "&ltri;": "\u25C3",
  "&ltrie;": "\u22B4",
  "&ltrif;": "\u25C2",
  "&lurdshar;": "\u294A",
  "&luruhar;": "\u2966",
  "&lvertneqq;": "\u2268\uFE00",
  "&lvnE;": "\u2268\uFE00",
  "&mDDot;": "\u223A",
  "&macr": "\xAF",
  "&macr;": "\xAF",
  "&male;": "\u2642",
  "&malt;": "\u2720",
  "&maltese;": "\u2720",
  "&map;": "\u21A6",
  "&mapsto;": "\u21A6",
  "&mapstodown;": "\u21A7",
  "&mapstoleft;": "\u21A4",
  "&mapstoup;": "\u21A5",
  "&marker;": "\u25AE",
  "&mcomma;": "\u2A29",
  "&mcy;": "\u043C",
  "&mdash;": "\u2014",
  "&measuredangle;": "\u2221",
  "&mfr;": "\u{1D52A}",
  "&mho;": "\u2127",
  "&micro": "\xB5",
  "&micro;": "\xB5",
  "&mid;": "\u2223",
  "&midast;": "*",
  "&midcir;": "\u2AF0",
  "&middot": "\xB7",
  "&middot;": "\xB7",
  "&minus;": "\u2212",
  "&minusb;": "\u229F",
  "&minusd;": "\u2238",
  "&minusdu;": "\u2A2A",
  "&mlcp;": "\u2ADB",
  "&mldr;": "\u2026",
  "&mnplus;": "\u2213",
  "&models;": "\u22A7",
  "&mopf;": "\u{1D55E}",
  "&mp;": "\u2213",
  "&mscr;": "\u{1D4C2}",
  "&mstpos;": "\u223E",
  "&mu;": "\u03BC",
  "&multimap;": "\u22B8",
  "&mumap;": "\u22B8",
  "&nGg;": "\u22D9\u0338",
  "&nGt;": "\u226B\u20D2",
  "&nGtv;": "\u226B\u0338",
  "&nLeftarrow;": "\u21CD",
  "&nLeftrightarrow;": "\u21CE",
  "&nLl;": "\u22D8\u0338",
  "&nLt;": "\u226A\u20D2",
  "&nLtv;": "\u226A\u0338",
  "&nRightarrow;": "\u21CF",
  "&nVDash;": "\u22AF",
  "&nVdash;": "\u22AE",
  "&nabla;": "\u2207",
  "&nacute;": "\u0144",
  "&nang;": "\u2220\u20D2",
  "&nap;": "\u2249",
  "&napE;": "\u2A70\u0338",
  "&napid;": "\u224B\u0338",
  "&napos;": "\u0149",
  "&napprox;": "\u2249",
  "&natur;": "\u266E",
  "&natural;": "\u266E",
  "&naturals;": "\u2115",
  "&nbsp": "\xA0",
  "&nbsp;": "\xA0",
  "&nbump;": "\u224E\u0338",
  "&nbumpe;": "\u224F\u0338",
  "&ncap;": "\u2A43",
  "&ncaron;": "\u0148",
  "&ncedil;": "\u0146",
  "&ncong;": "\u2247",
  "&ncongdot;": "\u2A6D\u0338",
  "&ncup;": "\u2A42",
  "&ncy;": "\u043D",
  "&ndash;": "\u2013",
  "&ne;": "\u2260",
  "&neArr;": "\u21D7",
  "&nearhk;": "\u2924",
  "&nearr;": "\u2197",
  "&nearrow;": "\u2197",
  "&nedot;": "\u2250\u0338",
  "&nequiv;": "\u2262",
  "&nesear;": "\u2928",
  "&nesim;": "\u2242\u0338",
  "&nexist;": "\u2204",
  "&nexists;": "\u2204",
  "&nfr;": "\u{1D52B}",
  "&ngE;": "\u2267\u0338",
  "&nge;": "\u2271",
  "&ngeq;": "\u2271",
  "&ngeqq;": "\u2267\u0338",
  "&ngeqslant;": "\u2A7E\u0338",
  "&nges;": "\u2A7E\u0338",
  "&ngsim;": "\u2275",
  "&ngt;": "\u226F",
  "&ngtr;": "\u226F",
  "&nhArr;": "\u21CE",
  "&nharr;": "\u21AE",
  "&nhpar;": "\u2AF2",
  "&ni;": "\u220B",
  "&nis;": "\u22FC",
  "&nisd;": "\u22FA",
  "&niv;": "\u220B",
  "&njcy;": "\u045A",
  "&nlArr;": "\u21CD",
  "&nlE;": "\u2266\u0338",
  "&nlarr;": "\u219A",
  "&nldr;": "\u2025",
  "&nle;": "\u2270",
  "&nleftarrow;": "\u219A",
  "&nleftrightarrow;": "\u21AE",
  "&nleq;": "\u2270",
  "&nleqq;": "\u2266\u0338",
  "&nleqslant;": "\u2A7D\u0338",
  "&nles;": "\u2A7D\u0338",
  "&nless;": "\u226E",
  "&nlsim;": "\u2274",
  "&nlt;": "\u226E",
  "&nltri;": "\u22EA",
  "&nltrie;": "\u22EC",
  "&nmid;": "\u2224",
  "&nopf;": "\u{1D55F}",
  "&not": "\xAC",
  "&not;": "\xAC",
  "&notin;": "\u2209",
  "&notinE;": "\u22F9\u0338",
  "&notindot;": "\u22F5\u0338",
  "&notinva;": "\u2209",
  "&notinvb;": "\u22F7",
  "&notinvc;": "\u22F6",
  "&notni;": "\u220C",
  "&notniva;": "\u220C",
  "&notnivb;": "\u22FE",
  "&notnivc;": "\u22FD",
  "&npar;": "\u2226",
  "&nparallel;": "\u2226",
  "&nparsl;": "\u2AFD\u20E5",
  "&npart;": "\u2202\u0338",
  "&npolint;": "\u2A14",
  "&npr;": "\u2280",
  "&nprcue;": "\u22E0",
  "&npre;": "\u2AAF\u0338",
  "&nprec;": "\u2280",
  "&npreceq;": "\u2AAF\u0338",
  "&nrArr;": "\u21CF",
  "&nrarr;": "\u219B",
  "&nrarrc;": "\u2933\u0338",
  "&nrarrw;": "\u219D\u0338",
  "&nrightarrow;": "\u219B",
  "&nrtri;": "\u22EB",
  "&nrtrie;": "\u22ED",
  "&nsc;": "\u2281",
  "&nsccue;": "\u22E1",
  "&nsce;": "\u2AB0\u0338",
  "&nscr;": "\u{1D4C3}",
  "&nshortmid;": "\u2224",
  "&nshortparallel;": "\u2226",
  "&nsim;": "\u2241",
  "&nsime;": "\u2244",
  "&nsimeq;": "\u2244",
  "&nsmid;": "\u2224",
  "&nspar;": "\u2226",
  "&nsqsube;": "\u22E2",
  "&nsqsupe;": "\u22E3",
  "&nsub;": "\u2284",
  "&nsubE;": "\u2AC5\u0338",
  "&nsube;": "\u2288",
  "&nsubset;": "\u2282\u20D2",
  "&nsubseteq;": "\u2288",
  "&nsubseteqq;": "\u2AC5\u0338",
  "&nsucc;": "\u2281",
  "&nsucceq;": "\u2AB0\u0338",
  "&nsup;": "\u2285",
  "&nsupE;": "\u2AC6\u0338",
  "&nsupe;": "\u2289",
  "&nsupset;": "\u2283\u20D2",
  "&nsupseteq;": "\u2289",
  "&nsupseteqq;": "\u2AC6\u0338",
  "&ntgl;": "\u2279",
  "&ntilde": "\xF1",
  "&ntilde;": "\xF1",
  "&ntlg;": "\u2278",
  "&ntriangleleft;": "\u22EA",
  "&ntrianglelefteq;": "\u22EC",
  "&ntriangleright;": "\u22EB",
  "&ntrianglerighteq;": "\u22ED",
  "&nu;": "\u03BD",
  "&num;": "#",
  "&numero;": "\u2116",
  "&numsp;": "\u2007",
  "&nvDash;": "\u22AD",
  "&nvHarr;": "\u2904",
  "&nvap;": "\u224D\u20D2",
  "&nvdash;": "\u22AC",
  "&nvge;": "\u2265\u20D2",
  "&nvgt;": ">\u20D2",
  "&nvinfin;": "\u29DE",
  "&nvlArr;": "\u2902",
  "&nvle;": "\u2264\u20D2",
  "&nvlt;": "<\u20D2",
  "&nvltrie;": "\u22B4\u20D2",
  "&nvrArr;": "\u2903",
  "&nvrtrie;": "\u22B5\u20D2",
  "&nvsim;": "\u223C\u20D2",
  "&nwArr;": "\u21D6",
  "&nwarhk;": "\u2923",
  "&nwarr;": "\u2196",
  "&nwarrow;": "\u2196",
  "&nwnear;": "\u2927",
  "&oS;": "\u24C8",
  "&oacute": "\xF3",
  "&oacute;": "\xF3",
  "&oast;": "\u229B",
  "&ocir;": "\u229A",
  "&ocirc": "\xF4",
  "&ocirc;": "\xF4",
  "&ocy;": "\u043E",
  "&odash;": "\u229D",
  "&odblac;": "\u0151",
  "&odiv;": "\u2A38",
  "&odot;": "\u2299",
  "&odsold;": "\u29BC",
  "&oelig;": "\u0153",
  "&ofcir;": "\u29BF",
  "&ofr;": "\u{1D52C}",
  "&ogon;": "\u02DB",
  "&ograve": "\xF2",
  "&ograve;": "\xF2",
  "&ogt;": "\u29C1",
  "&ohbar;": "\u29B5",
  "&ohm;": "\u03A9",
  "&oint;": "\u222E",
  "&olarr;": "\u21BA",
  "&olcir;": "\u29BE",
  "&olcross;": "\u29BB",
  "&oline;": "\u203E",
  "&olt;": "\u29C0",
  "&omacr;": "\u014D",
  "&omega;": "\u03C9",
  "&omicron;": "\u03BF",
  "&omid;": "\u29B6",
  "&ominus;": "\u2296",
  "&oopf;": "\u{1D560}",
  "&opar;": "\u29B7",
  "&operp;": "\u29B9",
  "&oplus;": "\u2295",
  "&or;": "\u2228",
  "&orarr;": "\u21BB",
  "&ord;": "\u2A5D",
  "&order;": "\u2134",
  "&orderof;": "\u2134",
  "&ordf": "\xAA",
  "&ordf;": "\xAA",
  "&ordm": "\xBA",
  "&ordm;": "\xBA",
  "&origof;": "\u22B6",
  "&oror;": "\u2A56",
  "&orslope;": "\u2A57",
  "&orv;": "\u2A5B",
  "&oscr;": "\u2134",
  "&oslash": "\xF8",
  "&oslash;": "\xF8",
  "&osol;": "\u2298",
  "&otilde": "\xF5",
  "&otilde;": "\xF5",
  "&otimes;": "\u2297",
  "&otimesas;": "\u2A36",
  "&ouml": "\xF6",
  "&ouml;": "\xF6",
  "&ovbar;": "\u233D",
  "&par;": "\u2225",
  "&para": "\xB6",
  "&para;": "\xB6",
  "&parallel;": "\u2225",
  "&parsim;": "\u2AF3",
  "&parsl;": "\u2AFD",
  "&part;": "\u2202",
  "&pcy;": "\u043F",
  "&percnt;": "%",
  "&period;": ".",
  "&permil;": "\u2030",
  "&perp;": "\u22A5",
  "&pertenk;": "\u2031",
  "&pfr;": "\u{1D52D}",
  "&phi;": "\u03C6",
  "&phiv;": "\u03D5",
  "&phmmat;": "\u2133",
  "&phone;": "\u260E",
  "&pi;": "\u03C0",
  "&pitchfork;": "\u22D4",
  "&piv;": "\u03D6",
  "&planck;": "\u210F",
  "&planckh;": "\u210E",
  "&plankv;": "\u210F",
  "&plus;": "+",
  "&plusacir;": "\u2A23",
  "&plusb;": "\u229E",
  "&pluscir;": "\u2A22",
  "&plusdo;": "\u2214",
  "&plusdu;": "\u2A25",
  "&pluse;": "\u2A72",
  "&plusmn": "\xB1",
  "&plusmn;": "\xB1",
  "&plussim;": "\u2A26",
  "&plustwo;": "\u2A27",
  "&pm;": "\xB1",
  "&pointint;": "\u2A15",
  "&popf;": "\u{1D561}",
  "&pound": "\xA3",
  "&pound;": "\xA3",
  "&pr;": "\u227A",
  "&prE;": "\u2AB3",
  "&prap;": "\u2AB7",
  "&prcue;": "\u227C",
  "&pre;": "\u2AAF",
  "&prec;": "\u227A",
  "&precapprox;": "\u2AB7",
  "&preccurlyeq;": "\u227C",
  "&preceq;": "\u2AAF",
  "&precnapprox;": "\u2AB9",
  "&precneqq;": "\u2AB5",
  "&precnsim;": "\u22E8",
  "&precsim;": "\u227E",
  "&prime;": "\u2032",
  "&primes;": "\u2119",
  "&prnE;": "\u2AB5",
  "&prnap;": "\u2AB9",
  "&prnsim;": "\u22E8",
  "&prod;": "\u220F",
  "&profalar;": "\u232E",
  "&profline;": "\u2312",
  "&profsurf;": "\u2313",
  "&prop;": "\u221D",
  "&propto;": "\u221D",
  "&prsim;": "\u227E",
  "&prurel;": "\u22B0",
  "&pscr;": "\u{1D4C5}",
  "&psi;": "\u03C8",
  "&puncsp;": "\u2008",
  "&qfr;": "\u{1D52E}",
  "&qint;": "\u2A0C",
  "&qopf;": "\u{1D562}",
  "&qprime;": "\u2057",
  "&qscr;": "\u{1D4C6}",
  "&quaternions;": "\u210D",
  "&quatint;": "\u2A16",
  "&quest;": "?",
  "&questeq;": "\u225F",
  "&quot": '"',
  "&quot;": '"',
  "&rAarr;": "\u21DB",
  "&rArr;": "\u21D2",
  "&rAtail;": "\u291C",
  "&rBarr;": "\u290F",
  "&rHar;": "\u2964",
  "&race;": "\u223D\u0331",
  "&racute;": "\u0155",
  "&radic;": "\u221A",
  "&raemptyv;": "\u29B3",
  "&rang;": "\u27E9",
  "&rangd;": "\u2992",
  "&range;": "\u29A5",
  "&rangle;": "\u27E9",
  "&raquo": "\xBB",
  "&raquo;": "\xBB",
  "&rarr;": "\u2192",
  "&rarrap;": "\u2975",
  "&rarrb;": "\u21E5",
  "&rarrbfs;": "\u2920",
  "&rarrc;": "\u2933",
  "&rarrfs;": "\u291E",
  "&rarrhk;": "\u21AA",
  "&rarrlp;": "\u21AC",
  "&rarrpl;": "\u2945",
  "&rarrsim;": "\u2974",
  "&rarrtl;": "\u21A3",
  "&rarrw;": "\u219D",
  "&ratail;": "\u291A",
  "&ratio;": "\u2236",
  "&rationals;": "\u211A",
  "&rbarr;": "\u290D",
  "&rbbrk;": "\u2773",
  "&rbrace;": "}",
  "&rbrack;": "]",
  "&rbrke;": "\u298C",
  "&rbrksld;": "\u298E",
  "&rbrkslu;": "\u2990",
  "&rcaron;": "\u0159",
  "&rcedil;": "\u0157",
  "&rceil;": "\u2309",
  "&rcub;": "}",
  "&rcy;": "\u0440",
  "&rdca;": "\u2937",
  "&rdldhar;": "\u2969",
  "&rdquo;": "\u201D",
  "&rdquor;": "\u201D",
  "&rdsh;": "\u21B3",
  "&real;": "\u211C",
  "&realine;": "\u211B",
  "&realpart;": "\u211C",
  "&reals;": "\u211D",
  "&rect;": "\u25AD",
  "&reg": "\xAE",
  "&reg;": "\xAE",
  "&rfisht;": "\u297D",
  "&rfloor;": "\u230B",
  "&rfr;": "\u{1D52F}",
  "&rhard;": "\u21C1",
  "&rharu;": "\u21C0",
  "&rharul;": "\u296C",
  "&rho;": "\u03C1",
  "&rhov;": "\u03F1",
  "&rightarrow;": "\u2192",
  "&rightarrowtail;": "\u21A3",
  "&rightharpoondown;": "\u21C1",
  "&rightharpoonup;": "\u21C0",
  "&rightleftarrows;": "\u21C4",
  "&rightleftharpoons;": "\u21CC",
  "&rightrightarrows;": "\u21C9",
  "&rightsquigarrow;": "\u219D",
  "&rightthreetimes;": "\u22CC",
  "&ring;": "\u02DA",
  "&risingdotseq;": "\u2253",
  "&rlarr;": "\u21C4",
  "&rlhar;": "\u21CC",
  "&rlm;": "\u200F",
  "&rmoust;": "\u23B1",
  "&rmoustache;": "\u23B1",
  "&rnmid;": "\u2AEE",
  "&roang;": "\u27ED",
  "&roarr;": "\u21FE",
  "&robrk;": "\u27E7",
  "&ropar;": "\u2986",
  "&ropf;": "\u{1D563}",
  "&roplus;": "\u2A2E",
  "&rotimes;": "\u2A35",
  "&rpar;": ")",
  "&rpargt;": "\u2994",
  "&rppolint;": "\u2A12",
  "&rrarr;": "\u21C9",
  "&rsaquo;": "\u203A",
  "&rscr;": "\u{1D4C7}",
  "&rsh;": "\u21B1",
  "&rsqb;": "]",
  "&rsquo;": "\u2019",
  "&rsquor;": "\u2019",
  "&rthree;": "\u22CC",
  "&rtimes;": "\u22CA",
  "&rtri;": "\u25B9",
  "&rtrie;": "\u22B5",
  "&rtrif;": "\u25B8",
  "&rtriltri;": "\u29CE",
  "&ruluhar;": "\u2968",
  "&rx;": "\u211E",
  "&sacute;": "\u015B",
  "&sbquo;": "\u201A",
  "&sc;": "\u227B",
  "&scE;": "\u2AB4",
  "&scap;": "\u2AB8",
  "&scaron;": "\u0161",
  "&sccue;": "\u227D",
  "&sce;": "\u2AB0",
  "&scedil;": "\u015F",
  "&scirc;": "\u015D",
  "&scnE;": "\u2AB6",
  "&scnap;": "\u2ABA",
  "&scnsim;": "\u22E9",
  "&scpolint;": "\u2A13",
  "&scsim;": "\u227F",
  "&scy;": "\u0441",
  "&sdot;": "\u22C5",
  "&sdotb;": "\u22A1",
  "&sdote;": "\u2A66",
  "&seArr;": "\u21D8",
  "&searhk;": "\u2925",
  "&searr;": "\u2198",
  "&searrow;": "\u2198",
  "&sect": "\xA7",
  "&sect;": "\xA7",
  "&semi;": ";",
  "&seswar;": "\u2929",
  "&setminus;": "\u2216",
  "&setmn;": "\u2216",
  "&sext;": "\u2736",
  "&sfr;": "\u{1D530}",
  "&sfrown;": "\u2322",
  "&sharp;": "\u266F",
  "&shchcy;": "\u0449",
  "&shcy;": "\u0448",
  "&shortmid;": "\u2223",
  "&shortparallel;": "\u2225",
  "&shy": "\xAD",
  "&shy;": "\xAD",
  "&sigma;": "\u03C3",
  "&sigmaf;": "\u03C2",
  "&sigmav;": "\u03C2",
  "&sim;": "\u223C",
  "&simdot;": "\u2A6A",
  "&sime;": "\u2243",
  "&simeq;": "\u2243",
  "&simg;": "\u2A9E",
  "&simgE;": "\u2AA0",
  "&siml;": "\u2A9D",
  "&simlE;": "\u2A9F",
  "&simne;": "\u2246",
  "&simplus;": "\u2A24",
  "&simrarr;": "\u2972",
  "&slarr;": "\u2190",
  "&smallsetminus;": "\u2216",
  "&smashp;": "\u2A33",
  "&smeparsl;": "\u29E4",
  "&smid;": "\u2223",
  "&smile;": "\u2323",
  "&smt;": "\u2AAA",
  "&smte;": "\u2AAC",
  "&smtes;": "\u2AAC\uFE00",
  "&softcy;": "\u044C",
  "&sol;": "/",
  "&solb;": "\u29C4",
  "&solbar;": "\u233F",
  "&sopf;": "\u{1D564}",
  "&spades;": "\u2660",
  "&spadesuit;": "\u2660",
  "&spar;": "\u2225",
  "&sqcap;": "\u2293",
  "&sqcaps;": "\u2293\uFE00",
  "&sqcup;": "\u2294",
  "&sqcups;": "\u2294\uFE00",
  "&sqsub;": "\u228F",
  "&sqsube;": "\u2291",
  "&sqsubset;": "\u228F",
  "&sqsubseteq;": "\u2291",
  "&sqsup;": "\u2290",
  "&sqsupe;": "\u2292",
  "&sqsupset;": "\u2290",
  "&sqsupseteq;": "\u2292",
  "&squ;": "\u25A1",
  "&square;": "\u25A1",
  "&squarf;": "\u25AA",
  "&squf;": "\u25AA",
  "&srarr;": "\u2192",
  "&sscr;": "\u{1D4C8}",
  "&ssetmn;": "\u2216",
  "&ssmile;": "\u2323",
  "&sstarf;": "\u22C6",
  "&star;": "\u2606",
  "&starf;": "\u2605",
  "&straightepsilon;": "\u03F5",
  "&straightphi;": "\u03D5",
  "&strns;": "\xAF",
  "&sub;": "\u2282",
  "&subE;": "\u2AC5",
  "&subdot;": "\u2ABD",
  "&sube;": "\u2286",
  "&subedot;": "\u2AC3",
  "&submult;": "\u2AC1",
  "&subnE;": "\u2ACB",
  "&subne;": "\u228A",
  "&subplus;": "\u2ABF",
  "&subrarr;": "\u2979",
  "&subset;": "\u2282",
  "&subseteq;": "\u2286",
  "&subseteqq;": "\u2AC5",
  "&subsetneq;": "\u228A",
  "&subsetneqq;": "\u2ACB",
  "&subsim;": "\u2AC7",
  "&subsub;": "\u2AD5",
  "&subsup;": "\u2AD3",
  "&succ;": "\u227B",
  "&succapprox;": "\u2AB8",
  "&succcurlyeq;": "\u227D",
  "&succeq;": "\u2AB0",
  "&succnapprox;": "\u2ABA",
  "&succneqq;": "\u2AB6",
  "&succnsim;": "\u22E9",
  "&succsim;": "\u227F",
  "&sum;": "\u2211",
  "&sung;": "\u266A",
  "&sup1": "\xB9",
  "&sup1;": "\xB9",
  "&sup2": "\xB2",
  "&sup2;": "\xB2",
  "&sup3": "\xB3",
  "&sup3;": "\xB3",
  "&sup;": "\u2283",
  "&supE;": "\u2AC6",
  "&supdot;": "\u2ABE",
  "&supdsub;": "\u2AD8",
  "&supe;": "\u2287",
  "&supedot;": "\u2AC4",
  "&suphsol;": "\u27C9",
  "&suphsub;": "\u2AD7",
  "&suplarr;": "\u297B",
  "&supmult;": "\u2AC2",
  "&supnE;": "\u2ACC",
  "&supne;": "\u228B",
  "&supplus;": "\u2AC0",
  "&supset;": "\u2283",
  "&supseteq;": "\u2287",
  "&supseteqq;": "\u2AC6",
  "&supsetneq;": "\u228B",
  "&supsetneqq;": "\u2ACC",
  "&supsim;": "\u2AC8",
  "&supsub;": "\u2AD4",
  "&supsup;": "\u2AD6",
  "&swArr;": "\u21D9",
  "&swarhk;": "\u2926",
  "&swarr;": "\u2199",
  "&swarrow;": "\u2199",
  "&swnwar;": "\u292A",
  "&szlig": "\xDF",
  "&szlig;": "\xDF",
  "&target;": "\u2316",
  "&tau;": "\u03C4",
  "&tbrk;": "\u23B4",
  "&tcaron;": "\u0165",
  "&tcedil;": "\u0163",
  "&tcy;": "\u0442",
  "&tdot;": "\u20DB",
  "&telrec;": "\u2315",
  "&tfr;": "\u{1D531}",
  "&there4;": "\u2234",
  "&therefore;": "\u2234",
  "&theta;": "\u03B8",
  "&thetasym;": "\u03D1",
  "&thetav;": "\u03D1",
  "&thickapprox;": "\u2248",
  "&thicksim;": "\u223C",
  "&thinsp;": "\u2009",
  "&thkap;": "\u2248",
  "&thksim;": "\u223C",
  "&thorn": "\xFE",
  "&thorn;": "\xFE",
  "&tilde;": "\u02DC",
  "&times": "\xD7",
  "&times;": "\xD7",
  "&timesb;": "\u22A0",
  "&timesbar;": "\u2A31",
  "&timesd;": "\u2A30",
  "&tint;": "\u222D",
  "&toea;": "\u2928",
  "&top;": "\u22A4",
  "&topbot;": "\u2336",
  "&topcir;": "\u2AF1",
  "&topf;": "\u{1D565}",
  "&topfork;": "\u2ADA",
  "&tosa;": "\u2929",
  "&tprime;": "\u2034",
  "&trade;": "\u2122",
  "&triangle;": "\u25B5",
  "&triangledown;": "\u25BF",
  "&triangleleft;": "\u25C3",
  "&trianglelefteq;": "\u22B4",
  "&triangleq;": "\u225C",
  "&triangleright;": "\u25B9",
  "&trianglerighteq;": "\u22B5",
  "&tridot;": "\u25EC",
  "&trie;": "\u225C",
  "&triminus;": "\u2A3A",
  "&triplus;": "\u2A39",
  "&trisb;": "\u29CD",
  "&tritime;": "\u2A3B",
  "&trpezium;": "\u23E2",
  "&tscr;": "\u{1D4C9}",
  "&tscy;": "\u0446",
  "&tshcy;": "\u045B",
  "&tstrok;": "\u0167",
  "&twixt;": "\u226C",
  "&twoheadleftarrow;": "\u219E",
  "&twoheadrightarrow;": "\u21A0",
  "&uArr;": "\u21D1",
  "&uHar;": "\u2963",
  "&uacute": "\xFA",
  "&uacute;": "\xFA",
  "&uarr;": "\u2191",
  "&ubrcy;": "\u045E",
  "&ubreve;": "\u016D",
  "&ucirc": "\xFB",
  "&ucirc;": "\xFB",
  "&ucy;": "\u0443",
  "&udarr;": "\u21C5",
  "&udblac;": "\u0171",
  "&udhar;": "\u296E",
  "&ufisht;": "\u297E",
  "&ufr;": "\u{1D532}",
  "&ugrave": "\xF9",
  "&ugrave;": "\xF9",
  "&uharl;": "\u21BF",
  "&uharr;": "\u21BE",
  "&uhblk;": "\u2580",
  "&ulcorn;": "\u231C",
  "&ulcorner;": "\u231C",
  "&ulcrop;": "\u230F",
  "&ultri;": "\u25F8",
  "&umacr;": "\u016B",
  "&uml": "\xA8",
  "&uml;": "\xA8",
  "&uogon;": "\u0173",
  "&uopf;": "\u{1D566}",
  "&uparrow;": "\u2191",
  "&updownarrow;": "\u2195",
  "&upharpoonleft;": "\u21BF",
  "&upharpoonright;": "\u21BE",
  "&uplus;": "\u228E",
  "&upsi;": "\u03C5",
  "&upsih;": "\u03D2",
  "&upsilon;": "\u03C5",
  "&upuparrows;": "\u21C8",
  "&urcorn;": "\u231D",
  "&urcorner;": "\u231D",
  "&urcrop;": "\u230E",
  "&uring;": "\u016F",
  "&urtri;": "\u25F9",
  "&uscr;": "\u{1D4CA}",
  "&utdot;": "\u22F0",
  "&utilde;": "\u0169",
  "&utri;": "\u25B5",
  "&utrif;": "\u25B4",
  "&uuarr;": "\u21C8",
  "&uuml": "\xFC",
  "&uuml;": "\xFC",
  "&uwangle;": "\u29A7",
  "&vArr;": "\u21D5",
  "&vBar;": "\u2AE8",
  "&vBarv;": "\u2AE9",
  "&vDash;": "\u22A8",
  "&vangrt;": "\u299C",
  "&varepsilon;": "\u03F5",
  "&varkappa;": "\u03F0",
  "&varnothing;": "\u2205",
  "&varphi;": "\u03D5",
  "&varpi;": "\u03D6",
  "&varpropto;": "\u221D",
  "&varr;": "\u2195",
  "&varrho;": "\u03F1",
  "&varsigma;": "\u03C2",
  "&varsubsetneq;": "\u228A\uFE00",
  "&varsubsetneqq;": "\u2ACB\uFE00",
  "&varsupsetneq;": "\u228B\uFE00",
  "&varsupsetneqq;": "\u2ACC\uFE00",
  "&vartheta;": "\u03D1",
  "&vartriangleleft;": "\u22B2",
  "&vartriangleright;": "\u22B3",
  "&vcy;": "\u0432",
  "&vdash;": "\u22A2",
  "&vee;": "\u2228",
  "&veebar;": "\u22BB",
  "&veeeq;": "\u225A",
  "&vellip;": "\u22EE",
  "&verbar;": "|",
  "&vert;": "|",
  "&vfr;": "\u{1D533}",
  "&vltri;": "\u22B2",
  "&vnsub;": "\u2282\u20D2",
  "&vnsup;": "\u2283\u20D2",
  "&vopf;": "\u{1D567}",
  "&vprop;": "\u221D",
  "&vrtri;": "\u22B3",
  "&vscr;": "\u{1D4CB}",
  "&vsubnE;": "\u2ACB\uFE00",
  "&vsubne;": "\u228A\uFE00",
  "&vsupnE;": "\u2ACC\uFE00",
  "&vsupne;": "\u228B\uFE00",
  "&vzigzag;": "\u299A",
  "&wcirc;": "\u0175",
  "&wedbar;": "\u2A5F",
  "&wedge;": "\u2227",
  "&wedgeq;": "\u2259",
  "&weierp;": "\u2118",
  "&wfr;": "\u{1D534}",
  "&wopf;": "\u{1D568}",
  "&wp;": "\u2118",
  "&wr;": "\u2240",
  "&wreath;": "\u2240",
  "&wscr;": "\u{1D4CC}",
  "&xcap;": "\u22C2",
  "&xcirc;": "\u25EF",
  "&xcup;": "\u22C3",
  "&xdtri;": "\u25BD",
  "&xfr;": "\u{1D535}",
  "&xhArr;": "\u27FA",
  "&xharr;": "\u27F7",
  "&xi;": "\u03BE",
  "&xlArr;": "\u27F8",
  "&xlarr;": "\u27F5",
  "&xmap;": "\u27FC",
  "&xnis;": "\u22FB",
  "&xodot;": "\u2A00",
  "&xopf;": "\u{1D569}",
  "&xoplus;": "\u2A01",
  "&xotime;": "\u2A02",
  "&xrArr;": "\u27F9",
  "&xrarr;": "\u27F6",
  "&xscr;": "\u{1D4CD}",
  "&xsqcup;": "\u2A06",
  "&xuplus;": "\u2A04",
  "&xutri;": "\u25B3",
  "&xvee;": "\u22C1",
  "&xwedge;": "\u22C0",
  "&yacute": "\xFD",
  "&yacute;": "\xFD",
  "&yacy;": "\u044F",
  "&ycirc;": "\u0177",
  "&ycy;": "\u044B",
  "&yen": "\xA5",
  "&yen;": "\xA5",
  "&yfr;": "\u{1D536}",
  "&yicy;": "\u0457",
  "&yopf;": "\u{1D56A}",
  "&yscr;": "\u{1D4CE}",
  "&yucy;": "\u044E",
  "&yuml": "\xFF",
  "&yuml;": "\xFF",
  "&zacute;": "\u017A",
  "&zcaron;": "\u017E",
  "&zcy;": "\u0437",
  "&zdot;": "\u017C",
  "&zeetrf;": "\u2128",
  "&zeta;": "\u03B6",
  "&zfr;": "\u{1D537}",
  "&zhcy;": "\u0436",
  "&zigrarr;": "\u21DD",
  "&zopf;": "\u{1D56B}",
  "&zscr;": "\u{1D4CF}",
  "&zwj;": "\u200D",
  "&zwnj;": "\u200C"
};

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/text-format.js
var C1_ENTITY_REPLACEMENTS = /* @__PURE__ */ new Map([
  [128, 8364],
  [130, 8218],
  [131, 402],
  [132, 8222],
  [133, 8230],
  [134, 8224],
  [135, 8225],
  [136, 710],
  [137, 8240],
  [138, 352],
  [139, 8249],
  [140, 338],
  [142, 381],
  [145, 8216],
  [146, 8217],
  [147, 8220],
  [148, 8221],
  [149, 8226],
  [150, 8211],
  [151, 8212],
  [152, 732],
  [153, 8482],
  [154, 353],
  [155, 8250],
  [156, 339],
  [158, 382],
  [159, 376]
]);
function decodeHTMLEntities(str2) {
  return str2.replace(/&(#\d+|#x[a-f0-9]+|[a-z]+\d*);?/gi, (match2, entity) => {
    if (typeof htmlEntities[match2] === "string") {
      return htmlEntities[match2];
    }
    if (entity.charAt(0) !== "#" || match2.charAt(match2.length - 1) !== ";") {
      return match2;
    }
    let codePoint;
    if (entity.charAt(1).toLowerCase() === "x") {
      codePoint = parseInt(entity.slice(2), 16);
    } else {
      codePoint = parseInt(entity.slice(1), 10);
    }
    let output = "";
    if (codePoint === 0 || codePoint >= 55296 && codePoint <= 57343 || codePoint > 1114111) {
      return "\uFFFD";
    }
    codePoint = C1_ENTITY_REPLACEMENTS.get(codePoint) ?? codePoint;
    if (codePoint > 65535) {
      codePoint -= 65536;
      output += String.fromCharCode(codePoint >>> 10 & 1023 | 55296);
      codePoint = 56320 | codePoint & 1023;
    }
    output += String.fromCharCode(codePoint);
    return output;
  });
}
var hexByte = (value) => value.toString(16).toUpperCase().padStart(2, "0");
function escapeHtml(str2) {
  return str2.trim().replace(/[<>"'?&]/g, (c) => "&#x" + hexByte(c.charCodeAt(0)) + ";");
}
var MAILTO_UNSAFE = /[^A-Za-z0-9\-._~!$'()*+,;:@]+/g;
var PERCENT_ENCODED = Array.from({ length: 256 }, (_, byte) => "%" + hexByte(byte));
function encodeMailto(address) {
  return address.replace(MAILTO_UNSAFE, (run) => Array.from(textEncoder.encode(run), (byte) => PERCENT_ENCODED[byte]).join(""));
}
function textToHtml(str2) {
  let html = escapeHtml(str2).replace(/\n/g, "<br />");
  return "<div>" + html + "</div>";
}
function createFinder(str2, regex) {
  let searchedFrom = Infinity;
  let found = null;
  return (pos) => {
    if (pos < searchedFrom || found && pos > found.index) {
      regex.lastIndex = pos;
      found = regex.exec(str2);
      searchedFrom = pos;
    }
    return found;
  };
}
function throughLastTag(str2, process) {
  const end = str2.lastIndexOf(">") + 1;
  return process(str2.slice(0, end)) + str2.slice(end);
}
function replaceClosedTags(str2, pattern, replacement) {
  return throughLastTag(str2, (head) => head.replace(pattern, replacement));
}
function replaceTags(str2, prefix, pattern, replacement) {
  const parts = [];
  let copied = 0;
  let searchFrom = 0;
  while (true) {
    prefix.lastIndex = searchFrom;
    const candidate = prefix.exec(str2);
    if (!candidate) {
      break;
    }
    const start = candidate.index;
    const gt = str2.indexOf(">", start);
    if (gt < 0) {
      break;
    }
    pattern.lastIndex = start;
    const match2 = pattern.exec(str2);
    if (!match2) {
      searchFrom = gt + 1;
      continue;
    }
    parts.push(str2.slice(copied, start), replacement(...match2));
    copied = searchFrom = start + match2[0].length;
  }
  parts.push(str2.slice(copied));
  return parts.join("");
}
function replaceBlocks(str2, open, openToGt, close, closeToGt, replacement) {
  const nextGt = createFinder(str2, />/g);
  const nextClose = createFinder(str2, close);
  const parts = [];
  let copied = 0;
  let searchFrom = 0;
  while (true) {
    open.lastIndex = searchFrom;
    const opener = open.exec(str2);
    if (!opener) {
      break;
    }
    const start = opener.index;
    searchFrom = start + 1;
    let from = start + opener[0].length;
    if (openToGt) {
      const gt = nextGt(from);
      if (!gt) {
        break;
      }
      from = gt.index + 1;
    }
    const closer = nextClose(from);
    if (!closer) {
      break;
    }
    let end = closer.index + closer[0].length;
    if (closeToGt) {
      const gt = nextGt(end);
      if (!gt) {
        break;
      }
      end = gt.index + 1;
    }
    parts.push(str2.slice(copied, start), replacement);
    copied = searchFrom = end;
  }
  parts.push(str2.slice(copied));
  return parts.join("");
}
function stripThroughLastTag(str2, prefix) {
  const limit = str2.lastIndexOf(">");
  let last = -1;
  prefix.lastIndex = 0;
  let match2;
  while ((match2 = prefix.exec(str2)) && match2.index < limit) {
    last = match2.index;
  }
  return last < 0 ? str2 : str2.slice(str2.indexOf(">", last) + 1);
}
function stripFromFirstTag(str2, prefix) {
  prefix.lastIndex = 0;
  const match2 = prefix.exec(str2);
  return match2 && match2.index < str2.lastIndexOf(">") ? str2.slice(0, match2.index) : str2;
}
function htmlToText(str2) {
  str2 = str2.replace(/\r\n|[\n\r\u2028\u2029]/g, "");
  str2 = replaceBlocks(str2, /<!--/g, false, /-->/g, false, " ");
  str2 = replaceClosedTags(str2, /<br\b[^>]*>/gi, "\n");
  str2 = replaceClosedTags(str2, /<\/?(p|div|table|tr|td|th)\b[^>]*>/gi, "\n\n");
  str2 = replaceBlocks(str2, /<script\b/gi, true, /<\/script\b/gi, true, " ");
  str2 = replaceBlocks(str2, /<style\b/gi, true, /<\/style\b/gi, true, " ");
  str2 = stripThroughLastTag(str2, /<body\b/gi);
  str2 = stripThroughLastTag(str2, /<\/head\b/gi);
  str2 = stripThroughLastTag(str2, /<!doctype\b/gi);
  str2 = stripFromFirstTag(str2, /<\/body\b/gi);
  str2 = stripFromFirstTag(str2, /<\/html\b/gi);
  str2 = throughLastTag(str2, (head) => replaceTags(head, /<a\b/gi, /<a\b[^>]*href\s*=\s*["']?([^\s"']+)[^>]*>/iy, (match2, href) => ` (${href}) `));
  str2 = replaceClosedTags(str2, /<\/?(span|em|i|strong|b|u|a)\b[^>]*>/gi, "");
  str2 = replaceTags(str2, /<li\b/gi, /<li\b[^>]*>[\n\u0001\s]*/iy, () => "* ");
  str2 = replaceClosedTags(str2, /<hr\b[^>]*>/g, "\n-------------\n");
  str2 = replaceClosedTags(str2, /<[^>]*>/g, " ");
  str2 = str2.replace(/\u0001/g, "\n").replace(/[ \t]+/g, " ").replace(/^\s+$/gm, "").replace(/\n\n+/g, "\n\n").replace(/^\n+/, "\n").replace(/\n+$/, "\n");
  str2 = decodeHTMLEntities(str2);
  return str2;
}
var dateFormatter = null;
function formatDate(date) {
  if (typeof Intl === "undefined") {
    return date;
  }
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) {
    return date;
  }
  dateFormatter ??= new Intl.DateTimeFormat("default", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false
  });
  return dateFormatter.format(parsed);
}
function formatTextAddress(address) {
  return (address.name ? [address.name, `<${address.address}>`] : [address.address]).join(" ");
}
function formatTextAddresses(addresses) {
  let parts = [];
  let processAddress = (address, partCounter) => {
    if (partCounter) {
      parts.push(", ");
    }
    if (address.group) {
      let groupStart = `${address.name}:`;
      let groupEnd = `;`;
      parts.push(groupStart);
      address.group.forEach(processAddress);
      parts.push(groupEnd);
    } else {
      parts.push(formatTextAddress(address));
    }
  };
  addresses.forEach(processAddress);
  return parts.join("");
}
function formatHtmlAddress(address) {
  return `<a href="mailto:${escapeHtml(encodeMailto(address.address))}" class="postal-email-address">${escapeHtml(address.name || `<${address.address}>`)}</a>`;
}
function formatHtmlAddresses(addresses) {
  let parts = [];
  let processAddress = (address, partCounter) => {
    if (partCounter) {
      parts.push('<span class="postal-email-address-separator">, </span>');
    }
    if (address.group) {
      let groupStart = `<span class="postal-email-address-group">${escapeHtml(address.name)}:</span>`;
      let groupEnd = `<span class="postal-email-address-group">;</span>`;
      parts.push(groupStart);
      address.group.forEach(processAddress);
      parts.push(groupEnd);
    } else {
      parts.push(formatHtmlAddress(address));
    }
  };
  addresses.forEach(processAddress);
  return parts.join(" ");
}
function foldLines(str2, lineLength, afterSpace) {
  str2 = (str2 || "").toString();
  lineLength = lineLength || 76;
  let pos = 0, len = str2.length, result = "", line2, match2;
  while (pos < len) {
    line2 = str2.slice(pos, pos + lineLength);
    if (line2.length < lineLength) {
      result += line2;
      break;
    }
    if (match2 = line2.match(/^[^\n\r]*(\r?\n|\r)/)) {
      line2 = match2[0];
      result += line2;
      pos += line2.length;
      continue;
    } else if ((match2 = line2.match(/(\s+)[^\s]*$/)) && match2[0].length - (afterSpace ? (match2[1] || "").length : 0) < line2.length) {
      line2 = line2.slice(0, line2.length - (match2[0].length - (afterSpace ? (match2[1] || "").length : 0)));
    } else if (match2 = str2.slice(pos + line2.length).match(/^[^\s]+(\s*)/)) {
      line2 = line2 + match2[0].slice(0, match2[0].length - (!afterSpace ? (match2[1] || "").length : 0));
    }
    result += line2;
    pos += line2.length;
    if (pos < len) {
      result += "\r\n";
    }
  }
  return result;
}
function formatTextHeader(message) {
  let rows = [];
  if (message.from) {
    rows.push({ key: "From", val: formatTextAddresses([message.from]) });
  }
  if (message.subject) {
    rows.push({ key: "Subject", val: message.subject });
  }
  if (message.date) {
    rows.push({ key: "Date", val: formatDate(message.date) });
  }
  if (message.to && message.to.length) {
    rows.push({ key: "To", val: formatTextAddresses(message.to) });
  }
  if (message.cc && message.cc.length) {
    rows.push({ key: "Cc", val: formatTextAddresses(message.cc) });
  }
  if (message.bcc && message.bcc.length) {
    rows.push({ key: "Bcc", val: formatTextAddresses(message.bcc) });
  }
  let maxKeyLength = rows.map((r) => r.key.length).reduce((acc, cur) => {
    return cur > acc ? cur : acc;
  }, 0);
  const lines = rows.flatMap((row) => {
    let sepLen = maxKeyLength - row.key.length;
    let prefix = `${row.key}: ${" ".repeat(sepLen)}`;
    let emptyPrefix = `${" ".repeat(row.key.length + 1)} ${" ".repeat(sepLen)}`;
    let foldedLines = foldLines(row.val, 80, true).split(/\r?\n/).map((line2) => line2.trim());
    return foldedLines.map((line2, i) => `${i ? emptyPrefix : prefix}${line2}`);
  });
  let maxLineLength = lines.map((r) => r.length).reduce((acc, cur) => {
    return cur > acc ? cur : acc;
  }, 0);
  let lineMarker = "-".repeat(maxLineLength);
  let template = `
${lineMarker}
${lines.join("\n")}
${lineMarker}
`;
  return template;
}
function formatHtmlHeader(message) {
  let rows = [];
  if (message.from) {
    rows.push(
      // through the plural formatter, because `From:` may hold RFC 5322 group syntax
      // and a group has no address of its own
      `<div class="postal-email-header-key">From</div><div class="postal-email-header-value">${formatHtmlAddresses([message.from])}</div>`
    );
  }
  if (message.subject) {
    rows.push(`<div class="postal-email-header-key">Subject</div><div class="postal-email-header-value postal-email-header-subject">${escapeHtml(message.subject)}</div>`);
  }
  if (message.date) {
    rows.push(`<div class="postal-email-header-key">Date</div><div class="postal-email-header-value postal-email-header-date" data-date="${escapeHtml(message.date)}">${escapeHtml(formatDate(message.date))}</div>`);
  }
  if (message.to && message.to.length) {
    rows.push(`<div class="postal-email-header-key">To</div><div class="postal-email-header-value">${formatHtmlAddresses(message.to)}</div>`);
  }
  if (message.cc && message.cc.length) {
    rows.push(`<div class="postal-email-header-key">Cc</div><div class="postal-email-header-value">${formatHtmlAddresses(message.cc)}</div>`);
  }
  if (message.bcc && message.bcc.length) {
    rows.push(`<div class="postal-email-header-key">Bcc</div><div class="postal-email-header-value">${formatHtmlAddresses(message.bcc)}</div>`);
  }
  let template = `<div class="postal-email-header">${rows.length ? '<div class="postal-email-header-row">' : ""}${rows.join('</div>\n<div class="postal-email-header-row">')}${rows.length ? "</div>" : ""}</div>`;
  return template;
}

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/address-parser.js
var TOKEN_OPERATOR = 1;
var TOKEN_NO_BREAK = 2;
var TOKEN_DIRTY = 4;
var TOKEN_ESCAPES = 8;
var TOKEN_STARTS_ESCAPED = 16;
var TokenList = class {
  constructor(str2) {
    this.str = str2;
    this.slots = new Int32Array(48);
    this.length = 0;
    this.cleaned = /* @__PURE__ */ new Map();
  }
  /**
   * Appends a token
   *
   * @param kind Kind and flags of the token
   * @param start Offset of its first character
   * @param end Offset just past its last character
   * @return Index of the token
   */
  push(kind, start, end) {
    if ((this.length + 1) * 3 > this.slots.length) {
      const grown = new Int32Array(this.slots.length * 2);
      grown.set(this.slots);
      this.slots = grown;
    }
    const at = this.length * 3;
    this.slots[at] = kind;
    this.slots[at + 1] = start;
    this.slots[at + 2] = end;
    return this.length++;
  }
  /**
   * The character of an operator token, an empty string for a text run
   */
  operatorAt(index) {
    const at = index * 3;
    return this.slots[at] & TOKEN_OPERATOR ? this.str.charAt(this.slots[at + 1]) : "";
  }
  /**
   * Whether a token is an operator
   */
  isOperator(index) {
    return (this.slots[index * 3] & TOKEN_OPERATOR) !== 0;
  }
  /**
   * Whether the next character continues the run of a token without whitespace in between
   */
  noBreak(index) {
    return (this.slots[index * 3] & TOKEN_NO_BREAK) !== 0;
  }
  /**
   * Value of a token
   */
  value(index) {
    const cleaned = this.cleaned.get(index);
    if (cleaned !== void 0) {
      return cleaned;
    }
    return this.str.slice(this.slots[index * 3 + 1], this.slots[index * 3 + 2]);
  }
};
var HAS_WHITESPACE = /\s/;
var QUOTED_LOCAL_ADDR = /^("(?:[^"\\]|\\[\s\S])*"@\S+)(?:\s+([\s\S]+))?$/;
var ADDR_SPEC = /^[^@\s]+@[^@\s]+$/;
var LITERAL_ADDR_SPEC = /^[^@\s]+@\[[^[\]\\\s]*\]$/;
var QUOTED_LOCAL_DOMAIN = /^@(?:[^@\s"]+|\[[^[\]\\\s]*\])$/;
function isAddrSpec(value) {
  return ADDR_SPEC.test(value) || LITERAL_ADDR_SPEC.test(value);
}
var LOOSE_ADDR_SPEC = /^[^@\s]+@\S+$/;
var LOOSE_TEXT_ADDR = /\s*\b[^@\s]+@[^\s]+\b\s*/y;
var DOMAIN_LITERAL_TAIL = /@(\[[^[\]\\]*\])$/;
function domainAt(address) {
  const literal = address.charAt(address.length - 1) === "]" ? DOMAIN_LITERAL_TAIL.exec(address) : null;
  return literal ? address.length - literal[1].length - 1 : address.lastIndexOf("@");
}
function quoteLocalPart(address) {
  const lastAt = domainAt(address);
  if (lastAt < 0) {
    return address;
  }
  const user = address.substring(0, lastAt);
  if (/^[^\s"(),:;<>@[\\\]]+$/.test(user) || /^"(?:[^"\\]|\\[\s\S])*"$/.test(user)) {
    return address;
  }
  return '"' + user.replace(/["\\]/g, "\\$&") + '"@' + address.substring(lastAt + 1);
}
function isSpaceCode(code) {
  return code === 32 || code >= 9 && code <= 13 || code === 160 || code === 5760 || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
function isWordCode(code) {
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
}
function isBoundary(text, at) {
  return isWordCode(text.charCodeAt(at - 1)) !== isWordCode(text.charCodeAt(at));
}
function indexOfAt(text, from, to) {
  for (let i = from; i < to; i++) {
    if (text.charCodeAt(i) === 64) {
      return i;
    }
  }
  return -1;
}
var LEADING_QUOTED_STRING = /^"(?:[^"\\]|\\[\s\S])*"/;
function joinAtSpacing(value, at) {
  if (at < 0) {
    return value;
  }
  let start = at;
  while (start > 0 && isSpaceCode(value.charCodeAt(start - 1))) {
    start--;
  }
  let end = at + 1;
  while (end < value.length && isSpaceCode(value.charCodeAt(end))) {
    end++;
  }
  return start === at && end === at + 1 ? value : value.slice(0, start) + "@" + value.slice(end);
}
function collapseAtSpacing(value) {
  const quoted = LEADING_QUOTED_STRING.exec(value);
  if (quoted) {
    let at2 = quoted[0].length;
    while (at2 < value.length && isSpaceCode(value.charCodeAt(at2))) {
      at2++;
    }
    if (value.charAt(at2) === "@" && value.indexOf("@", at2 + 1) < 0) {
      return joinAtSpacing(value, at2);
    }
  }
  const at = value.indexOf("@");
  if (at < 0 || value.indexOf("@", at + 1) >= 0 || value.lastIndexOf('"') > at) {
    return value;
  }
  return joinAtSpacing(value, at);
}
function looseAddressStart(text) {
  const len = text.length;
  let pos = 0;
  while (pos < len) {
    while (pos < len && isSpaceCode(text.charCodeAt(pos))) {
      pos++;
    }
    if (pos >= len) {
      break;
    }
    const runStart = pos;
    let runEnd = pos;
    while (runEnd < len && !isSpaceCode(text.charCodeAt(runEnd))) {
      runEnd++;
    }
    let at = indexOfAt(text, runStart, runEnd);
    if (at >= 0) {
      let lastBoundary = -1;
      for (let k = runEnd; k > runStart; k--) {
        if (isBoundary(text, k)) {
          lastBoundary = k;
          break;
        }
      }
      let atomStart = runStart;
      while (lastBoundary >= 0 && at >= 0) {
        if (at > atomStart && runEnd > at + 1 && lastBoundary > at + 1) {
          for (let start = atomStart; start < at; start++) {
            if (isBoundary(text, start)) {
              if (start > runStart) {
                return start;
              }
              let padded = runStart;
              while (padded > 0 && isSpaceCode(text.charCodeAt(padded - 1))) {
                padded--;
              }
              return padded;
            }
          }
        }
        atomStart = at + 1;
        at = indexOfAt(text, atomStart, runEnd);
      }
    }
    pos = runEnd;
  }
  return -1;
}
function recoverAddrSpec(address, text) {
  address = collapseAtSpacing(address);
  if (!HAS_WHITESPACE.test(address)) {
    return { address, text };
  }
  let rest;
  const quoted = address.match(QUOTED_LOCAL_ADDR);
  if (quoted) {
    if (!quoted[2]) {
      return { address, text };
    }
    address = quoted[1];
    rest = [quoted[2]];
  } else {
    if (address.indexOf('"') >= 0) {
      return { address, text };
    }
    const parts = address.split(/\s+/);
    let addrIndex = parts.findIndex(isAddrSpec);
    if (addrIndex < 0) {
      addrIndex = parts.findIndex((part) => LOOSE_ADDR_SPEC.test(part));
    }
    if (addrIndex < 0) {
      return { address, text };
    }
    address = parts.splice(addrIndex, 1)[0];
    rest = parts;
  }
  return {
    address,
    text: [text, ...rest].filter((part) => part).join(" ")
  };
}
function stripAddressComments(address) {
  const comments = [];
  let result = "";
  let comment = "";
  let depth = 0;
  let closer = "";
  let lastChar = "";
  let pendingSpace = false;
  let firstChar = "";
  let quoteSeen = false;
  let routeEnd = -1;
  for (let i = 0, len = address.length; i < len; i++) {
    const chr = address.charAt(i);
    if (depth) {
      if (chr === "\\" && i < len - 1) {
        comment += address.charAt(++i);
      } else if (chr === "(") {
        depth++;
        comment += chr;
      } else if (chr === ")" && !--depth) {
        comments.push(comment.trim());
        comment = "";
        pendingSpace = lastChar !== "@";
      } else {
        comment += chr;
      }
      continue;
    }
    if (pendingSpace && chr !== "(") {
      pendingSpace = false;
      if (chr !== "@" && chr !== "<" && !isSpaceCode(address.charCodeAt(i))) {
        result += " ";
        lastChar = " ";
      }
    }
    if (closer) {
      if (chr === "\\" && closer === '"' && i < len - 1) {
        result += chr + address.charAt(++i);
        lastChar = address.charAt(i);
        continue;
      }
      if (chr === closer) {
        closer = "";
      }
    } else if (chr === '"') {
      closer = '"';
      quoteSeen = true;
    } else if (chr === ":" && routeEnd < 0 && firstChar === "@" && !quoteSeen) {
      routeEnd = result.length + 1;
    } else if (chr === "[") {
      closer = "]";
    } else if (chr === "(") {
      depth = 1;
      continue;
    } else if (chr === "<") {
      result = "";
      lastChar = "";
      comments.length = 0;
      firstChar = "";
      quoteSeen = false;
      routeEnd = -1;
      continue;
    }
    result += chr;
    lastChar = chr;
    if (!firstChar && !isSpaceCode(address.charCodeAt(i))) {
      firstChar = chr;
    }
  }
  if (routeEnd >= 0 && result.indexOf("@", routeEnd) >= 0) {
    result = result.slice(routeEnd);
  }
  if (depth) {
    comments.push(comment.trim());
  }
  return { address: result.trim(), comments: comments.filter((text) => text) };
}
function collectAddressParts(tokens, from, to) {
  let state = "text";
  let data = {
    address: [],
    comment: [],
    text: [],
    textWasQuoted: [],
    // Track which text tokens came from inside quotes
    // For a text run that is a quoted local part followed by the unquoted '@' and domain
    // of an addr-spec, '"user"@example.com', the length of the local part, -1 otherwise
    quotedLocalAt: []
  };
  let lastTextPureQuoted = false;
  let i;
  let insideQuotes = false;
  const lastChars = { address: "", comment: "", text: "" };
  for (i = from; i < to; i++) {
    const value = tokens.value(i);
    const prevOperator = i > from ? tokens.operatorAt(i - 1) : "";
    const prevNoBreak = i > from && tokens.noBreak(i - 1);
    if (tokens.isOperator(i)) {
      switch (value) {
        case "<":
          state = "address";
          insideQuotes = false;
          break;
        case "(":
          state = "comment";
          insideQuotes = false;
          break;
        case '"':
          insideQuotes = !insideQuotes;
          state = "text";
          break;
        default:
          state = "text";
          insideQuotes = false;
          break;
      }
    } else {
      const opensAfterEmptyQuotedString = prevOperator === '"' && prevNoBreak && i > from + 1 && tokens.operatorAt(i - 2) === '"';
      const joins = prevNoBreak && data[state].length && (prevOperator !== ")" || lastChars[state] === "@" || value.charAt(0) === "@");
      if (joins) {
        const last = data[state].length - 1;
        if (state === "text" && !insideQuotes) {
          if (lastTextPureQuoted && value.charAt(0) === "@") {
            data.quotedLocalAt[last] = data.text[last].length;
          }
          lastTextPureQuoted = false;
        }
        data[state][last] += value;
        if (state === "text" && insideQuotes) {
          data.textWasQuoted[last] = true;
        }
      } else {
        data[state].push(value);
        if (state === "text") {
          data.textWasQuoted.push(insideQuotes || opensAfterEmptyQuotedString);
          data.quotedLocalAt.push(opensAfterEmptyQuotedString && value.charAt(0) === "@" ? 0 : -1);
          lastTextPureQuoted = insideQuotes;
        }
      }
      lastChars[state] = value.charAt(value.length - 1);
    }
  }
  let textFromComment = false;
  if (!data.text.length && data.comment.length) {
    data.text = data.comment;
    data.comment = [];
    textFromComment = true;
  }
  return { data, textFromComment };
}
function groupName(tokens, from, to) {
  return decodeWords(collectAddressParts(tokens, from, to).data.text.join(" "));
}
function _handleAddress(tokens, from, to) {
  const collected = collectAddressParts(tokens, from, to);
  const data = collected.data;
  let textFromComment = collected.textFromComment;
  let i;
  const addressComments = [];
  const addressParts = [];
  for (const part of data.address) {
    const stripped = stripAddressComments(part);
    for (const comment of stripped.comments) {
      addressComments.push(comment);
    }
    if (stripped.address) {
      addressParts.push(stripped.address);
    }
  }
  data.address = addressParts;
  if (!data.address.length && data.text.length && !textFromComment) {
    const candidates = data.text.map((part) => collapseAtSpacing(part));
    for (i = 0; i < data.text.length; i++) {
      const local = data.quotedLocalAt[i];
      const quotedLocal = data.textWasQuoted[i] && local >= 0 && QUOTED_LOCAL_DOMAIN.test(data.text[i].slice(local)) ? quoteLocalPart(data.text[i]) : "";
      if (quotedLocal || !data.textWasQuoted[i] && isAddrSpec(candidates[i])) {
        data.address = [quotedLocal || candidates[i]];
        data.text.splice(i, 1);
        data.textWasQuoted.splice(i, 1);
        data.quotedLocalAt.splice(i, 1);
        break;
      }
    }
    if (!data.address.length) {
      for (i = 0; i < data.text.length; i++) {
        if (!data.textWasQuoted[i]) {
          const part = candidates[i];
          const start = looseAddressStart(part);
          if (start >= 0) {
            LOOSE_TEXT_ADDR.lastIndex = start;
            const match2 = LOOSE_TEXT_ADDR.exec(part);
            if (match2) {
              data.address = [match2[0].trim()];
              data.text[i] = (part.slice(0, start) + " " + part.slice(start + match2[0].length)).trim();
              break;
            }
          }
          data.text[i] = data.text[i].trim();
        }
      }
    }
  }
  if (!data.text.length && data.comment.length) {
    data.text = data.comment;
    data.comment = [];
  }
  if (data.address.length > 1) {
    data.text = data.text.concat(data.address.splice(1));
  }
  const addressFromQuotedText = !data.address.length && data.textWasQuoted.some((wasQuoted) => wasQuoted);
  let text = data.text.join(" ");
  let addressValue = data.address.join(" ");
  if (!addressValue && isEncodedWordsOnly(text.trim())) {
    return { address: "", name: decodeWords(text) };
  }
  if (addressFromQuotedText && text.indexOf("@") >= 0) {
    addressValue = quoteLocalPart(joinAtSpacing(text, domainAt(text)));
    text = "";
  }
  ({ address: addressValue, text } = recoverAddrSpec(addressValue, text));
  if (!text && addressComments.length) {
    text = addressComments.join(" ");
    textFromComment = true;
  }
  const rawName = text || addressValue || "";
  const address = {
    address: addressValue || (textFromComment ? "" : text) || "",
    name: decodeWords(rawName)
  };
  if (address.address === rawName || address.address === address.name) {
    if (address.address.match(/@/)) {
      address.name = "";
    } else {
      address.address = "";
    }
  }
  return address;
}
var Tokenizer = class {
  /**
   * @param str Address field string
   */
  constructor(str2) {
    this.str = (str2 || "").toString();
    this.operatorCurrent = "";
    this.operatorExpecting = "";
    this.node = -1;
    this.escaped = false;
    this.inDomainLiteral = false;
    this.afterAt = false;
    this.inGroup = false;
    this.innerQuoted = false;
    this.innerComment = 0;
    this.innerLiteral = false;
    this.innerEscaped = false;
    this.list = new TokenList(this.str);
    this.operators = {
      '"': '"',
      "(": ")",
      "<": ">",
      ",": "",
      // A group is read in the same pass as the rest of the list, so its ':' only marks
      // where the name ends and its members are tokenized like any other address
      ":": "",
      // Semicolons are not a legal delimiter per the RFC2822 grammar other
      // than for terminating a group, but they are also not valid for any
      // other use in this context.  Given that some mail clients have
      // historically allowed the semicolon as a delimiter equivalent to the
      // comma in their UI, it makes sense to treat them the same as a comma
      // when used outside of a group.
      ";": ""
    };
  }
  /**
   * Tokenizes the original input string
   *
   * @return An array of operator|text tokens
   */
  tokenize() {
    const str2 = this.str;
    const len = str2.length;
    for (let i = 0; i < len; i++) {
      this.checkChar(str2.charAt(i), i);
    }
    this.closeText(len);
    const list = this.list;
    const slots = list.slots;
    let kept = 0;
    for (let i = 0, count = list.length; i < count; i++) {
      const kind = slots[i * 3];
      let start = slots[i * 3 + 1];
      let end = slots[i * 3 + 2];
      if (kind & TOKEN_DIRTY) {
        const value = this.cleanValue(start, end, kind).trim();
        if (!value) {
          continue;
        }
        list.cleaned.set(kept, value);
      } else if (!(kind & TOKEN_OPERATOR)) {
        while (start < end && isSpaceCode(str2.charCodeAt(start))) {
          start++;
        }
        while (end > start && isSpaceCode(str2.charCodeAt(end - 1))) {
          end--;
        }
        if (start === end) {
          continue;
        }
      }
      slots[kept * 3] = kind;
      slots[kept * 3 + 1] = start;
      slots[kept * 3 + 2] = end;
      kept++;
    }
    list.length = kept;
    return list;
  }
  /**
   * Ends the text run being collected, if there is one
   *
   * @param end Offset just past its last character
   */
  closeText(end) {
    if (this.node >= 0) {
      this.list.slots[this.node * 3 + 2] = end;
      this.node = -1;
    }
  }
  /**
   * Rebuilds the value of a text run that is no plain slice of the field, applying the
   * rules checkChar collects characters by: an escaping backslash is dropped, a line break
   * reads as a space and any other control character is left out
   *
   * @param start Offset of the first character of the run
   * @param end Offset just past its last character
   * @param kind Kind and flags of the run
   * @return Value of the run
   */
  cleanValue(start, end, kind) {
    const str2 = this.str;
    const escapes = (kind & TOKEN_ESCAPES) !== 0;
    let escaped = (kind & TOKEN_STARTS_ESCAPED) !== 0;
    let value = "";
    for (let i = start; i < end; i++) {
      const chr = str2.charAt(i);
      if (escapes && !escaped && chr === "\\") {
        escaped = true;
        continue;
      }
      escaped = false;
      if (chr === "\n") {
        value += " ";
      } else if (chr.charCodeAt(0) >= 33 || chr === " " || chr === "	") {
        value += chr;
      }
    }
    return value;
  }
  /**
   * Checks if a character is an operator or text and acts accordingly
   *
   * @param chr Character from the address field
   * @param i Offset of the character in the field
   */
  checkChar(chr, i) {
    if (!this.escaped && !this.operatorExpecting) {
      if (!this.inDomainLiteral && chr === "[" && this.afterAt) {
        this.inDomainLiteral = true;
      } else if (this.inDomainLiteral && (chr === "]" || chr === "," || chr === ";")) {
        this.inDomainLiteral = false;
      }
    }
    let nested = false;
    if (this.operatorExpecting === ">") {
      nested = this.trackInner(chr);
      if (!nested && chr === ";" && this.inGroup) {
        this.closeText(i);
        this.operatorExpecting = "";
        this.resetInner();
      }
    } else if (this.operatorExpecting === ")" && !this.escaped) {
      if (chr === "(") {
        this.innerComment++;
      } else if (chr === ")" && this.innerComment) {
        this.innerComment--;
        nested = true;
      }
    }
    if (this.escaped) {
    } else if (chr === this.operatorExpecting && !nested) {
      const nextChr = this.str.charAt(i + 1);
      this.closeText(i);
      this.list.push(nextChr && ![" ", "	", "\r", "\n", ",", ";"].includes(nextChr) ? TOKEN_OPERATOR | TOKEN_NO_BREAK : TOKEN_OPERATOR, i, i + 1);
      if (chr !== ")") {
        this.afterAt = false;
      }
      this.operatorExpecting = "";
      this.escaped = false;
      this.resetInner();
      return;
    } else if (!this.operatorExpecting && !(this.inDomainLiteral && chr === ":") && chr in this.operators) {
      this.closeText(i);
      this.list.push(TOKEN_OPERATOR, i, i + 1);
      if (chr === ":") {
        this.inGroup = true;
      } else if (chr === ";") {
        this.inGroup = false;
      }
      if (chr !== "(") {
        this.afterAt = false;
      }
      this.operatorExpecting = this.operators[chr];
      this.escaped = false;
      this.resetInner();
      return;
    } else if ((this.operatorExpecting === '"' || this.operatorExpecting === ")") && chr === "\\") {
      this.escaped = true;
      if (this.node >= 0) {
        this.list.slots[this.node * 3] |= TOKEN_DIRTY;
      }
      return;
    }
    if (this.node < 0) {
      this.node = this.list.push((this.operatorExpecting === '"' || this.operatorExpecting === ")" ? TOKEN_ESCAPES : 0) | (this.escaped ? TOKEN_STARTS_ESCAPED : 0), i, i);
    }
    if (chr === "\n") {
      chr = " ";
      this.list.slots[this.node * 3] |= TOKEN_DIRTY;
    }
    if (chr.charCodeAt(0) >= 33 || chr === " " || chr === "	") {
      if (!this.operatorExpecting && chr !== " " && chr !== "	") {
        this.afterAt = chr === "@";
      }
    } else {
      this.list.slots[this.node * 3] |= TOKEN_DIRTY;
    }
    this.escaped = false;
  }
  /**
   * Tracks the quoted strings, comments and domain literals inside an angle-addr, which its
   * closer must not be read from. A backslash escapes the next character inside a quoted
   * string and a comment. A domain literal opens right after an "@" and ends at the "]".
   * dtext holds the list separators as well, and inside the brackets they never split the
   * list anyway.
   *
   * @param chr Character from the address field
   * @return true while the character sits inside one of them, the one that closes it included
   */
  trackInner(chr) {
    if (this.innerEscaped) {
      this.innerEscaped = false;
      return true;
    }
    if (this.innerQuoted) {
      if (chr === "\\") {
        this.innerEscaped = true;
      } else if (chr === '"') {
        this.innerQuoted = false;
      }
      return true;
    }
    if (this.innerComment) {
      if (chr === "\\") {
        this.innerEscaped = true;
      } else if (chr === "(") {
        this.innerComment++;
      } else if (chr === ")") {
        this.innerComment--;
      }
      return true;
    }
    if (this.innerLiteral) {
      if (chr === "]") {
        this.innerLiteral = false;
      }
      return true;
    }
    if (chr === '"') {
      this.innerQuoted = true;
      return true;
    }
    if (chr === "(") {
      this.innerComment = 1;
      return true;
    }
    if (chr === "[" && this.afterAt) {
      this.innerLiteral = true;
      return true;
    }
    if (!isSpaceCode(chr.charCodeAt(0))) {
      this.afterAt = chr === "@";
    }
    return false;
  }
  /**
   * Forgets the nesting collected for the operator that just opened or ended
   */
  resetInner() {
    this.innerQuoted = false;
    this.innerComment = 0;
    this.innerLiteral = false;
    this.innerEscaped = false;
  }
};
function mergeNameFragments(list) {
  const merged = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const current = list[i];
    const next = merged.length ? merged[merged.length - 1] : null;
    if (next && current.address === "" && current.name && !current.group && next.address && next.name) {
      next.name = current.name + ", " + next.name;
    } else {
      merged.push(current);
    }
  }
  return merged.reverse();
}
function parseAddressList(str2) {
  const tokens = new Tokenizer(str2).tokenize();
  const parsedAddresses = [];
  let group = null;
  let members = [];
  let from = 0;
  for (let i = 0, len = tokens.length; i <= len; i++) {
    const operator = i < len ? tokens.operatorAt(i) : "";
    if (i < len && operator !== "," && operator !== ";" && operator !== ":") {
      continue;
    }
    if (operator === ":") {
      if (!group) {
        group = { name: groupName(tokens, from, i), group: [] };
        members = [];
      }
      from = i + 1;
      continue;
    }
    if (i > from) {
      (group ? members : parsedAddresses).push(_handleAddress(tokens, from, i));
    }
    from = i + 1;
    if (group && (operator === ";" || i === len)) {
      group.group = mergeNameFragments(members);
      parsedAddresses.push(group);
      group = null;
    }
  }
  return mergeNameFragments(parsedAddresses);
}
function addressParser(str2, options) {
  const parsedAddresses = parseAddressList(str2);
  if (options && options.flatten) {
    let addresses = [];
    let walkAddressList = (list) => {
      list.forEach((address) => {
        if (address.group) {
          return walkAddressList(address.group);
        } else {
          addresses.push(address);
        }
      });
    };
    walkAddressList(parsedAddresses);
    return addresses;
  }
  return parsedAddresses;
}
var address_parser_default = addressParser;

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/base64-encoder.js
function base64ArrayBuffer(arrayBuffer) {
  let base64 = "";
  const encodings = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(arrayBuffer);
  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;
  let a, b, c, d;
  let chunk;
  for (let i = 0; i < mainLength; i = i + 3) {
    chunk = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    a = (chunk & 16515072) >> 18;
    b = (chunk & 258048) >> 12;
    c = (chunk & 4032) >> 6;
    d = chunk & 63;
    base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d];
  }
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];
    a = (chunk & 252) >> 2;
    b = (chunk & 3) << 4;
    base64 += encodings[a] + encodings[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = bytes[mainLength] << 8 | bytes[mainLength + 1];
    a = (chunk & 64512) >> 10;
    b = (chunk & 1008) >> 4;
    c = (chunk & 15) << 2;
    base64 += encodings[a] + encodings[b] + encodings[c] + "=";
  }
  return base64;
}

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/otp-token.js
var MAX_FIELD_LENGTH = 8192;
var NUMBER = /-?(?:\d{1,12}\.\d{1,3}|\d{1,15})/y;
var STRING = /"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"/y;
var TOKEN = /[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/y;
var BYTE_SEQUENCE = /:[A-Za-z0-9+/=]*:/y;
var BOOLEAN = /\?[01]/y;
var DATE = /@-?\d{1,15}/y;
var DISPLAY_STRING = /%"((?:[\x20\x21\x23\x24\x26-\x7e]|%[0-9a-f]{2})*)"/y;
var KEY = /[a-z*][a-z0-9_\-.*]*/y;
var SPACES = / */y;
function match(cursor, re) {
  re.lastIndex = cursor.pos;
  const result = re.exec(cursor.input);
  if (result) {
    cursor.pos = re.lastIndex;
  }
  return result;
}
function parseString(cursor) {
  const result = match(cursor, STRING);
  return result && result[1].replace(/\\(["\\])/g, "$1");
}
function isDisplayString(cursor) {
  const result = match(cursor, DISPLAY_STRING);
  if (!result) {
    return false;
  }
  try {
    decodeURIComponent(result[1]);
    return true;
  } catch {
    return false;
  }
}
function parseBareItem(cursor) {
  const c = cursor.input.charAt(cursor.pos);
  switch (c) {
    case '"':
      return parseString(cursor) ?? false;
    case ":":
      return !!match(cursor, BYTE_SEQUENCE);
    case "?":
      return !!match(cursor, BOOLEAN);
    case "@":
      return !!match(cursor, DATE);
    case "%":
      return isDisplayString(cursor);
  }
  return !!match(cursor, c === "-" || c >= "0" && c <= "9" ? NUMBER : TOKEN);
}
function parseStringItem(value) {
  const cursor = { input: value, pos: 0 };
  match(cursor, SPACES);
  const item = parseString(cursor);
  if (item === null) {
    return null;
  }
  const params = /* @__PURE__ */ new Map();
  while (cursor.input[cursor.pos] === ";") {
    cursor.pos++;
    match(cursor, SPACES);
    const key = match(cursor, KEY);
    if (!key) {
      return null;
    }
    let paramValue = true;
    if (cursor.input[cursor.pos] === "=") {
      cursor.pos++;
      paramValue = parseBareItem(cursor);
      if (paramValue === false) {
        return null;
      }
    }
    params.set(key[0], paramValue);
  }
  match(cursor, SPACES);
  return cursor.pos === cursor.input.length ? { value: item, params } : null;
}
function isOtpOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || !/^([a-z0-9_-]+\.)*[a-z0-9_-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname)) {
    return false;
  }
  const isLoopback = /^(localhost|.+\.localhost|127(\.\d+){3}|\[::1\])$/.test(url.hostname);
  return url.protocol === "https:" || url.protocol === "http:" && isLoopback;
}
function getOtp(headers) {
  let otpHeader;
  for (const header of headers) {
    if (header.key === "otp-token") {
      if (otpHeader) {
        return void 0;
      }
      otpHeader = header;
    }
  }
  if (!otpHeader || otpHeader.value.length > MAX_FIELD_LENGTH) {
    return void 0;
  }
  const parsed = parseStringItem(otpHeader.value);
  const origin = parsed?.params.get("origin");
  if (!parsed?.value || typeof origin !== "string" || !isOtpOrigin(origin)) {
    return void 0;
  }
  return { code: parsed.value, origin };
}

// node_modules/.pnpm/postal-mime@4.2.0/node_modules/postal-mime/dist/esm/postal-mime.js
function isReadableStream(value) {
  return !!value && typeof value.getReader === "function";
}
function isBlob(value) {
  return value instanceof Blob || Object.prototype.toString.call(value) === "[object Blob]";
}
function isArrayBuffer(value) {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
}
var ATTACHMENT_ENCODINGS = /* @__PURE__ */ new Set(["arraybuffer", "base64", "utf8"]);
function parseAttachmentEncoding(value) {
  const encoding = String(value || "").replace(/[-_\s]/g, "").toLowerCase() || "arraybuffer";
  if (!ATTACHMENT_ENCODINGS.has(encoding)) {
    throw createError("EINVALIDOPTION", `Unknown attachment encoding ${encoding}`);
  }
  return encoding;
}
function renderEntry(textEntry, textType, convert) {
  if (textEntry.type === "subMessage") {
    return textType === "html" ? formatHtmlHeader(textEntry.value) : formatTextHeader(textEntry.value);
  }
  if (!convert) {
    return textEntry.value;
  }
  return textType === "html" ? textToHtml(textEntry.value) : htmlToText(textEntry.value);
}
var LINE_FEED = new Uint8Array([10]);
var MAX_NESTING_DEPTH = 256;
var MAX_HEADERS_SIZE = 2 * 1024 * 1024;
var MAX_PART_COUNT = 1e4;
var MAX_RFC822_NESTING_DEPTH = 10;
var MAX_FORWARDED_ADDRESSES = 1e4;
function countAddresses(addresses) {
  if (!addresses) {
    return 0;
  }
  let count = 0;
  for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
    count += 1 + (address.group ? address.group.length : 0);
  }
  return count;
}
function parseLimitOption(value, defaultValue, name, min = 0) {
  if (value === void 0 || value === null) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw createError("EINVALIDOPTION", `${name} must be a ${min ? "positive" : "non-negative"} integer`);
  }
  return value;
}
function parseLimits(options) {
  return {
    maxNestingDepth: parseLimitOption(options.maxNestingDepth, MAX_NESTING_DEPTH, "maxNestingDepth"),
    maxHeadersSize: parseLimitOption(options.maxHeadersSize, MAX_HEADERS_SIZE, "maxHeadersSize"),
    // The root part is always counted, so a limit of zero can parse nothing, not even
    // an empty message, and it threw EMAXPARTCOUNT from the constructor, where only
    // EINVALIDOPTION is thrown
    maxPartCount: parseLimitOption(options.maxPartCount, MAX_PART_COUNT, "maxPartCount", 1),
    // A limit of 0 disables inline parsing entirely, so every message/rfc822 part
    // becomes an attachment.
    maxRfc822NestingDepth: parseLimitOption(options.maxRfc822NestingDepth, MAX_RFC822_NESTING_DEPTH, "maxRfc822NestingDepth"),
    maxForwardedAddresses: parseLimitOption(options.maxForwardedAddresses, MAX_FORWARDED_ADDRESSES, "maxForwardedAddresses")
  };
}
var PostalMime = class _PostalMime {
  /**
   * Parses a raw email message
   *
   * @param buf Raw email message
   * @param options Parser options
   * @returns The parsed email
   */
  // async so that an invalid option rejects the returned promise instead of throwing
  // synchronously, which would escape a `.catch()` chain
  static async parse(buf, options) {
    const parser = new _PostalMime(options);
    return parser.parse(buf);
  }
  constructor(options, parent) {
    this.options = options || {};
    this.rfc822NestingDepth = parent ? parent.rfc822NestingDepth + 1 : 0;
    this.limits = parent ? parent.limits : parseLimits(this.options);
    this.counters = parent ? parent.counters : { headerSize: 0, partCount: 0, forwardedAddresses: 0 };
    this.root = this.currentNode = new MimeNode({ postalMime: this });
    this.boundaries = [];
    this.textContent = {};
    this.textMap = /* @__PURE__ */ new Map();
    this.textTypes = /* @__PURE__ */ new Set();
    this.attachments = [];
    this.forceRfc822Attachments = false;
    this.attachmentEncoding = parseAttachmentEncoding(this.options.attachmentEncoding);
    this.started = false;
  }
  /** @internal */
  async finalize() {
    await this.root.finalize();
  }
  /** @internal */
  async processLine(line2, lineBreak, isFinal) {
    let boundaries = this.boundaries;
    if (boundaries.length && line2.length > 2 && line2[0] === 45 && line2[1] === 45) {
      for (let i = 0; i < boundaries.length; i++) {
        let boundary = boundaries[i];
        if (line2.length < boundary.value.length + 2) {
          continue;
        }
        let boundaryMatches = true;
        for (let j = 0; j < boundary.value.length; j++) {
          if (line2[j + 2] !== boundary.value[j]) {
            boundaryMatches = false;
            break;
          }
        }
        if (!boundaryMatches) {
          continue;
        }
        let boundaryEnd = boundary.value.length + 2;
        let isTerminator = false;
        if (line2.length >= boundary.value.length + 4 && line2[boundary.value.length + 2] === 45 && line2[boundary.value.length + 3] === 45) {
          isTerminator = true;
          boundaryEnd = boundary.value.length + 4;
        }
        let hasValidTrailing = true;
        for (let j = boundaryEnd; j < line2.length; j++) {
          if (!isWsp(line2[j])) {
            hasValidTrailing = false;
            break;
          }
        }
        if (!hasValidTrailing) {
          continue;
        }
        if (isTerminator) {
          await boundary.node.finalize(true);
          this.currentNode = boundary.node.parentNode || this.root;
        } else {
          await boundary.node.finalizeChildNodes(true);
          this.currentNode = new MimeNode({
            postalMime: this,
            parentNode: boundary.node,
            parentMultipartType: boundary.node.contentType.multipart
          });
        }
        if (isFinal) {
          return this.finalize();
        }
        return;
      }
    }
    if (this.currentNode.feed(line2, lineBreak)) {
      return this.processLine(line2, lineBreak, isFinal);
    }
    if (isFinal) {
      return this.finalize();
    }
  }
  // Reads the next line without its line break. The break itself, the exact bytes between
  // the line and the next one, is returned alongside, because the body decoders write it
  // back out: a part has to keep the line endings it was sent with, see PassThroughDecoder.
  /** @internal */
  readLine() {
    let startPos = this.readPos;
    let endPos = this.readPos;
    while (this.readPos < this.av.length) {
      const c = this.av[this.readPos++];
      if (c !== 13 && c !== 10) {
        endPos = this.readPos;
      }
      if (c === 10) {
        return {
          bytes: new Uint8Array(this.buf, startPos, endPos - startPos),
          lineBreak: this.av.subarray(endPos, this.readPos),
          done: this.readPos >= this.av.length
        };
      }
    }
    return {
      bytes: new Uint8Array(this.buf, startPos, endPos - startPos),
      lineBreak: LINE_FEED,
      done: this.readPos >= this.av.length
    };
  }
  // Records a text part or a nested message under the node that selects it
  /** @internal */
  addTextEntry(selector, textType, item) {
    let textEntry = this.textMap.get(selector);
    if (!textEntry) {
      textEntry = {};
      this.textMap.set(selector, textEntry);
    }
    const entries = textEntry[textType] || [];
    textEntry[textType] = entries;
    entries.push(item);
    this.textTypes.add(textType);
  }
  // Sorts every leaf of the tree into text content, nested messages and attachments.
  // `alternative` is the closest enclosing multipart/alternative, if any: its text parts
  // are collected under the alternative itself, so that the body is assembled from one
  // representation of it rather than from every one. `related` tells whether the part
  // sits inside a multipart/related, where a Content-ID makes it an inline resource
  /** @internal */
  async collectNode(node, alternative, related) {
    if (!node.contentType.multipart) {
      const inlineRfc822 = this.isInlineMessageRfc822(node);
      const rfc822DepthExceeded = inlineRfc822 && this.rfc822NestingDepth >= this.limits.maxRfc822NestingDepth;
      if (inlineRfc822 && !rfc822DepthExceeded) {
        await this.collectSubMessage(node);
      } else if (this.isInlineTextNode(node)) {
        const textType = node.contentType.parsed.value === "text/html" ? "html" : "plain";
        this.addTextEntry(alternative || node, textType, { type: "text", value: node.getTextContent() });
      } else if (node.content) {
        this.collectAttachment(node, node.content, related, rfc822DepthExceeded);
      }
    } else if (node.contentType.multipart === "alternative") {
      alternative = node;
    } else if (node.contentType.multipart === "related") {
      related = true;
    }
    for (let childNode of node.childNodes) {
      await this.collectNode(childNode, alternative, related);
    }
  }
  // Parses an inline message/rfc822 part with a nested parser and takes over its text
  // parts and attachments
  /** @internal */
  async collectSubMessage(node) {
    const subParser = new _PostalMime({
      // Options that decide how a part is classified stay with the parser that
      // was configured, the limits and their counters come from this parser.
      // Attachments are encoded by the parent parser, so raw buffers are kept here.
      attachmentEncoding: "arraybuffer"
    }, this);
    const subMessage = await subParser.parse(node.content || new ArrayBuffer(0));
    this.counters.forwardedAddresses += countAddresses(subMessage.from) + countAddresses(subMessage.to) + countAddresses(subMessage.cc) + countAddresses(subMessage.bcc);
    if (this.counters.forwardedAddresses > this.limits.maxForwardedAddresses) {
      throw createError("EMAXFORWARDEDADDRESSES", `Maximum forwarded address count of ${this.limits.maxForwardedAddresses} addresses exceeded`);
    }
    const hasPlain = subParser.textTypes.has("plain");
    const hasHtml = subParser.textTypes.has("html");
    if (hasPlain || !hasHtml) {
      this.addTextEntry(node, "plain", { type: "subMessage", value: subMessage });
    }
    if (hasHtml) {
      this.addTextEntry(node, "html", { type: "subMessage", value: subMessage });
    }
    subParser.textMap.forEach((subTextEntry, subTextNode) => {
      this.textMap.set(subTextNode, subTextEntry);
    });
    for (let attachment of subMessage.attachments) {
      this.attachments.push(attachment);
    }
  }
  /** @internal */
  collectAttachment(node, content, related, rfc822DepthExceeded) {
    const filename = node.contentDisposition.parsed.params.filename || node.contentType.parsed.params.name || null;
    const attachment = {
      // An RFC 2231 filename is percent decoded without folding, since the same decoder
      // produces the boundary, so the fold happens here, see foldLineBreaks
      filename: filename ? decodeWords(foldLineBreaks(filename)) : null,
      mimeType: node.contentType.parsed.value,
      disposition: node.contentDisposition.parsed.value || null
    };
    if (related && node.contentId && !rfc822DepthExceeded) {
      attachment.related = true;
    }
    if (rfc822DepthExceeded) {
      attachment.rfc822DepthExceeded = true;
    }
    if (node.contentDescription) {
      attachment.description = decodeWords(node.contentDescription);
    }
    if (node.contentId) {
      attachment.contentId = node.contentId;
    }
    switch (node.contentType.parsed.value) {
      // Special handling for calendar events
      case "text/calendar":
      case "application/ics": {
        if (node.contentType.parsed.params.method) {
          attachment.method = node.contentType.parsed.params.method.toString().toUpperCase().trim();
        }
        const decodedText = node.getTextContent();
        let end = decodedText.length;
        while (end > 0 && decodedText.charCodeAt(end - 1) === 10) {
          end--;
        }
        attachment.content = textEncoder.encode(decodedText.slice(0, end) + "\n");
        break;
      }
      // Regular attachments
      default:
        attachment.content = content;
    }
    this.attachments.push(attachment);
  }
  // Joins the collected text parts into the plain and html bodies
  /** @internal */
  renderTextContent() {
    const textContent = {};
    this.textMap.forEach((mapEntry) => {
      this.textTypes.forEach((textType) => {
        const output = textContent[textType] || [];
        textContent[textType] = output;
        const ownEntries = mapEntry[textType];
        const entries = ownEntries || mapEntry[textType === "html" ? "plain" : "html"] || [];
        for (const textEntry of entries) {
          output.push(renderEntry(textEntry, textType, !ownEntries));
        }
      });
    });
    Object.keys(textContent).forEach((textType) => {
      this.textContent[textType] = textContent[textType].join("\n");
    });
  }
  /** @internal */
  isInlineTextNode(node) {
    if (node.contentDisposition.parsed.value === "attachment") {
      return false;
    }
    switch (node.contentType.parsed.value) {
      case "text/html":
      case "text/plain":
        return true;
      case "text/calendar":
      case "text/csv":
      default:
        return false;
    }
  }
  /** @internal */
  isInlineMessageRfc822(node) {
    if (this.forceRfc822Attachments || node.contentType.parsed.value !== "message/rfc822") {
      return false;
    }
    const encoding = node.contentTransferEncoding.encoding;
    if (encoding === "base64" || encoding === "quoted-printable") {
      return false;
    }
    let disposition = node.contentDisposition.parsed.value || (this.options.rfc822Attachments ? "attachment" : "inline");
    return disposition === "inline";
  }
  // A delivery status or feedback report carries the offending message as a part. It is
  // evidence rather than content, so it is not inlined into the body of the report
  /** @internal */
  hasReportParts() {
    let found = false;
    let walk = (node) => {
      if (!node.contentType.multipart) {
        if (["message/delivery-status", "message/feedback-report"].includes(node.contentType.parsed.value)) {
          found = true;
        }
      }
      for (let childNode of node.childNodes) {
        walk(childNode);
      }
    };
    walk(this.root);
    return found;
  }
  /** @internal */
  async resolveStream(stream) {
    let chunkLen = 0;
    let chunks = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!ArrayBuffer.isView(value)) {
        const error = createError("EINVALIDINPUT", "Stream chunks must be Uint8Array values");
        reader.cancel(error).catch(() => {
        });
        throw error;
      }
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      chunkLen += value.byteLength;
    }
    const result = new Uint8Array(chunkLen);
    let chunkPointer = 0;
    for (let chunk of chunks) {
      result.set(chunk, chunkPointer);
      chunkPointer += chunk.length;
    }
    return result;
  }
  /** @internal */
  async resolveInput(buf) {
    let input = buf;
    if (isReadableStream(input)) {
      input = await this.resolveStream(input);
    }
    input = input || new ArrayBuffer(0);
    if (typeof input === "string") {
      input = textEncoder.encode(input);
    }
    if (isBlob(input)) {
      input = await blobToArrayBuffer(input);
    }
    if (ArrayBuffer.isView(input)) {
      return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }
    if (!isArrayBuffer(input)) {
      throw createError("EINVALIDINPUT", "Unsupported email input type");
    }
    return input;
  }
  // Properties are added in the order the output has always had them, so the required
  // ones are filled in below rather than in the literal
  /** @internal */
  buildMessage() {
    const headers = this.root.headers;
    const message = {
      headers: headers.map((entry) => ({
        key: entry.key,
        originalKey: entry.originalKey,
        value: entry.value
      }))
    };
    for (const key of ["from", "sender"]) {
      const addressHeader = headers.find((line2) => line2.key === key);
      if (addressHeader && addressHeader.value) {
        const addresses = address_parser_default(addressHeader.value);
        if (addresses && addresses.length) {
          message[key] = addresses[0];
        }
      }
    }
    for (const [key, camelKey] of [
      ["delivered-to", "deliveredTo"],
      ["return-path", "returnPath"]
    ]) {
      const addressHeader = headers.find((line2) => line2.key === key);
      if (addressHeader && addressHeader.value) {
        const addresses = address_parser_default(addressHeader.value);
        if (addresses && addresses.length && addresses[0].address) {
          message[camelKey] = addresses[0].address;
        }
      }
    }
    for (const [key, camelKey] of [
      ["to", "to"],
      ["cc", "cc"],
      ["bcc", "bcc"],
      ["reply-to", "replyTo"]
    ]) {
      const addresses = [];
      for (const entry of headers) {
        if (entry.key === key && entry.value) {
          for (const address of address_parser_default(entry.value)) {
            addresses.push(address);
          }
        }
      }
      if (addresses.length) {
        message[camelKey] = addresses;
      }
    }
    for (const [key, camelKey] of [
      ["subject", "subject"],
      ["message-id", "messageId"],
      ["in-reply-to", "inReplyTo"],
      ["references", "references"]
    ]) {
      const header = headers.find((line2) => line2.key === key);
      if (header && header.value) {
        message[camelKey] = decodeWords(header.value);
      }
    }
    let dateHeader = headers.find((line2) => line2.key === "date");
    if (dateHeader) {
      let date = new Date(dateHeader.value);
      message.date = date.toString() === "Invalid Date" ? dateHeader.value : date.toISOString();
    }
    const otp = getOtp(headers);
    if (otp) {
      message.otp = otp;
    }
    if (this.textContent.html) {
      message.html = this.textContent.html;
    }
    if (this.textContent.plain) {
      message.text = this.textContent.plain;
    }
    message.attachments = this.attachments;
    message.headerLines = this.root.rawHeaderLines.slice();
    return message;
  }
  // Every attachment holds binary content at this point, since nested parsers are
  // created with the arraybuffer encoding. The string check narrows the public content
  // type rather than handling a reachable case
  /** @internal */
  encodeAttachments() {
    switch (this.attachmentEncoding) {
      case "arraybuffer":
        break;
      case "base64":
        for (let attachment of this.attachments) {
          if (attachment.content && typeof attachment.content !== "string") {
            attachment.content = base64ArrayBuffer(attachment.content);
            attachment.encoding = "base64";
          }
        }
        break;
      case "utf8": {
        let attachmentDecoder = new TextDecoder("utf8");
        for (let attachment of this.attachments) {
          if (attachment.content && typeof attachment.content !== "string") {
            attachment.content = attachmentDecoder.decode(attachment.content);
            attachment.encoding = "utf8";
          }
        }
        break;
      }
    }
  }
  /**
   * Parses a raw email message. A parser instance can be used once
   *
   * @param buf Raw email message
   * @returns The parsed email
   */
  async parse(buf) {
    if (this.started) {
      throw createError("EPARSERREUSED", "Can not reuse parser, create a new PostalMime object");
    }
    this.started = true;
    this.buf = await this.resolveInput(buf);
    this.av = new Uint8Array(this.buf);
    this.readPos = 0;
    while (this.readPos < this.av.length) {
      const line2 = this.readLine();
      await this.processLine(line2.bytes, line2.lineBreak, line2.done);
    }
    this.forceRfc822Attachments = Boolean(this.options.forceRfc822Attachments) || this.hasReportParts();
    await this.collectNode(this.root, false, false);
    if (this.rfc822NestingDepth === 0) {
      this.renderTextContent();
    }
    const message = this.buildMessage();
    this.encodeAttachments();
    return message;
  }
};

// src/data/categories.json
var categories_default = [
  {
    slug: "business-operations",
    label: "Business & Operations",
    count: 358,
    purpose: "Run the back office: invoices, reports, vendors, process and team admin.",
    updated: "2026-10-28"
  },
  {
    slug: "calendar-meetings-scheduling",
    label: "Calendar, Meetings & Scheduling",
    count: 120,
    purpose: "Book, move and prepare for meetings without the back-and-forth.",
    updated: "2026-10-28"
  },
  {
    slug: "coding-software",
    label: "Coding & Software",
    count: 574,
    purpose: "Write, review, debug and ship code with a bot at your side.",
    updated: "2026-10-28"
  },
  {
    slug: "email-inbox",
    label: "Email & Inbox",
    count: 300,
    purpose: "Triage, draft and tame your inbox.",
    updated: "2026-10-28"
  },
  {
    slug: "everything-else",
    label: "Everything Else",
    count: 65,
    purpose: "Bots that do not fit a box, from niche tools to one-off ideas.",
    updated: "2026-10-28"
  },
  {
    slug: "family-kids-learning",
    label: "Family, Kids & Learning",
    count: 331,
    purpose: "Homework help, learning plans, and family organising.",
    updated: "2026-10-28"
  },
  {
    slug: "food-recipes-dining",
    label: "Food, Recipes & Dining",
    count: 175,
    purpose: "Plan meals, cook from what you have, and pick where to eat.",
    updated: "2026-10-28"
  },
  {
    slug: "fun-games-hobbies",
    label: "Fun, Games & Hobbies",
    count: 146,
    purpose: "Games, hobbies and play.",
    updated: "2026-10-28"
  },
  {
    slug: "grok-bot-helpers-bots-that-build-or-manage-bots",
    label: "Grok Bot Helpers (Bots That Build or Manage Bots)",
    count: 503,
    purpose: "Bots that build, tune or manage other Grok bots.",
    updated: "2026-10-28"
  },
  {
    slug: "health-fitness-wellness",
    label: "Health, Fitness & Wellness",
    count: 190,
    purpose: "Training plans, nutrition, sleep and everyday wellness questions.",
    updated: "2026-10-28"
  },
  {
    slug: "home-garden-pets",
    label: "Home, Garden & Pets",
    count: 278,
    purpose: "Home projects, gardens and pet care.",
    updated: "2026-10-28"
  },
  {
    slug: "jobs-careers",
    label: "Jobs & Careers",
    count: 239,
    purpose: "Resumes, job search, interviews and career moves.",
    updated: "2026-10-28"
  },
  {
    slug: "legal-tax-paperwork",
    label: "Legal, Tax & Paperwork",
    count: 145,
    purpose: "Understand forms, filings and everyday legal and tax paperwork.",
    updated: "2026-10-28"
  },
  {
    slug: "marketing-seo-ads",
    label: "Marketing, SEO & Ads",
    count: 246,
    purpose: "Campaigns, search visibility, ad copy and content plans.",
    updated: "2026-10-28"
  },
  {
    slug: "money-personal-finance",
    label: "Money & Personal Finance",
    count: 340,
    purpose: "Budgets, bills, savings and everyday money decisions.",
    updated: "2026-10-28"
  },
  {
    slug: "privacy-security-scam-protection",
    label: "Privacy, Security & Scam Protection",
    count: 233,
    purpose: "Stop spam calls, spot scams, and lock down your data.",
    updated: "2026-10-28"
  },
  {
    slug: "productivity-personal-assistant",
    label: "Productivity & Personal Assistant",
    count: 550,
    purpose: "Tasks, notes, reminders and a personal assistant for the day.",
    updated: "2026-10-28"
  },
  {
    slug: "real-estate",
    label: "Real Estate",
    count: 61,
    purpose: "Search, compare and manage property, as a buyer, seller or landlord.",
    updated: "2026-10-28"
  },
  {
    slug: "research-news-briefings",
    label: "Research, News & Briefings",
    count: 731,
    purpose: "Research a topic, follow the news, and get a short briefing.",
    updated: "2026-10-28"
  },
  {
    slug: "sales-lead-generation",
    label: "Sales & Lead Generation",
    count: 253,
    purpose: "Find leads, write outreach and keep a pipeline moving.",
    updated: "2026-10-28"
  },
  {
    slug: "shopping-deals",
    label: "Shopping & Deals",
    count: 253,
    purpose: "Compare prices, find deals, and decide what to buy.",
    updated: "2026-10-28"
  },
  {
    slug: "trading-crypto-investing",
    label: "Trading, Crypto & Investing",
    count: 353,
    purpose: "Markets, crypto and investing research and tracking.",
    updated: "2026-10-28"
  },
  {
    slug: "travel",
    label: "Travel",
    count: 123,
    purpose: "Plan trips, find routes, and handle the details of getting there.",
    updated: "2026-10-28"
  },
  {
    slug: "video-images-audio-design",
    label: "Video, Images, Audio & Design",
    count: 543,
    purpose: "Make and edit video, images, audio and design work.",
    updated: "2026-10-28"
  },
  {
    slug: "writing-publishing",
    label: "Writing & Publishing",
    count: 321,
    purpose: "Draft, edit and publish writing of every length.",
    updated: "2026-10-28"
  },
  {
    slug: "x-twitter-social-media",
    label: "X (Twitter) & Social Media",
    count: 286,
    purpose: "Post, grow and manage your presence on X and other social platforms.",
    updated: "2026-10-28"
  }
];

// src/lib/submissions.ts
var BOT_LINK_RE = /^https:\/\/x\.ai\/bot\/([A-Za-z0-9_-]{4,64})$/i;
var BOT_LINK_SCAN = /https:\/\/x\.ai\/bot\/([A-Za-z0-9_-]{4,64})(?![A-Za-z0-9_-])/gi;
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
var singleLine = (s) => s.replace(CONTROL_RUN, " ").trim();
var str = (v) => typeof v === "string" ? v.trim() : void 0;
var line = (v) => typeof v === "string" ? singleLine(v) : void 0;
function isEmail(v) {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);
}
function honeypotOk(v) {
  return v === void 0 || v === null || v === "";
}
function fillTimeOk(v, minMs) {
  return typeof v === "number" && Number.isInteger(v) && v >= minMs;
}
function parseBotLink(link) {
  const m = BOT_LINK_RE.exec(link);
  return m ? { link: `https://x.ai/bot/${m[1].toLowerCase()}`, code: m[1] } : null;
}
function validateSubmission(body, categorySlugs, minFillMs) {
  const b = body && typeof body === "object" ? body : {};
  const errors = {};
  const name = line(b.name);
  if (!name || name.length < 3 || name.length > 120) errors.name = "required, 3-120 characters";
  const author = b.author === void 0 || b.author === null || b.author === "" ? null : line(b.author);
  if (author !== null && (author === void 0 || author.length > 80)) errors.author = "at most 80 characters";
  const description = line(b.description);
  if (!description || description.length < 10 || description.length > 500) errors.description = "required, 10-500 characters";
  const linkRaw = str(b.link);
  const parsed = linkRaw ? parseBotLink(linkRaw) : null;
  if (!parsed) errors.link = "must look like https://x.ai/bot/<code>";
  const category = str(b.category);
  if (!category || !categorySlugs.has(category)) errors.category = "must be one of the listed categories";
  if (!isEmail(b.email)) errors.email = "required, a valid email address";
  if (!honeypotOk(b.company_website)) errors.company_website = "must be empty";
  if (!fillTimeOk(b.filled_ms, minFillMs)) errors.filled_ms = "too fast";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      author,
      description,
      link: parsed.link,
      code: parsed.code,
      category,
      email: b.email.toLowerCase()
    }
  };
}
function ackAuthorized(authResults, envelopeFrom, headerFromRaw) {
  const env = envelopeFrom.trim().toLowerCase();
  if (!env || !authResults) return false;
  const seg = authResults.trim().split(",")[0];
  if ((seg.match(/\(/g) ?? []).length !== (seg.match(/\)/g) ?? []).length) return false;
  const first = seg.replace(/\([^)]*\)/g, " ");
  if (!/^mx\.cloudflare\.net\b/i.test(first)) return false;
  const spf = first.split(";").find((c) => /^\s*spf=/i.test(c));
  if (!spf || !/^\s*spf=pass\b/i.test(spf)) return false;
  const mailfrom = /\bsmtp\.mailfrom=("?)([^\s";]+)\1/i.exec(spf)?.[2].replace(/^<|>$/g, "").toLowerCase();
  if (mailfrom !== env) return false;
  const bare = (headerFromRaw ?? "").replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\([^)]*\)/g, " ");
  const addrs = bare.match(/[^\s<>@,;:"()]+@[^\s<>@,;:"()]+/g) ?? [];
  return addrs.length === 1 && addrs[0].toLowerCase() === env;
}
function makeToken(rand = (a) => crypto.getRandomValues(a)) {
  return [...rand(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
var TOKEN_RE = /^[0-9a-f]{32}$/;
function extractCodes(...texts) {
  const seen = /* @__PURE__ */ new Map();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(BOT_LINK_SCAN)) if (!seen.has(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), m[1]);
  }
  return [...seen.values()];
}
function digestRecipientCount(active, cap) {
  return Math.max(0, Math.min(active, Number.isFinite(cap) ? cap : 0));
}
var isOn = (v) => v === "1";
function firstDescriptionLine(text) {
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const text2 = singleLine(raw.replace(BOT_LINK_SCAN, "").replace(/\s+/g, " "));
    if (text2.length >= 3 && !text2.startsWith(">")) return text2.slice(0, 500);
  }
  return "(no description supplied)";
}
var oneLine = singleLine;
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var htmlNote = (text) => `<p>${esc(text).replace(/\n/g, "<br>")}</p>`;
var SITE = "https://grokbot.zone";
function ackText(name, link) {
  return `Hi \u2014 we got "${name}" (${link}).
It is queued. Once the platform page checks out, the bot is added to the site automatically, usually within an hour.
\u2014 GrokBot Zone \xB7 ${SITE}/recent/`;
}
function ownerSummary(r) {
  const f = (label, v) => `${label}: ${v === null ? "\u2014" : singleLine(v)}`;
  return {
    subject: oneLine(`[GZ] new submission #${r.id} \u2014 ${r.name} (${r.source})`),
    text: [
      "FYI: processed automatically, nothing to approve. It goes live when the platform page checks out.",
      "",
      "Submitted fields (untrusted):",
      f("name", r.name),
      f("author", r.author),
      f("category", r.category),
      f("link", r.link),
      f("submitter", r.submitter),
      f("ip", r.ip),
      f("source", r.source),
      f("description", r.description)
    ].join("\n")
  };
}
var postalLine = (v) => typeof v === "string" ? singleLine(v) : "";
function confirmMail(token, postal = "") {
  const url = `${SITE}/subscribe/confirm?t=${token}`;
  const addr = postalLine(postal);
  const foot = ["If you did not ask for this, ignore this email and nothing will happen.", addr ? `GrokBot Zone, ${addr}` : ""].filter(Boolean);
  const text = `Confirm: ${url}
You'll get an update email Monday and Thursday. Nothing happens until you confirm.

-- 
${foot.join("\n")}`;
  const html = `<p>Confirm your subscription to GrokBot Zone updates:</p><p><a href="${url}">Confirm my subscription</a></p><p>You'll get an update email Monday and Thursday. Nothing happens until you confirm.</p><hr><p style="color:#666;font-size:12px">${foot.map(esc).join("<br>")}</p>`;
  return { subject: "Confirm your GrokBot Zone update emails", text, html };
}
var firstSentence = (s) => (/^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s).slice(0, 200);
function digestMail(p, weekday, unsubToken, postal = "") {
  const addr = postalLine(postal);
  const unsub = `${SITE}/subscribe/unsubscribe?t=${unsubToken}`;
  const lines = p.top.slice(0, 10).map((b, i) => `${i + 1}. ${b.name} \u2014 ${firstSentence(b.description)} \u2192 ${SITE}/bots/${b.id}/`);
  const head = `${p.asOf} \u2014 ${p.totalBots} bots in ${p.categoryCount} categories.`;
  return {
    subject: `GrokBot Zone: ${p.totalBots} bots tracked + the ${weekday} top 10`,
    text: `${head}
${lines.join("\n")}

-- 
${addr ? `GrokBot Zone, ${addr}
` : ""}You get this because you confirmed a subscription.
Unsubscribe: ${unsub}`,
    html: `<p>${esc(head)}</p><table>${p.top.slice(0, 10).map((b, i) => `<tr><td>${i + 1}.</td><td><a href="${SITE}/bots/${esc(b.id)}/">${esc(b.name)}</a> \u2014 ${esc(firstSentence(b.description))}</td></tr>`).join("")}</table><hr><p style="color:#666;font-size:12px">${addr ? `GrokBot Zone, ${esc(addr)}<br>` : ""}You get this because you confirmed a subscription.<br><a href="${unsub}">Unsubscribe</a></p>`,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
  };
}
var b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{1,76}/g, "$&\r\n").trimEnd();
};
var ascii = (s) => /^[\x20-\x7e]*$/.test(s);
function rawReply(r) {
  const subject = oneLine(r.subject);
  const domain = r.from.split("@")[1] ?? "grokbot.zone";
  const h = [
    `From: <${r.from}>`,
    `To: <${r.to}>`,
    `Subject: ${ascii(subject) ? subject : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`}`,
    `Date: ${(r.now ?? /* @__PURE__ */ new Date()).toUTCString()}`,
    `Message-ID: <${r.id ?? makeToken()}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-replied"
  ];
  if (r.inReplyTo) h.push(`In-Reply-To: ${oneLine(r.inReplyTo)}`, `References: ${oneLine(r.inReplyTo)}`);
  const body = r.text.replace(/\r?\n/g, "\r\n");
  if (ascii(body.replace(/\r\n/g, ""))) h.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", body);
  else h.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(body));
  return h.join("\r\n") + "\r\n";
}

// src/worker/media.ts
var TYPES = { mp4: "video/mp4", webp: "image/webp" };
var CACHE = "public, max-age=31536000, immutable";
function parseRange(header, size) {
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? "");
  if (!m || m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return null;
  return start >= size ? "unsatisfiable" : { start, end: m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) };
}
var isMediaRequest = (request, url) => (request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/");
async function serveMedia(request, assets, url) {
  const res = await assets.fetch(new Request(url.toString()));
  if (res.status !== 200 || res.headers.has("content-encoding")) return res;
  const head = request.method === "HEAD";
  const ext = url.pathname.split(".").pop() ?? "";
  const base = {
    "Accept-Ranges": "bytes",
    "Content-Type": TYPES[ext] ?? res.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": CACHE
  };
  const etag = res.headers.get("etag");
  if (etag) base.ETag = etag;
  let size = Number(res.headers.get("content-length"));
  let bytes = null;
  if (!Number.isFinite(size) || res.headers.get("content-length") === null) {
    bytes = new Uint8Array(await res.arrayBuffer());
    size = bytes.length;
  }
  const drop = () => bytes ? void 0 : res.body?.cancel();
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    await drop();
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
  }
  if (!range) {
    const headers2 = { ...base, "Content-Length": String(size) };
    if (head) {
      await drop();
      return new Response(null, { status: 200, headers: headers2 });
    }
    return new Response(bytes ?? res.body, { status: 200, headers: headers2 });
  }
  const length = range.end - range.start + 1;
  const headers = { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(length) };
  if (head) {
    await drop();
    return new Response(null, { status: 206, headers });
  }
  bytes ??= new Uint8Array(await res.arrayBuffer());
  return new Response(bytes.subarray(range.start, range.end + 1), { status: 206, headers });
}

// src/data/classifier.json
var classifier_default = { v: 1, cats: ["business-operations", "calendar-meetings-scheduling", "coding-software", "email-inbox", "everything-else", "family-kids-learning", "food-recipes-dining", "fun-games-hobbies", "grok-bot-helpers-bots-that-build-or-manage-bots", "health-fitness-wellness", "home-garden-pets", "jobs-careers", "legal-tax-paperwork", "marketing-seo-ads", "money-personal-finance", "privacy-security-scam-protection", "productivity-personal-assistant", "real-estate", "research-news-briefings", "sales-lead-generation", "shopping-deals", "trading-crypto-investing", "travel", "video-images-audio-design", "writing-publishing", "x-twitter-social-media"], min: 24, margin: 6, tokens: { grok: [8, 12], job: [11, 17], bot: [8, 7], video: [23, 12, 25, 3], bots: [8, 10], inbox: [3, 15], news: [18, 13, 7, 3], stock: [21, 17], security: [15, 19], fantasy: [7, 20, 21, 4], draft: [24, 8, 3, 4], home: [10, 14, 17, 6], money: [14, 15, 17, 6], health: [9, 18], staff: [16, 11, 0, 4], travel: [22, 22], deal: [20, 16, 22, 5], school: [5, 17, 17, 4], chief: [16, 10, 0, 3], music: [23, 17], post: [25, 9, 24, 5], parent: [5, 20], resume: [11, 23], gmail: [3, 15], trade: [21, 14, 7, 11], family: [5, 14, 22, 5], broker: [15, 22], recipe: [6, 23], fitness: [9, 26], grocery: [6, 22, 20, 4], watch: [18, 11], email: [3, 9, 15, 5], code: [2, 11], trading: [21, 18], application: [11, 19], trip: [22, 19], meal: [6, 17, 9, 10], coding: [2, 13], bill: [14, 14, 12, 4], growth: [13, 17], research: [18, 8, 21, 4], clip: [23, 15], lead: [19, 12, 17, 5], youtube: [23, 14, 25, 5], opt: [15, 23], crypto: [21, 17], ops: [0, 11, 17, 4], source: [18, 8], customer: [19, 15, 3, 4], watche: [18, 6], flight: [22, 20, 17, 6], language: [5, 13, 12, 5], tailor: [11, 26, 17, 4], role: [11, 16], template: [8, 14], kids: [5, 17], team: [0, 8, 7, 6], football: [7, 19, 21, 6], option: [21, 14, 7, 7], price: [20, 11, 17, 5], seo: [13, 16], brief: [18, 7, 13, 3], data: [15, 11, 7, 7], coach: [9, 10, 7, 4], study: [5, 21, 17, 3], food: [6, 17, 9, 7], outs: [15, 22, 17, 3], car: [10, 16, 17, 6], waiver: [7, 19, 21, 7], search: [15, 11, 11, 8], subscription: [14, 13], career: [11, 23, 17, 4], business: [0, 9, 12, 5], jobs: [11, 14], game: [7, 14, 5, 4], song: [23, 16], repo: [2, 12, 15, 7], site: [15, 10, 13, 5], buy: [20, 14, 17, 8], into: [23, 4], ads: [13, 14, 6, 3], people: [15, 10], github: [2, 12, 15, 4], tutor: [5, 22, 17, 4], engineer: [2, 12, 11, 3], scam: [15, 15, 17, 5], spam: [15, 15, 3, 6], meeting: [1, 16, 19, 4], social: [25, 11, 13, 6], image: [23, 11, 24, 3], shop: [20, 13, 6, 4], turn: [23, 5], track: [18, 5, 12, 4], doctor: [9, 19, 12, 3], brand: [13, 12, 20, 5], medical: [9, 21, 12, 6], ebay: [20, 21, 17, 4], calendar: [1, 11, 3, 5], digest: [18, 7], bookmark: [25, 16, 6, 4], other: [8, 8], dinner: [6, 19, 5, 7], launch: [13, 13], workout: [9, 21, 12, 4], privacy: [15, 19, 22, 4], voice: [23, 7, 24, 5], wallet: [21, 17], agent: [17, 7, 2, 6], art: [23, 14], company: [0, 12], property: [17, 24, 14, 6], tax: [12, 18, 17, 7], return: [20, 13, 12, 8], lineup: [7, 17, 21, 6], app: [2, 9, 15, 4], instagram: [25, 18, 22, 4], triage: [3, 13], website: [2, 10, 13, 6], kitchen: [6, 20, 5, 4], engineering: [2, 13, 15, 4], content: [24, 11, 13, 8], bank: [14, 15, 12, 6], sleep: [9, 22, 17, 5], copy: [24, 12, 13, 5], lyric: [23, 21, 17, 5], token: [21, 12, 8, 4], spending: [14, 19, 12, 5], task: [0, 10, 8, 3], student: [5, 17, 10, 5], solana: [21, 20, 17, 5], legal: [12, 17, 15, 5], receipt: [14, 11, 12, 5], morning: [18, 5, 3, 4], podcast: [23, 13, 25, 3], child: [5, 21, 17, 5], training: [9, 16, 1, 6], design: [23, 8, 8, 4], prs: [2, 16, 17, 4], cli: [2, 12], interview: [11, 13, 0, 3], house: [10, 16, 17, 11], removal: [15, 21, 17, 5], household: [10, 11, 6, 9], maintenance: [10, 18, 17, 9], linkedin: [25, 12, 11, 8], opening: [11, 16, 7, 5], finance: [14, 15, 1, 4], companion: [7, 12, 22, 4], insurance: [12, 16, 9, 7], claude: [2, 10, 8, 6], pipeline: [19, 14, 11, 5], caption: [23, 12, 25, 6], earning: [21, 20, 17, 5], newsletter: [3, 16, 24, 4], photo: [23, 7, 6, 6], point: [22, 15, 7, 4], list: [6, 8], marketing: [13, 13, 3, 4], audio: [23, 14, 1, 4], routine: [8, 9, 9, 5], amazon: [20, 16, 6, 5], tracker: [18, 8, 9, 6], budget: [14, 10, 6, 7], thread: [25, 12, 1, 6], kid: [5, 20, 7, 6], spend: [14, 12, 6, 4], project: [0, 9], lesson: [5, 14], chef: [6, 19, 5, 7], outbound: [19, 17, 1, 5], teacher: [5, 16, 17, 4], intelligence: [18, 13, 22, 4], sale: [19, 11, 20, 6], find: [11, 5, 15, 4], mail: [3, 10, 1, 5], grokbot: [8, 14], writer: [24, 13, 13, 5], nutrition: [9, 22, 17, 6], hiring: [11, 18, 12, 5], recheck: [15, 23, 17, 6], ticker: [21, 17, 17, 5], hotel: [22, 22, 17, 5], fleet: [8, 9], scrubber: [15, 21, 17, 6], assistant: [16, 4, 12, 4], software: [2, 12], cart: [6, 15, 20, 9], tiktok: [25, 14, 13, 5], sit: [7, 18, 21, 7], footage: [23, 17, 17, 5], apps: [2, 9, 15, 8], crm: [19, 15, 17, 8], note: [1, 7, 16, 6], menu: [6, 19, 17, 5], itinerarie: [22, 25, 17, 7], phone: [15, 10, 3, 4], homework: [5, 21, 17, 6], daily: [9, 4, 18, 3], credit: [14, 10, 12, 5], studio: [23, 8, 13, 5], gift: [20, 15, 17, 8], learning: [5, 16, 17, 4], unsubscribe: [3, 19, 17, 6], gym: [9, 21, 17, 6], slack: [0, 11, 19, 6], usage: [8, 8], captain: [7, 16, 22, 4], weather: [10, 12, 22, 10], league: [7, 17, 17, 8], shopping: [20, 13, 6, 12], specialist: [16, 6, 0, 5], cursor: [2, 10], cook: [6, 21, 5, 7], trader: [21, 19, 17, 6], skill: [8, 8, 2, 4], market: [21, 9, 18, 6], plan: [6, 7, 22, 6], invoice: [14, 12, 1, 5], inventory: [10, 14, 20, 7], outlook: [3, 15, 17, 4], pantry: [6, 18, 17, 5], media: [25, 12], remove: [15, 18, 17, 5], gtm: [19, 17, 17, 5], contract: [12, 17, 7, 4], espn: [7, 19, 22, 7], restaurant: [6, 16, 22, 7], call: [15, 7, 19, 6], reply: [3, 9, 25, 7], operation: [0, 14, 17, 8], story: [24, 11, 25, 5], planner: [6, 12, 22, 10], transcript: [1, 14, 23, 5], writing: [24, 13, 17, 3], buys: [20, 13, 21, 7], posting: [11, 12, 25, 7], competitor: [13, 13, 19, 7], bitcoin: [21, 17, 17, 6], make: [23, 6], investor: [21, 16, 12, 6], director: [23, 12, 4, 7], expense: [14, 15, 17, 9], fit: [11, 10, 19, 4], briefing: [18, 9, 7, 4], schedule: [1, 10, 25, 5], founder: [19, 8, 0, 8], account: [25, 6, 13, 5], monitor: [18, 8, 13, 7], robinhood: [21, 17, 22, 7], build: [7, 5, 6, 4], repair: [10, 15, 12, 7], lodging: [22, 28, 17, 9], short: [23, 3], applie: [11, 14, 17, 8], product: [20, 7, 13, 6], blog: [24, 15, 13, 5], fridge: [6, 19, 17, 6], style: [23, 6, 17, 4], cash: [14, 11, 22, 7], tailored: [11, 17, 22, 7], desk: [12, 4, 21, 4], start: [7, 12, 4, 3], mcp: [2, 11, 17, 7], bug: [2, 17, 17, 6], quizze: [5, 17, 17, 6], quiz: [5, 24, 17, 8], campaign: [13, 14, 1, 6], ats: [11, 22, 17, 8], plant: [10, 18, 17, 6], hike: [14, 24, 17, 8], send: [3, 4], court: [12, 18, 17, 5], number: [15, 10, 17, 4], shot: [23, 11, 22, 6], moving: [10, 13, 17, 7], risk: [21, 9, 12, 6], portfolio: [21, 13, 17, 4], avatar: [23, 13, 8, 6], coffee: [6, 21, 17, 7], meme: [23, 14, 17, 5], suno: [23, 19, 17, 7], paperwork: [12, 17, 22, 6], film: [23, 13, 13, 7], board: [0, 9, 11, 7], sold: [20, 15, 17, 11], confirmation: [15, 16, 22, 6], small: [0, 5, 12, 5], retailer: [20, 17, 17, 6], codex: [2, 10, 8, 7], imagine: [23, 13, 17, 5], store: [6, 8, 20, 8], info: [15, 14, 17, 8], startup: [0, 12, 5, 4], deploy: [2, 11, 17, 3], follower: [25, 14, 15, 7], learn: [5, 8, 6, 4], listing: [17, 13, 20, 8], developer: [2, 13, 12, 5], hunt: [11, 10, 20, 6], cloud: [2, 8, 14, 4], sleeper: [7, 19, 21, 9], prospect: [19, 16, 17, 6], visual: [23, 12, 17, 4], route: [22, 7, 16, 6], destination: [22, 24, 17, 8], api: [2, 9, 8, 5], resale: [20, 21, 17, 8], lawyer: [12, 27, 17, 9], scene: [23, 12, 4, 8], realtor: [17, 27, 12, 10], installer: [8, 12, 17, 4], shield: [15, 19, 17, 7], ship: [2, 6, 7, 5], get: [23, 4], play: [7, 13, 23, 3], client: [0, 9, 13, 6], recovery: [9, 15, 17, 9], compliance: [12, 18, 15, 7], new: [17, 5, 18, 3], mac: [2, 8, 1, 4], supplement: [9, 25, 17, 9], wearable: [9, 25, 17, 9], dispute: [12, 16, 14, 8], investing: [21, 19, 17, 8], article: [24, 10, 25, 8], check: [9, 4, 15, 4], best: [20, 8, 22, 5], talent: [11, 25, 17, 9], rental: [17, 17, 22, 13], replie: [25, 7, 3, 6], strength: [9, 17, 17, 6], calorie: [9, 14, 6, 10], tech: [18, 7, 20, 4], apply: [11, 13, 8, 4], charge: [14, 11, 4, 7], topic: [25, 7, 18, 5], hubspot: [19, 24, 17, 9], keyword: [13, 13, 1, 5], explainer: [23, 10, 4, 6], coordinate: [16, 8, 17, 6], creator: [25, 7, 23, 6], notion: [0, 9, 19, 5], matching: [11, 13, 12, 4], transfer: [7, 15, 22, 10], book: [22, 7, 24, 7], finished: [23, 9, 24, 4], itinerary: [22, 23, 17, 9], ingredient: [6, 20, 17, 8], obsidian: [16, 13, 17, 6], debt: [14, 15, 12, 9], appliance: [10, 20, 17, 8], analytic: [13, 18, 17, 7], education: [5, 16, 17, 7], submit: [15, 11, 11, 9], captioned: [23, 14, 7, 7], apartment: [17, 26, 4, 8], reviewer: [2, 10, 12, 4], owed: [14, 14, 22, 9], xero: [14, 19, 12, 9], review: [2, 3], weeknight: [6, 25, 17, 10], report: [15, 4, 13, 4], dish: [6, 22, 17, 9], forgotten: [14, 13, 17, 9], engagement: [25, 15, 13, 8], month: [14, 10, 3, 4], still: [23, 8, 17, 6], viral: [25, 14, 17, 5], storyboard: [23, 21, 17, 9], aeo: [13, 17, 17, 7], builder: [2, 6], goal: [16, 7, 9, 5], item: [1, 9, 20, 9], simple: [9, 11, 6, 6], public: [25, 5, 17, 4], card: [14, 6, 20, 5], render: [23, 13, 17, 6], habit: [9, 13, 1, 5], weekly: [7, 6, 6, 5], pet: [10, 13, 17, 10], buying: [20, 13, 6, 9], meta: [13, 13, 22, 6], work: [0, 4], editor: [24, 10, 23, 7], tesla: [10, 9, 16, 4], reference: [23, 12, 17, 5], cinematic: [23, 16, 17, 8], cooking: [6, 18, 5, 8], eggbot: [8, 18, 17, 8], bookkeeping: [14, 14, 12, 12], estate: [17, 18, 12, 11], fraud: [15, 18, 17, 8], letter: [12, 12, 11, 9], decision: [4, 8, 1, 6], refund: [14, 11, 12, 9], read: [14, 4], producer: [23, 11, 1, 5], vertical: [23, 11, 25, 7], paper: [21, 8, 18, 7], hand: [2, 5, 17, 4], animation: [23, 17, 17, 8], motion: [23, 12, 13, 8], warm: [9, 9, 17, 5], activity: [5, 11, 17, 9], life: [16, 7, 12, 5], fact: [17, 7, 18, 6], cancel: [14, 11, 3, 9], comp: [17, 15, 20, 12], cat: [10, 19, 17, 9], coupon: [20, 15, 6, 13], polymarket: [21, 17, 17, 8], are: [8, 5, 4, 5], manager: [0, 5, 7, 5], twitter: [25, 17, 7, 8], btc: [21, 22, 17, 10], eth: [21, 22, 17, 10], write: [24, 5], instruction: [8, 10, 22, 5], merge: [2, 10, 19, 5], official: [15, 5, 4, 5], edit: [23, 9, 25, 6], maker: [23, 9, 7, 5], headline: [18, 13, 17, 7], candidate: [11, 12, 18, 5], law: [12, 16, 17, 6], lease: [12, 16, 17, 11], fare: [22, 19, 17, 8], narrated: [23, 13, 17, 6], vehicle: [10, 15, 9, 8], cuts: [23, 8, 15, 6], test: [2, 5, 24, 4], faab: [7, 22, 17, 9], episode: [23, 11, 17, 5], yahoo: [7, 14, 3, 11], coinbase: [21, 19, 17, 9], compare: [22, 11, 20, 8], original: [23, 8, 25, 6], prompt: [23, 7, 7, 4], runs: [0, 3], top: [18, 6], personal: [15, 5, 9, 4], log: [9, 8, 10, 5], wine: [6, 21, 17, 9], google: [13, 6, 1, 4], beat: [23, 10, 13, 6], walmart: [20, 18, 17, 8], cover: [11, 11, 25, 6], cleanup: [3, 10, 25, 6], injurie: [7, 18, 17, 8], usdc: [21, 16, 22, 9], script: [24, 8, 17, 5], generation: [23, 21, 17, 10], prospecting: [19, 18, 17, 8], need: [3, 6], injury: [7, 15, 21, 6], voiceover: [23, 15, 17, 8], settlement: [14, 12, 17, 12], match: [11, 11, 17, 8], trend: [18, 8, 25, 4], thumbnail: [23, 13, 7, 7], through: [2, 3], audit: [8, 4, 2, 4], sourced: [18, 6, 12, 4], ftc: [15, 17, 17, 8], employer: [11, 15, 1, 8], share: [8, 7, 21, 4], season: [7, 17, 17, 7], balance: [14, 11, 0, 5], recurring: [14, 10, 1, 8], booking: [22, 13, 1, 11], shortlist: [11, 12, 17, 11], recruiting: [11, 17, 17, 8], internship: [11, 20, 17, 9], recruiter: [11, 20, 17, 9], cfo: [14, 15, 17, 7], quickbook: [14, 15, 12, 8], link: [25, 5], finishe: [15, 15, 7, 7], use: [8, 6, 15, 4], sport: [7, 12, 5, 7], pump: [21, 15, 7, 10], create: [8, 8, 4, 6], diet: [6, 16, 9, 11], exam: [5, 13, 17, 6], stay: [22, 10, 12, 3], shared: [8, 6, 0, 6], packing: [22, 19, 17, 8], paste: [24, 5, 25, 4], character: [23, 9, 4, 7], computer: [2, 5, 8, 5], off: [15, 9, 17, 5], publish: [24, 10, 25, 6], drop: [20, 7, 7, 4], fun: [7, 14, 21, 8], web: [2, 5, 13, 4], phishing: [3, 14, 15, 13], firm: [12, 14, 17, 5], agentic: [21, 14, 17, 7], protein: [9, 14, 6, 11], run: [0, 5, 8, 4], wrote: [24, 18, 17, 9], saved: [25, 11, 6, 8], pay: [14, 8, 11, 6], purchase: [20, 12, 14, 7], curriculum: [5, 18, 17, 9], reel: [25, 12, 23, 7], payday: [14, 18, 17, 9], ready: [24, 4, 17, 4], backup: [8, 9, 9, 5], clawd: [21, 22, 17, 11], memecoin: [21, 22, 17, 11], suspiciou: [15, 18, 17, 9], flow: [14, 9, 21, 6], nfl: [7, 15, 4, 10], upload: [23, 8, 1, 5], free: [15, 5, 1, 4], cited: [12, 8, 18, 7], hunter: [20, 8, 11, 7], drink: [6, 18, 10, 9], deduction: [12, 21, 17, 10], coin: [21, 15, 7, 8], setup: [8, 5, 21, 4], garage: [10, 15, 17, 8], address: [17, 12, 15, 10], tailscale: [2, 10, 22, 7], primary: [18, 8, 1, 5], each: [7, 4, 11, 3], sell: [19, 9, 20, 8], creative: [13, 9, 23, 7], service: [10, 6, 19, 4], door: [8, 6, 10, 5], alert: [17, 6, 7, 4], animated: [23, 11, 24, 7], monthly: [14, 7, 15, 7], visit: [9, 11, 17, 8], allergie: [6, 20, 17, 10], instacart: [6, 20, 17, 10], weekday: [3, 4], title: [20, 8, 23, 7], rewrite: [24, 9, 22, 9], change: [2, 4, 13, 3], garden: [10, 17, 17, 9], order: [6, 8, 20, 6], activitie: [5, 14, 22, 11], sort: [3, 9, 17, 7], text: [15, 6, 3, 4], unclaimed: [17, 18, 14, 14], exposed: [15, 17, 17, 13], injection: [15, 17, 3, 8], before: [14, 4], intel: [18, 11, 17, 7], transport: [22, 20, 17, 9], vacation: [22, 20, 17, 14], spacex: [18, 8, 21, 6], tape: [21, 14, 17, 8], inboxe: [3, 12, 0, 6], hook: [25, 9, 13, 6], niche: [25, 9, 13, 8], connector: [8, 9, 17, 4], sender: [3, 14, 4, 11], icon: [23, 16, 17, 9], chain: [21, 10, 22, 5], memory: [8, 7, 0, 5], diagram: [23, 12, 17, 7], all: [8, 5, 12, 5], award: [22, 16, 17, 7], restock: [20, 12, 17, 10], limit: [21, 9, 8, 5], outreach: [19, 7, 11, 7], marketplace: [20, 10, 17, 7], about: [18, 3], prep: [11, 7, 1, 6], indeed: [11, 19, 17, 10], repro: [2, 16, 17, 9], overlap: [8, 12, 17, 7], junk: [3, 11, 15, 10], score: [19, 6, 17, 5], icp: [19, 16, 25, 9], landing: [13, 14, 1, 8], signal: [19, 6, 21, 6], repost: [25, 16, 1, 10], risky: [7, 12, 21, 5], filing: [12, 12, 21, 7], cro: [13, 19, 17, 10], ledger: [14, 9, 4, 8], comment: [25, 10, 19, 7], fund: [21, 13, 17, 7], ideal: [19, 19, 17, 10], vet: [10, 15, 6, 11], generate: [23, 12, 17, 7], archive: [3, 9, 25, 7], analyst: [21, 7, 13, 6], fat: [9, 15, 17, 8], vercel: [2, 13, 17, 8], net: [14, 11, 20, 6], squad: [7, 15, 17, 7], fixe: [15, 7, 9, 4], page: [24, 4, 13, 4], road: [22, 15, 12, 7], due: [1, 10, 14, 8], playlist: [23, 10, 17, 5], geo: [13, 15, 17, 8], positioning: [13, 15, 19, 8], day: [22, 6], deep: [18, 6, 2, 5], beta: [12, 13, 17, 9], flag: [15, 5, 14, 4], chatgpt: [8, 8, 13, 5], fill: [6, 9, 11, 9], sets: [7, 6, 8, 5], file: [12, 5, 15, 5], patient: [5, 10, 9, 7], request: [15, 6, 2, 5], following: [25, 13, 1, 7], reminder: [1, 9, 9, 6], saving: [14, 9, 17, 8], symptom: [9, 18, 17, 9], ins: [9, 10, 16, 5], marketer: [13, 13, 19, 6], chapter: [23, 11, 24, 9], week: [6, 6, 7, 5], mobile: [2, 9, 15, 5], artist: [23, 10, 4, 9], teache: [5, 10, 8, 5], linux: [2, 10, 15, 8], herme: [8, 11, 17, 6], plain: [12, 7, 9, 4], friendly: [9, 7, 6, 6], control: [10, 8, 12, 4], slot: [1, 17, 17, 8], backtest: [21, 17, 17, 10], care: [10, 7, 9, 5], joke: [7, 14, 12, 7], transcribe: [23, 14, 1, 10], question: [12, 4], shopper: [20, 12, 6, 10], unread: [3, 14, 17, 8], hunting: [17, 13, 11, 12], promo: [3, 9, 13, 7], aisle: [6, 17, 20, 10], action: [1, 8, 3, 6], prototype: [2, 12, 17, 8], camera: [10, 10, 23, 9], fix: [2, 5, 15, 5], traveler: [22, 21, 17, 11], discovery: [19, 12, 11, 8], touch: [19, 12, 4, 9], long: [23, 6, 7, 5], engine: [24, 9, 4, 7], handoff: [0, 7, 12, 5], polished: [23, 10, 4, 10], vault: [16, 9, 9, 7], owner: [1, 7, 0, 4], event: [5, 6, 1, 6], around: [6, 8, 9, 7], scout: [17, 6, 11, 5], matchday: [7, 17, 17, 8], case: [4, 10, 12, 10], claim: [12, 7, 4, 5], relay: [8, 9, 19, 5], facebook: [17, 10, 25, 9], climate: [10, 14, 1, 9], scrub: [15, 14, 17, 7], storie: [24, 8, 18, 5], warranty: [10, 12, 20, 8], tool: [8, 5], first: [19, 3], holiday: [20, 14, 7, 8], who: [19, 4, 1, 4], swing: [21, 14, 17, 8], live: [21, 3], grade: [4, 10, 5, 8], practice: [5, 8, 9, 5], never: [24, 3], landlord: [17, 20, 12, 10], screenshot: [2, 6, 15, 5], coverage: [12, 13, 17, 6], spanish: [5, 9, 12, 6], friend: [7, 11, 6, 6], scan: [15, 6, 21, 4], reputation: [15, 16, 17, 9], multi: [0, 5], appointment: [1, 11, 9, 10], counsel: [12, 16, 17, 8], summary: [1, 7, 17, 6], something: [10, 5, 18, 5], used: [10, 10, 20, 9], coder: [2, 11, 17, 7], effort: [2, 11, 17, 7], agenda: [1, 16, 17, 8], logs: [9, 7, 6, 5], mock: [11, 16, 22, 10], password: [15, 13, 17, 7], help: [12, 4, 15, 4], allergy: [6, 20, 17, 11], sommelier: [6, 20, 17, 11], gif: [23, 16, 17, 10], narration: [23, 16, 17, 10], printing: [23, 16, 17, 10], message: [3, 6, 17, 3], premium: [21, 11, 13, 7], chat: [8, 3], logo: [23, 13, 17, 8], businesse: [19, 7, 0, 6], scholarship: [5, 16, 17, 9], connected: [3, 10, 1, 9], mp4: [23, 11, 13, 11], transaction: [14, 15, 6, 9], contact: [19, 9, 1, 8], fees: [12, 10, 14, 10], clear: [3, 5], grow: [13, 11, 25, 7], x402: [21, 13, 17, 8], maximum: [2, 15, 17, 10], reservation: [6, 15, 22, 9], exchange: [21, 15, 17, 9], insider: [21, 15, 7, 10], sleeve: [21, 15, 17, 9], airline: [22, 19, 17, 10], medication: [9, 19, 1, 12], wellness: [9, 19, 17, 11], real: [17, 6], unfollow: [25, 13, 13, 7], suggest: [7, 8, 6, 6], love: [7, 15, 22, 9], course: [5, 9, 17, 4], progress: [5, 9, 9, 9], cloudflare: [2, 8, 13, 5], plugin: [8, 8, 2, 5], spec: [2, 7, 20, 5], roster: [7, 11, 0, 7], online: [20, 8, 14, 5], zoom: [1, 19, 17, 10], taste: [6, 9, 23, 6], interaction: [25, 15, 17, 9], ios: [2, 13, 17, 8], renewal: [14, 8, 17, 8], conflict: [1, 13, 12, 7], performance: [13, 13, 7, 7], wishlist: [20, 13, 7, 7], defensive: [15, 15, 22, 10], cheapest: [20, 11, 6, 8], console: [13, 11, 7, 7], warrantie: [10, 12, 15, 8], logistic: [22, 12, 5, 11], subject: [5, 12, 1, 8], dog: [10, 15, 17, 9], yard: [10, 15, 17, 9], device: [15, 11, 10, 9], restore: [8, 12, 17, 8], litigation: [12, 15, 17, 7], background: [23, 10, 1, 8], applicant: [11, 18, 17, 11], applier: [11, 18, 17, 11], trainer: [9, 15, 17, 8], changed: [17, 9, 18, 7], follow: [1, 6, 19, 5], concept: [23, 8, 5, 6], calm: [10, 5, 16, 5], college: [5, 10, 7, 8], feed: [17, 6, 18, 5], macro: [9, 12, 21, 9], conversion: [13, 14, 17, 8], bargain: [20, 18, 12, 12], lister: [20, 18, 17, 11], critic: [23, 12, 13, 9], mockup: [23, 12, 12, 9], class: [4, 10, 14, 9], statement: [14, 9, 9, 5], base: [21, 9, 6, 6], duplicate: [8, 7, 14, 7], researche: [19, 6, 12, 5], noise: [3, 10, 17, 5], salesforce: [19, 18, 17, 11], deliver: [4, 6, 18, 5], exact: [20, 8, 21, 4], safe: [7, 8, 15, 6], airport: [22, 18, 6, 9], print: [12, 7, 23, 6], scripture: [16, 10, 5, 9], busy: [5, 8, 9, 7], ninja: [14, 12, 4, 11], dive: [18, 14, 17, 10], matter: [3, 7, 12, 6], age: [5, 10, 9, 7], drill: [5, 10, 16, 7], checkout: [20, 12, 6, 8], bridge: [8, 8, 4, 7], support: [19, 9, 3, 7], profit: [21, 14, 20, 10], rank: [17, 8, 13, 6], helper: [12, 6, 6, 5], important: [3, 10, 4, 8], open: [1, 5, 11, 4], added: [8, 12, 10, 8], efficiency: [8, 12, 21, 9], battery: [10, 14, 17, 8], investment: [21, 11, 14, 8], ups: [1, 9, 17, 7], charging: [22, 12, 10, 11], description: [11, 9, 20, 6], paid: [13, 8, 14, 7], genre: [23, 14, 1, 11], speech: [23, 14, 17, 9], fail: [2, 9, 17, 5], taxe: [12, 17, 17, 9], ate: [9, 17, 17, 10], across: [20, 5, 17, 4], researcher: [17, 8, 18, 6], speaking: [5, 11, 1, 8], trash: [3, 11, 17, 11], worth: [25, 6, 14, 5], focused: [8, 8, 12, 5], waiting: [3, 10, 17, 9], channel: [0, 7, 24, 5], prose: [24, 17, 17, 11], designer: [17, 7, 23, 6], assignment: [5, 17, 17, 11], caregiver: [5, 17, 17, 11], session: [9, 8, 2, 4], body: [9, 13, 1, 8], paycheck: [14, 17, 17, 11], their: [25, 4, 8, 4], private: [10, 5, 5, 4], zero: [15, 8, 3, 7], show: [10, 4], want: [20, 6], player: [7, 13, 17, 6], consent: [15, 17, 12, 11], deadline: [12, 8, 22, 5], acceptance: [2, 13, 12, 10], devin: [2, 13, 17, 9], etfs: [21, 16, 17, 11], musebook: [21, 16, 17, 11], premarket: [21, 16, 17, 11], quant: [21, 16, 7, 11], sol: [21, 16, 7, 11], companie: [12, 8, 18, 7], visibility: [13, 11, 18, 6], amount: [14, 13, 12, 12], federal: [17, 13, 12, 13], idea: [4, 3], part: [20, 6, 23, 6], pick: [7, 5], another: [2, 11, 17, 8], recall: [10, 11, 17, 6], shipping: [20, 9, 12, 6], sound: [23, 9, 24, 8], income: [12, 11, 14, 9], launche: [13, 8, 18, 6], checklist: [22, 9, 12, 6], christma: [20, 16, 17, 10], b2b: [19, 13, 25, 10], pull: [17, 5, 16, 4], mile: [22, 16, 10, 9], assumption: [0, 13, 4, 12], were: [8, 13, 17, 9], smart: [10, 9, 12, 7], them: [1, 4], delivery: [6, 10, 20, 6], made: [4, 10, 17, 7], tester: [15, 12, 2, 8], filter: [17, 11, 10, 8], invent: [1, 8, 18, 7], trending: [18, 7, 20, 6], sec: [18, 10, 21, 9], rent: [17, 15, 14, 6], model: [23, 4, 2, 4], classroom: [5, 12, 17, 8], hint: [5, 12, 1, 9], approve: [17, 5, 3, 4], gate: [17, 5, 2, 4], storm: [10, 12, 12, 8], clipper: [23, 12, 7, 9], looping: [23, 12, 17, 9], spotify: [23, 9, 22, 7], year: [12, 10, 22, 8], location: [11, 10, 22, 6], hold: [21, 6, 1, 6], advice: [7, 9, 12, 7], digs: [18, 8, 20, 6], tutorial: [8, 15, 17, 11], asset: [17, 11, 21, 10], leaked: [15, 15, 17, 9], fyi: [3, 12, 12, 11], within: [20, 10, 7, 8], adhd: [16, 10, 7, 8], ping: [22, 7, 20, 6], against: [17, 5, 24, 4], momentum: [21, 12, 17, 8], put: [21, 12, 1, 9], git: [2, 10, 17, 7], front: [0, 6, 4, 5], equipment: [9, 12, 20, 8], how: [17, 4], scheduling: [1, 15, 17, 13], fed: [18, 12, 17, 9], expert: [4, 7, 2, 5], claudia: [23, 15, 17, 11], playing: [23, 15, 17, 11], production: [2, 7, 23, 5], right: [8, 4, 0, 4], cto: [2, 12, 17, 9], herdr: [2, 12, 17, 9], target: [11, 7, 20, 6], native: [13, 10, 2, 6], via: [2, 5, 1, 3], flashcard: [5, 15, 17, 10], homeschool: [5, 15, 17, 10], chore: [10, 12, 22, 9], release: [18, 5, 19, 4], vendor: [0, 7, 14, 7], water: [10, 10, 4, 9], secret: [15, 10, 8, 6], changelog: [8, 10, 22, 8], funnel: [13, 15, 17, 9], payoff: [17, 12, 14, 12], csv: [14, 10, 12, 6], left: [14, 10, 17, 6], renter: [12, 15, 17, 13], asks: [8, 4, 14, 4], prayer: [16, 14, 17, 11], backed: [7, 10, 25, 4], cut: [23, 5, 14, 5], binary: [2, 14, 17, 11], outer: [2, 14, 17, 11], staging: [2, 14, 17, 11], tonight: [6, 14, 17, 8], hyperliquid: [21, 14, 19, 11], its: [4, 4, 2, 3], word: [4, 6, 5, 5], chip: [7, 14, 17, 8], hour: [1, 7, 25, 6], quiet: [3, 4, 11, 4], steelman: [4, 19, 17, 10], focu: [1, 12, 16, 10], neutral: [18, 10, 17, 8], strategist: [25, 10, 13, 8], audience: [13, 11, 24, 10], remote: [11, 11, 17, 6], holding: [21, 9, 11, 6], weight: [9, 11, 6, 10], synced: [13, 10, 23, 9], length: [22, 12, 23, 11], square: [17, 13, 23, 11], ceo: [0, 7, 13, 5], choice: [4, 14, 1, 6], analysi: [21, 8, 7, 7], watchlist: [21, 8, 18, 6], truck: [10, 11, 6, 9], construction: [0, 11, 11, 9], out: [20, 4], record: [17, 7, 10, 5], installed: [8, 9, 10, 8], forecast: [10, 9, 14, 7], zip: [17, 9, 10, 9], community: [17, 9, 25, 9], reddit: [25, 9, 19, 8], add: [4, 7, 8, 7], loop: [7, 6, 3, 5], buyer: [17, 12, 19, 8], ballot: [4, 10, 18, 8], internet: [14, 11, 10, 9], reading: [16, 6, 5, 6], sponsor: [3, 14, 17, 9], answer: [5, 3], science: [5, 9, 6, 7], playbook: [21, 9, 7, 6], cad: [2, 11, 17, 8], stop: [22, 8, 21, 5], sellable: [8, 11, 17, 8], sounding: [24, 13, 22, 11], carrier: [15, 13, 12, 12], output: [8, 9, 12, 7], not: [4, 5, 12, 5], full: [4, 5, 23, 4], genealogy: [5, 13, 17, 9], teach: [5, 13, 17, 9], scheduler: [1, 18, 17, 11], pre: [17, 6, 21, 5], math: [5, 8, 20, 5], angle: [18, 11, 17, 9], room: [17, 8, 10, 7], sweep: [17, 10, 3, 8], starship: [18, 9, 22, 9], chart: [21, 6, 25, 4], sorted: [6, 11, 3, 6], unknown: [18, 13, 17, 11], watcher: [1, 6, 20, 6], chase: [17, 8, 14, 8], linked: [17, 10, 14, 9], gets: [15, 7, 6, 4], bookkeeper: [14, 11, 12, 10], wasted: [14, 11, 8, 9], hexakin: [8, 13, 17, 10], verified: [11, 7, 4, 4], rule: [12, 5, 17, 5], printer: [23, 10, 17, 8], window: [8, 5, 4, 5], secretary: [1, 13, 17, 7], liquid: [21, 13, 17, 9], thesi: [21, 13, 17, 9], reason: [19, 10, 1, 7], national: [10, 13, 17, 9], pool: [17, 12, 21, 10], tabletop: [7, 17, 17, 11], layout: [23, 9, 17, 6], journal: [16, 9, 21, 7], alt: [23, 13, 17, 10], palette: [23, 13, 17, 10], radio: [23, 13, 17, 10], persona: [8, 9, 11, 7], graph: [2, 9, 18, 7], brain: [16, 6, 8, 5], speak: [4, 13, 23, 5], negotiate: [20, 13, 3, 8], schema: [13, 13, 7, 9], date: [1, 6, 12, 6], honest: [11, 6, 4, 4], pickup: [6, 13, 17, 12], architect: [0, 10, 8, 8], pass: [17, 6, 20, 6], few: [17, 6, 8, 5], independent: [19, 8, 4, 7], contractor: [10, 8, 4, 8], clean: [1, 4, 3, 4], whole: [7, 7, 8, 6], sheet: [14, 5, 17, 4], round: [7, 10, 21, 5], hub: [0, 7, 22, 5], vibe: [4, 8, 22, 8], pulse: [18, 7, 9, 7], billing: [12, 10, 13, 10], sunday: [6, 10, 5, 7], they: [8, 3], grocerie: [6, 17, 17, 11], graphic: [25, 10, 23, 8], searchable: [25, 10, 17, 6], inactive: [25, 12, 7, 11], essay: [24, 12, 17, 9], two: [4, 4, 18, 4], accessibility: [2, 12, 17, 10], optional: [1, 7, 20, 6], canva: [5, 12, 17, 9], spaced: [5, 12, 17, 9], tell: [6, 4, 20, 4], snap: [10, 8, 6, 7], frame: [17, 11, 23, 8], payout: [14, 12, 12, 10], speaker: [23, 10, 1, 9], auditor: [4, 5, 8, 5], principle: [4, 12, 7, 4], routing: [16, 8, 1, 7], look: [17, 6, 10, 4], asking: [17, 10, 19, 10], revenue: [19, 10, 12, 6], without: [17, 4], yourself: [24, 7, 4, 6], cyber: [15, 12, 4, 11], permission: [15, 12, 1, 9], finder: [20, 5, 11, 5], birthday: [20, 10, 1, 6], over: [10, 5, 17, 4], server: [15, 9, 2, 7], kalshi: [21, 12, 17, 9], sentiment: [21, 12, 17, 9], connection: [25, 10, 4, 9], level: [5, 7, 12, 5], guard: [15, 8, 12, 5], webhook: [8, 10, 17, 7], concierge: [22, 12, 10, 8], senior: [11, 10, 13, 5], human: [24, 5, 1, 5], honestly: [11, 12, 17, 8], update: [0, 5, 17, 5], until: [4, 4, 2, 4], working: [17, 6, 4, 5], agency: [13, 9, 19, 8], speed: [13, 9, 4, 9], carousel: [25, 12, 24, 9], happen: [25, 12, 17, 8], publishe: [24, 8, 1, 7], reverse: [2, 9, 17, 8], thin: [4, 11, 2, 9], thing: [20, 6, 1, 5], solo: [17, 8, 0, 7], folder: [3, 7, 25, 6], done: [11, 6, 0, 6], after: [24, 3, 1, 3], leak: [14, 9, 12, 7], router: [2, 8, 8, 6], eye: [18, 8, 1, 8], anything: [20, 5, 17, 4], hardening: [15, 16, 17, 11], japanese: [5, 8, 22, 5], consumer: [15, 12, 12, 8], prioritie: [0, 9, 16, 7], standup: [1, 15, 17, 9], library: [17, 8, 23, 6], statu: [22, 7, 10, 6], approval: [17, 5, 13, 5], sponsorship: [20, 12, 17, 8], emergency: [10, 12, 17, 8], solar: [10, 12, 16, 9], figma: [17, 14, 23, 11], unused: [14, 11, 25, 9], floor: [20, 9, 9, 6], keeper: [14, 7, 7, 5], applying: [11, 15, 17, 11], fitting: [11, 15, 17, 11], cost: [14, 5, 22, 5], line: [1, 5, 3, 4], bids: [4, 12, 7, 11], evidence: [17, 5, 9, 4], summarie: [25, 7, 18, 6], recording: [1, 9, 23, 8], today: [17, 9, 3, 5], miss: [4, 9, 5, 9], missed: [12, 11, 9, 7], seller: [17, 11, 20, 8], box: [4, 10, 20, 7], chatter: [21, 11, 17, 8], prediction: [21, 11, 7, 9], hard: [17, 6, 6, 6], total: [22, 10, 14, 8], category: [14, 9, 1, 7], hidden: [22, 11, 12, 8], adjuster: [12, 15, 4, 13], fine: [12, 15, 17, 9], policie: [12, 15, 17, 9], loss: [9, 11, 21, 9], burn: [4, 8, 21, 7], see: [17, 7, 8, 6], closure: [18, 11, 17, 10], literature: [18, 11, 17, 10], sector: [18, 11, 17, 10], craigslist: [17, 16, 20, 15], glasser: [13, 15, 17, 11], thrift: [20, 15, 17, 11], table: [6, 9, 4, 7], broken: [2, 7, 1, 7], idle: [7, 8, 2, 7], booked: [22, 15, 17, 9], time: [1, 4], directory: [3, 9, 13, 7], choose: [18, 4, 11, 4], auto: [12, 9, 4, 6], document: [12, 9, 17, 7], reflection: [16, 11, 7, 10], red: [15, 7, 0, 6], step: [5, 3], method: [2, 9, 17, 7], tested: [2, 9, 17, 7], practical: [9, 9, 17, 8], citation: [18, 7, 17, 6], whenever: [4, 15, 1, 8], block: [25, 7, 9, 4], glp: [9, 15, 12, 11], manual: [22, 11, 10, 11], heavy: [11, 11, 17, 7], face: [23, 9, 17, 7], person: [17, 6, 24, 5], careful: [2, 6, 22, 5], drive: [22, 5, 3, 4], world: [4, 11, 22, 4], wire: [7, 11, 21, 7], covering: [12, 8, 22, 6], archivist: [8, 11, 17, 9], ssh: [8, 11, 17, 9], material: [11, 9, 5, 7], packet: [11, 9, 12, 9], advisor: [12, 6, 14, 6], deposit: [17, 15, 12, 11], down: [15, 6, 4, 4], using: [15, 5, 17, 4], network: [15, 7, 10, 6], cleaning: [10, 14, 17, 11], outdoor: [10, 14, 17, 11], dos: [3, 11, 12, 8], mailbox: [3, 11, 17, 8], key: [8, 5, 24, 5], gemini: [2, 7, 1, 6], worker: [2, 7, 9, 7], english: [12, 6, 21, 4], buffer: [25, 11, 22, 9], command: [4, 8, 8, 7], feedback: [19, 9, 11, 5], pricing: [13, 9, 20, 8], exploited: [15, 14, 17, 10], gone: [15, 14, 12, 11], protection: [15, 14, 14, 12], vuln: [15, 14, 12, 11], brokerage: [12, 14, 17, 14], texa: [12, 14, 17, 9], guide: [22, 6, 4, 6], noisy: [3, 14, 17, 11], tree: [5, 8, 10, 8], ahead: [1, 11, 4, 8], fee: [20, 11, 1, 8], advocate: [4, 11, 14, 8], receptionist: [1, 14, 22, 10], pixel: [17, 14, 23, 10], http: [2, 8, 17, 7], response: [19, 10, 17, 7], state: [17, 10, 12, 8], general: [4, 9, 0, 8], rest: [1, 9, 0, 8], format: [13, 8, 24, 8], everyday: [5, 7, 22, 5], three: [17, 5, 4, 4], socratic: [5, 10, 0, 8], optimizer: [8, 8, 1, 7], preference: [8, 8, 22, 8], tidy: [8, 8, 12, 7], leftover: [6, 7, 16, 7], history: [20, 6, 7, 6], academic: [5, 14, 1, 12], ages: [5, 14, 17, 11], baby: [5, 14, 17, 11], profile: [13, 6, 25, 6], hardware: [2, 7, 22, 6], access: [4, 9, 15, 8], closer: [3, 10, 19, 9], payment: [17, 12, 12, 9], chaser: [14, 14, 17, 11], accountability: [9, 14, 11, 11], adjust: [9, 14, 1, 11], bedtime: [9, 14, 17, 9], demo: [4, 12, 25, 8], view: [25, 8, 19, 5], asked: [20, 10, 17, 7], flip: [17, 11, 20, 10], advertising: [13, 14, 12, 11], high: [6, 6, 25, 5], strategy: [17, 9, 13, 8], forge: [23, 7, 8, 6], pack: [17, 6, 13, 4], quote: [1, 5, 25, 4], docs: [12, 7, 3, 6], adapt: [6, 13, 9, 11], rsvp: [1, 13, 17, 8], catalyst: [21, 13, 17, 11], dex: [21, 13, 17, 11], edge: [21, 13, 17, 11], behavior: [2, 10, 17, 9], conductor: [2, 10, 17, 9], sits: [2, 10, 7, 9], spot: [21, 5, 15, 4], alpha: [21, 10, 17, 8], position: [21, 10, 17, 8], quality: [8, 5, 20, 5], diy: [10, 10, 17, 7], errand: [10, 10, 17, 7], browser: [13, 7, 25, 6], confirm: [6, 8, 22, 7], nightly: [3, 5, 18, 4], office: [12, 8, 0, 5], intent: [19, 10, 22, 8], form: [24, 4, 5, 3], radar: [1, 4, 19, 4], sidekick: [21, 8, 10, 8], authorized: [15, 13, 6, 9], medicare: [15, 13, 9, 11], political: [15, 13, 17, 9], voicemail: [15, 13, 17, 9], printable: [23, 8, 20, 7], context: [1, 6, 2, 5], finding: [25, 5, 2, 5], already: [6, 5, 14, 5], slow: [22, 10, 8, 8], affect: [18, 10, 17, 9], entertainment: [18, 10, 17, 9], hacker: [13, 10, 18, 10], newsroom: [18, 10, 17, 9], experience: [11, 10, 22, 7], roundup: [7, 9, 1, 7], threat: [15, 10, 18, 7], orchestrate: [2, 8, 11, 7], prove: [2, 8, 17, 7], saas: [14, 9, 2, 8], walk: [1, 5, 19, 4], stream: [4, 8, 23, 7], dollar: [4, 11, 14, 10], freelancer: [14, 10, 19, 8], bible: [24, 8, 5, 7], label: [3, 6, 4, 6], lab: [9, 8, 10, 4], shopify: [20, 8, 13, 7], partner: [4, 4, 5, 4], drafting: [12, 13, 17, 8], hear: [15, 10, 23, 10], shoot: [22, 10, 23, 10], double: [1, 13, 9, 9], lean: [0, 8, 17, 5], onboarding: [0, 8, 7, 6], lock: [7, 8, 15, 8], adult: [5, 8, 10, 7], actually: [6, 4], seed: [19, 10, 7, 9], desktop: [20, 6, 8, 5], clinic: [9, 13, 17, 9], condition: [9, 13, 4, 13], fuel: [9, 13, 12, 10], classifie: [3, 13, 17, 10], ignore: [3, 13, 17, 10], switch: [7, 13, 4, 12], talk: [4, 7, 8, 4], ordered: [6, 13, 7, 9], everything: [24, 6, 3, 5], gentle: [9, 9, 16, 6], equity: [21, 10, 17, 7], explain: [12, 8, 5, 4], tour: [17, 14, 22, 13], login: [15, 10, 1, 7], fans: [7, 8, 18, 8], odds: [22, 9, 21, 8], experiment: [13, 9, 25, 6], operator: [13, 5, 19, 3], picture: [4, 8, 5, 7], dev: [7, 9, 21, 8], repeat: [8, 8, 7, 6], slide: [24, 9, 1, 8], system: [4, 5, 18, 4], stress: [4, 9, 12, 8], searche: [17, 10, 11, 7], checker: [24, 6, 15, 5], discount: [12, 12, 20, 8], yes: [20, 4], pacing: [24, 12, 17, 10], remember: [6, 8, 20, 7], more: [17, 5, 5, 5], gatekeeper: [15, 12, 1, 10], vulnerabilitie: [15, 12, 17, 9], vulnerability: [15, 12, 17, 9], led: [19, 12, 17, 9], objection: [4, 16, 17, 14], offer: [17, 9, 19, 5], learner: [5, 12, 17, 10], require: [5, 12, 17, 10], accounting: [12, 14, 14, 12], cancellation: [14, 12, 6, 10], overdue: [14, 12, 17, 10], driver: [7, 12, 22, 9], scoring: [7, 12, 11, 9], propose: [1, 6, 8, 5], dms: [15, 7, 25, 5], type: [22, 9, 17, 8], mention: [25, 6, 22, 6], eat: [6, 12, 9, 10], whatever: [6, 12, 17, 8], memorie: [8, 12, 17, 11], wipe: [8, 12, 17, 11], keys: [21, 6, 2, 6], install: [15, 6, 2, 5], unifi: [9, 12, 17, 8], package: [8, 4, 24, 4], criteria: [17, 14, 11, 12], side: [17, 8, 12, 7], miner: [17, 12, 21, 9], process: [0, 7, 17, 5], seat: [0, 5, 4, 4], quick: [1, 8, 6, 7], shift: [1, 12, 13, 7], cop: [21, 12, 17, 10], strategie: [17, 15, 21, 12], close: [17, 6, 1, 6], area: [17, 12, 10, 6], album: [22, 12, 23, 9], loud: [23, 9, 17, 8], talking: [22, 9, 23, 9], movie: [23, 7, 17, 6], than: [4, 9, 25, 8], buddy: [20, 6, 5, 5], anywhere: [10, 12, 17, 9], friction: [10, 12, 22, 11], lawn: [10, 12, 1, 11], lot: [10, 12, 17, 9], paint: [10, 12, 20, 10], train: [10, 12, 22, 11], appeal: [17, 14, 12, 12], register: [4, 13, 12, 12], easy: [6, 9, 17, 9], move: [13, 4, 14, 4] } };

// src/lib/strip-emails.ts
var EMAIL_RE2 = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var stripEmails = (s) => s.replace(EMAIL_RE2, "[email hidden]");

// src/worker/dp/classify.ts
var tokenize = (s) => (s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map((t) => t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
function classify(model, name, description) {
  const s = new Array(model.cats.length).fill(0);
  for (const t of new Set(tokenize(`${name} ${description}`))) {
    const e = model.tokens[t];
    if (e) for (let i = 0; i < e.length; i += 2) s[e[i]] += e[i + 1];
  }
  let best = 0, second = 0, bc = -1;
  s.forEach((v, c) => {
    if (v > best) {
      second = best;
      best = v;
      bc = c;
    } else if (v > second) second = v;
  });
  return bc >= 0 && best >= model.min && best - second >= model.margin ? model.cats[bc] : null;
}

// src/worker/dp/ingest.ts
var CODE_RE = /^[A-Za-z0-9_-]{21}$/;
var UA = "GrokBotZone/1.0 (+https://grokbot.zone/faq/)";
var botUrl = (code) => `https://x.ai/bot/${code}`;
var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
var decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 1114112 ? String.fromCodePoint(n) : "";
  }
  return ENT[e.toLowerCase()] ?? m;
});
var attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? m[2] ?? m[3] : null;
};
function parseHead(html) {
  const end = html.toLowerCase().indexOf("</head>");
  const head = end >= 0 ? html.slice(0, end) : html;
  let canonical = null;
  const og = {};
  for (const m of head.matchAll(/<(link|meta)\b[^>]*>/gi)) {
    const tag = m[0];
    if (m[1].toLowerCase() === "link") {
      if ((attr(tag, "rel") ?? "").toLowerCase() === "canonical") canonical = attr(tag, "href");
    } else {
      const p = attr(tag, "property") ?? attr(tag, "name");
      const c = attr(tag, "content");
      if (p && c !== null && !(p in og)) og[p.toLowerCase()] = c;
    }
  }
  const cm = canonical ? /\/bot\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(canonical) : null;
  const title = decodeEntities(og["og:title"] ?? "").replace(/\s+/g, " ").trim();
  const i = title.lastIndexOf(" by ");
  return {
    canonicalCode: cm && CODE_RE.test(cm[1]) ? cm[1] : null,
    name: (i > 0 ? title.slice(0, i) : title).trim(),
    author: i > 0 ? title.slice(i + 4).trim() : "",
    description: decodeEntities(og["og:description"] ?? "").replace(/\s+/g, " ").trim()
  };
}
async function readHead(res, max = 16384) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(out) || out.length >= max) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
  }
  return out;
}
var denylist = (secret) => (secret ?? "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean);
var hits = (text, list) => {
  const t = text.toLowerCase();
  return list.some((w) => t.includes(w));
};
function scrub(f, list) {
  const name = stripEmails(f.name).slice(0, 200);
  let author = stripEmails(f.author).slice(0, 200);
  const description = stripEmails(f.description).slice(0, 2e3);
  const authorHit = hits(author, list);
  if (authorHit) author = "";
  return { name, author, description, excluded: authorHit || hits(name, list) || hits(description, list) };
}
function ingest(head, requestedCode, list, model) {
  if (!head.name) return null;
  const s = scrub(head, list);
  return { ...s, code: requestedCode, category: s.excluded ? null : classify(model, s.name, s.description) };
}

// src/worker/dp/util.ts
var HOUR = 36e5;
var DAY = 864e5;
var iso = (ms) => new Date(ms).toISOString();
var dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
var daysBack = (ms, n) => dayOf(ms - n * DAY);
var dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
var addDays = (d, n) => dayOf(Date.parse(`${d}T00:00:00Z`) + n * DAY);
var sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
var realClock = { now: () => Date.now(), sleep: sleepReal };
var CATEGORY_NONE = "uncategorized";
var botId = (category, code) => `${category ?? CATEGORY_NONE}-${code}`;
async function readMeta(db, keys) {
  const { results } = await db.prepare(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}
var metaPut = (db, k, v) => db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v);

// src/worker/dp/discovery.ts
var LISTING_URL = "https://x.ai/bot/marketplace";
var CDX = "https://web.archive.org/cdx/search/cdx";
var CDX_ROWS = 500;
var ARCHIVE_TIMEOUT_MS = 9e4;
function parseListing(html) {
  const out = /* @__PURE__ */ new Map();
  for (const m of html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?x\.ai)?\/bot\/([A-Za-z0-9_-]+)["'/?#]/g)) {
    if (CODE_RE.test(m[1]) && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), m[1]);
  }
  return [...out.values()];
}
function parseCdx(rows) {
  const found = /* @__PURE__ */ new Map();
  let resume = null, lastTs = null;
  if (!Array.isArray(rows)) return { found: [], resume, lastTs };
  const body = rows.slice(1);
  const tail = body.length >= 2 && Array.isArray(body[body.length - 2]) && body[body.length - 2].length === 0 ? body[body.length - 1] : null;
  if (Array.isArray(tail) && typeof tail[0] === "string") resume = tail[0];
  for (const r of body) {
    if (!Array.isArray(r) || r.length < 2) continue;
    lastTs = typeof r[0] === "string" ? r[0] : lastTs;
    const m = /^https?:\/\/(?:www\.)?x\.ai\/bot\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i.exec(String(r[1]));
    if (m && CODE_RE.test(m[1]) && !found.has(m[1].toLowerCase())) found.set(m[1].toLowerCase(), m[1]);
  }
  return { found: [...found.values()], resume, lastTs };
}
var cdxStamp = (ms) => iso(ms).replace(/\D/g, "").slice(0, 14);
async function discover(up, st, nowMs) {
  const found = [];
  const state = {};
  const l = await up.request(LISTING_URL, { method: "GET" }, true);
  if (l && l.status === 200 && l.res) {
    let html = "";
    try {
      html = await l.res.text();
    } catch {
    }
    for (const code of parseListing(html)) found.push({ code, source: "listing" });
  }
  const q = new URLSearchParams({ url: "x.ai/bot/", matchType: "prefix", output: "json", fl: "timestamp,original", "filter": "statuscode:200", collapse: "urlkey", limit: String(CDX_ROWS) });
  if (st.archive_from) q.set("from", st.archive_from);
  else {
    q.set("showResumeKey", "true");
    if (st.archive_resume) q.set("resumeKey", st.archive_resume);
  }
  const a = await up.request(`${CDX}?${q}`, { method: "GET" }, false, ARCHIVE_TIMEOUT_MS);
  if (a && a.status === 200 && a.res) {
    let rows = null;
    try {
      rows = await a.res.json();
    } catch {
    }
    if (rows) {
      const p = parseCdx(rows);
      for (const code of p.found) found.push({ code, source: "archive" });
      if (st.archive_from) state.archive_from = cdxStamp(nowMs);
      else if (p.resume) state.archive_resume = p.resume;
      else state.archive_from = cdxStamp(nowMs);
    }
  }
  return { found, state };
}

// src/worker/dp/lists.ts
var LIST_TIMEOUT_MS = 3e4;
var LIST_MAX_BYTES = 20 * 1024 * 1024;
var LIST_ADD_CAP = 1e3;
var LIST_CHUNK = 2e3;
var CODE_IN_TEXT = /x\.ai\/bot\/([A-Za-z0-9_-]{21})(?![A-Za-z0-9_-])/g;
function parseSources(raw) {
  const out = [];
  for (const line2 of (raw ?? "").split("\n")) {
    const u = line2.trim();
    if (/^https:\/\/\S+$/i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}
function extractCodes2(text, into = /* @__PURE__ */ new Map()) {
  for (const m of text.matchAll(CODE_IN_TEXT)) if (!into.has(m[1].toLowerCase())) into.set(m[1].toLowerCase(), m[1]);
  return into;
}
async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) {
    await res.body?.cancel().catch(() => {
    });
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}
async function pullLists(raw, f, opts = {}) {
  const urls = parseSources(raw);
  const found = /* @__PURE__ */ new Map();
  let fetchedOk = 0;
  for (const [i, url] of urls.entries()) {
    try {
      const res = await f(url, { method: "GET", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(opts.timeoutMs ?? LIST_TIMEOUT_MS) });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {
        });
        console.error(`lists: source ${i + 1} skipped, status ${res.status}`);
        continue;
      }
      const text = await readCapped(res, opts.maxBytes ?? LIST_MAX_BYTES);
      if (text === null) {
        console.error(`lists: source ${i + 1} skipped, body over the size cap`);
        continue;
      }
      extractCodes2(text, found);
      fetchedOk++;
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      console.error(`lists: source ${i + 1} skipped, ${timedOut ? "timeout" : "fetch failed"}`);
    }
  }
  return { codes: [...found.values()], sources: urls.length, fetchedOk };
}
async function queueCodes(db, codes, nowMs, cap = LIST_ADD_CAP) {
  let added = 0;
  for (let i = 0; i < codes.length && added < cap; i += LIST_CHUNK) {
    const chunk = codes.slice(i, i + LIST_CHUNK).map((c) => ({ c }));
    const r = await db.prepare(
      `INSERT OR IGNORE INTO bots(code_lc, code, source, status, first_seen)
       SELECT lower(json_extract(value, '$.c')), json_extract(value, '$.c'), 'listing', 'pending', ? FROM json_each(?)
       WHERE lower(json_extract(value, '$.c')) NOT IN (SELECT code_lc FROM bots) LIMIT ?`
    ).bind(iso(nowMs), JSON.stringify(chunk), cap - added).run();
    added += Number(r.meta?.changes ?? 0);
  }
  return added;
}

// src/worker/dp/liveness.ts
var MAX_UPSTREAM = 40;
var MAX_PENDING_PER_RUN = 30;
var GAP_MS = 1100;
var THROTTLE_HOLD_MS = 6 * 36e5;
var MIN_SAMPLE = 4;
var Upstream = class {
  constructor(f, clock, limit = MAX_UPSTREAM) {
    this.f = f;
    this.clock = clock;
    this.left = limit;
  }
  f;
  clock;
  left;
  used = 0;
  responses = 0;
  blocked = 0;
  last = -Infinity;
  get throttled() {
    return this.responses >= MIN_SAMPLE && this.blocked / this.responses >= 0.5;
  }
  /** null = budget spent or throttled; status 0 = network error or timeout. */
  async request(url, init = {}, track = true, timeoutMs = 9e3) {
    if (this.left <= 0 || this.throttled) return null;
    this.left--;
    this.used++;
    const wait = GAP_MS - (this.clock.now() - this.last);
    if (wait > 0) await this.clock.sleep(wait);
    this.last = this.clock.now();
    try {
      const res = await this.f(url, { ...init, headers: { "User-Agent": UA, ...init.headers ?? {} }, signal: AbortSignal.timeout(timeoutMs) });
      if (track) {
        this.responses++;
        if (res.status === 403 || res.status === 429) this.blocked++;
      }
      return { status: res.status, res };
    } catch {
      return { status: 0, res: null };
    }
  }
};
function applyVerdict(row, v, nowMs) {
  const now = iso(nowMs);
  if (v.kind === "live") {
    return { status: "live", fail_count: 0, first_fail: null, last_live: now, last_checked: now, ...v.code ? { code: v.code } : {} };
  }
  if (v.kind === "gone") {
    const fail_count = row.fail_count + 1;
    const first_fail = row.first_fail ?? now;
    const dead = fail_count >= 2 && nowMs - Date.parse(first_fail) >= DAY;
    return { fail_count, first_fail, last_checked: now, status: dead ? "dead" : row.status };
  }
  return { last_checked: now };
}
var REDIRECTS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function target(res) {
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    const u = new URL(loc, "https://x.ai/");
    const m = /^\/bot\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    return u.hostname === "x.ai" && m ? m[1] : null;
  } catch {
    return null;
  }
}
async function headCheck(up, row) {
  const r = await up.request(botUrl(row.code), { method: "HEAD", redirect: "manual" });
  if (!r) return { kind: "none" };
  return judge(up, row, r, "HEAD");
}
async function judge(up, row, r, method) {
  if (r.status === 200) return { kind: "live" };
  if (r.status === 404 || r.status === 410) return { kind: "gone" };
  if (REDIRECTS.has(r.status) && r.res) {
    const code2 = target(r.res);
    if (!code2 || code2.toLowerCase() !== row.code_lc) return { kind: "none" };
    const r2 = await up.request(botUrl(code2), { method, redirect: "manual" });
    if (!r2) return { kind: "none" };
    if (r2.status === 200) return { kind: "live", code: code2 };
    if (r2.status === 404 || r2.status === 410) return { kind: "gone" };
  }
  return { kind: "none" };
}
async function ingestCheck(up, row, clock, list, model) {
  const r = await up.request(botUrl(row.code), { method: "GET", redirect: "manual" });
  if (!r) return {};
  const retryLater = { last_checked: iso(clock.now()) };
  const v = await judge(up, row, r, "GET");
  if (v.kind === "live") {
    let res = r.status === 200 ? r.res : null;
    let code = row.code;
    if (!res && v.code) {
      const r2 = await up.request(botUrl(v.code), { method: "GET", redirect: "manual" });
      if (!r2 || r2.status !== 200) return retryLater;
      res = r2.res;
      code = v.code;
    } else if (!res) return retryLater;
    let html;
    try {
      html = await readHead(res);
    } catch {
      return retryLater;
    }
    const head = parseHead(html);
    const got = ingest(head, code, list, model);
    if (!got) return retryLater;
    return {
      ...applyVerdict(row, { kind: "live", code }, clock.now()),
      name: got.name,
      author: got.author,
      description: got.description,
      category: got.category,
      cats: got.category,
      status: got.excluded ? "excluded" : "live"
    };
  }
  return applyVerdict(row, v, clock.now());
}
var MAX_SUBMISSION_REQUESTS = 10;
async function runChecks(up, rows, clock, list, model) {
  const patches = [];
  let subSpent = 0;
  for (const row of rows) {
    if (up.left <= 0 || up.throttled) break;
    const sub = row.status === "pending" && row.source === "submission";
    if (sub && subSpent >= MAX_SUBMISSION_REQUESTS) continue;
    const before = up.used, saved = up.left;
    if (sub) up.left = Math.min(up.left, MAX_SUBMISSION_REQUESTS - subSpent);
    let patch;
    try {
      if (row.status === "pending" && row.name === "") patch = await ingestCheck(up, row, clock, list, model);
      else patch = applyVerdict(row, await headCheck(up, row), clock.now());
    } catch {
      patch = { last_checked: iso(clock.now()) };
    }
    if (sub) {
      const spent = up.used - before;
      subSpent += spent;
      up.left = saved - spent;
    }
    if (Object.keys(patch).length) patches.push({ row, patch });
  }
  return { patches, checked: patches.length, stoppedThrottled: up.throttled };
}

// data/signals/popularity.json
var popularity_default = {
  asOf: "2026-10-28",
  basis: "popularity order recorded with the listings at capture time",
  global: [
    "fUj6TYhiW_cjtzWvbsFgz",
    "VBmzZaD3abMPl53kwWuYp",
    "f5EvPVrHkyTX3piZyVmXO",
    "zvsgYtQHUcSKGRhAb_JzM",
    "93gOz3op1UQdBdbekQFLK",
    "n8nC9GmY6ZBdnTE0zRs1T",
    "794hIWjgfm5XGVkyIyU0b",
    "j7B5LHnEIPTuPQZxxQwpx",
    "-qkf41F4R1MtZRetyUrxW",
    "DMifb6iyC03g6HvPNrkGw",
    "lsXZ6NdEqAdCHe8z88QAl",
    "XftMzXd6cq-DT_ZLvdoy5"
  ],
  perCategory: {
    "Business & Operations": [
      "j7B5LHnEIPTuPQZxxQwpx",
      "FU-Ev6_Ju4lFGWwWRD0GD",
      "ph-u_zkF5Vui1GdGnysn9",
      "AMa1ig4YyoxfYtWFe7PLi",
      "GVAnpUah1K6PzJtG9EuG9",
      "afZj-XnYkThA4MB7GfZK6",
      "Q3VCc_x0Y8lWd4m-rung2",
      "XJCoBm6z7qjAnt9ScG8i7",
      "fePZGiWiTZP9n4BoKIlMY",
      "gwY3JyQ7noK9GSHFo-p7E",
      "rrvGu13S5uYCc09WP7A-9",
      "nB2LrfTaw07kYIuE32UZk",
      "Lrx_GIK9mbXKotjqjwDeA",
      "IO2pTDUEtf9GhEDw_WnZn",
      "jonryYohiQwZx_gdg0BT2",
      "HICQrhoWRRdPNMszNXbtV",
      "OkIvqIKyCEHxsaxnqnM-S",
      "puXSD9IzcL1GX_oQfH88w",
      "gZ3LMBTn-zVygV-G9_2m8",
      "0WMwSjhQuRoM99_FcZtkS",
      "wc8Bkk0usMFMGeZ9V9EfE",
      "Q6Owq4QjKJeSyo4FJ8hZW",
      "8_XzpQayXtHkFps55OeLR",
      "ktZpLWjTag-lOUcLUUBSj",
      "Fwf_OUvMYPcvVkKsy9jNd",
      "GpfSXlyQGc1kbScfa8Sx0",
      "Y9y8k-uDEBQESnan7klFI",
      "8yW0q8kjOcnbzJZBsWZuc",
      "Cnqct6P0wqESfF8IgITMq",
      "MjDEHaYtTp85wXm_SpT0k"
    ],
    "Calendar, Meetings & Scheduling": [
      "YklttiPpAHweKbOLV1TSF",
      "vVST27b0qMvGLrEfxZ3nj",
      "AWWfTsu3hekFx0CTloXf0",
      "GRrmYf9RDCK2DddGYSe6g",
      "vxvNEoprSLLwOa2d02f6C",
      "dF0wbCNEVHlP0n6l9t5-t",
      "7KeRruqggKKBCx3MPcJel",
      "s0dfd5486dc759d409d69",
      "fO1_CInLVUekMeFvYDAwD",
      "Awo50vxQeDKxmot5ZjphN",
      "MF5NW2YJoIJywffL3Zi5W",
      "HoTdd2YekB-DPaAthBkuZ",
      "-j00v29rSvOvd-ht6q_vi",
      "SUQn0WMY2zEL9cwEmd2jv",
      "-GzMJlSIqdo89K0qs3yC4",
      "nJ7hHZsPczXvJIi0wv8c-",
      "o1i1t2DhvfahqIlO5o1gd",
      "B_WCQAMMbhkNU2r3r4YNO",
      "w1d4ZVJ6ag9AljTBvZqkN",
      "bdkJcjP5Gt9BaGTqh1vXH",
      "-BXZiXKHwvcge3PviX2yK",
      "JN9e1WggIKVWhCEZrySlj",
      "Of0WZSYyqWtQXV9Z52pqv",
      "Uicr9Dc3FKOmsMfbN_NHB",
      "n78nHL2pCQJVpseg8uqgU",
      "Z7LfRtBtwfaojaomMrAuX",
      "hSB5eAvp41y3-atquZoR9",
      "wJRcag7l4xPBW4Hc_mA0_",
      "XrDqxz9-QvCKazAQACQxh",
      "pmHKMlkRfVnvDS5MfRTS8"
    ],
    "Coding & Software": [
      "794hIWjgfm5XGVkyIyU0b",
      "lS9XaHCr9QTTHhNtb0VQX",
      "_5NG_WsrOdQs2jtUhZeQH",
      "-hmCmHB0ynJGvSKxeINfS",
      "SxqbG1NT5qEw7ggmHqQu_",
      "lKQWoQAvYgg_7Bkg2R-m7",
      "0LLQmzk-yzwHi0zuiV0lC",
      "p4sSEZV7xqcBgdT7m2O8i",
      "NYDai_DOI_2pNDIKerrpD",
      "Ks3X7JpD-6I86s3zkJFRh",
      "FeeqMRMJr2jwixCROZcIh",
      "XBauviUoNcdi05-ExoOo4",
      "sd4474cf03cd8552905ff",
      "EIaKiBO_5k6RITsM47150",
      "qL920VjKyua3_u89UYnQL",
      "OayZREvep4QIt3u8PNWdb",
      "W0LrVwNwsRHhFY4PG7586",
      "aB0M7wQOAcFgd_G0rTEWF",
      "TAS_Ef2phuIndqWeMz_9b",
      "tLSg4HxepSclMqbZUTRnX",
      "Ub3T7usX-c6yRQibQq83P",
      "__4FfrkUdvpdMk6-LKg5r",
      "OR72i4SNc0_F1IzbCfg-D",
      "mLpMFiQGgnXgXpmi0eb7k",
      "xK8W0ukRv4iZjglzz-FRE",
      "aU_t4X-Yf6w9DHfhIGD9n",
      "5hqR_5PVUy7WMbNaXPJ8s",
      "WBmiRJCwxzSCBHBTdC1wi",
      "Nx4wpKeM_NYx577xlJFMD",
      "H7sxHpPsvu7vKG16DrsDU"
    ],
    "Email & Inbox": [
      "f5EvPVrHkyTX3piZyVmXO",
      "lsXZ6NdEqAdCHe8z88QAl",
      "0VC1XzREXRFGe0hVo-JEG",
      "F4GyQybzyfsBx6iXlwbHk",
      "BYaLwjYHrWUAcUlyZVbgP",
      "BX4-kOUI2CzphgiYLZ1hb",
      "estQ8HWdKqhheDNmOGjcy",
      "wtEIGNZ8oipDDVQTDHMPB",
      "Rw8d83KAzTYQWBAtAscin",
      "JZAccYtlRFvDSU2CnMnkZ",
      "MzuJZpvaIK2KpexUVY-V0",
      "4Kert6xnfaArPgZmyJi5M",
      "GiBPBQR2WrHNul4k9Tz6Q",
      "_e4a8viXo8YiLjdUv4fqH",
      "0iuz7X3hVDGJhJIBWTTZ_",
      "moKscJ7PToJw_PVQWvkf_",
      "9Uh8RaBqp6PrcOcZjMHbD",
      "ndO6BI7E2ur5X-bhWM_1R",
      "AIymMNJms4j1HgXNqutxL",
      "gpPjBLipn7IDb7AWPBnmV",
      "-hFhR6u_HxM1mlGX92HK9",
      "XO8uABzMu5WMtRJKwVHp7",
      "91mq1IFljG-EWQhe5kdXe",
      "yH2UttxbMwMugweZrigHT",
      "opCFOq0FKZ41PBIiBeuVO",
      "wIxb391-9pDKoWXQ8xrbD",
      "wXaXn5rj0pJIMzzonyXsl",
      "uvdl2ZJyNekgZv_niJKY-",
      "QIfSY8pPwjqBSIdal-5CI",
      "UrO63RhN1LGXD3DzoMess"
    ],
    "Everything Else": [
      "T5qKapW7Nd2RtXweCzGBG",
      "AtYdjvimO286h3sOIDfB4",
      "JaqEBG9Fah4MNpLJHVvbu",
      "uv4r3mNUgymF11q0N3L7F",
      "fXHgGtuPfTcHBTVKSCZ1d",
      "tMEJdHdRUQHgQMOOy-xjj",
      "Z9SkA7zeEf33Mn5SvfV5W",
      "91R37-rUOh9sS1tZkIF9d",
      "-TlSH1rNkA-c2JLsFFVc7",
      "fyuSERJF73FI7wFYm7cJF",
      "YYh5V5fbSRIfe2VTKCfNX",
      "XCaz2bKzsJ4J1DmkaYyc4",
      "BTFxr9l6QaZ2iS9lHVpDM",
      "iv-6BncmS0G5UWrxc9tN7",
      "Fq4c6b2KeDg3dnIGc5KWI",
      "237C0hK8Lph45gLkwplld",
      "1fdwKWpdKjtdLYUTskkey",
      "7xonnJvEu_lLjq5nfw6Wn",
      "M0ZZw7AT7MzGjvYe1jLBb",
      "y6tzA4pwUoQmefjiH3ZZj",
      "7IWqEVkSNn8-HiQ4gmvSg",
      "eAfHja9cbCki3zc7PXXb2",
      "FaRchqvTT6ZCRVPf0JABl",
      "WjjSdgUDlEwqV65WHACcT",
      "UUZnEDx7jk_nNkkLJTvfo",
      "XGIep-r89FqSquTEKtd1f",
      "o5-uGEYICXDqQoNUNa2q8",
      "ewFkIRV929jhuW5mHqL_a",
      "YYr1SAiufBW0I2R4h1VHv",
      "7z0WNYmnERTnXKmxI12gB"
    ],
    "Family, Kids & Learning": [
      "cht7ytAhe3euOQy2wnEg9",
      "wOE4e95HNxhSbrzyLkSI-",
      "uY_7s1TZILVzUeJ9lLOx9",
      "wGlMEM1W5fXmmtuoyt_aO",
      "yE46R6j5vNPhd92fGxZRu",
      "7yCzCeGQTMD6oNKSPcFqj",
      "Y5F5Ps7_n4nKMZKYzVIS0",
      "cVFusYdAgGA9GY8wHPl2x",
      "48AySlgtv9GHanbzyldxd",
      "dVQjvC6c-sMhtgVskciBH",
      "518qV18_NL99vPVeqNTEL",
      "Fya-gFsQPOlJzJ862syni",
      "dZEyXZ6zMhmiY52eJOQnX",
      "peJxDrQRS4t2DHuHfzhfW",
      "kQskeKZmuyO86rKA_IzuA",
      "G2eeD6pM6N6TNfnHbsC8c",
      "W9ggmKPKWVEKU-F0iJDgW",
      "Rit95fVYvgO8ulGTvVpw9",
      "F5coW1LJyNjK5Pw3zvTkS",
      "BUwa-zYgc9_ScRyfGAns_",
      "KaR3Qn_JsXYOfT2Rwe1Hz",
      "Yu8p1lw1sJi35Q15kTTtR",
      "ol1MY4Xg2sjHu_EBkEka4",
      "UhDiVftUmgcaoYBdNbgrC",
      "dY0kiyv0TTzXLZaJiUBP9",
      "nCvvqyJrHo3D36F6TJd6d",
      "bbUyqHFOpA-BKIZU8UbDS",
      "VRnL9JSmo0g5-4iPNFULU",
      "bxlNO70DBmOumx0hLhwPs",
      "rbJkQAWks3FSiHpV0qR-z"
    ],
    "Food, Recipes & Dining": [
      "TIMrxLJHbEEpdr25yYgvL",
      "E_j1gMmT7KLW4HWbMV2nK",
      "Fz4k0xj4eCoXkWlfhBNKx",
      "3U6zxtPa1b8GbWheaIr4J",
      "zFlBJV-8p1LwP4xgleCwl",
      "ouezkwgSV26h5aMS0Pa4m",
      "K-bz2_bFptZdWAAW7Phxp",
      "v8QoJHekKdrCyhWOEhES0",
      "PuMm5kYCJgtjzlIMBVkai",
      "_SRTioxlU87XALDdBXsie",
      "xcDDh2Cxttl4GUoVZaLj8",
      "1CX2xQOCmw885viaWCws5",
      "Ed-L-mUFR_9nR2BYMssNF",
      "fJDtqjOqB4NddEV0D3FZN",
      "C2hHOX-gwODZjsy1YB5FX",
      "XcZpofYvIFmfsxXK4Ifxg",
      "H3LFWOGUBop6BQWysbT12",
      "TK4dlegma4fLQQqMzWkds",
      "Z2puBNkxQHcCFZxL5DK7Z",
      "lr3m3njdFG6KbeS9tNGx8",
      "K0pXH0afB-Gvipvclt8g9",
      "g0KqTkLQdHWjCD6XDEjVp",
      "5eVWbPiZUJt8HPqnjVlpG",
      "BR_bVaj5zOasyjWX6ygGg",
      "WkGExRci7Q1LO9B1nfaCn",
      "j2bqDafGnyOv6bKMOOGOp",
      "ut4lZu2vLMn2mq4dzZP6G",
      "2lXpzDLP4YQwbrXBX0HaI",
      "9J6OME5--PpDmAuCxFYBG",
      "v5OIJ6Q7oIdUwTrRh-kfL"
    ],
    "Fun, Games & Hobbies": [
      "qDtCI8WZgVJKbN3rogL8j",
      "hSJYHTSH02J0ZchLG-zu8",
      "sCQxQhL0pxmUEbFZ-cmgO",
      "sw6dnxtAjKOyNS5KRuDkN",
      "EJYTBBKPwAOdZPrKZCp8v",
      "q1CDLzD89gR7dL_Qin9Wz",
      "7IwivP0nZscnafCxkhpuC",
      "uv2Ej8EsdmBpBn0p9FnhH",
      "40yecp78USuXhCXVnuUSo",
      "nALI6ijv-K3XNVx45Y2tW",
      "hIFPpNZzUvd7zLg9juZ_a",
      "KE7y0gGJRdbb-9ozqUwDc",
      "WJc0G06lrr_H9OEyQ8Ijl",
      "UQwakt_7MR7WFDz0LWgND",
      "Q7aNUqH_a6GuiD6n0HfaY",
      "LaVTvyGxyZt4p2lwldnnc",
      "MYauHGRcP387M8a_2mbNT",
      "ozEfaAFJMDGoB-ysym8_V",
      "UYdkpfZSu4O6N8_cRXpJO",
      "HvJZI9Kj-DIyFEk309CdD",
      "MNAkssnLggwp3t74suuPs",
      "FGBuaEH72GHuC9ZrVj7XA",
      "iaOrz78m_w7I90kusc5ia",
      "l8tq3o7JcvC-YFV2HaHfu",
      "rVm8IS4-zeJMSbo5ln9OU",
      "_qeZe0Y7621Wr8y6d7KBU",
      "GkzMzuaxSoJhBCZxSRAkM",
      "EcUpzABnh3MfZQTN7inmP",
      "E8XC3NO5V_u63vWoHxJF0",
      "O-7W0uf0-_raG54kvXQcV"
    ],
    "Grok Bot Helpers (Bots That Build or Manage Bots)": [
      "VBmzZaD3abMPl53kwWuYp",
      "Ww-RXj-lLqpg_oWqzccKZ",
      "93gOz3op1UQdBdbekQFLK",
      "z2ds5I1IWLO2M1lFFvhQ4",
      "_jOdbfkB16zxu7MRcmReE",
      "4BmzjFu_i3mVd58irr1x1",
      "i5YF8f-zdcR76uKPrqg3J",
      "p7Gh6HIrfv4AGzIow6-9X",
      "JYH-wtQpWziQwHuwud9av",
      "HP4Q8GHtSIjbyGeI2vg7S",
      "HKZR4k_DCSzy2PSnkkE8v",
      "3BA2IfnuKJ6JRu3hCofdA",
      "_VfbyLY4aGU8KJD46l5Mk",
      "Dje9IjmShPDhZYsGfDnTw",
      "PKtdrwJNC54pLQIAT3H60",
      "4V0rzExpIY19WpNGt71Fp",
      "XMYbnGwxPJUePeRWYOduO",
      "_qhDx4CZfm2-h1RkRyef1",
      "1B3dBw5xR7rwVGT2xGieq",
      "0QOzV3XYLmzbu_WJQYOby",
      "fUKxoLkvZXWJ2r6Aj99sT",
      "l5alJyDSwdmZc-j_XksCH",
      "w3TZCehmbfZesYLz-mOym",
      "WxGbnDbKL3pzLxixjUuK0",
      "Gs5Xs18vnlTyCpcoBDGZ7",
      "PZGj0sDJZW6G3QgZOohDD",
      "XBsOfo3zlutpRPm4FO-zn",
      "EK086K-pdFSZiwJsMvqIq",
      "GGnJOdH3hv321H2QES9UE",
      "B3GjCUHLnI793bGJ1bjT8"
    ],
    "Health, Fitness & Wellness": [
      "6WDjYuRuZN23rSKzl8H_F",
      "1xAJYJPes3X7dUM2mk9Di",
      "PwWb6fJXpeG857af6tEYi",
      "hbzAWQX-CBMF2uAa00jEs",
      "MxgOLBbOpSBsrnYcUulNh",
      "pipXVVxoIV8Efwk_lvUyD",
      "EVQ-0yhShRgL-2qAfdD-8",
      "6MHDA-LzErngNoRBaktLZ",
      "3zE_2sCWH3YTIyIVw8ieK",
      "vpsfo9EnOdJZhIbF2jKrn",
      "s98xfhpL_T32hwckQyjwg",
      "A26SuAqgUsZhJ9CtFmCsA",
      "YT5ogjDNfbE9AW4OhfEo1",
      "dO9rojWVgFL5kjmWYYu_y",
      "he2XcxXmWZVLyao1esDv-",
      "pmaYkbv50yT2tHFrU5o7h",
      "arpIlNG9WYxhAwM24b82I",
      "KywgZj-K8XrKhkVRdCX9Y",
      "cA9uzca3M66V1hk6Au94p",
      "xyw9RJlxNlyXtfjYvcvsT",
      "nkmFntyGYALNwmUBMXCWj",
      "Waw-nx8VWg1lxX8dMkfie",
      "ns3Wo_EYJfm6YQFLHR-Cc",
      "NHDcLbHnQyb1nWlfkVAjm",
      "DdNlDzU_cYi-JJv2YR2CS",
      "s5465ebb9e192551741f7",
      "bT0goMlObmvdG6nXDTkas",
      "ug20hy7rQtr37O8IBoeSm",
      "lBqaV-hht-_BO8TbMZYnM",
      "pC0n6aHDTevS5BpCBLmnQ"
    ],
    "Home, Garden & Pets": [
      "c47Jj2QSSR1UXEcuBgUtQ",
      "X4NHZvN9cvBBS5EgdjsLx",
      "dGYdqS9vLSXpxoNCPBHys",
      "ljzXIgAQcGOV0QxYjHH8I",
      "EC3L23d7wESxjrEDJ2F1D",
      "esUBlwCDVvKUlr77LY8Rs",
      "XA4E-6164Df_AcWlT2G2W",
      "2daEJSUffM8-Dcn2MJjrQ",
      "A1t0gfd8P4hbldi8swcem",
      "n0tywD5YprRhnlIh4h7on",
      "Sw67HeNm7RZ4eP-Jn9h-O",
      "emI7u6fHCg-GBOpxSFoit",
      "uT5Zg-fOrmIxowsqoMXzD",
      "7a8zayr1duE5o39tS2-h6",
      "s20b2c65ebeebb7362fa7",
      "co-LK7P_8ttJ9V8eP_YbN",
      "KwNAf2LD5pNi1NNk8GjOO",
      "Oq7SLPCXbRlF4DwyWZDtU",
      "VRju--X8VRlzTySAh-WTd",
      "MtPP0rOpFzXjEsDyX5mbv",
      "cMNbUq3j5RsHg9mcPxtjM",
      "1r5hTSHVhXCCLb06sMSL1",
      "PQhKM1G6t5kFI0ZwjIt1t",
      "HzmMgW9tr_6YLKDhPFCr3",
      "6H9d0YMSVVXyssBTG2Eh5",
      "Q1j14lHJQzOqkTBZ071gt",
      "ZcypezNRfx6zOMeqtSr1r",
      "M348bgVJPk7DwhFRl7lz_",
      "QqtV5CQa9HRXNC6NmoOjc",
      "DNyx6KvnAFXJUjpQSgwPZ"
    ],
    "Jobs & Careers": [
      "l8p6rXw-lalL-UNiHySnJ",
      "KDahOjiDbbAvxqx9KaGcq",
      "vIX2YW6rr6nQnf8-Rhyzc",
      "EbF8AR1wEHSWCGOp9D1qK",
      "in_PtzvudSXOJ178cNxv0",
      "0uOnsCTsoM8Rx9_yh2koe",
      "ZVmTPe7q2tTeG0JA1rwbG",
      "bAGe8vsdblitlsmH-z0ys",
      "LjgqoCpO0n-8GJdrwJhjk",
      "tUOKN-_Mt8wxeLQcS25ZN",
      "2OahtdVJ5dShzLr9yqL7U",
      "DuR7hXCsNBslEHmUG1vOZ",
      "p6mYbkrvmKcJ5THLVz-EH",
      "XAUki5gPKNwV8Fd6_FCaO",
      "JWyArDklTr6y7KB06lqRY",
      "YLaDxv5e9FSS40odzLmnU",
      "Nj02K7UYwyWfNvS8ws37q",
      "-5YDwi84IyQZSsUXnwxVa",
      "zDczcAxvLi2ApGDLFC8Gz",
      "hJpHNyYyMkUp5y0dXrZiU",
      "r5gMnnIQ21PIbXKFeft-O",
      "WD8zpAN1xP5V3LU8vv9vn",
      "02o6Ky82Bl__bv9dyIuBW",
      "6hqKLQUA0hV-arRXt5MjJ",
      "aq4OcVU_MPO542ZDllWhK",
      "jl5W3FXsJyMZwiGTbkmfQ",
      "wbW8mPLUOhsPITGY_9rn0",
      "m3e7_PPhIQXqwnVUx5vGy",
      "sac3a109dfe021c555c7c",
      "iZvo8_lHfF0csZ-YmcZpv"
    ],
    "Legal, Tax & Paperwork": [
      "vY1eft-dZTKssiaUQvJEc",
      "Yetb1ei_7VvPfWlYqYwAM",
      "e9qoWx6021Xkdd4pacyAO",
      "P1LmE76VG38Ui-XCmzAZE",
      "A4haB5wrqQewiNFIukYZ5",
      "_YVGSK3nmzT_-mYpCB-6e",
      "80S9pLYa2B3pd96wfbjm1",
      "Di5nuItACWsZdMi2CaRgK",
      "4l5O9MZhZElvIGxDw4YEH",
      "gSl7t05_1bxod5TitgrDv",
      "I5_3GqD6I9YL9qebuc0te",
      "vMr8x1Lm8mpo-jKBrdxCh",
      "ZyfbeSKKsHi6mL8bJjg93",
      "-A5GzkqCGxtedkKF_I9CK",
      "b6vWcnzWjIAySVSuPWPk0",
      "Mr87JZkXHwpJQRknVuZcr",
      "7wSIwep9R-eedkBMse1gd",
      "s6-8ydSHNYZVDsnWrtv9a",
      "f7I5mP0uJf9brGIuK0ETo",
      "CrRvSjE9QTGDd_cWC6KEH",
      "mA4Ik2mIduPANDqFVmVMX",
      "Xf744EvEIun3bzP0zdp0u",
      "Kjoz94o-27PM_NgvcPntn",
      "niWUVSbAnXTTcZAK87iKl",
      "0TmnKtakm--gYpX_1jcni",
      "Gv02Uedgl530XCpAqbUoU",
      "lDkNsblCAkXCxBU44ZHxp",
      "KSx8Y5v8FFgHNhKjSN56Y",
      "uV8ZjlR6ehlZ074hdvXG8",
      "BawAoz1FeYXd6HzBqWntt"
    ],
    "Marketing, SEO & Ads": [
      "VjbtJ_qTdzbhJGmXdvTIc",
      "_rzRrKKlUyBD3znUN5b3Q",
      "0IhyZWxwbf2cFmsmroZQL",
      "xzkXiUbdYfPd7g30OhLGf",
      "1RbG9yW5MpQ55XcQlJ0aQ",
      "JeNCKNe0ItsLMWYrLiRcb",
      "nXp4Rp2trKV8AK-RC1Ohf",
      "aw0Zj54sIsAK7vMnajdz0",
      "XbN6iofs_Qjsi2Od1yjyI",
      "gadc3bVOsg9iIwmzAGRve",
      "eOOgCFKObb0jBX_Ur1KZ6",
      "R_rFWGcUu3PHaSyH8VjIt",
      "VS2G5p1b_nQixeiYcdwFs",
      "6Uqn1sN0LwXFp4YIqb8Xu",
      "lspmRxTlNoTmFuIHpm-S-",
      "_l8tAONAOSZ-wU-Quresz",
      "P4UiFNUcfH-751NuybyV1",
      "Jyx1Lg-VzYgyjDc-y-GQi",
      "paAB-Sc86QahFqHEzzHba",
      "k-Vww5TQVS0FR5BoGCqtT",
      "tr-3hPrAG7_LeSzKZ5_vu",
      "8OqqCibnjW8m8cgdn3Qyl",
      "dep-tU0gmIPgiqNsvS4N4",
      "46JFu0eOr47MvAOVwyyeG",
      "CaNidmFikjRDtkc7_2OnO",
      "0xtz8H-BKc1flsiMuX_md",
      "BpqAk55ZrJ2O5SqJm1Mhz",
      "JBHxWeDSuBJMl_6eyK18O",
      "gP9RhBvsSES-Ed1VGMKjS",
      "xitvwtu2RlmS_HAkYDgSx"
    ],
    "Money & Personal Finance": [
      "cMpw0zb2v9RRtQPDfsVFm",
      "q4u8YgzGQqCAOUZcg0Lgt",
      "pwQ612YrX3R0eACnIMlom",
      "MK5zStpj_As8CsRwg3r6w",
      "gCWYD009F66A3XDEYdZgf",
      "WW-UbmTKXn79q0yXapvJE",
      "_CIeV4P17QVoxuaEyeiFZ",
      "Zq7A3Opad78rsoj8eoFay",
      "Ahnj6ebmipMFoqhlHn4tf",
      "Ig18n1eWo_BWokrQB8Dqq",
      "nTYpW4_gAdl1PIztHj90l",
      "Pdi1tggl4brwTKus3xvJH",
      "wyfpX8C4jOj-4_4RAQ249",
      "_XFuh52J-TXU1pLEvWxYs",
      "mAJFosTgk_BmdFi0IWObU",
      "8oUlDrGOJstb0BJN7gBUw",
      "XWuhGoPY9Ak9b-1QqQ_q0",
      "ZJrwuDsQRM1QBC-xQ-Ext",
      "XjfLn_WyeGXzwHjPLL6jW",
      "qjvowkAqkdRzGrubOcRbs",
      "MY7NJmE2egN-855ZN6vSh",
      "YuGzbyI7jVfZedsRUOLCm",
      "eIicxWVI6dT6IOHrUDO8h",
      "jkzfj_gAvDLT8WGMhDLuI",
      "xYeE15lS-qomwX0uWkqYJ",
      "WV324ip4rhNCbkRyhEmdH",
      "W4QR9L1qUuMaTIv61t8tl",
      "XEHPBUHEWd4IB0ReUpKzB",
      "Hfm0xbUx8FqPTd5EYvjat",
      "tZ7zSNa0s1OEtrfFiFlHV"
    ],
    "Privacy, Security & Scam Protection": [
      "fUj6TYhiW_cjtzWvbsFgz",
      "-qkf41F4R1MtZRetyUrxW",
      "DFnZYjCELW2QdywUWZRiG",
      "8jDicbA-2vUVHoUVb5sfF",
      "E3_qOY1VUJWZMh2inUvwT",
      "9SQS0iMj0Ml8yvXnWNTVg",
      "lKfEfQBUdsa0MPhm-4SQU",
      "KOvTJswbPvn7bIthDZhGu",
      "C5EIiTZZL2pPpsb_po7Zs",
      "HSx6HHjUF9_F9kL9qA34m",
      "DWcrUM2ZY3g7lhp0pPA5l",
      "ZPBt18dahGDQ2tmr10D-T",
      "5hcTGitbEYVxYIhdxTJKd",
      "74dzSmLYzMoTvVkLef9Dw",
      "0n3_NyM3Y_LZ8dbMnncmc",
      "n6bSJ2vt2rZuIQahc6G1h",
      "zPBVnLWm9zXhmIjpx2G9D",
      "lTECTKtNLwK_xZhTaq_d_",
      "LHzqMbOeyqA7GZV_aq6gD",
      "Z-1lj3U4-IdLhvH-As2vc",
      "2Oxll84I_kSeoa8K4x3G8",
      "D_3MSloEPYuOajLAhh9YN",
      "hv70IMR--R-c9VZF3aZ7X",
      "GMgVqKF_rn4UU6jISZ_V_",
      "m8LgFBTwlCWHQvVMy77z_",
      "_tZPXK6Re_HQamujV_2zZ",
      "UAP3RBvypVexaojEVEvLj",
      "Vju8QfyKmjEWoV-HJkctY",
      "oQxAmMC8N8HCKqP2Tz85n",
      "WrqD2uAQv_6-mA__IlNLi"
    ],
    "Productivity & Personal Assistant": [
      "sc0a0ec3ce9c675824106",
      "sf813cbd3aadad1cfda46",
      "_DnP777DCicZpaTtm9_h5",
      "yTSGElYcIjFW_5IXu2I-e",
      "XjQ-AZTMrGLmQOTeMu3LF",
      "gBIsnjL6CucNZAW_ByGPx",
      "Nk-vzuWqTvqSed-G8-Za5",
      "KvPUjItGazccrvGwOm401",
      "aNNg3UZFH19vK0KPuyoUW",
      "we_JMJA8IuOvy1eUX6EQz",
      "TPVT39k9ILCz7QYzRja2B",
      "VsZ0QiNcoVNer6PFdyKzI",
      "5hJ_io8a7Y0IImGtFbvJL",
      "lQruhDeXx1KC_fXxNtpVE",
      "W7RKxR9J74ZWJz7qCNHmM",
      "1CN_MjQ2E4oT3hnJXscGB",
      "kcmEmRS4Z5YmFr_KRwSFL",
      "_yXnxJ4kArm8W64FsQIvL",
      "IM85IkIwRCySw0epewBpX",
      "9h28mHEds4Q5FHkni25Js",
      "Pk7TEuX76FMyyACwBHcc0",
      "wkofmk1kzvLmfH4xz0Bf5",
      "mSGZexR_OiumWB7bqdnPh",
      "LyOQ5fUSLM_z3gIiktpkP",
      "hzmpoxnpMR2HNU6dCBf2q",
      "mExccKrtfNSo6e8eSBLzK",
      "krKc-KoCIrGQREMvzef6f",
      "ojRGlp3tVO75MAzhEoVEv",
      "3RksvqtLwsmjspO2swLS8",
      "dadANmm6M496kgq3qgBJ3"
    ],
    "Real Estate": [
      "3ufXSXC-Z8OadVsV9yMLL",
      "F_s7sno8HC2xZlii-ACzg",
      "Unq9DxJfw_lsKB4-KxgUg",
      "4wovVk-3n65GZSQnG_srx",
      "gIPVW_A1Ygg3QBaKpOqTg",
      "6VeOVsZzMkrKElrPi_kOR",
      "rkHdbyaGbAbfAKO3ax7ID",
      "sPjI0Dec1DUvTc7H0zxNG",
      "mVJfH1ZPyKg_ldqUhaMJU",
      "aF1pTFYqb_cM2kTdxu60M",
      "PRdnJ63L8h0FVlMAA1UN4",
      "85qsR6t4r8jI3oKbPm5Uu",
      "0havI1dJhzL_gG11rueQN",
      "A4ku8kkVSTMvIG9eX2oCG",
      "E-kJk5BzNtNzcjAYNknTE",
      "-Kd5faVbWx2bloyDjKwoG",
      "ssC5TnXkyb1lkdzOa21Mg",
      "WjN2P4BH04i5JKuKjXqTA",
      "uPcfO_n3R-y8vDn0Kru9T",
      "JrnQAM0z-7SNI9UtIO3-Z",
      "PqoiUm-y63jlVMRe2h_Nw",
      "y4iQpd9VSjs_h8FCPF5Up",
      "sd6f165284d7fd2f25e56",
      "4c6rlyshWwOpTN_d9HNhm",
      "amNEjElPIlHuan3BCbOT2",
      "rT68Jw98kUdeABmvFobN5",
      "eQ4tLI6SMBanz6rovfhyV",
      "PD7LPOk0HP53QxxWWEN8R",
      "Y5hNK15XXDa7pzffWJeHG",
      "raHfEQQz1Wbrszn27LgNU"
    ],
    "Research, News & Briefings": [
      "DMifb6iyC03g6HvPNrkGw",
      "XftMzXd6cq-DT_ZLvdoy5",
      "i1xwguSTrplEdPvx96MYh",
      "i2hvaEONDg6_gEF5C9RlK",
      "TxB-fy1KryaYJLYWBcGtT",
      "RO8GwQZFXL9O95i13epqF",
      "vKZRklu07uF34Ut9XzMxt",
      "BFiw9Y7BzTQ-3jFBAro1X",
      "Y7iWVNiPdorgu6oFY-PRG",
      "O3iqVd_ZrdRtrDJpxcKss",
      "8hhdYqfvRzigWstUtcmBZ",
      "NIEguoGUjA648fUPle8F5",
      "qBFjPRQ3IbHG69qIFHblE",
      "uFRK1GoAsiopBLPY19QCe",
      "4VEl6mp1QrsvvjTFR-qE_",
      "z7xup0Ax1SBl2K84PELqF",
      "M2ZLrLAUFFU0fFf6Aq28c",
      "8aU6ly_uunnMabpybs3hB",
      "xYZX2g2H3MEIvGgWEDc1T",
      "iKSYn9Dsn07JyR50qePha",
      "fBaHx06vVseLELg2vPOE6",
      "Ho_6yW-icLF6xWHnNVhNo",
      "EDqq9TCA9F9EQ3XnStcKb",
      "kd0J340FaLqQLq81oTYnd",
      "JzHMH4sxHC2IGktj0M49m",
      "gNyxnXEv2hYNzFqoaSvLT",
      "v8v1GweiGXT_hgWwWUzuy",
      "ybwDQYov12VBIPd_LVI6K",
      "uZ415Kgq26rilwSeCGgBF",
      "2cB1nlHWzI7os1zaZ3kCg"
    ],
    "Sales & Lead Generation": [
      "tIas6udS9kSXpcAz6LFd1",
      "gj3IlHOOpzecm6xpmPJOt",
      "wsbOPOkHApmIYLrErnC4e",
      "v1lSvhJCo4UrNGZxc5Fw8",
      "AamPlGjd2lIdDv6seEMXR",
      "yA2-Ti3sPVNFO-zRzkwuX",
      "oPDkINUfpUXhJDdsfRZht",
      "i03IaF768-ielyzegoGye",
      "X-hZf_AreWNt-ZQPYs0Ev",
      "yZ5MFQFdl32vHt6fcIJAc",
      "znrhzY4AYMg4v3QTfU0IJ",
      "6xnxd_CHg0cXVMQCwnRrZ",
      "B6nsTFJlkGP4R-BbdIzeV",
      "aUF_wTHXGWKU3-QPm6PmN",
      "RpAQeGjhzaiO6_Rq_4fyC",
      "PlsyvUb0KnHIQr6psoy0L",
      "Ed8OwTpWaFfZdJHEAoT4t",
      "Uj8zF0iprBX0AsSB3mU2V",
      "fcJJMM58AdXSTBdW3xWyW",
      "AMFF7LG8gxX1bLIH-_D3A",
      "WHMChivJ0obkKm2uvo9xK",
      "r9Svkbs3dN6CY1Iy_Au4b",
      "9ppPlUn9YaDuVx4VAArOR",
      "bFY4jZu-Wwf3LNencvnzD",
      "2bFnH8zBwS5Nj4R-5Wfcr",
      "FQQtGnBeXfCT9sENlX0Ad",
      "vl06Y9ix4dUpsyFfX5K6v",
      "ylBNvuYu7IDolbSmmKHUU",
      "UJQ0HSSxARkK_YVpwGXWq",
      "jbZ6e5CtU019W0wvZrhdl"
    ],
    "Shopping & Deals": [
      "yTeKCLayahHnMdHFG9GJg",
      "vZfC76-4UC1XU7qC4m726",
      "WFW6_5N596TQpWCRjRZ5w",
      "DGg-YKZc5Wwl7QN1O2sKG",
      "Iwo67RW41Q_QXkgQhOL09",
      "stEZpy6WQFTBOWaOOSWAM",
      "L6q8qCzomu2lTs9mu_r1X",
      "Vx13jzt30gpYEztDQbueA",
      "GDYcubpm7IMGco1qI0jHv",
      "NCqLyXzEfvFNuRTs_md3t",
      "lkkCqhC1jBFp6ouZOQd9m",
      "7dKRlaXWiAlCVy2EtIPzj",
      "HSnT7YbUNKs-eVVyNYgg7",
      "0SIU6LHXHupWQkgRq1VNf",
      "D0h0h30nGaZqg8jzxdqwP",
      "R9KJ5NXBENQMscLmj8_Mk",
      "6P8spN6KhyUKNm4UH-meW",
      "5m2ZmmvB9P0dtq4efpill",
      "M0xhuQl4vjLdWj6l3lWeo",
      "vBskzZFRWX5t20481zgS5",
      "wQqwDgxQoM8egthKV0dF0",
      "Ty39S5W0445nHECUz4sgr",
      "4TxZ2KVW5aM6bfOleofNb",
      "7lshPSP7YWEvGzK5ju1Tg",
      "iri8Z5mxwAWTHJgZUr6nb",
      "W4gNjXXfAN_S75Y-cakHM",
      "--X3KeUBk4AwgtfcxxKxZ",
      "BAbHIps4VA0Hr4GLIOJme",
      "rBXWgythSa09pIp14rnV4",
      "yrm2MJ2nInUhoneTBSwJF"
    ],
    "Trading, Crypto & Investing": [
      "n8nC9GmY6ZBdnTE0zRs1T",
      "KtMjZLEGpkN0K6XuLH2UJ",
      "6rORf8SNvR8Sl1hl3THjO",
      "zkVS-PkX1ooTE2nP21DPO",
      "TSgExceGHVJN9U2E4-_23",
      "cp_nk3ftrAgaKbYONW6fa",
      "EgPGxirvQCSHoxbnw6Ym0",
      "GuhaTzThKQG2MKJyHoREx",
      "5axq0n6JtBkqjhMaCDO6d",
      "m9p839QVulo48OQa04cds",
      "tlMpwlAUeDm1kVvjsMxa8",
      "g9tPt-xZyWIEUZcYfQfmq",
      "gsMvBGnKZFIjRU4bCsLR2",
      "KAdPTgvXbDoqYAvg2h65y",
      "m9Cywb2QyPGZnl4l70aR-",
      "7FPF-Zk8Z6l91WfVgBjuk",
      "nHYn9Fkzgb4kdVxjffvlc",
      "PGEVwTjv7Q9cObVSFGRlM",
      "6XD2O5ulgL-dNxQUyU90s",
      "7DlZjgLrcgPUNVkl_cC95",
      "7wv5WYGOnMMImpWdicU3E",
      "FjaItlOeqggdXOLQ1luOk",
      "ae2avzsCyJJnkHsJa7uX2",
      "5ajAIMCNzawDbHLc01gbO",
      "lCyabZFDNNBn7xkNxxhlA",
      "FRPgDTB8gD_iSm6aWIp_Z",
      "mthHv9pksQ6KNBr-hAc09",
      "Ah14z0wvw1_ON1cuG7OuL",
      "w28JNIqjDzbDarnegbh7o",
      "g5J-pr8mBUjLbY2LktOl1"
    ],
    Travel: [
      "sCd3BcjAeQrr77Qrg1waM",
      "PFD95widaEeqjkYLLUZmD",
      "zYTKGwDgxJnIoHHy4eXAC",
      "ZApqGaOa7Rw1kXUHo5vyG",
      "d8C0ufUatv_fgoCRbfXZ4",
      "ySpYZ_5kCKLZZa9H5lQkg",
      "0hD-M0m0boT7nmRKuQKOD",
      "qdj9RHgwlMBpQflJy0K_X",
      "cr8KAg2sp0Nyam7-QF-jh",
      "Qk34TQ_fBXQOWB2kbPbqd",
      "nKo1yWVsJZlLHOXU-dBtA",
      "57uOFOEX5O7ZfTWml40ny",
      "xKCMy-qFRRVxJVCERoee3",
      "6FxcOf5cgteUpdtd3g700",
      "F0ZQruHL4AsmoLxWWLvUG",
      "T27nv3vIy89yKldqELWbn",
      "xG8090ZuddD1vqrDdeTHZ",
      "BZr7_j7WC1klRjG8SrwWx",
      "2pewBd6QpttNiH52dyGhq",
      "TbFMZABkeH7gyIIGxjfdU",
      "A5PJWWubWq6RSITiu_tdG",
      "EEQXiBDbM6YJG1eedy8d4",
      "tNPnclaPMOw4so1wXqfOj",
      "_V9NG3Es7w7am2Kpb6lWg",
      "xqinGTgeghdOyeYmzqO2m",
      "AM17wqUeEmweEHWn58rEL",
      "XGri4qPORtUxnDruyF_da",
      "438hek2SIHhpHn9FDlQCe",
      "xhYtadt6BRbZh3MMEppLa",
      "eXQt5VUovcU0HMj_b-CDY"
    ],
    "Video, Images, Audio & Design": [
      "zvsgYtQHUcSKGRhAb_JzM",
      "VHMdjIGjGpgDSJR7dW6Gz",
      "-L1yFJ5mtwPgn3O_iYUo_",
      "14O3EsptD43aAhoAzvfq3",
      "eFnHzlDcKdoA406SzZbNZ",
      "V8XugyLxzbQXLM9o5b3B-",
      "NqdH9qGvrq-yWRaXhJGM-",
      "KQnsHIvv4_Xk7HyhmewP3",
      "Eeu5NZp62OzQjtlY4ons2",
      "kGiyk73f5CF8XtBMIh0gW",
      "ES3LVns98INeXAoYwef_f",
      "Vk0cnF2c364QxNv-Xip1M",
      "1yHtUns0ArP0-pWh909yc",
      "32fHIBw9Yz-s_o35KycGX",
      "Py5IDzYhNWMoMmzfHFbuB",
      "gt3VqCqSRUJvGD8TFtumG",
      "OWlFWpZguniH2sxh85Grx",
      "rt9m-FTkJoGsZzAjsKLPM",
      "qG_ZROllzSSRGKx_iIbsQ",
      "uYI1q2h7nf7wynlwMaW2Z",
      "BsTA9W4uysdokbBQiriuQ",
      "0zdwc6Tybp9Y87KQEny3W",
      "-PewQ9-5OJOire4J4GI4L",
      "eTLAqnD45kW3h-THwU8XM",
      "nMlGey0lg20bVWCKUoerm",
      "TUBFpf9exUG-qi7RYKZLs",
      "qG9mJ4EM-96hA3A1UNw4E",
      "xM153pKfXPLWagLi_O1vR",
      "loV2_2DMLL-qGrs3nExSy",
      "0BXizj5Ie0OhSa3XDCXMf"
    ],
    "Writing & Publishing": [
      "wtq-j01kD7o8gQFx7E9zv",
      "YwxIbVEWqXN-HYCxiMCoB",
      "jHT5FLhpCMx7JeIq9BEHY",
      "hp7QlVUPuYUp09kc6IFAA",
      "-PuwO8v1fhC4LujsgwLS-",
      "k_7pPRlHeZc2cku1zvVqr",
      "ScOhH1qaoq4XdoYhisagg",
      "xQV-50aQnTgSTraVZPdcR",
      "eIdFwAQ7gWA4xlpQ71jXf",
      "p6yHgNaOHh55XAhXCURuY",
      "VTWG_fyW6Xr_pkjEBM9VC",
      "rcz99db1XPeP3Ldmc_887",
      "k3eBiEIAtXSRUCZJX5aYJ",
      "UUsZRoInD7OHp4sjrZ-we",
      "3aEIY6-TxA3_UwqHgE7XU",
      "UuYRfr-bxgEiuEn_q0e2G",
      "DlRZRodFVy-cxUZDA47QF",
      "hXNMjR6j1A1gnOYyw-72t",
      "9Md8JAsr7Vyk8cv8BcnLf",
      "czVH2_zAJ03lca6ti7cwJ",
      "ySMQW544mSpZFty-DaGml",
      "jJX-rUshHTIK8RP9IpJKE",
      "s1mAnWBblavtTdNumF1VO",
      "stafFTntS-WCezIkdt6fh",
      "T3ZWXx3oYZJSIY4aIVang",
      "-qDULtwkUNS9lKOOxPFvE",
      "s7aaf6431077930df326f",
      "FReKiR82_-lF359lhshpR",
      "720sUKDBHmLpX8Ov4Ufrt",
      "NAFAT-NGrQ7-zLccn4qg1"
    ],
    "X (Twitter) & Social Media": [
      "PaYvPhWPSynlUwFqMX7nc",
      "UmGyUKTHDS4-ziSOlsUeV",
      "Vn8tnMK2GyiFmnWNoF0gT",
      "Y0HBAodNhuJB2Gt5i9LEm",
      "wmWF7EgQD3c1O3cSHFA0v",
      "xSfBSprfKv5h909uzrv7W",
      "Ozmc1X3HNxehT0xz2G4cK",
      "IIpqei3mrbiDeXL-cuhQo",
      "1k1nfNzus_-WXY-nOYM2V",
      "2jelZnGWnAlhmvHFZOp1N",
      "hJPLrcDzGgHhLvEKXRcF1",
      "puPDbZveO1FFvjCXERZoj",
      "TO7sTihoe0TDdDcR2YXin",
      "DqAO8x8wjsb7jazJCBEdl",
      "EN9Ftdn8ZaoLEg-SLPkZL",
      "F9fQmTvQ07m-5HvwvW7kw",
      "LSdxvT3cVnTC4tJV9T_WA",
      "nUcS_RpBYZV5XqCM-ncWm",
      "U-qq-Q-CiWdwRFWk5hmgY",
      "7U_uHDAKGtHqoGsKMyREA",
      "UUcFa8QmAvI3ZyWsEMOt8",
      "Jh9Rlh-ynMYjCqw4V6B9X",
      "uz0PRmWy2_30MzZpATxmH",
      "Cfl2KaSwJw20vkq1kgjXA",
      "ydje9SAP_d0lIHxOdu2_j",
      "Q6AwABs_6Nt0Lx8LzR-A_",
      "4yPjIA8Zp0BHH3wR62sea",
      "fJoloWNDTl7ee9VwxNJxH",
      "NreQEY_NUMvtMd-ueZOWK",
      "Ky0xwV840V9RZoTPQlne_"
    ]
  }
};

// src/data/recent.json
var recent_default = {
  asOf: "2026-10-28",
  basis: "no per-bot publish timestamp is published by the platform; recency surface is ordered by category refresh and labelled with this date",
  categories: [
    {
      slug: "research-news-briefings",
      label: "Research, News & Briefings",
      count: 731,
      asOf: "2026-10-28"
    },
    {
      slug: "coding-software",
      label: "Coding & Software",
      count: 574,
      asOf: "2026-10-28"
    },
    {
      slug: "productivity-personal-assistant",
      label: "Productivity & Personal Assistant",
      count: 550,
      asOf: "2026-10-28"
    },
    {
      slug: "video-images-audio-design",
      label: "Video, Images, Audio & Design",
      count: 543,
      asOf: "2026-10-28"
    },
    {
      slug: "grok-bot-helpers-bots-that-build-or-manage-bots",
      label: "Grok Bot Helpers (Bots That Build or Manage Bots)",
      count: 503,
      asOf: "2026-10-28"
    },
    {
      slug: "business-operations",
      label: "Business & Operations",
      count: 358,
      asOf: "2026-10-28"
    },
    {
      slug: "trading-crypto-investing",
      label: "Trading, Crypto & Investing",
      count: 353,
      asOf: "2026-10-28"
    },
    {
      slug: "money-personal-finance",
      label: "Money & Personal Finance",
      count: 340,
      asOf: "2026-10-28"
    },
    {
      slug: "family-kids-learning",
      label: "Family, Kids & Learning",
      count: 331,
      asOf: "2026-10-28"
    },
    {
      slug: "writing-publishing",
      label: "Writing & Publishing",
      count: 321,
      asOf: "2026-10-28"
    },
    {
      slug: "email-inbox",
      label: "Email & Inbox",
      count: 300,
      asOf: "2026-10-28"
    },
    {
      slug: "x-twitter-social-media",
      label: "X (Twitter) & Social Media",
      count: 286,
      asOf: "2026-10-28"
    },
    {
      slug: "home-garden-pets",
      label: "Home, Garden & Pets",
      count: 278,
      asOf: "2026-10-28"
    },
    {
      slug: "sales-lead-generation",
      label: "Sales & Lead Generation",
      count: 253,
      asOf: "2026-10-28"
    },
    {
      slug: "shopping-deals",
      label: "Shopping & Deals",
      count: 253,
      asOf: "2026-10-28"
    },
    {
      slug: "marketing-seo-ads",
      label: "Marketing, SEO & Ads",
      count: 246,
      asOf: "2026-10-28"
    },
    {
      slug: "jobs-careers",
      label: "Jobs & Careers",
      count: 239,
      asOf: "2026-10-28"
    },
    {
      slug: "privacy-security-scam-protection",
      label: "Privacy, Security & Scam Protection",
      count: 233,
      asOf: "2026-10-28"
    },
    {
      slug: "health-fitness-wellness",
      label: "Health, Fitness & Wellness",
      count: 190,
      asOf: "2026-10-28"
    },
    {
      slug: "food-recipes-dining",
      label: "Food, Recipes & Dining",
      count: 175,
      asOf: "2026-10-28"
    },
    {
      slug: "fun-games-hobbies",
      label: "Fun, Games & Hobbies",
      count: 146,
      asOf: "2026-10-28"
    },
    {
      slug: "legal-tax-paperwork",
      label: "Legal, Tax & Paperwork",
      count: 145,
      asOf: "2026-10-28"
    },
    {
      slug: "travel",
      label: "Travel",
      count: 123,
      asOf: "2026-10-28"
    },
    {
      slug: "calendar-meetings-scheduling",
      label: "Calendar, Meetings & Scheduling",
      count: 120,
      asOf: "2026-10-28"
    },
    {
      slug: "everything-else",
      label: "Everything Else",
      count: 65,
      asOf: "2026-10-28"
    },
    {
      slug: "real-estate",
      label: "Real Estate",
      count: 61,
      asOf: "2026-10-28"
    }
  ]
};

// src/worker/dp/trending.ts
var WINDOW = 14;
var HALF_LIFE = 3;
var W_OPEN = 3;
var W_VIEW = 1;
var PRIOR_MAX = 10;
var GLOBAL_N = 300;
var CATEGORY_N = 50;
var CARD_N = 100;
var RECENT_N = 60;
var decay = (d) => Math.pow(0.5, d / HALF_LIFE);
var SEED_RANK = new Map(popularity_default.global.map((c, i) => [c.toLowerCase(), i + 1]));
var SEED_N = popularity_default.global.length;
function prior(rank, n, t) {
  if (!rank || t >= WINDOW) return 0;
  return PRIOR_MAX * (1 - (rank - 1) / n) * Math.pow(0.5, Math.max(t, 0) / HALF_LIFE);
}
function order(rows) {
  const r6 = (n) => Math.round(n * 1e6);
  return rows.filter((r) => r.score > 0).sort((a, b) => r6(b.score) - r6(a.score) || b.o14 - a.o14 || (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : 0) || (a.code_lc < b.code_lc ? -1 : 1));
}
var CARD_COLS = "code_lc, code, name, author, description, category, source";
var cardOf = (r) => ({ n: r.name ?? "", a: r.author ?? "", d: (r.description ?? "").slice(0, 220), c: r.category ?? null, k: r.code ?? "", s: r.source ?? "" });
var MAX_CHANGES_BYTES = 12e5;
async function buildTrendingPhase(db, nowMs, telemetryStart) {
  const today = dayOf(nowMs);
  const generatedAt = iso(nowMs);
  const t = dayDiff(telemetryStart, today);
  const days = Array.from({ length: WINDOW }, (_, d) => daysBack(nowMs, d));
  const caseSql = `CASE d.day ${days.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END`;
  const binds = [];
  days.forEach((day, d) => binds.push(day, decay(d)));
  const tel = await db.prepare(
    `SELECT b.code_lc, b.code, b.category, b.cats, b.first_seen,
            SUM((${W_OPEN} * d.opens + ${W_VIEW} * d.views) * ${caseSql}) AS score, SUM(d.opens) AS o14
       FROM bot_daily d JOIN bots b ON b.code_lc = d.code_lc
      WHERE d.day >= ? AND d.day <= ? AND b.status = 'live'
      GROUP BY d.code_lc HAVING score > 0 ORDER BY score DESC LIMIT 2000`
  ).bind(...binds, days[WINDOW - 1], today).all();
  const rows = new Map(tel.results.map((r) => [r.code_lc, { ...r, prior: 0 }]));
  if (t < WINDOW) {
    const seedCodes = [...SEED_RANK.keys()];
    const p = await db.prepare(`SELECT code_lc, code, category, cats, first_seen FROM bots WHERE status = 'live' AND code_lc IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(seedCodes)).all();
    for (const r of p.results) {
      const pr = prior(SEED_RANK.get(r.code_lc), SEED_N, t);
      const cur = rows.get(r.code_lc);
      if (cur) {
        cur.prior = pr;
        cur.score += pr;
      } else rows.set(r.code_lc, { ...r, score: pr, o14: 0, prior: pr });
    }
  }
  const ranked = order([...rows.values()]);
  const idOf = (r) => botId(r.category, r.code);
  const global = ranked.slice(0, GLOBAL_N);
  const perCategory = {};
  for (const r of ranked) {
    const slugs = (r.cats ? r.cats.split(",") : r.category ? [r.category] : []).filter(Boolean);
    for (const s of slugs) {
      const a = perCategory[s] ??= [];
      if (a.length < CATEGORY_N) a.push(idOf(r));
    }
  }
  const sumPrior = ranked.reduce((n, r) => n + r.prior, 0);
  const sumAll = ranked.reduce((n, r) => n + r.score, 0);
  const trending = {
    asOf: today,
    basis: "first-party opens and views on grokbot.zone over the last 14 days, recomputed hourly",
    global: global.map(idOf),
    perCategory,
    method: {
      window_days: WINDOW,
      half_life_days: HALF_LIFE,
      weights: { opens: W_OPEN, views: W_VIEW },
      source: "first-party",
      telemetry_start: telemetryStart,
      prior_until: t < WINDOW ? addDays(telemetryStart, WINDOW) : null,
      prior_share: sumAll ? Math.round(sumPrior / sumAll * 1e3) / 1e3 : 0
    },
    generatedAt
  };
  const cards = {};
  const shown = global.slice(0, CARD_N);
  if (shown.length) {
    const c = await db.prepare(`SELECT ${CARD_COLS} FROM bots WHERE code_lc IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(shown.map((r) => r.code_lc))).all();
    const by = new Map(c.results.map((r) => [r.code_lc, r]));
    for (const r of shown) {
      const row = by.get(r.code_lc);
      if (row) cards[idOf(r)] = cardOf(row);
    }
  }
  const sig = global.length ? await db.prepare(`SELECT day, code_lc, views, opens FROM bot_daily WHERE day >= ? AND code_lc IN (SELECT value FROM json_each(?)) ORDER BY code_lc, day`).bind(days[WINDOW - 1], JSON.stringify(global.map((r) => r.code_lc))).all() : { results: [] };
  const idByLc = new Map(global.map((r) => [r.code_lc, idOf(r)]));
  const botsSig = {};
  for (const r of sig.results) (botsSig[idByLc.get(r.code_lc)] ??= {})[r.day] = [r.opens, r.views];
  const signals = {
    generatedAt,
    window_days: WINDOW,
    days: [...days].reverse(),
    fields: ["opens", "views"],
    method: trending.method,
    bots: botsSig
  };
  return { trending, signals, cards };
}
async function buildRecentPhase(db, nowMs) {
  const today = dayOf(nowMs);
  const generatedAt = iso(nowMs);
  const cards = {};
  const rec = await db.prepare(`SELECT ${CARD_COLS}, first_seen FROM bots WHERE status = 'live' ORDER BY first_seen DESC, code_lc ASC LIMIT ?`).bind(RECENT_N).all();
  const recentIds = [];
  for (const r of rec.results) {
    const id = botId(r.category, r.code);
    recentIds.push(id);
    cards[id] ??= cardOf(r);
  }
  const recent = { ...recent_default, asOf: today, basis: "live bots, newest additions first", bots: recentIds, generatedAt };
  const added = await db.prepare(`SELECT code, name, author, description, category, cats, source, first_seen FROM bots WHERE source != 'seed' AND last_live IS NOT NULL AND status IN ('live', 'dead') ORDER BY first_seen, code_lc`).all();
  const deadRows = await db.prepare(`SELECT code, code_lc FROM bots WHERE status = 'dead' ORDER BY code_lc`).all();
  const st = await db.prepare(`SELECT status, COUNT(*) AS n FROM bots GROUP BY status`).all();
  const stats = { live: 0, dead: 0, pending: 0, excluded: 0 };
  for (const r of st.results) stats[r.status] = r.n;
  let list = added.results;
  const row = (r) => ({ id: botId(r.category, r.code), code: r.code, name: r.name, author: r.author, description: r.description, category: r.category, cats: r.cats ? r.cats.split(",") : [], source: r.source, first_seen: r.first_seen });
  let truncated = 0;
  while (list.length > 1 && JSON.stringify(list.map(row)).length > MAX_CHANGES_BYTES) {
    const drop = Math.ceil(list.length / 10);
    truncated += drop;
    list = list.slice(drop);
  }
  const changes = {
    generatedAt,
    since: "2026-10-30",
    ...truncated ? { truncated } : {},
    added: list.map((r) => ({ id: botId(r.category, r.code), code: r.code, name: r.name, author: r.author, description: r.description, category: r.category, cats: r.cats ? r.cats.split(",") : [], source: r.source, first_seen: r.first_seen })),
    dead: deadRows.results.map((r) => r.code),
    excluded: stats.excluded
  };
  return { recent, changes, cards, dead: deadRows.results.map((r) => r.code_lc), stats };
}

// src/worker/dp/cron.ts
var MODEL = classifier_default;
var META_KEYS = ["throttled_until", "trending_at", "checks_hourly", "stats", "discovery_last_run", "discovery_new", "archive_resume", "archive_from", "last_run", "rejected_unresolved", "lists_stat"];
var TRENDING_EVERY_MS = 55 * 6e4;
var COLS = "code_lc, code, name, author, description, category, cats, source, status, first_seen, last_checked, last_live, fail_count, first_fail";
var updateSql = "UPDATE bots SET code=?, name=?, author=?, description=?, category=?, cats=?, status=?, last_checked=?, last_live=?, fail_count=?, first_fail=? WHERE code_lc=?";
function counted(db) {
  let n = 0;
  const hook = (st) => ({
    __st: st,
    bind: (...a) => hook(st.bind(...a)),
    first: (...a) => {
      n++;
      return st.first(...a);
    },
    all: (...a) => {
      n++;
      return st.all(...a);
    },
    run: (...a) => {
      n++;
      return st.run(...a);
    }
  });
  const wrapped = {
    prepare: (sql) => hook(db.prepare(sql)),
    batch: (sts) => {
      n++;
      return db.batch(sts.map((x) => x.__st ?? x));
    }
  };
  return { db: wrapped, count: () => n };
}
function safeMessage(e, list) {
  let m = (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 200);
  for (const w of list) m = m.split(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig")).join("[x]");
  return m;
}
async function runDataPlane(env, scheduledTime, deps = { fetch: (...a) => fetch(...a), clock: realClock }) {
  if (!env.DB) return { upstream: 0, checked: 0, discovered: 0, throttled: false, hourly: false, queries: 0, skipped: "no DB binding" };
  const { db, count } = counted(env.DB);
  const { clock } = deps;
  const now = clock.now();
  const start = env.TELEMETRY_START || dayOf(now);
  const list = denylist(env.NOREF_TOKENS);
  const meta = await readMeta(db, META_KEYS);
  const report = { upstream: 0, checked: 0, discovered: 0, throttled: false, hourly: false, queries: 0 };
  const writes = [];
  const setMeta = (k, v) => writes.push(metaPut(db, k, v));
  let lastError = null;
  const phase = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      lastError = { phase: name, at: iso(clock.now()), message: safeMessage(e, list) };
      console.error(`dataplane phase ${name} failed:`, lastError.message);
      report.skipped = `${name} failed`;
      return void 0;
    }
  };
  const stats = meta.stats ? JSON.parse(meta.stats) : { live: 0, dead: 0, pending: 0, excluded: 0 };
  const heldUntil = meta.throttled_until ? Date.parse(meta.throttled_until) : 0;
  const up = new Upstream(deps.fetch, clock, MAX_UPSTREAM);
  if (heldUntil > now) {
    report.throttled = true;
  } else {
    const t = new Date(scheduledTime);
    const inWindow = t.getUTCHours() === 4 && t.getUTCMinutes() >= 10 && t.getUTCMinutes() < 20;
    const doDiscovery = inWindow || !meta.discovery_last_run;
    if (doDiscovery) await phase("discovery", async () => {
      const found = await discover(up, { archive_resume: meta.archive_resume, archive_from: meta.archive_from }, now);
      if (found.found.length) {
        const r = await db.prepare(
          `INSERT OR IGNORE INTO bots(code_lc, code, source, status, first_seen)
           SELECT lower(json_extract(value, '$.c')), json_extract(value, '$.c'), json_extract(value, '$.s'), 'pending', ? FROM json_each(?)`
        ).bind(iso(now), JSON.stringify(found.found.map((f) => ({ c: f.code, s: f.source })))).run();
        report.discovered = Number(r.meta?.changes ?? 0);
        stats.pending += report.discovered;
      }
      for (const [k, v] of Object.entries(found.state)) setMeta(k, v);
      setMeta("discovery_last_run", iso(now));
      const dn = meta.discovery_new ? JSON.parse(meta.discovery_new) : {};
      dn[dayOf(now)] = (dn[dayOf(now)] ?? 0) + report.discovered;
      for (const k of Object.keys(dn)) if (k < addDays(dayOf(now), -8)) delete dn[k];
      setMeta("discovery_new", JSON.stringify(dn));
    });
    if (doDiscovery && env.LIST_SOURCES?.trim()) await phase("lists", async () => {
      const pull = await pullLists(env.LIST_SOURCES, deps.fetch);
      let added = 0;
      try {
        added = await queueCodes(db, pull.codes, now);
      } finally {
        const stat = { last_run: iso(now), sources: pull.sources, fetched_ok: pull.fetchedOk, added };
        setMeta("lists_stat", JSON.stringify(stat));
      }
      report.listed = added;
      stats.pending += added;
    });
    const room = up.left;
    if (room > 0) await phase("checks", async () => {
      const pend = list.length ? 1 : 0;
      const subCap = pend * Math.min(room, MAX_SUBMISSION_REQUESTS);
      const otherCap = pend * Math.min(room, MAX_PENDING_PER_RUN);
      const sel = (status, n) => db.prepare(`SELECT ${COLS} FROM bots WHERE status = ? ORDER BY last_checked LIMIT ?`).bind(status, n);
      const pendSql = (cmp2, n) => db.prepare(
        `SELECT ${COLS} FROM bots WHERE status = 'pending' AND source ${cmp2} 'submission' ORDER BY last_checked LIMIT ${n}`
      );
      const [subs, others, live, dead] = await db.batch([
        pendSql("=", subCap),
        db.prepare(`SELECT ${COLS} FROM bots WHERE status = 'pending' AND source != 'submission' ORDER BY last_checked LIMIT MAX(0, MIN(?, ? - (SELECT MIN(?, COUNT(*)) FROM bots WHERE status = 'pending' AND source = 'submission')))`).bind(otherCap, MAX_PENDING_PER_RUN, subCap),
        sel("live", room),
        sel("dead", room)
      ]);
      const cmp = (a, b) => (a.last_checked ?? "").localeCompare(b.last_checked ?? "") || (a.code_lc < b.code_lc ? -1 : 1);
      const rows = [...subs.results, ...others.results, ...[...live.results, ...dead.results].sort(cmp)];
      const run = await runChecks(up, rows, clock, list, MODEL);
      report.checked = run.checked;
      if (run.patches.length) {
        const st = run.patches.map(({ row, patch }) => {
          const m = { ...row, ...patch };
          return db.prepare(updateSql).bind(m.code, m.name, m.author, m.description, m.category, m.cats, m.status, m.last_checked, m.last_live, m.fail_count, m.first_fail, m.code_lc);
        });
        await db.batch(st);
        for (const { row, patch } of run.patches) {
          const to = patch.status ?? row.status;
          if (to !== row.status) {
            stats[row.status] = Math.max(0, (stats[row.status] ?? 0) - 1);
            stats[to] = (stats[to] ?? 0) + 1;
          }
        }
        const bucket = iso(now).slice(0, 13);
        const ch = meta.checks_hourly ? JSON.parse(meta.checks_hourly) : {};
        ch[bucket] = (ch[bucket] ?? 0) + run.checked;
        const cutoff = iso(now - 25 * HOUR).slice(0, 13);
        for (const k of Object.keys(ch)) if (k < cutoff) delete ch[k];
        meta.checks_hourly = JSON.stringify(ch);
        setMeta("checks_hourly", meta.checks_hourly);
      }
      if (run.stoppedThrottled) {
        report.throttled = true;
        setMeta("throttled_until", iso(now + THROTTLE_HOLD_MS));
      }
    });
    report.upstream = up.used;
  }
  const due = !meta.trending_at || now - Date.parse(meta.trending_at) >= TRENDING_EVERY_MS;
  if (due) {
    report.hourly = true;
    await phase("submissions", async () => {
      const n = await settleSubmissions(db, now);
      if (n) setMeta("rejected_unresolved", String(Number(meta.rejected_unresolved ?? 0) + n));
    });
    const tr = await phase("trending", () => buildTrendingPhase(db, now, start));
    const rc = await phase("recent", () => buildRecentPhase(db, now));
    if (tr) {
      setMeta("trending_json", JSON.stringify(tr.trending));
      setMeta("signals_json", JSON.stringify(tr.signals));
      setMeta("cards_json", JSON.stringify({ ...rc?.cards ?? {}, ...tr.cards }));
      if (rc) setMeta("recent_json", JSON.stringify(rc.recent));
      setMeta("trending_at", iso(now));
    }
    if (rc) {
      setMeta("changes_json", JSON.stringify(rc.changes));
      setMeta("dead_json", JSON.stringify(rc.dead));
      Object.assign(stats, rc.stats);
    }
    if (new Date(scheduledTime).getUTCHours() === 4) await phase("purge", async () => {
      const today = dayOf(now);
      await db.batch([
        db.prepare("DELETE FROM visit_seen WHERE day < ?").bind(addDays(today, -2)),
        db.prepare("DELETE FROM meta WHERE k LIKE 'salt:%' AND k < ?").bind(`salt:${addDays(today, -2)}`),
        db.prepare("DELETE FROM bot_daily WHERE day < ?").bind(addDays(today, -60))
      ]);
    });
  }
  setMeta("stats", JSON.stringify(stats));
  setMeta("last_run", iso(clock.now()));
  if (lastError) setMeta("last_error", JSON.stringify(lastError));
  try {
    await db.batch(writes);
  } catch (e) {
    const le = { phase: "recent", at: iso(clock.now()), message: safeMessage(e, list) };
    await db.batch([metaPut(db, "last_error", JSON.stringify(le)), metaPut(db, "last_run", iso(clock.now()))]);
    report.skipped = "meta write failed";
  }
  report.queries = count();
  return report;
}
var UNRESOLVED_AFTER_DAYS = 7;
async function settleSubmissions(db, nowMs) {
  const cutoff = new Date(nowMs - UNRESOLVED_AFTER_DAYS * 864e5).toISOString();
  const out = await db.batch([
    db.prepare(`UPDATE submissions SET status = 'approved' WHERE status = 'pending' AND lower(code) IN (SELECT code_lc FROM bots WHERE status = 'live')`),
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE status = 'pending' AND lower(code) IN (SELECT code_lc FROM bots WHERE status IN ('dead', 'excluded'))`),
    db.prepare(`UPDATE submissions SET status = 'rejected' WHERE status = 'pending' AND created_at < ?`).bind(cutoff),
    db.prepare(`UPDATE bots SET status = 'excluded' WHERE status = 'pending' AND source = 'submission' AND first_seen < ?`).bind(cutoff)
  ]);
  return Number(out[2].meta?.changes ?? 0);
}

// src/worker/dp/serve.ts
var LABEL = new Map(categories_default.map((c) => [c.slug, c.label]));
var STALE_MS = 3 * 36e5;
var jsonHeaders = (maxAge) => ({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` });
var esc2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
var cache = null;
var KEYS = ["trending_json", "recent_json", "signals_json", "changes_json", "cards_json", "trending_at", "dead_json"];
async function stored(db, nowMs) {
  if (cache && cache.db === db && nowMs - cache.at < 6e4) return cache.meta;
  const meta = await readMeta(db, KEYS);
  if (meta.trending_at) cache = { db, at: nowMs, meta };
  return meta;
}
function fresh(meta, nowMs) {
  return !!meta.trending_at && nowMs - Date.parse(meta.trending_at) <= STALE_MS;
}
var FILES = {
  "/api/v1/trending.json": "trending_json",
  "/api/v1/recent.json": "recent_json",
  "/api/v1/signals/daily.json": "signals_json",
  "/api/v1/catalog/changes.json": "changes_json"
};
var isStoredFile = (path) => path in FILES;
async function storedFile(db, path, nowMs = Date.now()) {
  if (!db) return null;
  try {
    const meta = await stored(db, nowMs);
    const body = meta[FILES[path]];
    const hasTwin = path === "/api/v1/trending.json" || path === "/api/v1/recent.json";
    if (!body || hasTwin && !fresh(meta, nowMs)) return null;
    return new Response(body + "\n", { headers: jsonHeaders(300) });
  } catch {
    return null;
  }
}
async function healthBody(db, nowMs, nowIso, nosecret, switches) {
  let d1 = false;
  const m = {};
  let events = 0;
  try {
    d1 = !!db && !!await db.prepare("SELECT 1 AS ok").first();
    if (db) {
      Object.assign(m, await readMeta(db, ["last_run", "checks_hourly", "stats", "throttled_until", "discovery_last_run", "discovery_new", "trending_at", "last_error", "rejected_unresolved", "lists_stat"]));
      const day = nowIso.slice(0, 10);
      const e = await db.prepare("SELECT COALESCE(SUM(views + opens), 0) AS n FROM bot_daily WHERE day = ?").bind(day).first();
      events = e?.n ?? 0;
    }
  } catch {
  }
  const parse = (s, d) => {
    try {
      return s ? JSON.parse(s) : d;
    } catch {
      return d;
    }
  };
  const ch = parse(m.checks_hourly, {});
  const cut = new Date(nowMs - 24 * 36e5).toISOString().slice(0, 13);
  const checked = Object.entries(ch).filter(([k]) => k >= cut).reduce((n, [, v]) => n + v, 0);
  const st = parse(m.stats, {});
  const dn = parse(m.discovery_new, {});
  const ls = parse(m.lists_stat, {});
  const wk = new Date(nowMs - 7 * 864e5).toISOString().slice(0, 10);
  const held = m.throttled_until && Date.parse(m.throttled_until) > nowMs ? m.throttled_until : null;
  return {
    ok: d1,
    d1,
    liveness: { last_run: m.last_run ?? null, checked_24h: checked, live: st.live ?? 0, dead: st.dead ?? 0, pending: st.pending ?? 0, throttled_until: held },
    discovery: {
      last_run: m.discovery_last_run ?? null,
      new_7d: Object.entries(dn).filter(([k]) => k >= wk).reduce((n, [, v]) => n + v, 0),
      lists: { last_run: ls.last_run ?? null, sources: ls.sources ?? 0, fetched_ok: ls.fetched_ok ?? 0, added: ls.added ?? 0 },
      noref: { configured: nosecret, excluded: st.excluded ?? 0 }
    },
    submissions: { rejected_unresolved: Number(m.rejected_unresolved ?? 0) },
    telemetry: { events_today: events },
    trending: { generatedAt: m.trending_at ?? null },
    last_error: parse(m.last_error, null),
    noref: nosecret ? "ok" : "missing",
    switches
  };
}
var cardHtml = (id, c, level, trending, showCategory) => {
  const href = `/bots/${esc2(id)}/`;
  const rel = "";
  const label = c.c ? LABEL.get(c.c) : void 0;
  const foot = [
    trending ? '<span class="trend"><span class="dot" aria-hidden="true"></span>Trending</span>' : "",
    showCategory && c.c && label ? `<a class="cat" href="/categories/${esc2(c.c)}/">${esc2(label)}</a>` : ""
  ].join("");
  return `<article class="card panel gz-botcard"><h${level} class="name"><a href="${href}"${rel}>${esc2(c.n)}</a></h${level}>` + (c.a ? `<p class="by">by ${esc2(c.a)}</p>` : "") + `<p class="desc">${esc2(c.d)}</p><p class="foot">${foot}</p></article>`;
};
function trendingList(ids, cards, level, limit, ranked) {
  return ids.filter((i) => cards[i]).slice(0, limit).map((id, i) => `<li data-rank="${i + 1}">${ranked ? `<span class="rank" aria-label="Rank ${i + 1}">${i + 1}</span>` : ""}${cardHtml(id, cards[id], level, true, true)}</li>`).join("");
}
function recentList(ids, cards, level, limit) {
  return ids.filter((i) => cards[i]).slice(0, limit).map((id) => `<li>${cardHtml(id, cards[id], level, false, true)}</li>`).join("");
}
var TRENDING_NOTE = "Ranked by what grokbot.zone visitors opened and viewed in the last 14 days. Updated hourly.";
var RECENT_NOTE = "Newest additions to grokbot.zone first.";
var priorNote = (until) => ` Blended with our launch snapshot until ${esc2(until)}.`;
async function livePage(res, db, path, nowMs = Date.now()) {
  if (!db || res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  try {
    const meta = await stored(db, nowMs);
    if (!fresh(meta, nowMs) || !meta.trending_json || !meta.recent_json || !meta.cards_json) return res;
    const tr = JSON.parse(meta.trending_json), rc = JSON.parse(meta.recent_json), cards = JSON.parse(meta.cards_json);
    const tnote = TRENDING_NOTE + (tr.method?.prior_until ? priorNote(tr.method.prior_until) : "");
    const rw = new HTMLRewriter();
    const trendHtml = (limit, level, ranked) => trendingList(tr.global, cards, level, limit, ranked);
    if (path === "/trending/" || path === "/trending") {
      rw.on('[data-live="trending-list"]', { element(e) {
        e.setInnerContent(trendHtml(100, 2, true), { html: true });
      } }).on('[data-live="trending-note"]', { element(e) {
        e.setInnerContent(tnote);
      } });
    } else if (path === "/recent/" || path === "/recent") {
      rw.on('[data-live="recent-list"]', { element(e) {
        e.setInnerContent(recentList(rc.bots, cards, 2, 60), { html: true });
      } }).on('[data-live="recent-note"]', { element(e) {
        e.setInnerContent(RECENT_NOTE);
      } });
    } else if (path === "/") {
      rw.on('[data-live="trending-rail"]', { element(e) {
        e.setInnerContent(trendHtml(12, 3, false), { html: true });
      } }).on('[data-live="trending-asof"]', { element(e) {
        e.setInnerContent(tnote);
      } }).on('[data-live="recent-rail"]', { element(e) {
        e.setInnerContent(recentList(rc.bots, cards, 3, 8), { html: true });
      } }).on('[data-live="recent-asof"]', { element(e) {
        e.setInnerContent(RECENT_NOTE);
      } }).on('[data-live="recent-basis"]', { element(e) {
        e.remove();
      } });
    } else return res;
    const out = rw.transform(res);
    const h = new Headers(out.headers);
    for (const k of ["etag", "last-modified", "content-length"]) h.delete(k);
    h.set("Cache-Control", "no-cache");
    return new Response(out.body, { status: out.status, headers: h });
  } catch {
    return res;
  }
}
function gonePage(res, id, categorySlug) {
  const label = categorySlug ? LABEL.get(categorySlug) : void 0;
  const link = categorySlug && label ? ` <a href="/categories/${esc2(categorySlug)}/">More in ${esc2(label)}</a>.` : ' <a href="/categories/">Browse categories</a>.';
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" };
  const minimal = () => new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Bot no longer shared | GrokBot Zone</title></head><body><main><h1>This bot is no longer shared</h1><p>The bot's owner has stopped sharing it.${link}</p></main></body></html>`,
    { status: 410, headers }
  );
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) return minimal();
  try {
    const rw = new HTMLRewriter().on("article.bot", { element(e) {
      e.setInnerContent(`<h1>This bot is no longer shared</h1><p class="desc">The bot's owner has stopped sharing it.${link}</p>`, { html: true });
    } }).on("title", { element(e) {
      e.setInnerContent("Bot no longer shared | GrokBot Zone");
    } }).on("head", { element(e) {
      e.append('<meta name="robots" content="noindex">', { html: true });
    } });
    return new Response(rw.transform(res).body, { status: 410, headers });
  } catch {
    return minimal();
  }
}
async function liveState(db, nowMs = Date.now()) {
  if (!db) return null;
  try {
    const meta = await stored(db, nowMs);
    if (!meta.changes_json) return null;
    const ch = JSON.parse(meta.changes_json);
    const dead = new Set(meta.dead_json ? JSON.parse(meta.dead_json) : []);
    return { added: Array.isArray(ch.added) ? ch.added : [], dead };
  } catch {
    return null;
  }
}

// src/worker/dp/telemetry.ts
var BLOCKED_UA = /bot|crawl|spider|slurp|preview|headless|curl|wget|python|go-http|okhttp|java|http-client/i;
function isHuman(req) {
  if (req.method !== "GET") return false;
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua || BLOCKED_UA.test(ua)) return false;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") return false;
  if (/prefetch/i.test(req.headers.get("purpose") ?? "") || /prefetch/i.test(req.headers.get("sec-purpose") ?? "")) return false;
  return true;
}
var hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
function clientKey(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}
async function visitorHash(salt, ip) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${clientKey(ip)}`))).slice(0, 16);
}
var saltCache = null;
async function dailySalt(db, day) {
  if (saltCache?.db === db && saltCache.day === day) return saltCache.salt;
  const fresh2 = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  await db.prepare("INSERT OR IGNORE INTO meta(k, v) VALUES(?, ?)").bind(`salt:${day}`, fresh2).run();
  const row = await db.prepare("SELECT v FROM meta WHERE k = ?").bind(`salt:${day}`).first();
  saltCache = { db, day, salt: row?.v ?? fresh2 };
  return saltCache.salt;
}
async function record(db, kind, codeLc, req, nowMs = Date.now()) {
  try {
    if (!db || !isHuman(req)) return;
    const day = dayOf(nowMs);
    const vh = await visitorHash(await dailySalt(db, day), req.headers.get("cf-connecting-ip") ?? "");
    const ins = await db.prepare("INSERT OR IGNORE INTO visit_seen(day, code_lc, kind, vh) VALUES(?, ?, ?, ?)").bind(day, codeLc, kind, vh).run();
    if (!Number(ins.meta?.changes ?? 0)) return;
    const col = kind === "open" ? "opens" : "views";
    await db.prepare(`INSERT INTO bot_daily(day, code_lc, ${col}) VALUES(?, ?, 1) ON CONFLICT(day, code_lc) DO UPDATE SET ${col} = ${col} + 1`).bind(day, codeLc).run();
  } catch (e) {
    console.error("telemetry write skipped:", e.message);
  }
}
var GO_RE = /^[A-Za-z0-9_-]{1,64}$/;
async function go(req, db, code, wait, seed = async () => null) {
  const notFound = () => new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const redirect = (target3) => new Response(null, { status: 302, headers: { Location: botUrl(target3), "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!GO_RE.test(code)) return notFound();
  const lc = code.toLowerCase();
  let target2 = null;
  let verified = false;
  if (db) {
    try {
      const row = await db.prepare("SELECT code FROM bots WHERE code_lc = ? AND status IN ('live', 'pending')").bind(lc).first();
      if (!row) return notFound();
      target2 = row.code;
      verified = true;
    } catch (e) {
      console.error("go lookup failed:", e.message);
    }
  }
  if (!verified) {
    try {
      target2 = await seed(lc);
    } catch {
      target2 = null;
    }
    if (!target2) return notFound();
    return redirect(target2);
  }
  wait(record(db, "open", lc, req));
  return redirect(target2);
}
var deadCache = null;
async function isDead(db, codeLc, nowMs = Date.now()) {
  if (!db) return false;
  try {
    if (!deadCache || deadCache.db !== db || nowMs - deadCache.at > 3e5) {
      const row = await db.prepare("SELECT v FROM meta WHERE k = 'dead_json'").first();
      deadCache = { db, at: nowMs, set: new Set(row ? JSON.parse(row.v) : []) };
    }
    return deadCache.set.has(codeLc);
  } catch {
    return false;
  }
}

// src/worker/dp/merge.ts
var SLUGS = new Set(categories_default.map((c) => c.slug));
var SITE2 = "https://grokbot.zone";
function splitId(id) {
  let best = null;
  for (const s of SLUGS) if (id.startsWith(`${s}-`) && (!best || s.length > best.length)) best = s;
  return best ? [best, id.slice(best.length + 1)] : id.startsWith(`${CATEGORY_NONE}-`) ? [null, id.slice(CATEGORY_NONE.length + 1)] : [null, id];
}
var seedCache = null;
async function seedMap(assets) {
  if (seedCache && seedCache.assets === assets) return seedCache.map;
  const res = await assets.fetch(new Request(`${SITE2}/api/v1/seed-codes.json`));
  if (!res.ok) return null;
  const codes = (await res.json()).codes;
  seedCache = { assets, map: new Map(codes.map((c) => [c.toLowerCase(), c])) };
  return seedCache.map;
}
async function mergeState(db, assets) {
  const st = await liveState(db);
  if (!st) return null;
  let seed = null;
  try {
    seed = await seedMap(assets);
  } catch {
    seed = null;
  }
  const extras = seed ? st.added.filter((b) => !st.dead.has(b.code.toLowerCase()) && !seed.has(b.code.toLowerCase())).sort((a, b) => a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : a.code < b.code ? -1 : 1) : [];
  return { extras, dead: st.dead };
}
var cardOf2 = (b) => ({ n: b.name, a: b.author, d: b.description.slice(0, 220), c: b.category, k: b.code, s: b.source });
var catsOfEntry = (b) => (b.cats?.length ? b.cats : b.category ? [b.category] : []).filter((s) => SLUGS.has(s));
function searchLive(m) {
  const bots = m.extras.map((b) => ({
    i: b.id,
    n: b.name,
    a: b.author,
    d: b.description.length > 140 ? b.description.slice(0, 139) + "\u2026" : b.description,
    r: 1e6,
    ...b.category ? { c: b.category } : {},
    cats: catsOfEntry(b)
  }));
  return new Response(JSON.stringify({ bots, dead: [...m.dead] }) + "\n", { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
async function categoryPage(res, slug, m) {
  if (res.status !== 200) return res;
  let text = await res.text();
  const add = m.extras.filter((b) => catsOfEntry(b).includes(slug));
  let removed = 0;
  if (m.dead.size) text = text.replace(/<li data-code="([a-z0-9_-]+)">[\s\S]*?<\/li>/g, (all, c) => m.dead.has(c) ? (removed++, "") : all);
  if (!add.length && !removed) return new Response(text, { status: 200, headers: res.headers });
  if (add.length) {
    const html = add.map((b) => `<li data-code="${esc2(b.code.toLowerCase())}">${cardHtml(b.id, cardOf2(b), 2, false, false)}</li>`).join("");
    const at = text.indexOf("data-bot-list");
    const end = at >= 0 ? text.indexOf("</ul>", at) : -1;
    if (end >= 0) text = text.slice(0, end) + html + text.slice(end);
    else add.length = 0;
  }
  text = text.replace(/(data-count[^>]*><span class="num"[^>]*>)(\d+)(<\/span>)/, (_a, x, n, y) => `${x}${Number(n) - removed + add.length}${y}`);
  return new Response(text, { status: 200, headers: res.headers });
}
async function uncategorizedPage(tpl, m) {
  if (tpl.status !== 200) return tpl;
  const text = await tpl.text();
  const list = (m?.extras ?? []).filter((b) => !catsOfEntry(b).length);
  const title = "Uncategorized Grok bots | GrokBot Zone";
  const desc = `${list.length} live Grok bots that have not been sorted into a category yet.`;
  const items = list.map((b) => `<li data-code="${esc2(b.code.toLowerCase())}">${cardHtml(b.id, cardOf2(b), 2, false, false)}</li>`).join("");
  const main = `<main id="main"><div class="wrap page-head"><p class="crumbs"><a href="/categories/">Categories</a> / Uncategorized</p><h1>Uncategorized</h1><p>Bots that have not been sorted into a category yet.</p><p data-count><span class="num">${list.length}</span> bots \xB7 live list</p></div><div class="wrap block">` + (list.length ? `<ul class="grid" data-bot-list>${items}</ul>` : "<p>No bots are waiting for a category right now.</p>") + "</div></main>";
  const out = text.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`).replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc2(desc)}">`).replace(/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="https://grokbot.zone/categories/uncategorized/"><meta name="robots" content="noindex">').replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${title}">`).replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc2(desc)}">`).replace(/<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="https://grokbot.zone/categories/uncategorized/">').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "").replace(/<main id="main">[\s\S]*?<\/main>/, () => main);
  const h = new Headers(tpl.headers);
  for (const k of ["etag", "last-modified", "content-length"]) h.delete(k);
  h.set("Cache-Control", "no-cache");
  return new Response(out, { status: 200, headers: h });
}
var codeOfUrl = (u) => {
  const x = /\/bots\/([^/]+)\/?$/.exec(u);
  return x ? splitId(x[1])[1].toLowerCase() : null;
};
var MAX_FEED_EXTRAS = 50;
function feedJson(body, m) {
  const j = JSON.parse(body);
  const keep = j.items.filter((it) => !m.dead.has(codeOfUrl(it.url) ?? ""));
  const add = m.extras.slice(0, MAX_FEED_EXTRAS).map((b) => ({ id: `${SITE2}/bots/${b.id}/`, url: `${SITE2}/bots/${b.id}/`, title: b.name, summary: b.description, date_modified: b.first_seen }));
  return JSON.stringify({ ...j, items: [...add, ...keep] }, null, 1) + "\n";
}
function feedXml(body, m, generatedAt) {
  const entries = [...body.matchAll(/ {2}<entry>[\s\S]*?<\/entry>\n/g)];
  let out = body;
  for (const e of entries) {
    const c = /<id>[^<]*\/bots\/([^/<]+)\/<\/id>/.exec(e[0]);
    if (c && m.dead.has(splitId(c[1])[1].toLowerCase())) out = out.replace(e[0], "");
  }
  const add = m.extras.slice(0, MAX_FEED_EXTRAS).map((b) => `  <entry>
    <title>${esc2(b.name)}</title>
    <link href="${SITE2}/bots/${esc2(b.id)}/"/>
    <id>${SITE2}/bots/${esc2(b.id)}/</id>
    <updated>${esc2(b.first_seen)}</updated>
    <summary>${esc2(b.description)}</summary>
  </entry>
`).join("");
  if (add) {
    const i = out.indexOf("  <entry>");
    out = i >= 0 ? out.slice(0, i) + add + out.slice(i) : out.replace("</feed>", add + "</feed>");
    out = out.replace(/<updated>[^<]*<\/updated>/, `<updated>${generatedAt}</updated>`);
  }
  return out;
}
function sitemapIndex(body, m) {
  return m.extras.length ? body.replace("</sitemapindex>", `<sitemap><loc>${SITE2}/sitemap-live.xml</loc></sitemap></sitemapindex>`) : body;
}
function sitemapStatic(body, m) {
  if (!m.dead.size) return body;
  return body.split("</url>").filter((u) => {
    const x = /\/bots\/([^/<]+)\/<\/loc>/.exec(u);
    return !(x && m.dead.has(splitId(x[1])[1].toLowerCase()));
  }).join("</url>");
}
function sitemapLive(m) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${m.extras.map((b) => `<url><loc>${SITE2}/bots/${esc2(b.id)}/</loc></url>`).join("")}</urlset>`;
}

// src/worker/dp/page.ts
var LABEL2 = new Map(categories_default.map((c) => [c.slug, c.label]));
var TEMPLATE_PATH = "/bot-template/";
function catsOf(r) {
  const all = [r.category, ...r.cats ? r.cats.split(",") : []].filter((s) => !!s && LABEL2.has(s));
  return [...new Set(all)];
}
function seoLabel(r) {
  const cat = r.category ? LABEL2.get(r.category) : void 0;
  return `${r.name}${r.author ? ` by ${r.author}` : ""}${cat ? ` (${cat})` : ""}`;
}
function renderBotPage(tpl, r) {
  const id = botId(r.category, r.code);
  const path = `/bots/${id}/`;
  const url = `https://grokbot.zone${path}`;
  const slugs = catsOf(r);
  const cat = slugs[0] ? LABEL2.get(slugs[0]) : null;
  const date = (r.first_seen || "").slice(0, 10);
  const label = seoLabel(r);
  const title = `${label} | Grok bot | GrokBot Zone`;
  const description = `${label}: a Grok bot${cat ? ` in ${cat}` : ""}. First listed ${date}.`;
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: r.name,
      description,
      url: `https://x.ai/bot/${r.code}`,
      ...cat ? { applicationCategory: cat } : {},
      ...r.author ? { author: { "@type": "Person", name: r.author } } : {},
      operatingSystem: "Web",
      mainEntityOfPage: url
    },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://grokbot.zone/" },
      ...slugs[0] ? [{ "@type": "ListItem", position: 2, name: cat, item: `https://grokbot.zone/categories/${slugs[0]}/` }] : [],
      { "@type": "ListItem", position: slugs[0] ? 3 : 2, name: r.name, item: url }
    ] }
  ].map((o) => JSON.stringify(o).replace(/</g, "\\u003c"));
  let ldAt = 0;
  const attr2 = (name, value) => ({ element(e) {
    e.setAttribute(name, value);
  } });
  const text = (v) => ({ element(e) {
    e.setInnerContent(v);
  } });
  const drop = { element(e) {
    e.remove();
  } };
  const rw = new HTMLRewriter().on('meta[name="robots"]', drop).on("title", text(title)).on('meta[name="description"]', attr2("content", description)).on('meta[property="og:title"]', attr2("content", title)).on('meta[property="og:description"]', attr2("content", description)).on('meta[property="og:url"]', attr2("content", url)).on('link[rel="canonical"]', attr2("href", url)).on('script[type="application/ld+json"]', { element(e) {
    e.setInnerContent(ld[ldAt++] ?? "{}", { html: true });
  } }).on('[data-f="crumb"]', slugs[0] ? {} : drop).on('[data-f="crumb-link"]', slugs[0] ? { element(e) {
    e.setAttribute("href", `/categories/${slugs[0]}/`);
    e.setInnerContent(cat);
  } } : {}).on('[data-f="name"]', text(r.name)).on('[data-f="by"]', r.author ? text(`by ${r.author}`) : drop).on('[data-f="desc"]', text(r.description)).on('[data-f="cats-row"]', slugs.length ? {} : drop).on('[data-f="cats-row"] dt', text(slugs.length === 1 ? "Category" : "Categories")).on('[data-f="cats"]', { element(e) {
    e.setInnerContent(slugs.map((s) => `<a href="/categories/${esc2(s)}/">${esc2(LABEL2.get(s))}</a>`).join(" \xB7 "), { html: true });
  } }).on('[data-f="author-row"]', r.author ? {} : drop).on('[data-f="author"]', text(r.author)).on('[data-f="date-label"]', text("First listed")).on('[data-f="date"]', { element(e) {
    e.setAttribute("datetime", date);
    e.setInnerContent(date);
  } }).on('[data-f="open"]', attr2("href", `/go/${r.code}`)).on('[data-f="share"]', { element(e) {
    e.setAttribute("data-title", r.name);
    e.setAttribute("data-url", url);
  } }).on('[data-f="note"]', text(`This description is a snapshot from ${date}. The bot's own page has the current details.`));
  const out = rw.transform(tpl);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, s-maxage=3600" });
  return new Response(out.body, { status: 200, headers });
}

// src/worker/index.ts
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};
var DIGEST_CRON = "0 13 * * MON,THU";
var SUBMIT_FROM = "submit@grokbot.zone";
var UPDATES_FROM = "updates@grokbot.zone";
var CATEGORY_SLUGS = new Set(categories_default.map((c) => c.slug));
var json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
});
var disabled = () => json(503, { ok: false, error: "disabled" });
function page(status, title, line2, wantsText2, extraHtml = "") {
  if (wantsText2) return new Response(`${title}
${line2}
`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | GrokBot Zone</title><style>body{background:#030203;color:#f4f1f4;font:16px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2rem}a{color:#00ffcc}button{font:inherit;font-weight:600;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#00ffcc;color:#030203;cursor:pointer}</style></head><body><main><h1>${title}</h1><p>${line2}</p>${extraHtml}<p><a href="/">Back to GrokBot Zone</a></p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
var wantsText = (req) => {
  const a = req.headers.get("accept") ?? "";
  return a.includes("text/plain") && !a.includes("text/html");
};
var codesCache = null;
async function shippedCodes(env) {
  if (codesCache) return codesCache;
  const res = await env.ASSETS.fetch(new Request(`${SITE}/api/v1/codes.json`));
  if (!res.ok) throw new Error(`codes.json ${res.status}`);
  codesCache = new Set((await res.json()).codes);
  return codesCache;
}
async function seedSpelling(env, codeLc) {
  const map = await seedMap(env.ASSETS);
  return map?.get(codeLc) ?? null;
}
async function logSend(env, kind, recipient, messageId, ok, errorCode) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO send_log (kind, recipient, message_id, ok, error_code) VALUES (?, ?, ?, ?, ?)").bind(kind, recipient, messageId, ok ? 1 : 0, errorCode).run();
  } catch (e) {
    console.error("send_log insert failed", e.message);
  }
}
async function sendMail(env, via, kind, msg) {
  if (!via) {
    await logSend(env, kind, msg.to, null, false, "E_NO_BINDING");
    return { ok: false, code: "E_NO_BINDING" };
  }
  try {
    const r = await via.send({ ...msg, subject: oneLine(msg.subject) });
    await logSend(env, kind, msg.to, r?.messageId ?? null, true, null);
    return { ok: true, code: null };
  } catch (e) {
    const code = e.code ?? "E_SEND_FAILED";
    console.error(`send ${kind} failed:`, code, e.message);
    await logSend(env, kind, msg.to, null, false, code);
    return { ok: false, code };
  }
}
async function takeAckSlot(env, nowMs = Date.now()) {
  if (!env.DB) return false;
  const cap = Number(env.ACK_DAILY_BUDGET ?? "200");
  if (!Number.isFinite(cap) || cap <= 0) return false;
  try {
    const r = await env.DB.prepare("INSERT INTO meta(k, v) VALUES(?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 WHERE CAST(v AS INTEGER) < ?").bind(`ack_budget:${new Date(nowMs).toISOString().slice(0, 10)}`, cap).run();
    return Number(r.meta.changes) > 0;
  } catch (e) {
    console.error("ack budget check failed:", e.message);
    return false;
  }
}
async function gate(rl, key) {
  if (!rl) return "unavailable";
  try {
    return (await rl.limit({ key })).success ? "ok" : "limited";
  } catch {
    return "unavailable";
  }
}
var unavailable = () => json(503, { ok: false, error: "unavailable" });
async function writeGate(rl, key) {
  const g = await gate(rl, key);
  if (g === "unavailable") return unavailable();
  return g === "limited" ? json(429, { ok: false, error: "rate_limited" }, { "Retry-After": "60" }) : null;
}
var clientIp = (req) => req.headers.get("cf-connecting-ip") ?? "unknown";
var isJson = (req) => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return void 0;
  }
}
async function health(env) {
  const switches = { FORM_SUBMIT_ENABLED: env.FORM_SUBMIT_ENABLED ?? "0", EMAIL_SUBMIT_ENABLED: env.EMAIL_SUBMIT_ENABLED ?? "0", SUBSCRIBE_ENABLED: env.SUBSCRIBE_ENABLED ?? "0", DIGEST_ENABLED: env.DIGEST_ENABLED ?? "0" };
  const now = Date.now();
  const body = await healthBody(env.DB, now, new Date(now).toISOString(), denylist(env.NOREF_TOKENS).length > 0, switches);
  return json(body.ok ? 200 : 503, body);
}
function flags(env) {
  return json(200, { form: isOn(env.FORM_SUBMIT_ENABLED), subscribe: isOn(env.SUBSCRIBE_ENABLED), email: isOn(env.EMAIL_SUBMIT_ENABLED) });
}
var SUBMISSIONS_PER_DAY = 200;
async function intakeBot(db, code, nowMs = Date.now()) {
  const lc = code.toLowerCase();
  const known = () => db.prepare("SELECT 1 AS x FROM bots WHERE code_lc = ?").bind(lc).first();
  if (await known()) return "known";
  const day = new Date(nowMs).toISOString().slice(0, 10);
  try {
    const r = await db.prepare(
      `INSERT INTO bots(code_lc, code, source, status, first_seen) SELECT ?, ?, 'submission', 'pending', ?
        WHERE (SELECT COUNT(*) FROM bots WHERE source = 'submission' AND first_seen >= ?) < ?
          AND (SELECT COUNT(*) FROM submissions WHERE created_at >= ?) < ?`
    ).bind(lc, code, new Date(nowMs).toISOString(), day, SUBMISSIONS_PER_DAY, day, SUBMISSIONS_PER_DAY).run();
    if (r.meta.changes) return "new";
  } catch {
    return "known";
  }
  return await known() ? "known" : "cap";
}
async function submit(req, env, ctx) {
  if (!isOn(env.FORM_SUBMIT_ENABLED)) return disabled();
  if (!env.DB) return disabled();
  if (!isJson(req)) return json(415, { ok: false, error: "content type must be application/json" });
  const ip = clientIp(req);
  const stop = await writeGate(env.SUBMISSIONS_RL, `${ip}:submit`);
  if (stop) return stop;
  const body = await readJson(req);
  if (body === void 0) return json(400, { ok: false, errors: { body: "invalid JSON" } });
  const v = validateSubmission(body, CATEGORY_SLUGS, Number(env.MIN_FILL_MS ?? "3000"));
  if (!v.ok) return json(400, { ok: false, errors: v.errors });
  const s = v.value;
  if (!CODE_RE.test(s.code)) return json(400, { ok: false, errors: { link: "must look like https://x.ai/bot/<21-character code>" } });
  if ((await shippedCodes(env)).has(s.code.toLowerCase())) return json(409, { ok: false, error: "already_listed" });
  const existing = await env.DB.prepare("SELECT id, status FROM submissions WHERE link = ?").bind(s.link).first();
  let id;
  if (existing && existing.status !== "rejected") return json(409, { ok: false, error: "already_pending" });
  const intake = await intakeBot(env.DB, s.code);
  if (intake === "known") return json(409, { ok: false, error: "already_listed" });
  if (intake === "cap") return new Response("Too many new submissions today. Please try again tomorrow.\n", { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "3600" } });
  if (existing) {
    const r = await env.DB.prepare("UPDATE submissions SET status='pending', source='webform', name=?, author=?, description=?, code=?, category=?, submitter_email=?, ip=? WHERE id=? AND status='rejected'").bind(s.name, s.author, s.description, s.code, s.category, s.email, ip, existing.id).run();
    if (!r.meta.changes) return json(409, { ok: false, error: "already_pending" });
    id = existing.id;
  } else {
    const r = await env.DB.prepare("INSERT INTO submissions (source, name, author, description, code, link, category, submitter_email, ip) VALUES ('webform', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link) DO NOTHING").bind(s.name, s.author, s.description, s.code, s.link, s.category, s.email, ip).run();
    if (!r.meta.changes) return json(409, { ok: false, error: "already_pending" });
    id = r.meta.last_row_id;
  }
  ctx.waitUntil((async () => {
    if (await takeAckSlot(env)) await sendMail(env, env.EMAIL, "ack", { to: s.email, from: SUBMIT_FROM, subject: "Your bot submission to GrokBot Zone", text: ackText(s.name, s.link), html: htmlNote(ackText(s.name, s.link)) });
    else await logSend(env, "ack", s.email, null, false, "E_ACK_BUDGET");
    await notifyOwner(env, { id, name: s.name, author: s.author, category: s.category, link: s.link, submitter: s.email, ip, description: s.description, source: "webform" });
  })());
  return json(201, { ok: true, id, status: "pending" });
}
async function notifyOwner(env, r) {
  const to = (env.OWNER_ADDRESS ?? "").trim();
  const m = ownerSummary(r);
  if (!to) {
    await logSend(env, "owner_summary", "(unset)", null, false, "E_NO_OWNER_ADDRESS");
    return;
  }
  await sendMail(env, env.NOTIFY_OWNER ?? env.EMAIL, "owner_summary", { to, from: UPDATES_FROM, subject: m.subject, text: m.text, html: htmlNote(m.text) });
}
async function subscribe(req, env, ctx) {
  if (!isOn(env.SUBSCRIBE_ENABLED)) return disabled();
  if (!env.DB) return disabled();
  if (!isJson(req)) return json(415, { ok: false, error: "content type must be application/json" });
  const stop = await writeGate(env.SUBSCRIBE_RL, `${clientIp(req)}:subscribe`);
  if (stop) return stop;
  const body = await readJson(req);
  if (!body || typeof body !== "object") return json(400, { ok: false, errors: { body: "invalid JSON" } });
  const errors = {};
  const email2 = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!isEmail(email2)) errors.email = "required, a valid email address";
  if (!honeypotOk(body.company_website)) errors.company_website = "must be empty";
  if (Object.keys(errors).length) return json(400, { ok: false, errors });
  const row = await env.DB.prepare("SELECT id, status FROM subscribers WHERE email = ?").bind(email2).first();
  if (row?.status === "pending") return json(200, { ok: true, status: "already_pending" });
  if (row?.status === "active") return json(409, { ok: false, error: "already_subscribed" });
  if (row?.status === "bounced") return json(409, { ok: false, error: "unavailable" });
  const confirm2 = makeToken();
  const unsub = makeToken();
  if (row) {
    await env.DB.prepare("UPDATE subscribers SET status='pending', confirm_token=?, unsub_token=?, confirmed_at=NULL, unsubscribed_at=NULL WHERE id=?").bind(confirm2, unsub, row.id).run();
  } else {
    const r = await env.DB.prepare("INSERT INTO subscribers (email, confirm_token, unsub_token) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(email2, confirm2, unsub).run();
    if (!r.meta.changes) return json(200, { ok: true, status: "already_pending" });
  }
  const mail = confirmMail(confirm2, env.MAIL_POSTAL_ADDRESS);
  ctx.waitUntil(sendMail(env, env.EMAIL, "confirm", { to: email2, from: UPDATES_FROM, ...mail }).then(() => void 0));
  return json(201, { ok: true, status: "pending_confirm" });
}
var tokenOf = (url) => {
  const t = url.searchParams.get("t") ?? "";
  return TOKEN_RE.test(t) ? t : "";
};
var badToken = (req) => wantsText(req) || (req.headers.get("accept") ?? "").includes("json") ? json(410, { ok: false, error: "bad_token" }) : page(410, "Link not valid", "This link is not valid or has expired.", false);
async function confirm(req, env, url) {
  if (!isOn(env.SUBSCRIBE_ENABLED) || !env.DB) return disabled();
  const t = tokenOf(url);
  const row = t ? await env.DB.prepare("SELECT id, status FROM subscribers WHERE confirm_token = ?").bind(t).first() : null;
  if (!row || row.status !== "pending" && row.status !== "active") return badToken(req);
  if (row.status === "pending") {
    await env.DB.prepare("UPDATE subscribers SET status='active', confirmed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").bind(row.id).run();
  }
  return page(200, "You are subscribed", "Thanks. You will get an update email on Monday and Thursday.", wantsText(req));
}
async function unsubscribe(req, env, url) {
  if (!env.DB) return disabled();
  const t = tokenOf(url);
  const row = t ? await env.DB.prepare("SELECT id, status, email FROM subscribers WHERE unsub_token = ?").bind(t).first() : null;
  if (!row) return req.method === "POST" ? json(410, { ok: false, error: "bad_token" }) : badToken(req);
  if (req.method !== "POST") {
    if (row.status !== "pending" && row.status !== "active") return page(200, "You are unsubscribed", "You will not get any more update emails.", wantsText(req));
    const form = `<form method="post" action="/subscribe/unsubscribe?t=${t}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`;
    return page(200, "Unsubscribe from GrokBot Zone?", "Press the button to stop the update emails. Nothing changes until you do.", wantsText(req), form);
  }
  const body = await req.text();
  if (!/List-Unsubscribe=One-Click/.test(body)) return json(400, { ok: false, error: "expected List-Unsubscribe=One-Click" });
  if (row.status === "pending" || row.status === "active") {
    const r = await env.DB.prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND status IN ('pending','active')").bind(row.id).run();
    if (r.meta.changes) await logSend(env, "unsubscribe", row.email, null, true, null);
  }
  if ((req.headers.get("accept") ?? "").includes("text/html")) return page(200, "You are unsubscribed", "You will not get any more update emails.", false);
  return new Response("Unsubscribed.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
async function email(message, env, _ctx) {
  if (!isOn(env.EMAIL_SUBMIT_ENABLED)) {
    message.setReject("submissions closed");
    return;
  }
  if (message.to.split("@")[0].toLowerCase() !== "submit") {
    message.setReject("unknown mailbox");
    return;
  }
  const auth = (message.headers.get("authentication-results") ?? "").trim();
  if (/^mx\.cloudflare\.net\b/i.test(auth) && /dmarc=fail/i.test(auth)) {
    message.setReject("dmarc");
    return;
  }
  if (!env.DB) {
    message.setReject("submissions closed");
    return;
  }
  const sender = message.from.trim().toLowerCase();
  const stop = await gate(env.SUBMISSIONS_RL, `${sender}:email`);
  if (stop !== "ok") {
    message.setReject(stop === "limited" ? "rate limited" : "temporarily unavailable");
    return;
  }
  const parsed = await new PostalMime().parse(await new Response(message.raw).arrayBuffer());
  const found = extractCodes(parsed.text, parsed.html).filter((c) => CODE_RE.test(c));
  if (!found.length) {
    message.setReject("no bot link found");
    return;
  }
  const shipped = await shippedCodes(env);
  const fresh2 = found.filter((c) => !shipped.has(c.toLowerCase()));
  const skipped = found.filter((c) => shipped.has(c.toLowerCase()));
  if (fresh2.length > 5) {
    message.setReject("too many links in one message");
    return;
  }
  const subject = oneLine(parsed.subject ?? message.headers.get("subject") ?? "");
  const desc = firstDescriptionLine(parsed.text ?? parsed.html?.replace(/<[^>]*>/g, " "));
  const excerpt = (parsed.text ?? "").slice(0, 1500);
  const queued = [];
  for (const code of fresh2) {
    const link = `https://x.ai/bot/${code}`;
    const name = (subject || desc).slice(0, 120).padEnd(3, ".");
    const existing = await env.DB.prepare("SELECT id, status FROM submissions WHERE link = ?").bind(link).first();
    if (existing && existing.status !== "rejected") {
      skipped.push(code);
      continue;
    }
    const intake = await intakeBot(env.DB, code);
    if (intake === "known") {
      skipped.push(code);
      continue;
    }
    if (intake === "cap") {
      if (!queued.length) {
        message.setReject("too many new submissions today");
        return;
      }
      skipped.push(code);
      continue;
    }
    let id;
    if (existing) {
      const r = await env.DB.prepare("UPDATE submissions SET status='pending', source='email', name=?, description=?, code=?, submitter_email=?, raw_excerpt=? WHERE id=? AND status='rejected'").bind(name, desc, code, message.from, excerpt, existing.id).run();
      if (!r.meta.changes) {
        skipped.push(code);
        continue;
      }
      id = existing.id;
    } else {
      const r = await env.DB.prepare("INSERT INTO submissions (source, name, description, code, link, submitter_email, raw_excerpt) VALUES ('email', ?, ?, ?, ?, ?, ?) ON CONFLICT(link) DO NOTHING").bind(name, desc, code, link, message.from, excerpt).run();
      if (!r.meta.changes) {
        skipped.push(code);
        continue;
      }
      id = r.meta.last_row_id;
    }
    queued.push(code);
    await notifyOwner(env, { id, name, author: null, category: null, link, submitter: message.from, ip: "\u2014", description: desc, source: "email" });
  }
  const auto = (message.headers.get("auto-submitted") ?? "no").toLowerCase() !== "no" || /no-?reply|mailer-daemon/i.test(message.from);
  if (!auto) {
    if (!ackAuthorized(auth, message.from, message.headers.get("from"))) await logSend(env, "ack", message.from, null, false, "E_ACK_UNAUTHENTICATED");
    else if (!await takeAckSlot(env)) await logSend(env, "ack", message.from, null, false, "E_ACK_BUDGET");
    else {
      const lines = [`Hi \u2014 we got your message for GrokBot Zone.`];
      if (queued.length) lines.push(`Queued for review: ${queued.map((c) => `https://x.ai/bot/${c}`).join(", ")}`);
      if (skipped.length) lines.push(`Already listed or already queued: ${skipped.map((c) => `https://x.ai/bot/${c}`).join(", ")}`);
      lines.push("Once the platform page checks out the bot is added automatically, usually within an hour.", `\u2014 GrokBot Zone \xB7 ${SITE}/trending/`);
      const text = lines.join("\n");
      const replySubject = `Re: ${subject || "your submission"}`;
      try {
        const raw = rawReply({ from: message.to, to: message.from, subject: replySubject, text, inReplyTo: message.headers.get("message-id") });
        await message.reply(new EmailMessage(message.to, message.from, raw));
        await logSend(env, "ack", message.from, null, true, null);
      } catch (e) {
        console.error("reply failed, no fallback send:", e.message);
        await logSend(env, "ack", message.from, null, false, e.code ?? "E_REPLY_FAILED");
      }
    }
  }
  const owner = (env.OWNER_ADDRESS ?? "").trim();
  if (!owner) {
    await logSend(env, "owner_summary", "(unset)", null, false, "E_NO_OWNER_ADDRESS");
    return;
  }
  try {
    await message.forward(owner);
    await logSend(env, "owner_summary", owner, null, true, null);
  } catch (e) {
    console.error("forward failed:", e.message);
    await logSend(env, "owner_summary", owner, null, false, e.code ?? "E_FORWARD_FAILED");
  }
}
async function digest(controller, env) {
  if (!isOn(env.DIGEST_ENABLED)) {
    console.log("digest: dark (DIGEST_ENABLED != 1), 0 sends");
    return;
  }
  if (!env.DB) {
    console.log("digest: no DB binding, 0 sends");
    return;
  }
  const postal = postalLine(env.MAIL_POSTAL_ADDRESS);
  const res = await env.ASSETS.fetch(new Request(`${SITE}/digests/latest.json`));
  if (!res.ok) {
    console.error(`digest: payload ${res.status}, 0 sends`);
    return;
  }
  const payload = await res.json();
  const cap = Number(env.DIGEST_MAX_SENDS ?? "100");
  const { results } = await env.DB.prepare("SELECT email, unsub_token FROM subscribers WHERE status='active' ORDER BY id LIMIT ?").bind(digestRecipientCount(1e9, cap)).all();
  const weekday = new Date(controller.scheduledTime).getUTCDay() === 4 ? "Thursday" : "Monday";
  let sent = 0;
  for (const s of results) {
    const m = digestMail(payload, weekday, s.unsub_token, postal);
    const r = await sendMail(env, env.EMAIL, "digest", { to: s.email, from: UPDATES_FROM, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
    if (r.ok) sent++;
    if (r.code === "E_RATE_LIMIT_EXCEEDED" || r.code?.startsWith("E_QUOTA")) {
      console.error(`digest: stopped on ${r.code}`);
      break;
    }
  }
  console.log(`digest: ${weekday} sent=${sent} active_considered=${results.length} cap=${cap}`);
}
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === "www.grokbot.zone") {
      url.hostname = "grokbot.zone";
      return Response.redirect(url.toString(), 301);
    }
    const res = await route(request, env, ctx, url);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
  email,
  async scheduled(controller, env, ctx) {
    if (controller.cron === DIGEST_CRON) ctx.waitUntil(digest(controller, env));
    else ctx.waitUntil(runDataPlane(env, controller.scheduledTime).then((r) => console.log("dataplane", JSON.stringify(r))).catch((e) => console.error("dataplane failed:", e.message)));
  }
};
async function route(request, env, ctx, url) {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const m = request.method;
  if (isMediaRequest(request, url)) return serveMedia(request, env.ASSETS, url);
  try {
    if (path === "/api/health" && (m === "GET" || m === "HEAD")) return await health(env);
    if (path === "/api/flags" && m === "GET") return flags(env);
    if (path === "/api/submit" || path === "/api/v1/submissions") {
      if (m === "POST") return await submit(request, env, ctx);
      return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    }
    if (path === "/subscribe") {
      if (m === "POST") return await subscribe(request, env, ctx);
      return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    }
    if (path === "/subscribe/confirm" && m === "GET") return await confirm(request, env, url);
    if (path === "/subscribe/unsubscribe" && (m === "GET" || m === "POST")) return await unsubscribe(request, env, url);
  } catch (e) {
    console.error("route error", path, e.message);
    return json(500, { ok: false, error: "internal" });
  }
  return dataPlane(request, env, ctx, path);
}
var BOT_PAGE_RE = /^\/bots\/([^/]+)$/;
var CATEGORY_RE = /^\/categories\/([a-z0-9-]+)$/;
var notFoundPage = (request, env) => env.ASSETS.fetch(new Request(new URL("/_gz_not_found_", request.url), { headers: unconditional(request).headers }));
async function dbBotPage(request, env, ctx, notFound, id, cat, lc) {
  if (!env.DB) return notFound;
  const row = await env.DB.prepare("SELECT code, name, author, description, category, cats, first_seen, status FROM bots WHERE code_lc = ?").bind(lc).first();
  if (!row || botId(row.category, row.code).toLowerCase() !== id.toLowerCase()) return notFound;
  if (row.status === "dead") return gonePage(notFound, id, cat);
  if (row.status !== "live") return notFound;
  const tpl = await env.ASSETS.fetch(new Request(new URL(TEMPLATE_PATH, request.url)));
  if (tpl.status !== 200) return notFound;
  if (request.method === "GET") ctx.waitUntil(record(env.DB, "view", lc, request));
  return renderBotPage(tpl, row);
}
async function mergedAsset(request, env, path) {
  const cat = CATEGORY_RE.exec(path)?.[1];
  const kind = path === "/search/live.json" ? "search" : cat && CATEGORY_SLUGS.has(cat) ? "category" : ["/feed.json", "/feed.xml", "/sitemap-index.xml", "/sitemap-0.xml", "/sitemap-live.xml"].includes(path) ? path : null;
  if (!kind) return null;
  const m = await mergeState(env.DB, env.ASSETS);
  if (!m || !m.extras.length && !m.dead.size) return kind === "/sitemap-live.xml" ? notFoundPage(request, env) : null;
  if (kind === "search") return searchLive(m);
  const xml = { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" } };
  if (kind === "/sitemap-live.xml") return m.extras.length ? new Response(sitemapLive(m), xml) : notFoundPage(request, env);
  const res = await env.ASSETS.fetch(unconditional(request));
  if (res.status !== 200) return res;
  const h = new Headers(res.headers);
  for (const k of ["etag", "last-modified", "content-length"]) h.delete(k);
  h.set("Cache-Control", "no-cache");
  if (kind === "category") {
    const out = await categoryPage(new Response(res.body, { status: 200, headers: h }), cat, m);
    return out;
  }
  const body = await res.text();
  const merged = kind === "/feed.json" ? feedJson(body, m) : kind === "/feed.xml" ? feedXml(body, m, (/* @__PURE__ */ new Date()).toISOString()) : kind === "/sitemap-index.xml" ? sitemapIndex(body, m) : sitemapStatic(body, m);
  return new Response(merged, { status: 200, headers: h });
}
async function dataPlane(request, env, ctx, path) {
  try {
    return await dataPlaneInner(request, env, ctx, path);
  } catch (e) {
    console.error("dataplane route error", path, e.message);
    return path === "/go" || path.startsWith("/go/") ? new Response("Not found\n", { status: 404 }) : env.ASSETS.fetch(request);
  }
}
async function dataPlaneInner(request, env, ctx, path) {
  const get = request.method === "GET" || request.method === "HEAD";
  if (path === "/go" || path.startsWith("/go/")) return go(request, env.DB, decodeURIComponent(path.slice(4)).replace(/\/+$/, ""), (p) => ctx.waitUntil(p), (lc) => seedSpelling(env, lc));
  if (get && isStoredFile(path)) {
    const stored2 = await storedFile(env.DB, path);
    if (stored2) return stored2;
    if (path !== "/api/v1/trending.json" && path !== "/api/v1/recent.json") return json(503, { ok: false, error: "not_ready" }, { "Retry-After": "600" });
  }
  if (path === TEMPLATE_PATH.replace(/\/$/, "")) return notFoundPage(request, env);
  if (!get) return env.ASSETS.fetch(request);
  if (path === "/categories/uncategorized") {
    let tpl = new Response(null, { status: 404 });
    for (const slug of [...CATEGORY_SLUGS].slice(0, 3)) {
      tpl = await env.ASSETS.fetch(new Request(new URL(`/categories/${slug}/`, request.url), { headers: unconditional(request).headers }));
      if (tpl.status === 200) break;
    }
    return uncategorizedPage(tpl, await mergeState(env.DB, env.ASSETS));
  }
  if (request.method === "GET") {
    const merged = await mergedAsset(request, env, path);
    if (merged) return merged;
  }
  const m = BOT_PAGE_RE.exec(path);
  const livePath = path === "/" || path === "/trending" || path === "/recent";
  if (!m && !(livePath && request.method === "GET")) return env.ASSETS.fetch(request);
  const res = await env.ASSETS.fetch(unconditional(request));
  if (m) {
    const [cat, code] = splitId(m[1]);
    const lc = code.toLowerCase();
    if (await isDead(env.DB, lc)) return gonePage(res, m[1], cat);
    if (res.status === 200) {
      if (request.method === "GET") ctx.waitUntil(record(env.DB, "view", lc, request));
      return res;
    }
    if (res.status !== 404) return res;
    return dbBotPage(request, env, ctx, res, m[1], cat, lc);
  }
  return livePage(res, env.DB, path);
}
function unconditional(req) {
  const h = new Headers(req.headers);
  for (const k of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"]) h.delete(k);
  return new Request(req, { headers: h });
}
export {
  index_default as default
};
