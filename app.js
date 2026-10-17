(function () {
  const { flattenWords, batchProgress, clipFileName, extForMime, pickMime, resumeIndex, makeZip } = window.SuretLib;
  const WORDS = flattenWords(BATCHES);
  const ENDPOINT = (CONFIG.endpoint || "").trim();
  const MAX_SECONDS = 12;

  const $ = (id) => document.getElementById(id);
  const el = {
    cat: $("cat"), num: $("num"), prompt: $("prompt"), hint: $("hint"), statusLine: $("statusLine"),
    recBtn: $("recBtn"), recLabel: $("recLabel"), review: $("review"), playBtn: $("playBtn"), redoBtn: $("redoBtn"),
    spelling: $("spelling"), saveBtn: $("saveBtn"), prevBtn: $("prevBtn"), skipBtn: $("skipBtn"), nextBtn: $("nextBtn"),
    progressText: $("progressText"), queueText: $("queueText"), bar: $("bar"),
    backdrop: $("backdrop"), helpSheet: $("helpSheet"), listSheet: $("listSheet"), wordList: $("wordList"),
    sendBtn: $("sendBtn"), sendNote: $("sendNote"), toast: $("toast"),
  };

  // ---------- small persistence helpers ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("suret-recorder", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("recs", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  let dbPromise = null;
  function db() { return (dbPromise ||= openDb()); }
  async function dbAll() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = d.transaction("recs").objectStore("recs").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPut(rec) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("recs", "readwrite");
      tx.objectStore("recs").put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- state ----------
  const recs = new Map(); // id -> {id, status, spelling, mime, blob, updated}
  let index = Math.min(Math.max(parseInt(store.get("suret.idx") || "0", 10) || 0, 0), WORDS.length - 1);
  let draft = null; // {blob, mime, dirty}
  let key = new URLSearchParams(location.hash.slice(1)).get("k") || store.get("suret.key") || "";
  if (key) store.set("suret.key", key);
  let badKey = !!ENDPOINT && !key;
  let interacted = false; // any tap or typing on the card this visit

  const STATUS_TEXT = {
    uploaded: ["✓ Sent to Madison", "ok"],
    pending: ["Saved · sending…", "warn"],
    local: ["✓ Saved on this phone", "ok"],
    skipped: ["Skipped", ""],
  };

  // ---------- rendering ----------
  function render() {
    const w = WORDS[index];
    const rec = recs.get(w.id);
    el.cat.textContent = w.cat;
    el.num.textContent = `${w.id} / ${WORDS.length}`;
    el.prompt.textContent = w.en;
    el.hint.textContent = w.hint;
    const [text, cls] = STATUS_TEXT[rec?.status] || ["", ""];
    const keyProblem = key ? "This link isn't working. Ask Madison to send it again." : "This link is incomplete. Ask Madison to send it again.";
    el.statusLine.textContent = badKey ? keyProblem : text;
    el.statusLine.className = "status-line " + (badKey ? "warn" : cls);
    el.review.classList.toggle("show", !!draft);
    el.saveBtn.disabled = !draft || recording;
    el.prevBtn.disabled = index === 0 || recording;
    el.nextBtn.disabled = index === WORDS.length - 1 || recording;
    el.skipBtn.disabled = recording;
    renderProgress();
  }

  // Progress is shown for the batch of the current card, so a new batch
  // starts at 0 instead of feeling like a long way from the end.
  function renderProgress() {
    const recorded = new Set(), skippedIds = new Set();
    let waiting = 0, local = 0;
    for (const r of recs.values()) {
      (r.status === "skipped" ? skippedIds : recorded).add(r.id);
      if (r.status === "pending") waiting++;
      if (r.status === "local") local++;
    }
    const batch = WORDS[index].batch;
    const { done, total } = batchProgress(WORDS, recorded, batch);
    const skipped = batchProgress(WORDS, skippedIds, batch).done;
    el.progressText.textContent = `Batch ${batch} · ${done} of ${total} recorded` + (skipped ? ` · ${skipped} skipped` : "");
    el.queueText.textContent = waiting ? `${waiting} sending…` : local ? "saved on this phone" : "";
    el.bar.style.width = `${((done + skipped) / total) * 100}%`;
  }

  function goTo(i) {
    index = Math.min(Math.max(i, 0), WORDS.length - 1);
    store.set("suret.idx", String(index));
    const rec = recs.get(WORDS[index].id);
    draft = rec?.blob ? { blob: rec.blob, mime: rec.mime, dirty: false } : null;
    el.spelling.value = rec?.spelling || "";
    stopPlayback();
    render();
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove("show"), 2600);
  }

  // ---------- recording ----------
  let stream = null, recorder = null, recording = false, chunks = [], timer = null, startedAt = 0;

  async function ensureStream() {
    if (stream && stream.getAudioTracks().some((t) => t.readyState === "live")) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    return stream;
  }

  function releaseStream() {
    if (stream && !recording) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast("This browser can't record. Open the link in Safari or Chrome.");
      return;
    }
    try {
      await ensureStream();
    } catch (err) {
      const blocked = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      toast(blocked
        ? "Microphone blocked. Allow mic access, or open the link in Safari or Chrome."
        : "Couldn't find a microphone.");
      return;
    }
    stopPlayback();
    const mime = pickMime((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || "audio/mp4";
      const blob = new Blob(chunks, { type });
      recording = false;
      clearInterval(timer);
      el.recBtn.classList.remove("recording");
      el.recBtn.setAttribute("aria-label", "Start recording");
      if (blob.size < 1000) {
        el.recLabel.textContent = "Too short. Tap to try again";
        render();
        return;
      }
      draft = { blob, mime: type, dirty: true };
      el.recLabel.textContent = "Tap to record again";
      render();
    };
    recorder.start();
    recording = true;
    startedAt = Date.now();
    el.recBtn.classList.add("recording");
    el.recBtn.setAttribute("aria-label", "Stop recording");
    tick();
    timer = setInterval(tick, 250);
    render();
  }

  function tick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.recLabel.textContent = `Recording 0:${String(s).padStart(2, "0")} · tap to stop`;
    if (s >= MAX_SECONDS) stopRecording();
  }

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  let player = null;
  function stopPlayback() {
    if (player) {
      player.pause();
      URL.revokeObjectURL(player.src);
      player = null;
    }
  }
  function play() {
    if (!draft) return;
    stopPlayback();
    player = new Audio(URL.createObjectURL(draft.blob));
    player.play().catch(() => toast("Couldn't play it back. Try Redo."));
  }

  // ---------- saving & uploading ----------
  async function saveCurrent() {
    const w = WORDS[index];
    const rec = recs.get(w.id);
    const spelling = el.spelling.value.trim();
    const changed = draft && (draft.dirty || (rec?.spelling || "") !== spelling || rec?.status === "skipped");
    if (!changed) return false;
    const next = {
      id: w.id,
      status: ENDPOINT ? "pending" : "local",
      spelling,
      mime: draft.mime,
      blob: draft.blob,
      updated: Date.now(),
    };
    recs.set(w.id, next);
    draft.dirty = false;
    try { await dbPut(next); } catch { toast("Couldn't save on this phone. Keep this page open."); }
    pump();
    return true;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function post(payload) {
    const res = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify(payload) });
    return res.json();
  }

  let pumping = false;
  async function pump() {
    if (pumping || !ENDPOINT || !key || badKey) return;
    pumping = true;
    try {
      const queue = [...recs.values()].filter((r) => r.status === "pending" && r.blob).sort((a, b) => a.id - b.id);
      for (const rec of queue) {
        const w = WORDS[rec.id - 1];
        const out = await post({
          k: key, id: rec.id, en: w.en, cat: w.cat, hint: w.hint,
          spelling: rec.spelling, mime: rec.mime, data: await blobToBase64(rec.blob),
        });
        if (!out.ok) {
          if (out.error === "bad key") badKey = true;
          throw new Error(out.error || "upload failed");
        }
        // A newer take may have replaced this one while it was uploading.
        if (recs.get(rec.id) === rec) {
          rec.status = "uploaded";
          await dbPut(rec).catch(() => {});
        }
        render();
      }
    } catch {
      // Network hiccup or server error: the 30-second retry picks it up.
    } finally {
      pumping = false;
      render();
    }
  }

  // Pull the list of words already in Madison's Drive, so progress survives
  // a cleared browser or a switch to a different phone/browser.
  async function syncFromServer() {
    if (!ENDPOINT || !key) return;
    try {
      const out = await post({ k: key, action: "status" });
      if (!out.ok) {
        if (out.error === "bad key") { badKey = true; render(); }
        return;
      }
      for (const id of out.ids || []) {
        if (!recs.has(id) && WORDS[id - 1]) {
          const rec = { id, status: "uploaded", spelling: (out.spellings || {})[id] || "", mime: "", blob: null, updated: 0 };
          recs.set(id, rec);
          dbPut(rec).catch(() => {});
        }
      }
      const next = resumeIndex(WORDS, new Set(recs.keys()), { index, interacted: interacted || recording || !!draft });
      if (next !== index) goTo(next);
      render();
    } catch { /* offline: fine */ }
  }

  // ---------- sending everything as one file ----------
  async function sendAll() {
    const files = [];
    const manifest = [];
    for (const w of WORDS) {
      const rec = recs.get(w.id);
      if (!rec) continue;
      const entry = { id: w.id, cat: w.cat, en: w.en, hint: w.hint, spelling: rec.spelling || "", status: rec.status, file: "" };
      if (rec.blob && rec.status !== "skipped") {
        entry.file = clipFileName(w, extForMime(rec.mime));
        files.push({ name: entry.file, data: new Uint8Array(await rec.blob.arrayBuffer()) });
      }
      manifest.push(entry);
    }
    if (!files.length) { toast("Nothing recorded on this phone yet."); return; }
    files.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    const file = new File([makeZip(files)], "suret-recordings.zip", { type: "application/zip" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Suret recordings" }); } catch { /* cancelled */ }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- sheets ----------
  function openSheet(sheet) {
    el.backdrop.classList.add("show");
    sheet.classList.add("show");
  }
  function closeSheets() {
    el.backdrop.classList.remove("show");
    el.helpSheet.classList.remove("show");
    el.listSheet.classList.remove("show");
  }
  function renderList() {
    el.wordList.textContent = "";
    let cat = "", batch = 0;
    for (const w of WORDS) {
      if (w.batch !== batch) {
        batch = w.batch;
        cat = "";
        const b = document.createElement("h2");
        b.className = "batch-head";
        b.textContent = `Batch ${batch}`;
        el.wordList.appendChild(b);
      }
      if (w.cat !== cat) {
        cat = w.cat;
        const h = document.createElement("h3");
        h.textContent = cat;
        el.wordList.appendChild(h);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "word-row";
      const n = document.createElement("span"); n.className = "n"; n.textContent = w.id;
      const t = document.createElement("span"); t.className = "w"; t.textContent = w.en + (w.hint ? ` (${w.hint})` : "");
      const d = document.createElement("i"); d.className = "dot " + (recs.get(w.id)?.status || "");
      row.append(n, t, d);
      row.addEventListener("click", async () => { interacted = true; await saveCurrent(); closeSheets(); goTo(w.id - 1); });
      el.wordList.appendChild(row);
    }
  }

  // ---------- wiring ----------
  el.recBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
  el.playBtn.addEventListener("click", play);
  el.redoBtn.addEventListener("click", startRecording);
  el.saveBtn.addEventListener("click", async () => {
    const saved = await saveCurrent();
    if (saved) toast(ENDPOINT ? "Saved. Sending to Madison…" : "Saved");
    if (index < WORDS.length - 1) goTo(index + 1);
    else { render(); toast("That's the last one. Thank you!"); }
  });
  el.nextBtn.addEventListener("click", async () => { await saveCurrent(); goTo(index + 1); });
  el.prevBtn.addEventListener("click", async () => { await saveCurrent(); goTo(index - 1); });
  const card = document.querySelector("main");
  card.addEventListener("pointerdown", () => { interacted = true; }, true);
  card.addEventListener("keydown", () => { interacted = true; }, true);
  el.skipBtn.addEventListener("click", async () => {
    const w = WORDS[index];
    if (!recs.get(w.id)?.blob) {
      const rec = { id: w.id, status: "skipped", spelling: "", mime: "", blob: null, updated: Date.now() };
      recs.set(w.id, rec);
      dbPut(rec).catch(() => {});
    }
    goTo(index + 1);
  });
  el.spelling.addEventListener("keydown", (e) => { if (e.key === "Enter" && !el.saveBtn.disabled) el.saveBtn.click(); });
  $("helpBtn").addEventListener("click", () => openSheet(el.helpSheet));
  $("helpClose").addEventListener("click", () => { store.set("suret.seenHelp", "1"); closeSheets(); });
  $("listBtn").addEventListener("click", () => { renderList(); openSheet(el.listSheet); });
  el.backdrop.addEventListener("click", closeSheets);
  el.sendBtn.addEventListener("click", sendAll);
  if (!ENDPOINT) el.sendNote.textContent = "Your recordings are saved on this phone. When you're done (or anytime), tap this to send them all to Madison in one file: Discord, Messages, AirDrop, anything.";
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopRecording(); releaseStream(); } });
  window.addEventListener("online", pump);
  setInterval(pump, 30000);

  (async function init() {
    try {
      for (const rec of await dbAll()) {
        // Recorded before Drive saving was switched on: send those now.
        if (ENDPOINT && rec.status === "local") rec.status = "pending";
        recs.set(rec.id, rec);
      }
    } catch { /* storage unavailable: still works for this visit */ }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    goTo(resumeIndex(WORDS, new Set(recs.keys()), { index, interacted: false }));
    if (!store.get("suret.seenHelp")) openSheet(el.helpSheet);
    pump();
    syncFromServer();
  })();
})();
