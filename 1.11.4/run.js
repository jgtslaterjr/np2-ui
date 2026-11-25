
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const base = n => String(n || "").replace(/\.[^.]+$/, "");
const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
const MODE = { time: "Timed", freq: "Frequency sweep", power: "Power sweep" };
const STATE = { idle: "Standby", loading: "Loading…", loaded: "Ready", running: "Running", paused: "Paused", ended: "Finished", stopped: "Stopped", failed: "Couldn't run" };
const WANT = decodeURIComponent(location.hash.slice(1));
const CIRC = 2 * Math.PI * 86;
const stageColor = i => `var(--st${(i % 8) + 1})`;

let S = null, busy = false, tableKey = "", stagesKey = "", ringKey = "", lastError = "";

// The ring covers the whole protocol: one arc per stage, sized by its planned length and drawn in that
// stage's colour, faint for the part still to come and solid for the part done. Where a stage uses
// cross-frequency coupling, a thin inner arc marks its window, with ticks across the ring where it starts and stops.
const CR = 72, CCIRC = 2 * Math.PI * CR;
function renderRing(stages, fracs) {
  const n = stages.length;
  const secs = stages.map(s => s.totalSec || 0), all = secs.reduce((a, b) => a + b, 0);
  const share = i => all ? secs[i] / all : 1 / n;
  const gap = n > 1 ? 3 : 0;
  const key = JSON.stringify([secs, stages.map(s => s.coupling || null)]);
  if (key !== ringKey) {
    ringKey = key;
    let at = 0, atFrac = 0, cpl = "";
    const tick = (frac, title) => { const a = frac * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      return `<line class="ctick" x1="${100 + 65 * c}" y1="${100 + 65 * s}" x2="${100 + 94 * c}" y2="${100 + 94 * s}"><title>${title}</title></line>`; };
    const segs = stages.map((s, i) => {
      const len = Math.max(0, share(i) * CIRC - gap), off = -(at + gap / 2);
      const cp = s.coupling;
      if (cp && secs[i]) {
        const f0 = atFrac + share(i) * cp.startSec / secs[i], f1 = atFrac + share(i) * cp.endSec / secs[i];
        const clen = (f1 - f0) * CCIRC, c = `cx="100" cy="100" r="${CR}" fill="none" stroke-width="5" stroke-dashoffset="${-f0 * CCIRC}"`;
        const label = `Coupling ${esc(cp.freq)} Hz: ${clock(cp.startSec)} to ${clock(cp.endSec)}`;
        cpl += `<circle class="cpl bg" ${c} stroke-dasharray="${clen} ${CCIRC}"><title>${label}</title></circle>` +
          `<circle class="cpl fg" data-i="${i}" data-len="${clen}" ${c} stroke-dasharray="0 ${CCIRC}"/>`;
        if (cp.startSec > 0) cpl += tick(f0, `Coupling starts at ${clock(cp.startSec)}`);
        if (cp.endSec < secs[i]) cpl += tick(f1, `Coupling stops at ${clock(cp.endSec)}`);
      }
      at += share(i) * CIRC; atFrac += share(i);
      const c = `cx="100" cy="100" r="86" fill="none" stroke-width="14" stroke-dashoffset="${off}" style="--sc:${stageColor(i)}"`;
      return `<circle class="seg bg" ${c} stroke-dasharray="${len} ${CIRC}"/>` +
        `<circle class="seg fg" data-len="${len}" ${c} stroke-dasharray="0 ${CIRC}"${n === 1 ? ' stroke-linecap="round"' : ""}/>`;
    }).join("");
    $("#segs").innerHTML = segs + cpl;
  }
  $("#ring").classList.toggle("one", n === 1);
  document.querySelectorAll("#segs .seg.fg").forEach((el, i) => {
    const len = +el.dataset.len * Math.max(0, Math.min(1, fracs[i] || 0));
    el.setAttribute("stroke-dasharray", `${len} ${CIRC}`);
  });
  document.querySelectorAll("#segs .cpl.fg").forEach(el => {
    const i = +el.dataset.i, cp = stages[i].coupling, el_s = Math.max(0, Math.min(1, fracs[i] || 0)) * secs[i];
    const f = Math.max(0, Math.min(1, (el_s - cp.startSec) / (cp.endSec - cp.startSec)));
    el.setAttribute("stroke-dasharray", `${+el.dataset.len * f} ${CCIRC}`);
  });
}

function say(html, cls = "") { $("#msg").innerHTML = html ? `<div class="note ${cls}">${html}</div>` : ""; }
async function ask(fn) {
  if (busy) return;
  busy = true; render();
  try {
    const r = await fn();
    if (r.ok) { S = r.data; lastError = ""; } else { lastError = r.error; }
  } catch (e) { lastError = e.message; }
  busy = false; render();
}

function render() {
  if (!S) return;
  const st = S.state, cur = S.current;
  document.title = `${STATE[st] || st} · ${base(S.name || WANT)} · Run on NP2`;
  $("#title").textContent = base(S.name || WANT);
  $("#kind").textContent = S.kind ? "· " + (S.kind === "batch" ? `batch, ${S.stages.length} stage${S.stages.length > 1 ? "s" : ""}` : "single file") : "";
  $("#dry").hidden = !S.dryRun;
  $("#notes").hidden = !S.notes; $("#notes").textContent = S.notes ? `“${S.notes}”` : "";

  // Message area: errors first, then what to do next.
  if (lastError) say(esc(lastError), "bad");
  else if (S.lostContact) say("<b>Lost contact with the NP2.</b> The protocol may still be running on the controller. Check the npAP Wi-Fi; Stop still works once it's back, or stop it on the controller.", "bad");
  else if (st === "failed") say(esc(S.error || "The protocol couldn't be run."), "bad");
  else if (st === "stopped") say(esc(S.error || "Stopped."), "info");
  else if (st === "ended") say(`<b>Finished.</b> ${esc(base(S.name))} ran to the end.`, "ok");
  else if (st === "loading") say(`<span class="loading"><span class="spin"></span>Loading ${esc(base(cur ? cur.name : S.name || WANT))} into the NP2…</span>`, "info");
  else if (st === "loaded") say("Loaded into the NP2 and ready. Put the headset and nasal clip on, then press <b>Run</b>. Nothing turns on until you do.", "");
  else say("");

  $("#panel").hidden = !cur && !["failed", "stopped", "ended"].includes(st);
  $("#status").className = "status " + st;
  $("#statusText").textContent = (STATE[st] || st) + (st === "loading" && S.kind === "batch" && cur ? ` stage ${S.stage + 1}` : "");

  // Progress against the whole protocol: earlier stages count in full, the current one by its clock.
  const total = cur ? cur.totalSec : 0, el = cur ? (st === "ended" ? total : cur.elapsedSec) : 0;
  const stages = S.stages && S.stages.length ? S.stages : (cur ? [{ totalSec: total }] : []);
  const fracs = stages.map((s, i) => st === "ended" || i < S.stage ? 1 : i === S.stage && total ? el / total : 0);
  const all = stages.reduce((t, s) => t + (s.totalSec || 0), 0);
  const done = stages.slice(0, S.stage).reduce((t, s) => t + (s.totalSec || 0), 0) + el;
  if (stages.length) renderRing(stages, fracs);
  $("#ring").classList.toggle("done", st === "ended");
  const pct = st === "ended" ? 100 : all ? Math.min(100, Math.floor(done / all * 100)) : 0;
  $("#clock").textContent = pct + "%";
  $("#clockOf").innerHTML = all ? `${clock(st === "ended" ? all : done)} of ${clock(all)}${S.kind === "batch" ? `<br>stage ${Math.min(S.stage + 1, stages.length)} of ${stages.length}` : ""}` : "";

  if (cur) {
    const f = [[ "Mode", MODE[cur.mode] ], [ "Remaining", clock(all - (st === "ended" ? all : done)) ]];
    if (S.kind === "batch") f.push([ `Stage ${S.stage + 1}`, `${clock(el)} / ${clock(total)}` ]);
    if (cur.sweep) f.push([ cur.sweep.kind === "freq" ? "Frequency now" : "Power now",
      `${cur.sweepValue}${cur.sweep.unit === "%" ? "%" : " Hz"}${cur.locked ? " (locked)" : ""}` ],
      [ "Sweep", `${cur.sweep.start}→${cur.sweep.end}${cur.sweep.unit === "%" ? "%" : " Hz"}, ${cur.sweep.dur}s steps` ]);
    const cp = cur.coupling;
    if (cp) {
      // "in m:ss" until coupling starts, "ON" while it's on, "OFF" once its window has passed.
      const t = st === "ended" ? total : el;
      f.push([ `Coupling ${cp.freq} Hz`,
        ["ended", "stopped", "failed"].includes(st) || t >= cp.endSec ? "OFF"
        : t >= cp.startSec && t > 0 ? "ON"
        : cp.startSec > t ? `in ${clock(cp.startSec - t)}` : "at start" ]);
    }
    $("#facts").innerHTML = f.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("");
  }

  // Buttons
  const live = st === "running" || st === "paused";
  const finished = ["ended", "stopped", "failed"].includes(st);
  $("#run").textContent = finished ? "Run again" : "Run";
  $("#run").disabled = busy || !(st === "loaded" || finished);
  $("#pause").textContent = st === "paused" ? "Resume" : "Pause";
  $("#pause").disabled = busy || !live;
  $("#stop").disabled = busy || !(live || st === "loaded" || st === "loading" || S.lostContact);
  $("#lock").hidden = !(cur && cur.sweep);
  $("#lock").disabled = busy || !live || !!(cur && cur.locked);
  $("#lock").classList.toggle("on", !!(cur && cur.locked));
  $("#hint").textContent = st === "running" && S.kind === "batch" ? "Keep the app open: it starts each stage when the one before ends."
    : live ? "You can close this window; the app asks whether to stop the protocol first." : "";

  // Batch stages
  $("#stagesCard").hidden = S.kind !== "batch";
  if (S.kind === "batch") {
    const key = JSON.stringify([S.stage, st, S.stages.map(s => s.endedAt)]);
    if (key !== stagesKey) {
      stagesKey = key;
      $("#stages").innerHTML = S.stages.map((s, i) => `<li class="${i === S.stage && !finished ? "now" : s.endedAt ? "done" : ""}" style="--sc:${stageColor(i)}"><span class="n">${i + 1}</span>` +
        `<span class="t" title="${esc(s.name)}">${esc(base(s.name))} <span class="d">${esc(MODE[s.mode] || "")}</span></span><span class="d">${s.totalSec ? clock(s.totalSec) : "–"}</span></li>`).join("");
    }
  }

  // Module table for the stage on the controller
  $("#tableCard").hidden = !cur;
  if (cur) {
    const key = cur.name;
    if (key !== tableKey) {
      tableKey = key;
      $("#tableTitle").textContent = S.kind === "batch" ? `Modules · ${base(cur.name)}` : "Modules";
      $("#rows").innerHTML = cur.rows.map(r => r.active
        ? `<tr><td><b>${r.pos}</b></td><td>${esc(r.power)}</td><td>${esc(r.freq)}</td><td><span class="pill ${r.phase === "B" ? "pb" : "pa"}">${r.phase}</span></td><td>${esc(r.cross)}</td><td>${esc(r.time)}</td></tr>`
        : `<tr class="off"><td><b>${r.pos}</b></td><td>off</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`).join("");
    }
  }
}

$("#run").addEventListener("click", () => {
  const again = ["ended", "stopped", "failed"].includes(S && S.state);
  ask(async () => again ? window.np2run.load(WANT) : window.np2run.start());
});
$("#pause").addEventListener("click", () => ask(() => S.state === "paused" ? window.np2run.resume() : window.np2run.pause()));
$("#stop").addEventListener("click", () => ask(() => window.np2run.stop()));
$("#lock").addEventListener("click", () => ask(() => window.np2run.lock()));

// Dark mode (both windows) and blackout (every screen). Neither touches the controller.
function showDark(r) {
  if (!r || !r.ok) return;
  $("#darkBtn").textContent = r.data.dark ? "Light mode" : "Dark mode";
  $("#darkBtn").title = r.data.dark ? "Switch both app windows back to the normal theme"
    : "Switch both app windows to the dark theme (until you switch it off or close this window)";
  $("#darkBtn").setAttribute("aria-pressed", String(r.data.dark));
}
$("#darkBtn").addEventListener("click", async () =>
  showDark(await window.np2run.darkMode($("#darkBtn").getAttribute("aria-pressed") !== "true")));
$("#blackBtn").addEventListener("click", () => window.np2run.blackout());
window.np2run.darkMode().then(showDark, () => {});

async function poll() {
  if (busy) return;
  try { const r = await window.np2run.state(); if (r.ok && !busy) { S = r.data; render(); } } catch { /* next tick */ }
}

(async function start() {
  say(`<span class="loading"><span class="spin"></span>Loading ${esc(base(WANT))} into the NP2…</span>`);
  $("#title").textContent = base(WANT);
  const r = await window.np2run.state();
  const cur = r.ok ? r.data : { state: "idle" };
  // A protocol already on the controller (window reopened): show it rather than loading another.
  if (["loading", "loaded", "running", "paused"].includes(cur.state)) {
    S = cur;
    if (cur.name !== WANT) lastError = `${base(cur.name)} is already ${cur.state === "loaded" ? "loaded" : cur.state} on the NP2. Stop it before running ${base(WANT)}.`;
    render();
  } else {
    S = { state: "loading", name: WANT, stages: [] };
    await ask(() => window.np2run.load(WANT));
    if (lastError) { S = { ...S, state: "failed", error: lastError }; lastError = ""; render(); }
  }
  setInterval(poll, 500);
})();
