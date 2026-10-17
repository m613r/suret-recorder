// Pure helpers shared by the page and the tests. Loaded as a plain script in
// the browser (exposes window.SuretLib) and via require() in Node.
(function (root) {
  function flattenWords(list) {
    const words = [];
    for (const [cat, items] of list) {
      for (const item of items) {
        const [en, hint] = Array.isArray(item) ? item : [item, ""];
        words.push({ id: words.length + 1, cat, en, hint });
      }
    }
    return words;
  }

  function clipFileName(word, ext) {
    const safe = word.en
      .replace(/\//g, "-")
      .replace(/[^A-Za-z0-9' -]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return String(word.id).padStart(3, "0") + " " + safe + "." + ext;
  }

  function extForMime(mime) {
    const base = (mime || "").split(";")[0].trim();
    return { "audio/mp4": "m4a", "audio/webm": "webm", "audio/ogg": "ogg" }[base] || "audio";
  }

  // iPhones record mp4/AAC; Chrome on Android records webm/opus.
  function pickMime(isTypeSupported) {
    for (const type of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
      if (isTypeSupported(type)) return type;
    }
    return "";
  }

  // Where to put someone when the server reports what's already recorded:
  // the first word not done, but only on a fresh visit still sitting on
  // card 1. Never yank someone who has started recording or navigating.
  function resumeIndex(words, doneIds, { index, interacted }) {
    if (interacted || index !== 0) return index;
    const first = words.findIndex((w) => !doneIds.has(w.id));
    return first > 0 ? first : index;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Uncompressed ("stored") zip: audio is already compressed, so deflate
  // would gain nothing and this keeps the page free of dependencies.
  function makeZip(files) {
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
      const name = enc.encode(file.name);
      const crc = crc32(file.data);
      const size = file.data.length;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      locals.push(new Uint8Array(local.buffer), name, file.data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true); // version made by
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, size, true);
      central.setUint32(24, size, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), name);

      offset += 30 + name.length + size;
    }
    const centralSize = centrals.reduce((n, part) => n + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let pos = 0;
    for (const part of parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }

  const api = { flattenWords, clipFileName, extForMime, pickMime, resumeIndex, crc32, makeZip };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SuretLib = api;
})(this);
