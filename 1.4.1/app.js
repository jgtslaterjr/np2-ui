
"use strict";
// The app ships with no protocol files. They come from the connected NP2, or from the last read of it when it's off.
let DATA = { single: {}, batch: {}, protected: [],       // packed view used by every renderer
  order: { "getlistfile_vnp0.json": [], "getlistfile_vnp2.json": [], "getlistbatchfile.json": [] } };
let RAW = null;            // raw device files (only when live), used by the editors
let SOURCE = { live: false, at: "" };
// window.np2 is the app's device bridge (preload.js). Without it (page opened on its own) the explorer is read-only.
const HAS_BRIDGE = !!window.np2;

/* ---------- Device facts (from the NP2 user manual and controller GUI) ---------- */
// module_no -> position. Taken from the controller's own GUI script (script2a.js table mapping).
const POS = { 1: "R3", 2: "NR", 3: "C3", 4: "R2", 5: "C2", 6: "R1", 7: "C1", 8: "L1", 9: "L2", 10: "L3", 11: "NL", 12: "C4" };
const ORDER = ["C1", "L1", "R1", "C2", "L2", "R2", "C3", "L3", "R3", "C4", "NL", "NR"];
// Target cortices, from the manual's "Positioning the headset modules" page.
const TARGET = {
  C1: "Dorsomedial prefrontal cortex", L1: "Left dorsolateral prefrontal cortex", R1: "Right dorsolateral prefrontal cortex",
  C2: "Primary motor cortex", L2: "Left somatosensory cortex", R2: "Right somatosensory cortex",
  C3: "Precuneus", L3: "Left posterior cingulate", R3: "Right posterior cingulate",
  C4: "Cerebellum", NL: "Left nostril (olfactory route)", NR: "Right nostril (olfactory route)"
};
const SHORT = { C1: "DMPFC", L1: "DLPFC", R1: "DLPFC", C2: "Motor", L2: "Somato", R2: "Somato", C3: "Precuneus", L3: "PCC", R3: "PCC", C4: "Cerebellum", NL: "Nasal", NR: "Nasal" };
const isNasal = p => p === "NL" || p === "NR";
// Power chart in the manual is linear: 140% = ~305 mW/cm2 (headset) and ~140 mW/cm2 (nasal).
const mw = (pct, pos) => Math.round(pct * (isNasal(pos) ? 1.0 : 305 / 140));

const BANDS = [
  { key: "delta", name: "Delta", lo: 0, hi: 3.99, range: "1–3 Hz",
    text: "The slowest brain rhythm, dominant in deep, dreamless sleep. Associated with rest and restoration." },
  { key: "theta", name: "Theta", lo: 4, hi: 7.99, range: "4–7 Hz",
    text: "Linked to memory encoding in the hippocampus, drowsiness and deep meditative states. Theta is the rhythm that gamma bursts 'ride on' during memory tasks." },
  { key: "alpha", name: "Alpha", lo: 8, hi: 12.99, range: "8–12 Hz",
    text: "Relaxed, eyes-closed wakefulness. 10 Hz is the brain's most prominent resting rhythm; higher alpha is associated with calm focus and reduced sensory noise." },
  { key: "beta", name: "Beta", lo: 13, hi: 30.99, range: "13–30 Hz",
    text: "Active thinking, alertness and motor control. Low beta (12–15 Hz) is associated with relaxed attention; higher beta with effortful concentration." },
  { key: "gamma", name: "Gamma", lo: 31, hi: 100, range: "31–100 Hz",
    text: "Fast rhythm tied to attention, perception and binding information across regions. 40 Hz is the most studied: Vielight's own pilot studies and MIT's 40 Hz sensory-stimulation work target it for cognitive health." },
  { key: "high", name: "Above EEG", lo: 100.01, hi: 1e9, range: "> 100 Hz",
    text: "Above the classic EEG bands. Little research exists on what these pulse rates do; Vielight's broad sweeps pass through them to cover the whole spectrum." }
];
const band = f => BANDS.find(b => f >= b.lo && f <= b.hi) || BANDS[BANDS.length - 1];
const bandVar = f => `var(--${band(f).key})`;

const REGION_TEXT = {
  dmn: ["Default mode network", "C1, C3, L3, R3",
    "The medial prefrontal cortex, precuneus and posterior cingulate are core hubs of the default mode network: active during rest, mind-wandering, self-reflection and recalling memories. It is the network most studied in Vielight's research on cognitive decline."],
  cen: ["Executive control", "L1, R1",
    "The dorsolateral prefrontal cortex supports working memory, planning, attention and switching between tasks."],
  sm: ["Sensorimotor strip", "C2, L2, R2",
    "The primary motor and somatosensory cortices plan movement and process touch and body position."],
  cb: ["Cerebellum", "C4",
    "Coordinates movement, balance and timing, and contributes to attention and processing speed."],
  nasal: ["Intranasal route", "NL, NR",
    "The nasal applicators shine light up toward the olfactory bulb, which connects directly to limbic structures (amygdala, entorhinal cortex, hippocampus). Light here also passes through the dense capillaries of the nasal lining."]
};
const REGION_OF = { C1: "dmn", C3: "dmn", L3: "dmn", R3: "dmn", L1: "cen", R1: "cen", C2: "sm", L2: "sm", R2: "sm", C4: "cb", NL: "nasal", NR: "nasal" };

/* ---------- File analysis ---------- */
const ext = n => n.split(".").pop();
const base = n => n.replace(/\.vnp\d$/, "");
const fmtMin = m => {
  if (m == null) return "–";
  if (m < 1) return `${Math.round(m * 60)} s`;
  const r = Math.round(m * 10) / 10;
  return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)} min`;
};
const steps = s => Math.floor((s.end - s.start) / s.step) + 1;

function analyze(name, f = DATA.single[name]) {
  const mods = f.m.map(([no, active, run, delay, phase, duty, freq, power, cross]) => ({
    no, pos: POS[no], active: !!active, run, delay, phase, duty, freq, power, cross: !!cross
  }));
  const fs = f.fs, ps = f.ps, cr = f.cross;
  const fsweep = fs.active ? { start: fs.startFreq, end: fs.endFreq, step: fs.freqStepSize, dur: fs.stepDuration } : null;
  const psweep = ps.active ? { start: ps.startPower, end: ps.endPower, step: ps.powerStepSize, dur: ps.stepDuration } : null;
  const sweep = fsweep || psweep;
  // A module lights only if it's on, its light isn't off, it has power (or a ramp) and a run time above 0.
  // Run time 0 stays dark even during a sweep or ramp (seen on the device).
  const lit = mods.filter(m => m.active && m.duty !== 0 && m.run > 0 && (m.power > 0 || psweep));
  const sweepMin = sweep ? steps(sweep) * sweep.dur / 60 : null;
  const modMin = Math.max(0, ...mods.filter(m => m.active).map(m => (m.delay || 0) + (m.run || 0)));
  const total = sweep ? sweepMin : modMin;
  const freqs = fsweep ? [fsweep.start, fsweep.end] : [...new Set(lit.map(m => m.freq))].sort((a, b) => a - b);
  const powers = psweep ? [psweep.start, psweep.end] : [...new Set(lit.map(m => m.power))].sort((a, b) => a - b);
  const crossMods = cr.active ? lit.filter(m => m.cross) : [];
  const phases = { A: lit.filter(m => m.phase === 0), B: lit.filter(m => m.phase === 1) };
  // A rest (pause) file is dark on purpose: nothing lights, and no sweep or coupling is set up that would expect light.
  const rest = !lit.length && !sweep && !cr.active && modMin > 0;
  const mainFreq = fsweep ? (fsweep.start + fsweep.end) / 2 : (freqs[0] ?? 0);
  const a = { name, f, mods, fsweep, psweep, sweep, sweepMin, modMin, total, freqs, powers, lit, crossMods, phases, rest, mainFreq, cr };
  a.issues = findIssues(a);
  a.sev = a.issues.some(i => i.sev === "bad") ? "bad" : a.issues.length ? "warn" : "";
  return a;
}

/* ---------- Problem check ---------- */
// "bad" (red ✕): set up so it can't do what it looks meant to do. "warn" (amber ?): odd, possibly intended.
// Rest/pause files are left alone.
function findIssues(a) {
  const out = [];
  if (a.rest) return out;
  const add = (sev, ms, text) => out.push({ sev, pos: ms.map(m => m.pos), text: (ms.length ? `${posList(ms)}: ` : "") + text });
  const on = a.mods.filter(m => m.active);
  if (!a.lit.length) {
    add("bad", [], a.sweep ? `The ${a.fsweep ? "frequency sweep" : "power ramp"} runs for ${fmtMin(a.sweepMin)}, but no module lights, so nothing happens for that time.`
      : a.cr.active ? "Coupling is on, but no module lights, so nothing happens."
      : "No module has a run time above 0, so this file does nothing.");
  }
  const run0 = on.filter(m => !m.run);
  if (run0.length) add("bad", run0, `switched on but run time is 0 min, so ${run0.length > 1 ? "they never light" : "it never lights"}. Set a run time that covers the ${a.sweep ? (a.fsweep ? "sweep" : "ramp") : "stage"}${a.sweep ? ` (${fmtMin(a.sweepMin)})` : ""}.`);
  const pow0 = on.filter(m => m.run && m.duty !== 0 && !m.power && !a.psweep);
  if (pow0.length) add("bad", pow0, `switched on but power is 0%, so ${pow0.length > 1 ? "they never light" : "it never lights"}.`);
  const dark = on.filter(m => m.run && m.duty === 0);
  if (dark.length && a.lit.length) add("warn", dark, `switched on but the light is set to “off”, so ${dark.length > 1 ? "they stay" : "it stays"} dark. Fine if intended; otherwise choose pulsed or continuous.`);
  const ramp0 = a.psweep ? on.filter(m => m.run && m.duty !== 0 && !m.power) : [];
  if (ramp0.length) add("warn", ramp0, `module power is 0% under the power ramp. It isn't confirmed that the ramp overrides it; setting it to the ramp's end power (${a.psweep.end}%) is safer.`);
  if (a.cr.active && a.lit.length && !a.crossMods.length) add("warn", [], `Coupling is on at ${a.cr.freq} Hz, but no lit module is set to use it, so it has no effect.`);
  const orphan = on.filter(m => m.cross && !a.cr.active);
  if (orphan.length) add("warn", orphan, "marked “Coupled”, but coupling is off for the file, so it's ignored.");
  return out;
}
const flag = (sev, title) => sev ? `<span class="flag ${sev}" title="${esc(title || "")}">${sev === "bad" ? "✕" : "?"}</span>` : "";
function issuesBox(issues, what = "this file") {
  if (!issues.length) return "";
  const bad = issues.some(i => i.sev === "bad");
  return `<section class="issues ${bad ? "" : "warn"}"><h3>${bad ? `Problem${issues.length > 1 ? "s" : ""} in ${what}` : `Check ${what}`}</h3><ul>${issues.map(i => `<li>${flag(i.sev)}${i.html || esc(i.text)}</li>`).join("")}</ul></section>`;
}
function batchIssues(b, st) {
  const out = [];
  st.forEach((a, i) => {
    const n = esc(base(b.steps[i])), link = `<a href="#${encodeURIComponent(b.steps[i])}">${n}</a>`;
    if (!a) out.push({ sev: "bad", text: `Stage ${i + 1} (${base(b.steps[i])}) isn't on the device.`, html: `Stage ${i + 1} (${n}) isn't on the device.` });
    else if (a.sev) out.push({ sev: a.sev, text: `Stage ${i + 1} (${base(b.steps[i])}): ${a.issues[0].text}`,
      html: `Stage ${i + 1} (${link}): ${esc(a.issues[0].text)}${a.issues.length > 1 ? ` <span class="hint">(+${a.issues.length - 1} more)</span>` : ""}` });
  });
  return out;
}
const worst = issues => issues.some(i => i.sev === "bad") ? "bad" : issues.length ? "warn" : "";

function family(name) {
  const n = base(name), e = ext(name);
  if (e === "vnp0") return "Your single files (.vnp0)";
  if (e === "vnp1") return "Built-in files (.vnp1)";
  if (/^SS/.test(n)) return "Library · Short sweeps";
  if (/^LS/.test(n)) return "Library · Long sweeps";
  if (/^BS/.test(n)) return "Library · Broad sweeps";
  if (/^L\d/.test(n)) return "Library · Limbic protocol";
  if (/^sj_/.test(n)) return "Library · Single tones";
  if (/XC$/.test(n) && /_/.test(n)) return "Library · X-wing chiastic (coupled)";
  if (/^6_/.test(n)) return "Library · Cingulate coupled sweeps";
  return "Library · Anterior cingulate / chiastic";
}
const FAMILY_TEXT = {
  "Library · Short sweeps": "Short sweeps step through a narrow band (3–6 Hz wide), one hertz per minute, on all 12 modules. The F version runs at 85% power, the G version at 25%.",
  "Library · Long sweeps": "Long sweeps cover an 11 Hz span, one hertz per minute (11 minutes). F = 85% power, G = 25% power.",
  "Library · Broad sweeps": "Broad sweeps race from 1 Hz up to the named frequency at one hertz per second, touching every band from delta upward. F = 85% power, G = 25% power.",
  "Library · Limbic protocol": "The Limbic protocol drives only the two nasal applicators and the cerebellum module (C4), at one steady frequency, aiming light at the olfactory route into the limbic system.",
  "Library · Single tones": "Single steady tones at 100% power, used as the stages of the Meditate batch.",
  "Library · X-wing chiastic (coupled)": "\"Chiastic\" means crossed: the headset is split into two groups pulsing in opposite phase in a diagonal pattern, while a second frequency is coupled onto the light.",
  "Library · Cingulate coupled sweeps": "Gamma sweeps with 6 Hz theta coupling, aimed at cingulate networks combined with frontal, parietal or sensorimotor regions.",
  "Library · Anterior cingulate / chiastic": "Sweeps using a crossed A/B phase layout, labelled for anterior cingulate networks with insula, frontal or other partners."
};

/* ---------- Narrative builders ---------- */
const list = arr => arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
const posList = ms => list(ORDER.filter(p => ms.some(m => m.pos === p)));

function deviceStory(a) {
  const out = [];
  if (a.rest) {
    out.push(`Every module is set to 0% power${a.mods.some(m => m.duty === 0) ? " with pulsing switched off" : ""}, so the headset stays dark for ${fmtMin(a.total)}. In a batch this acts as a timed rest between stages.`);
    return out;
  }
  const off = a.mods.filter(m => !a.lit.includes(m));
  if (!a.lit.length) out.push("<b>No module lights</b> with these settings, so the headset stays dark.");
  else out.push(`Lights <b>${a.lit.length} of 12</b> modules: ${posList(a.lit)}.` + (off.length ? ` ${posList(off)} stay${off.length === 1 ? "s" : ""} dark.` : ""));
  if (a.fsweep) {
    const s = a.fsweep;
    out.push(`<b>Frequency sweep.</b> The controller steps every lit module from ${s.start} Hz to ${s.end} Hz in ${s.step} Hz steps, holding each step for ${s.dur} s. That is ${steps(s)} steps, ${fmtMin(a.sweepMin)} in total. The manual says the sweep's total time takes priority, so the modules' own frequency and run-time values (${list([...new Set(a.lit.map(m => m.run + " min"))])}) are ignored while it runs. A module still needs a run time above 0 to light at all.`);
  } else if (a.freqs.length) {
    out.push(`<b>Pulse rate:</b> ${a.freqs.length === 1 ? `every lit module flashes at ${a.freqs[0]} Hz` : `modules flash at ${list(a.freqs.map(f => f + " Hz"))}`}, with the light on for half of each cycle (50% duty).`);
  }
  if (a.psweep) {
    const s = a.psweep;
    out.push(`<b>Power ramp.</b> Output rises from ${s.start}% to ${s.end}% in ${s.step}% steps every ${s.dur} s: ${steps(s)} steps over ${fmtMin(a.sweepMin)}. On the headset that is about ${mw(s.start, "C1")} → ${mw(s.end, "C1")} mW/cm². The ramp is expected to override the per-module power values (not yet confirmed on the device).`);
  } else if (a.powers.length) {
    const p = a.powers;
    const head = a.lit.filter(m => !isNasal(m.pos)), nose = a.lit.filter(m => isNasal(m.pos));
    const bits = [];
    if (head.length) bits.push(`headset ≈ ${list([...new Set(head.map(m => mw(m.power, m.pos)))].map(String))} mW/cm²`);
    if (nose.length) bits.push(`nasal ≈ ${list([...new Set(nose.map(m => mw(m.power, m.pos)))].map(String))} mW/cm²`);
    out.push(`<b>Power:</b> ${list(p.map(x => x + "%"))}${p.some(x => x > 100) ? " (overdrive)" : ""}, which the manual's chart puts at ${bits.join(" and ")}.`);
  }
  if (!a.sweep && a.lit.length) {
    const runs =[...new Set(a.lit.map(m => `${m.delay}/${m.run}`))];
    if (runs.length > 1) {
      const groups = {};
      a.lit.forEach(m => (groups[`${m.run}`] ??= []).push(m));
      out.push(`<b>Timing:</b> ` + Object.entries(groups).map(([r, ms]) => `${posList(ms)} run ${r} min`).join("; ") + ".");
    } else {
      out.push(`<b>Timing:</b> all lit modules run ${fmtMin(a.lit[0].run)}${a.lit[0].delay ? ` after a ${a.lit[0].delay}-minute delay` : ""}.`);
    }
  }
  const delayed = a.lit.filter(m => m.delay > 0);
  if (delayed.length && a.sweep) out.push(`${posList(delayed)} have a start delay of ${list([...new Set(delayed.map(m => m.delay + " min"))])} recorded, but the sweep time takes priority.`);
  if (a.phases.A.length && a.phases.B.length) {
    out.push(`<b>Split phase.</b> The lit modules form two groups that pulse in opposite phase, so one group is lit while the other is dark. Phase A: ${posList(a.phases.A)}. Phase B: ${posList(a.phases.B)}.`);
  }
  if (a.cr.active && a.crossMods.length) {
    const stop = a.cr.stopCoupling ? `stops at minute ${a.cr.stopCoupling}` : "has no stop time set";
    out.push(`<b>Cross-frequency coupling at ${a.cr.freq} Hz</b> is applied to ${posList(a.crossMods)}. It starts ${a.cr.couplingDelay ? `after ${a.cr.couplingDelay} min` : "immediately"} and ${stop}. Coupling layers a second rhythm onto the base pulse train, like the brain nests fast gamma bursts inside slower theta waves.`);
  } else if (a.cr.active) {
    out.push(`Cross-frequency coupling (${a.cr.freq} Hz) is switched on at file level, but no module has it applied, so it has no effect.`);
  }
  return out;
}

function brainStory(a) {
  if (a.rest) return { bands: [], regions: [], extras: ["A dark interval gives the tissue a break between stimulation blocks. Photobiomodulation research often uses rest periods because effects on blood flow and cell metabolism continue for a while after the light stops."] };
  const lo = a.fsweep ? Math.min(a.fsweep.start, a.fsweep.end) : Math.min(...a.freqs);
  const hi = a.fsweep ? Math.max(a.fsweep.start, a.fsweep.end) : Math.max(...a.freqs);
  const bands = BANDS.filter(b => !(b.hi < lo || b.lo > hi));
  const regions = [...new Set(a.lit.map(m => REGION_OF[m.pos]))];
  const extras = [];
  if (a.cr.active && a.crossMods.length) {
    const baseF = a.fsweep ? `${lo}–${hi}` : a.freqs.join("/");
    const pair = [band(a.mainFreq).name, band(a.cr.freq).name];
    extras.push(`<b>Coupling (${baseF} Hz with ${a.cr.freq} Hz):</b> pairs ${pair[0] === pair[1] ? "two " + pair[0].toLowerCase() + " rhythms" : pair[0].toLowerCase() + " with " + pair[1].toLowerCase()}. In the brain, gamma nested in theta is thought to help the hippocampus hold items in working memory; protocols aimed at memory borrow the idea. Whether pulsing light this way reproduces that pattern hasn't been shown.`);
  }
  if (a.phases.A.length && a.phases.B.length) {
    extras.push("<b>Opposite-phase groups</b> create a rhythmic contrast between regions instead of driving the whole cortex in lockstep. The intent is to engage the communication between hemispheres or networks, not just their activity level.");
  }
  if (a.psweep) extras.push("<b>The power ramp</b> starts low and climbs, which may make the warmth some users feel at high power more comfortable. No study shows a ramp changes the effect.");
  if (a.fsweep && (hi - lo) > 50) extras.push("<b>A broad sweep</b> doesn't stay in any one band long enough to target it. It sweeps the whole spectrum, and is sometimes used as a primer before more focused stages; there's no direct evidence for that role.");
  return { bands, regions, extras };
}

/* ---------- SVG: head map ---------- */
const XY = { // top view, nose at the top
  NL: [148, 26], NR: [192, 26],
  C1: [170, 78], L1: [105, 96], R1: [235, 96],
  C2: [170, 158], L2: [86, 162], R2: [254, 162],
  C3: [170, 236], L3: [105, 236], R3: [235, 236],
  C4: [170, 300]
};
function headSVG(a) {
  const byPos = Object.fromEntries(a.mods.map(m => [m.pos, m]));
  const dot = pos => {
    const m = byPos[pos], [x, y] = XY[pos], lit = a.lit.includes(m);
    const f = a.fsweep ? a.mainFreq : m.freq;
    const fill = lit ? bandVar(f) : "var(--off)";
    const ring = lit && a.phases.A.length && a.phases.B.length ? (m.phase ? "var(--phase-b)" : "var(--phase-a)") : "none";
    const pw = a.psweep ? a.psweep.end : m.power;
    const r = lit ? 14 + Math.min(pw, 140) / 140 * 8 : 13;
    const cross = lit && a.cr.active && m.cross;
    const mi = a.issues.filter(i => i.pos.includes(pos)), sev = worst(mi);
    const badge = sev ? `<circle cx="${x + r - 1}" cy="${y + r - 1}" r="7" fill="var(--panel)" stroke="var(--${sev})" stroke-width="1.5"/><text x="${x + r - 1}" y="${y + r + 2.5}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--${sev})">${sev === "bad" ? "✕" : "?"}</text>` : "";
    return `<g>
      ${lit ? `<circle cx="${x}" cy="${y}" r="${r + 7}" fill="${fill}" opacity=".16"/>` : ""}
      <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${sev ? `var(--${sev})` : ring}" stroke-width="${sev ? 2.5 : ring === "none" ? 0 : 4}" ${sev ? 'stroke-dasharray="4 3"' : ""}/>
      ${cross ? `<circle cx="${x + r - 2}" cy="${y - r + 2}" r="6" fill="var(--panel)" stroke="var(--ink)" stroke-width="1.5"/><text x="${x + r - 2}" y="${y - r + 5.5}" text-anchor="middle" font-size="8" font-weight="700" fill="var(--ink)">×</text>` : ""}
      <text x="${x}" y="${y + 4}" text-anchor="middle" font-family="var(--font-display)" font-weight="700" font-size="13" fill="${lit ? "#fff" : "var(--muted)"}">${pos}</text>
      ${badge}
      <title>${pos} · ${TARGET[pos]}${mi.length ? ` · ${mi.map(i => i.text).join(" ")}` : ""}${lit ?` · ${a.fsweep ? `sweep ${a.fsweep.start}–${a.fsweep.end}` : m.freq} Hz · ${a.psweep ? `${a.psweep.start}→${a.psweep.end}` : m.power}%${cross ? ` · coupled ${a.cr.freq} Hz` : ""}` : " · off"}</title>
    </g>`;
  };
  return `<svg viewBox="0 0 340 340" role="img" aria-label="Headset map, top view, nose at top">
    <path d="M170 44 C 70 44 40 120 44 190 C 48 265 100 322 170 326 C 240 322 292 265 296 190 C 300 120 270 44 170 44 Z" fill="none" stroke="var(--line)" stroke-width="2"/>
    <path d="M156 46 L170 14 L184 46" fill="none" stroke="var(--line)" stroke-width="2"/>
    <text x="14" y="190" font-size="11" fill="var(--muted)" font-family="var(--font-display)">LEFT</text>
    <text x="296" y="190" font-size="11" fill="var(--muted)" font-family="var(--font-display)">RIGHT</text>
    ${Object.keys(XY).map(dot).join("")}
  </svg>`;
}

/* ---------- SVG: timeline ---------- */
// Drawn at the container's real pixel width (and redrawn on resize), so text stays 11px at any window size.
const TIMELINES = new Map();   // id -> analysis, for the charts on the page
let timelineSeq = 0;
const timelineObserver = new ResizeObserver(entries => entries.forEach(e => {
  const el = e.target, a = TIMELINES.get(el.dataset.tl), w = Math.round(el.clientWidth);
  if (!a || !w || +el.dataset.w === w) return;
  el.dataset.w = w;
  el.innerHTML = drawTimeline(a, w);
}));
function timelineSVG(a) {
  for (const id of TIMELINES.keys()) if (!document.querySelector(`[data-tl="${id}"]`)) TIMELINES.delete(id);
  const id = String(++timelineSeq);
  TIMELINES.set(id, a);
  requestAnimationFrame(() => { const el = document.querySelector(`[data-tl="${id}"]`); if (el) timelineObserver.observe(el); });
  return `<div class="tl" data-tl="${id}">${drawTimeline(a, 680)}</div>`;
}

function drawTimeline(a, W) {
  const rowH = 14, barH = 6, left = 40, top = 22;
  const hasCurve = !!a.sweep, isF = !!a.fsweep;
  const right = W - (isF ? 84 : 14);               // frequency sweeps keep a gutter for the band names
  const curveH = hasCurve ? 120 : 0;
  const y0 = hasCurve ? top + curveH + 24 : 8;      // first module row
  const yb = y0 + ORDER.length * rowH + 2;         // time axis
  const H = yb + 22;
  const T = Math.max(a.total, 0.1);
  const x = t => left + (t / T) * (right - left);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline">`;

  if (hasCurve) {
    const sw = a.sweep, n = steps(sw);
    const vals = Array.from({ length: n }, (_, i) => sw.start + i * sw.step);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    // Broad frequency sweeps (e.g. 1–1020 Hz) use a log axis; on a linear one every band below 100 Hz shares a few pixels.
    const log = isF && lo > 0 && hi / lo >= 8;
    let dmin, dmax, ticks;
    if (log) {
      dmin = lo; dmax = hi;
      ticks = [...new Set([lo, ...[1, 10, 100, 1000, 10000].filter(v => v > lo && v < hi), hi])];
    } else {
      // Frequency sweeps zoom to their own range; power sweeps start at 0.
      const pad = isF ? Math.max(1, (hi - lo) * 0.15) : 0;
      const st = niceStep(isF ? hi - lo + 2 * pad : hi || 1, Math.floor(curveH / 26));
      dmin = isF ? Math.max(0, Math.floor((lo - pad) / st) * st) : 0;
      dmax = Math.max(Math.ceil(hi / st) * st, dmin + st);
      ticks = [];
      for (let v = dmin; v <= dmax + 1e-9; v += st) ticks.push(Math.round(v * 100) / 100);
    }
    const f = log ? Math.log10 : v => v;
    const y = v => top + curveH - ((f(v) - f(dmin)) / (f(dmax) - f(dmin))) * curveH;
    // Gridlines for every tick; a label only where it clears the one below by 13 px (the top label always wins).
    const shown = [];
    [...ticks].reverse().forEach(v => { if (!shown.length || y(v) - y(shown[shown.length - 1]) >= 13) shown.push(v); });
    for (let i = shown.length - 1; i > 0; i--) if (y(shown[i]) - y(shown[i - 1]) < 13) shown.splice(i, 1);
    ticks.forEach(v => { s += `<line class="axis" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/>`; });
    shown.forEach(v => { s += `<text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; });
    s += `<text x="${left - 6}" y="${top - 10}" text-anchor="end" class="unit">${isF ? "Hz" : "%"}</text>`;
    if (log) s += `<text x="${right}" y="${top - 10}" text-anchor="end" class="unit">log scale</text>`;

    if (isF) {
      // Band stripes, with the names in the right-hand gutter, pushed apart so they never overlap.
      const labels = [];
      BANDS.forEach((b, i) => {
        const v0 = Math.max(b.lo, dmin), v1 = Math.min(i + 1 < BANDS.length ? BANDS[i + 1].lo : Infinity, dmax);
        if (v1 <= v0) return;
        const yTop = y(v1), yBot = y(v0);
        s += `<rect x="${left}" y="${yTop}" width="${right - left}" height="${yBot - yTop}" fill="var(--${b.key})" opacity=".07"><title>${b.name} ${b.range}</title></rect>`;
        if (b.lo > dmin) s += `<line x1="${left}" x2="${right}" y1="${yBot}" y2="${yBot}" stroke="var(--${b.key})" stroke-dasharray="3 4" opacity=".5"/>`;
        labels.push({ b, want: (yTop + yBot) / 2, yTop, yBot });
      });
      labels.sort((p, q) => p.want - q.want);
      const gap = 13;
      labels.forEach((l, i) => { l.y = Math.max(l.want, i ? labels[i - 1].y + gap : top + 4); });
      for (let i = labels.length - 1; i >= 0; i--) labels[i].y = Math.min(labels[i].y, i < labels.length - 1 ? labels[i + 1].y - gap : top + curveH - 2);
      labels.forEach(l => {
        // A short leader from the stripe when its name had to move off it.
        if (l.y < l.yTop || l.y > l.yBot) s += `<path d="M${right} ${l.want} L${right + 6} ${l.y}" fill="none" stroke="var(--${l.b.key})" opacity=".7"/>`;
        s += `<text x="${right + 10}" y="${l.y + 4}" style="fill:var(--${l.b.key})">${l.b.name}</text>`;
      });
    }

    let d = "", area = `M${x(0)} ${y(dmin)}`;
    vals.forEach((v, i) => {
      const t0 = i * sw.dur / 60, t1 = (i + 1) * sw.dur / 60;
      d += `${i ? "L" : "M"}${x(t0)} ${y(v)} L${x(t1)} ${y(v)} `;
      area += ` L${x(t0)} ${y(v)} L${x(t1)} ${y(v)}`;
    });
    area += ` L${x(T)} ${y(dmin)} Z`;
    const col = isF ? bandVar(a.mainFreq) : "var(--nir)";
    s += `<path d="${area}" fill="${col}" opacity=".12"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  }

  const ticks = niceTicks(T, Math.max(2, Math.floor((right - left) / 80)));
  ticks.forEach(t => { s += `<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="${y0}" y2="${yb}"/>`; });
  ORDER.forEach((p, i) => {
    const m = a.mods.find(mm => mm.pos === p), lit = a.lit.includes(m);
    const yy = y0 + i * rowH, by = yy + (rowH - barH) / 2;
    s += `<text x="${left - 6}" y="${yy + rowH / 2 + 4}" text-anchor="end"${lit ? ' class="lit"' : ""}>${p}</text>`;
    s += `<rect x="${left}" y="${by}" width="${right - left}" height="${barH}" rx="${barH / 2}" fill="var(--bg)"/>`;
    if (lit) {
      const t0 = a.sweep ? 0 : m.delay, t1 = a.sweep ? T : m.delay + m.run;
      const col = a.fsweep ? bandVar(a.mainFreq) : bandVar(m.freq);
      s += `<rect x="${x(t0)}" y="${by}" width="${Math.max(barH, x(t1) - x(t0))}" height="${barH}" rx="${barH / 2}" fill="${col}" opacity="${a.phases.B.length && m.phase ? .55 : .95}"><title>${p}: ${fmtMin(t1 - t0)}</title></rect>`;
      if (a.cr.active && m.cross) {
        const c0 = a.cr.couplingDelay || 0, c1 = a.cr.stopCoupling ? Math.min(a.cr.stopCoupling, T) : T;
        // Coupling window: a fine line just under the bar.
        s += `<rect x="${x(c0)}" y="${by + barH + 1}" width="${Math.max(1, x(c1) - x(c0))}" height="1.5" fill="var(--ink)" opacity=".75"><title>${p}: coupled ${a.cr.freq} Hz</title></rect>`;
      }
    }
  });
  // Plain numbers, with the unit on the last label (anchored so it stays inside the chart).
  ticks.forEach((t, i) => {
    const last = i === ticks.length - 1, anchor = last && x(t) > right - 24 ? "end" : "middle";
    s += `<text x="${x(t)}" y="${yb + 15}" text-anchor="${anchor}">${t}${last ? " min" : ""}</text>`;
  });
  return s + `</svg>`;
}
// Round step that splits `span` into at most `maxN` intervals.
function niceStep(span, maxN) {
  const p = 10 ** Math.floor(Math.log10(span / Math.max(1, maxN)));
  return [1, 2, 2.5, 5, 10].map(k => k * p).find(st => span / st <= maxN);
}
function niceTicks(T, maxN) {
  const st = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 60].find(s => T / s <= maxN) || 60;
  const out = [];
  for (let t = 0; t <= T + 1e-9; t += st) out.push(Math.round(t * 100) / 100);
  return out;
}

/* ---------- Rendering ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Your files are .vnp0 (single) and .vnp4 (batch). Everything else is a Vielight original and is never written.
const isMine = n => /\.vnp[04]$/i.test(n) && !(DATA.protected || []).includes(n.toLowerCase());
const MINE = { has: isMine };
const canCopy = n => !!(DATA.single[n] || DATA.batch[n]);
/* Copies of Vielight files carry a fixed source note at the start of their notes. */
const SRC_RE = /^Source Vielight (?:library|built-in|batch) file \((.+?)\)\.(?:\s+|$)/;
const SRC_KIND = { vnp1: "built-in", vnp2: "library", vnp3: "batch" };
const sourceNote = n => `Source Vielight ${SRC_KIND[ext(n)]} file (${n}).`;
const vielightSource = notes => (SRC_RE.exec(notes || "") || [])[1] || "";
const srcTag = notes => { const s = vielightSource(notes); return s ? `<span>· copied from Vielight ${esc(s)}</span>` : ""; };

function summaryFreq(a) {
  if (a.rest) return "rest";
  if (!a.lit.length) return "no light";
  if (a.fsweep) return `${a.fsweep.start}→${a.fsweep.end} Hz`;
  return a.freqs.map(f => f + " Hz").join(" / ");
}
function batchInfo(name) {
  const b = DATA.batch[name];
  const st = b.steps.map(s => DATA.single[s] ? analyze(s) : null);
  const total = st.reduce((t, a) => t + (a ? a.total : 0), 0);
  return { b, st, total };
}

function buildIndex() {
  const q = $("#q").value.trim().toLowerCase();
  const groups = new Map();
  const add = (g, html) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(html); };
  const match = (name, extra) => !q || (name + " " + extra).toLowerCase().includes(q);
  const batches = DATA.order["getlistbatchfile.json"];
  ["vnp4", "vnp3"].forEach(e => batches.filter(n => ext(n) === e).forEach(n => {
    const { b, st, total } = batchInfo(n);
    if (!match(n, b.notes + " batch")) return;
    const col = st[0] ? (st[0].rest || !st[0].lit.length ? "var(--off)" : bandVar(st[0].mainFreq)) : "var(--off)";
    const iss = batchIssues(b, st);
    add(e === "vnp4" ? "Your batches (.vnp4)" : "Vielight batches (.vnp3)", item(n, col, `${b.steps.length} st · ${fmtMin(total)}`, worst(iss), iss.map(i => i.text).join("\n")));
  }));
  [...DATA.order["getlistfile_vnp0.json"], ...DATA.order["getlistfile_vnp2.json"]].forEach(n => {
    const a = analyze(n);
    if (!match(n, a.f.notes + " " + summaryFreq(a) + (a.fsweep ? " sweep" : "") + " " + family(n))) return;
    add(family(n), item(n, a.rest || !a.lit.length ? "var(--off)" : bandVar(a.mainFreq), `${summaryFreq(a)}`, a.sev, a.issues.map(i => i.text).join("\n")));
  });
  const order = ["Your batches (.vnp4)", "Your single files (.vnp0)", "Vielight batches (.vnp3)", "Built-in files (.vnp1)"];
  const keys = [...groups.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || x.localeCompare(y));
  $("#index").innerHTML = `<button class="item" data-go="" ${current === "" ? 'aria-current="true"' : ""}><span class="swatch" style="background:var(--nir)"></span><span class="name">How the NP2 works</span></button>` +
    (keys.length ? keys.map(k => `<div class="group"><h2>${esc(k)}</h2>${groups.get(k).join("")}</div>`).join("") : `<p style="padding:0 18px;color:var(--muted)">${q ? `No files match “${esc(q)}”.` : "No files yet."}</p>`);
}
function item(n, col, meta, sev = "", why = "") {
  return `<button class="item" data-go="${esc(n)}" ${current === n ? 'aria-current="true"' : ""}><span class="swatch" style="background:${col}"></span><span class="name">${esc(base(n))}</span>${flag(sev, why)}${MINE.has(n) ? `<span class="mine-tag">yours</span>` : ""}<span class="meta">${esc(meta)}</span></button>`;
}

function renderSingle(name) {
  const a = analyze(name), e = ext(name);
  const fam = family(name);
  const kind = { vnp0: "Your single file", vnp1: "Built-in single file", vnp2: "Vielight library file" }[e];
  const usedIn = Object.entries(DATA.batch).filter(([, b]) => b.steps.includes(name)).map(([n]) => n);
  const brain = brainStory(a);
  const notes = a.f.notes && !/pre-programmed/.test(a.f.notes) ? a.f.notes : "";
  const head = a.lit.filter(m => !isNasal(m.pos));
  const pmax = a.psweep ? a.psweep.end : Math.max(0, ...a.lit.map(m => m.power));
  return `
  <header>
    <div class="eyebrow"><span>${kind}</span><span>·</span><span>.${e}</span>${MINE.has(name) ? `<span class="mine-tag">yours</span>` : ""}${a.f.secret ? `<span title="Hidden from viewing in the controller's GUI">· Vielight IP (hidden in GUI)</span>` : ""}${a.f.default ? "<span>· factory default</span>" : ""}${srcTag(a.f.notes)}</div>
    <h2 class="title">${esc(base(name))}</h2>
    ${notes ? `<p class="lede">“${esc(notes)}” <span class="note-src">· note stored in the file</span></p>` : ""}
    ${e === "vnp2" && FAMILY_TEXT[fam] ? `<p class="lede">${FAMILY_TEXT[fam]}</p>` : ""}
  </header>
  ${editBar(name)}
  ${issuesBox(a.issues)}
  <section class="stats">
    <div class="stat"><div class="k">Duration</div><div class="v">${fmtMin(a.total)}</div><div class="s">${a.sweep ? `${steps(a.sweep)} steps × ${a.sweep.dur}s` : "longest module"}</div></div>
    <div class="stat"><div class="k">Frequency</div><div class="v">${summaryFreq(a)}</div><div class="s">${a.rest ? "lights off" : [...new Set(brain.bands.map(b => b.name))].join(" → ")}</div></div>
    <div class="stat"><div class="k">Power</div><div class="v">${a.rest ? "0%" : a.psweep ? `${a.psweep.start}→${a.psweep.end}%` : a.powers.map(p => p + "%").join(" / ")}</div><div class="s">${a.rest || !a.lit.length ? "" : head.length ? `≈ ${mw(pmax, "C1")} mW/cm² headset peak` : `≈ ${mw(pmax, "NL")} mW/cm² nasal`}</div></div>
    <div class="stat"><div class="k">Modules lit</div><div class="v">${a.lit.length} / 12</div><div class="s">${a.phases.A.length && a.phases.B.length ? `A ${a.phases.A.length} · B ${a.phases.B.length}` : "single phase"}</div></div>
    <div class="stat"><div class="k">Coupling</div><div class="v">${a.crossMods.length ? a.cr.freq + " Hz" : "none"}</div><div class="s">${a.crossMods.length ? `${a.crossMods.length} modules${a.cr.stopCoupling ? `, to min ${a.cr.stopCoupling}` : ""}` : a.cr.active ? "enabled, unused" : ""}</div></div>
  </section>
  <section class="two">
    <div class="card headmap"><h3>Headset map</h3>${headSVG(a)}
      <div class="legend">${a.phases.A.length && a.phases.B.length ? `<span><i style="background:var(--phase-a)"></i>Phase A ring</span><span><i style="background:var(--phase-b)"></i>Phase B ring</span>` : ""}${a.crossMods.length ? "<span>× = coupled</span>" : ""}<span>Size = power · color = frequency band</span><span>Top view, nose at top</span></div>
    </div>
    <div class="card"><h3>How it drives the NP2</h3>${deviceStory(a).map(p => `<p>${p}</p>`).join("")}
      ${usedIn.length ? `<h4>Used in</h4><p>${usedIn.map(n => `<a href="#${encodeURIComponent(n)}">${esc(base(n))}</a>`).join(", ")}</p>` : ""}
    </div>
  </section>
  <section class="card chart"><h3>Timeline</h3>${timelineSVG(a)}
    <div class="legend">${a.sweep ? `<span>Top: ${a.fsweep ? "frequency" : "power"} at each step.</span>` : ""}<span>Bars: when each module is lit.</span>${a.crossMods.length ? "<span>Fine line under a bar: coupling window.</span>" : ""}${a.phases.B.length && a.phases.A.length ? "<span>Faded bars: phase B.</span>" : ""}</div>
  </section>
  <section class="card"><h3>Impact on the brain</h3>
    ${brain.bands.length ? `<h4>Frequency band${brain.bands.length > 1 ? "s" : ""}</h4>` + brain.bands.map(b => `<p><b style="color:var(--${b.key})">${b.name} (${b.range}).</b> ${b.text}</p>`).join("") : ""}
    ${brain.regions.length ? `<h4>Target regions</h4>` + brain.regions.map(r => { const [t, ps, txt] = REGION_TEXT[r]; return `<p><b>${t}</b> <span class="note-src">(${ps.split(", ").filter(p => a.lit.some(m => m.pos === p)).join(", ")})</span>. ${txt}</p>`; }).join("") : ""}
    ${brain.extras.length ? `<h4>What the design adds</h4>` + brain.extras.map(x => `<p>${x}</p>`).join("") : ""}
    <p class="disclaimer">Mechanism: 810 nm near-infrared light is absorbed by cytochrome c oxidase in mitochondria, which can raise cellular energy (ATP) production and release nitric oxide, improving local blood flow. Pulsing the light at brain-rhythm frequencies is proposed to encourage those rhythms; that part of the evidence is still early.</p>
  </section>
  <section class="card"><h3>Module settings</h3><div class="tablewrap"><table>
    <thead><tr><th>Pos</th><th>Target</th><th>Power</th><th>mW/cm²</th><th>Freq</th><th>Phase</th><th>Light</th><th>Delay / run</th><th>Coupled</th><th>#</th></tr></thead>
    <tbody>${ORDER.map(p => { const m = a.mods.find(x => x.pos === p), lit = a.lit.includes(m);
      const mi = a.issues.filter(i => i.pos.includes(p));
      return `<tr class="${lit ? "" : "off"}"><td><b>${p}</b>${flag(worst(mi), mi.map(i => i.text).join("\n"))}</td><td>${TARGET[p]}</td><td class="num">${a.psweep && lit ? "ramp" : m.power + "%"}</td><td class="num">${a.psweep && lit ? "–" : mw(m.power, p)}</td><td class="num">${a.fsweep && lit ? "sweep" : m.freq + " Hz"}</td><td><span class="pill ${m.phase ? "pb" : "pa"}">${m.phase ? "B" : "A"}</span></td><td>${m.duty === 5 ? "pulsed 50%" : m.duty === 10 ? "continuous" : m.duty === 0 ? "off" : "duty " + m.duty}</td><td class="num">${m.delay}/${m.run} min</td><td>${a.cr.active && m.cross ? a.cr.freq + " Hz" : "–"}</td><td class="num">${m.no}</td></tr>`; }).join("")}</tbody>
  </table></div><p class="disclaimer" style="margin-top:10px">Grey rows are switched off in the file. “#” is the module number stored in the file; positions come from the controller's own GUI mapping. mW/cm² is read off the manual's power chart.</p></section>`;
}

function renderBatch(name) {
  const { b, st, total } = batchInfo(name);
  const mine = MINE.has(name);
  const strip = st.map((a, i) => `<div style="flex:${a ? a.total : 1};background:${a ? (a.rest || !a.lit.length ? "var(--off)" : bandVar(a.mainFreq)) : "var(--off)"}" title="${esc(b.steps[i])}">${a && a.total / total > .1 ? esc(base(b.steps[i])) : ""}</div>`).join("");
  const arc = st.map(a => a ? (a.rest ? "rest" : !a.lit.length ? "no light" : band(a.mainFreq).name.toLowerCase() + (a.crossMods.length ? " + " + band(a.cr.freq).name.toLowerCase() + " coupling" : "")) : "?");
  const regions = [...new Set(st.flatMap(a => a ? a.lit.map(m => REGION_OF[m.pos]) : []))];
  return `
  <header>
    <div class="eyebrow"><span>${ext(name) === "vnp4" ? "Batch (.vnp4)" : "Vielight batch (.vnp3)"}</span>${mine ? `<span class="mine-tag">yours</span>` : ""}${srcTag(b.notes)}</div>
    <h2 class="title">${esc(base(name))}</h2>
    ${b.notes ? `<p class="lede">“${esc(b.notes)}” <span class="note-src">· note stored in the file</span></p>` : ""}
  </header>
  <section class="stats">
    <div class="stat"><div class="k">Total time</div><div class="v">${fmtMin(total)}</div><div class="s">${total > 20.5 ? "longer than" : "within"} the manual's 20-min guidance</div></div>
    <div class="stat"><div class="k">Stages</div><div class="v">${b.steps.length} / 8</div><div class="s">run back to back</div></div>
    <div class="stat"><div class="k">Arc</div><div class="v" style="font-size:15px">${esc(arc.join(" → "))}</div></div>
  </section>
  ${editBar(name)}
  ${issuesBox(batchIssues(b, st), "this batch")}
  ${mine ? designCallout(b, st) : ""}
  <section class="card"><h3>Sequence</h3><div class="strip">${strip}</div>
    <div class="stages" style="margin-top:14px">${st.map((a, i) => `<button class="stage" data-go="${esc(b.steps[i])}"><span class="n">${i + 1}</span><span><span class="t">${esc(base(b.steps[i]))}${a ? flag(a.sev, a.issues.map(x => x.text).join("\n")) : flag("bad", "Not on the device")}</span><br><span class="d">${a ? `${summaryFreq(a)} · ${a.rest ? "lights off" : a.psweep ? `power ${a.psweep.start}→${a.psweep.end}%` : a.powers.map(p => p + "%").join("/")} · ${a.lit.length} modules${a.crossMods.length ? ` · ${a.cr.freq} Hz coupling` : ""}${a.phases.A.length && a.phases.B.length ? " · split phase" : ""}` : "file not found on device"}</span></span><span class="dur">${a ? fmtMin(a.total) : "–"}</span></button>`).join("")}</div>
  </section>
  <section class="card"><h3>How it drives the NP2</h3>
    <p>The controller runs each stage's file in order, from stage 1 to ${b.steps.length}. Each stage uses its own module layout, frequency and power. When one stage finishes, the next starts automatically.</p>
    ${st.map((a, i) => a ? `<h4>Stage ${i + 1} · ${esc(base(b.steps[i]))} · ${fmtMin(a.total)}</h4>${deviceStory(a).map(p => `<p>${p}</p>`).join("")}` : "").join("")}
  </section>
  <section class="card"><h3>Impact on the brain</h3>
    <p>The batch moves through ${list([...new Set(arc)])}. ${batchArcText(st)}</p>
    <h4>Regions reached across the batch</h4>
    ${regions.map(r => { const [t, , txt] = REGION_TEXT[r]; return `<p><b>${t}.</b> ${txt}</p>`; }).join("")}
    <p class="disclaimer">These are the intended effects as described in research on brain rhythms and photobiomodulation, not guaranteed outcomes. The NP2 is sold as a general wellness device, not a medical device.</p>
  </section>`;
}
function batchArcText(st) {
  const fs = st.filter(a => a && !a.rest);
  if (!fs.length) return "";
  const sweeps = fs.filter(a => a.fsweep).length, coupled = fs.filter(a => a.crossMods.length).length;
  const parts = [];
  if (sweeps === fs.length) parts.push("Every stage is a sweep, so the brain is never held at one frequency for long; the design favours range and flexibility over a single target rhythm.");
  else if (!sweeps) parts.push("Every stage holds steady frequencies, so each block gives a sustained, single-rhythm stimulus.");
  else parts.push("It mixes sweeps with steady-frequency blocks: sweeps explore a range, steady blocks hold a target rhythm.");
  if (coupled) parts.push(`${coupled} stage${coupled > 1 ? "s use" : " uses"} cross-frequency coupling, layering two rhythms at once.`);
  return parts.join(" ");
}
// "Your design, in plain terms": written from the stage files' current settings, so it follows every edit.
function designCallout(b, st) {
  if (!st.length) return "";
  const n = st.length, longest = Math.max(...st.map(a => a ? a.total : 0));
  const slow = a => ["delta", "theta", "alpha"].includes(band(a.mainFreq).key);
  const num = m => String(Math.round(m * 10) / 10);
  const lines = st.map((a, i) => {
    const name = esc(base(b.steps[i]));
    if (!a) return `<p><b>${i + 1}. ${name}</b> ${flag("bad")} isn't on the device, so this stage can't run.</p>`;
    const head = `${name}, ${a.total < 1 ? fmtMin(a.total) : (a.sweep && a.total % 1 ? "~" : "") + fmtMin(Math.round(a.total * 10) / 10)}`;
    if (a.rest) return `<p><b>${i + 1}. Rest (${head}).</b> Lights off: a timed pause between stages.</p>`;
    if (!a.lit.length) return `<p><b>${i + 1}. ${name}</b> ${flag(a.sev)} No module lights in this stage, so nothing happens for ${fmtMin(a.total)}. Open it to fix.</p>`;
    const bnd = band(a.mainFreq), coupled = a.crossMods.length ? band(a.cr.freq) : null;
    const role = n > 1 && i === 0 && (a.psweep || slow(a)) && !coupled ? "Warm up"
      : n > 1 && i === n - 1 && slow(a) && !coupled ? "Cool down"
      : coupled ? `${bnd.name}–${coupled.name.toLowerCase()} coupling`
      : `${bnd.name} ${a.total === longest ? "core" : "block"}`;
    const freq = a.fsweep ? `sweeps ${a.fsweep.start} → ${a.fsweep.end} Hz` : `${list(a.freqs.map(f => f + " Hz"))} ${bnd.name.toLowerCase()}`;
    const mods = a.lit.length === 12 ? "All 12 modules" : `${a.lit.length} module${a.lit.length > 1 ? "s" : ""} (${posList(a.lit)})`;
    const head12 = a.lit.some(m => !isNasal(m.pos)) ? "C1" : "NL";
    const power = a.psweep ? `power rising from ${a.psweep.start}% to ${a.psweep.end}% (about ${mw(a.psweep.start, head12)} → ${mw(a.psweep.end, head12)} mW/cm²)`
      : `${list(a.powers.map(p => p + "%"))}${a.powers.length === 1 ? ` (≈ ${mw(a.powers[0], head12)} mW/cm² ${head12 === "C1" ? "headset" : "nasal"})` : ""}`;
    let s = `${mods} at ${freq}, ${power}`;
    if (coupled) s += `, with ${a.cr.freq} Hz ${coupled.name.toLowerCase()} coupled on ${a.crossMods.length === a.lit.length ? "every lit module" : posList(a.crossMods)}${a.cr.stopCoupling && a.cr.stopCoupling < a.total ? ` until minute ${a.cr.stopCoupling}` : " for the whole stage"}`;
    s += ".";
    if (role === "Warm up" && a.psweep) s += " Power climbs gradually, mainly for comfort; there's no evidence a warm-up changes the effect.";
    else if (role === "Cool down") s += " A gentler, slower rhythm meant to wind down; its benefit is untested.";
    if (coupled && bnd.key === "theta" && coupled.key === "gamma") s += " Meant to echo the theta–gamma pattern the hippocampus is thought to use for working memory. That light can reproduce it is unproven, so treat this stage as experimental.";
    else if (!coupled && a.freqs.includes(40) && !a.fsweep) s += ` ${a.total === longest && n > 1 ? "The longest block, built" : "Built"} on 40 Hz, the setting most studied with this device, though mainly in small pilot studies of people with dementia rather than healthy adults.`;
    return `<p><b>${i + 1}. ${role} (${head}).</b> ${flag(a.sev, a.issues.map(x => x.text).join("\n"))}${s}</p>`;
  });
  const total = st.reduce((t, a) => t + (a ? a.total : 0), 0);
  const sum = n > 1 ? ` (${st.map(a => a ? num(a.total) : "?").join(" + ")})` : "";
  lines.push(`<p>The total is about ${fmtMin(Math.round(total))}${sum}, which ${total > 20.5 ? "is longer than" : "matches"} the manual's guidance of 20-minute sessions every other day.</p>`);
  return `<section class="callout card" style="border-radius:0 10px 10px 0"><h3>Your design, in plain terms</h3>${lines.join("")}</section>`;
}

// Shown until the first read of an NP2 has filled the file list.
function firstRunCard() {
  const s = STATUS?.setup;
  if (s?.state === "failed") return `<section class="card"><h3>Couldn't read your NP2 yet</h3><p>${esc(s.error)}</p><p>Nothing was saved. The app will try again shortly.</p></section>`;
  if (s?.state === "reading" || STATUS?.device?.reachable) return `<section class="card"><h3><span class="spin"></span>Reading your NP2…</h3><p>Copying every file from the controller to this computer, which takes about a minute. Nothing on the device is changed.</p></section>`;
  return `<section class="card"><h3>Connect your NP2</h3><p>Turn on your NP2 and join its <b>npAP</b> Wi-Fi (the Wi-Fi chip above can do that). The app then loads your device's files automatically.</p></section>`;
}
function renderHome() {
  const counts = { b: Object.keys(DATA.batch).length, s: Object.keys(DATA.single).length };
  const empty = !counts.s && !counts.b, sample = DATA.single["Gamma.vnp1"];
  return `
  <header>
    <div class="eyebrow"><span>Vielight Neuro Pro 2</span><span>·</span><span>810 nm near-infrared</span></div>
    <h2 class="title">How the NP2 works</h2>
    <p class="lede">${empty ? "Once your NP2 is connected, its files appear on the left. Pick one" : `The controller on your device holds ${counts.s} single files and ${counts.b} batches. Pick any file on the left`} to see which modules it lights, how it pulses, how long it runs, and what that is meant to do in the brain.</p>
  </header>
  ${empty ? firstRunCard() : ""}
  <section class="${sample ? "two" : ""}">
    ${sample ? `<div class="card headmap"><h3>Twelve light sources</h3>${headSVG(analyze("Gamma.vnp1"))}
      <div class="legend"><span>Shown: the factory Gamma file (40 Hz, all modules)</span></div></div>` : ""}
    <div class="card"><h3>What a file controls</h3>
      <p><b>Modules.</b> Ten headset modules (810 nm LEDs, up to ~305 mW/cm²) and two nasal applicators (up to ~140 mW/cm²). Each can be on or off.</p>
      <p><b>Frequency.</b> Each module flashes at 1–9,999 Hz, lit for half of each cycle (pulsed 50% duty), or stays on continuously.</p>
      <p><b>Power.</b> 0–140% per module; above 100% is overdrive.</p>
      <p><b>Time.</b> Each module has a start delay and a run time (0–99 min).</p>
      <p><b>Phase A/B.</b> Phase B pulses exactly opposite to phase A, so two groups can alternate.</p>
      <p><b>Sweeps.</b> A frequency or power sweep steps every module through a range. Only one sweep can be on, and its total time overrides the per-module times.</p>
      <p><b>Cross-frequency coupling.</b> A second frequency layered onto chosen modules, with its own start and stop minute.</p>
      <p><b>Batches.</b> Up to 8 single files run back to back.</p>
    </div>
  </section>
  <section class="card"><h3>Frequency bands</h3><p>The colors used throughout this explorer:</p>
    <div class="bands">${BANDS.map(b => `<div class="band" style="border-color:var(--${b.key})"><b>${b.name}</b> <span class="r">${b.range}</span><p>${b.text}</p></div>`).join("")}</div></section>
  <section class="card"><h3>Target regions</h3>
    ${Object.values(REGION_TEXT).map(([t, ps, txt]) => `<p><b>${t}</b> <span class="note-src">(${ps})</span>. ${txt}</p>`).join("")}
  </section>
  <section class="card"><h3>File types on the controller</h3><ul>
    <li><b>.vnp0</b>: single files you created.</li>
    <li><b>.vnp1</b>: built-in files (Alpha, Gamma, Rest). Save under a new name to edit them.</li>
    <li><b>.vnp2</b>: Vielight's protocol library. The controller's GUI hides their settings as Vielight intellectual property; they were read here through the device's file interface.</li>
    <li><b>.vnp3 / .vnp4</b>: batches of up to 8 single files. Vielight's are .vnp3; yours are .vnp4.</li>
  </ul></section>
  <p class="disclaimer">Safety, from the manual: don't stare at the diodes; stop and lower the power if you feel discomfort; the base of the controller gets hot at high power. Vielight recommends 20-minute sessions every other day for healthy users. The NP2 is a general wellness device, not a medical device, and nothing here is medical advice.</p>`;
}

/* ---------- Live data and connection status ---------- */
function packSingle(f) {
  return { notes: f.notes || "", secret: !!f.secretFile, default: !!f.defaultFile, usedByBatch: f.usedByBatch || 0,
    fs: f.frequency, ps: f.power, cross: f.cross,
    m: f.modules.map(m => [m.module_no, m.active ? 1 : 0, m.activeRunTime ?? 0, m.delayStartTime ?? 0,
      m.moduleControl.phase, m.moduleControl.dutyCycle, m.freq ?? 0, m.power ?? 0, m.applyCross ? 1 : 0]) };
}
function useRaw(raw) {
  DATA = { single: {}, batch: {}, order: raw.order, protected: raw.protected };
  for (const [n, f] of Object.entries(raw.single)) DATA.single[n] = packSingle(f);
  for (const [n, b] of Object.entries(raw.batch)) DATA.batch[n] = { notes: (b.notes || "").trim(), steps: b.filenames.filter(Boolean) };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtWhen = iso => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
// Offline: show the files as they were the last time the app read them from the device (saved by the app on
// every live read). Empty if the app has never been connected.
let OFFLINE_AT = "";
async function loadLastSeen() {
  if (!HAS_BRIDGE) return false;
  try {
    const r = await window.np2.lastSeen();
    if (!r.ok || !r.data || SOURCE.live) return false;
    useRaw(r.data);
    OFFLINE_AT = `last seen ${fmtWhen(r.data.fetchedAt)}`;
    SOURCE = { live: false, at: OFFLINE_AT };
    return true;
  } catch { return false; }
}
async function loadFiles(refresh) {
  if (!HAS_BRIDGE) return false;
  try {
    const r = await window.np2.files(!!refresh);
    if (!r.ok) throw new Error(r.error);
    RAW = r.data;
    useRaw(r.data);
    SOURCE = { live: true, at: r.data.fetchedAt };
    lastListsKey = null;   // the next look takes a fresh fingerprint
    return true;
  } catch (e) {
    SOURCE = { live: false, at: OFFLINE_AT, error: e.message };
    return false;
  }
}

// Refresh: reload every file from the device and redraw the file list (and the page, unless a file is being edited).
let refreshing = false, lastListsKey = null;
async function refreshFiles(manual) {
  if (refreshing || !HAS_BRIDGE) return;
  refreshing = true; renderConn();
  const b = $("#refresh");
  if (b) { b.classList.add("busy"); b.disabled = true; }
  const ok = await loadFiles(true);
  if (ok) { buildIndex(); if (!draft) route(); }
  refreshing = false;
  if (b) { b.classList.remove("busy"); b.disabled = false; }
  renderConn();
  if (manual) toast(ok ? "File list refreshed from the NP2." : `<b>Couldn't refresh.</b> ${esc(SOURCE.error || "Is the NP2 connected?")}`, !ok);
}
document.addEventListener("click", e => { if (e.target.closest("#refresh, [data-refresh-chip]")) refreshFiles(true); });
// The automatic backup refreshed the file view: redraw from it (no device reads). The app shows Vielight originals
// from its last copy, and the backup is what checks that copy, so say so if one turned out different.
async function showBackupView(libraryChanged) {
  if (!HAS_BRIDGE || refreshing) return;
  if (await loadFiles(false)) { buildIndex(); if (!draft) route(); renderConn(); }
  if (libraryChanged.length)
    toast(`<b>${libraryChanged.length === 1 ? "A Vielight library file" : `${libraryChanged.length} Vielight library files`} changed on the NP2</b> since the app last read ${libraryChanged.length === 1 ? "it" : "them"}: ${esc(libraryChanged.join(", "))}. The app now shows the device's version.`);
}
// Every 30 s: a cheap look at the device's file lists (three small reads). If they changed, for example a file
// was saved from the controller's own screens, reload everything. Skipped while a check or restore is running.
async function watchLists() {
  if (!HAS_BRIDGE || !SOURCE.live || !STATUS?.device?.reachable || refreshing || RESTORE?.busy || checkingNow()) return;
  try {
    const r = await window.np2.listsKey();
    if (!r.ok || !r.data) return;   // null: the device was busy, look again next time
    if (lastListsKey && r.data !== lastListsKey) refreshFiles(false);
    else lastListsKey = r.data;
  } catch { /* try again next time */ }
}
let STATUS = null, reloading = false;
async function pollStatus() {
  if (HAS_BRIDGE) {
    try { const r = await window.np2.status(); STATUS = r.ok ? r.data : { bridgeDown: true, error: r.error }; }
    catch (e) { STATUS = { bridgeDown: true, error: e.message }; }
  }
  // New install: keep the home page's first-run message in step with the setup.
  const setupKey = STATUS?.setup ? `${STATUS.setup.state}|${STATUS.setup.error || ""}` : "";
  if (setupKey !== lastSetupKey) {
    lastSetupKey = setupKey;
    if (!location.hash.slice(1) && !draft) route();
  }
  // The device came back while we were showing the snapshot: switch to live data (once any first-time setup is done).
  if (STATUS?.device?.reachable && !STATUS.setup && !SOURCE.live && !reloading) {
    reloading = true;
    if (await loadFiles(true) && !draft) route();
    reloading = false;
  }
  const runKey = STATUS?.run?.active ? STATUS.run.name : "";
  if (runKey !== lastRunKey) { lastRunKey = runKey; if (!draft && current) route(); }
  // The NP2 connected or dropped (or the first status arrived after the file was drawn): redraw the open file so its
  // Run / Edit / Delete buttons follow. Not while editing, so a draft is never redrawn.
  const okKey = String(editingAllowed());
  if (okKey !== lastOkKey) { lastOkKey = okKey; if (!draft && current) route(); }
  // A run ended or was stopped while the history page is open: show the new entry.
  const histKey = STATUS?.run ? `${STATUS.run.name}|${STATUS.run.state}` : "";
  if (histKey !== lastHistKey) { lastHistKey = histKey; if (location.hash === "#history") refreshHistory(); }
  renderConn();
  // An automatic backup finished while the backups page is open: show the new list.
  const bk = STATUS?.backup ? `${STATUS.backup.running}|${STATUS.backup.checkedAt}` : "";
  if (bk !== lastBackupKey) {
    lastBackupKey = bk;
    if (location.hash === "#backups") refreshBackups();
    // The backup read every file and the app's file view was refreshed from it (no extra device reads).
    if (STATUS?.backup?.last?.view === "updated") showBackupView(STATUS.backup.last.libraryChanged || []);
  }
}
let lastBackupKey = "", lastSetupKey = "", lastRunKey = "", lastHistKey = "", lastOkKey = "";
const rssiBars = r => r >= -50 ? 5 : r >= -60 ? 4 : r >= -70 ? 3 : r >= -80 ? 2 : r >= -90 ? 1 : 0;
const chip = (cls, k, v, attrs) => attrs
  ? `<button class="chip ${cls}" ${attrs}><span class="dot"></span><b>${k}</b> ${v}</button>`
  : `<span class="chip ${cls}"><span class="dot"></span><b>${k}</b> ${v}</span>`;
let wifiBusy = false;
const editingAllowed = () => HAS_BRIDGE && SOURCE.live && !!STATUS?.device?.reachable && !STATUS?.run?.active;
// Running a protocol: needs the app, the NP2 answering, live files, and the file to be on the device now.
const onDevice = name => Object.values(DATA.order).some(l => l.includes(name));
function runBlocked(name) {
  if (!HAS_BRIDGE) return "Open the NP2 Protocol Explorer app to run protocols.";
  if (!STATUS?.device?.reachable) return "Needs the NP2 connected (npAP Wi-Fi).";
  if (!SOURCE.live) return "Waiting for the live file list from the NP2.";
  if (!onDevice(name)) return "This file isn't on the NP2 any more.";
  return "";
}
async function openRun(name) {
  const why = runBlocked(name);
  if (why) { toast(esc(why), true); return; }
  try {
    const r = await window.np2.openRun(name);
    if (!r.ok) toast(esc(r.error), true);
    else if (r.data.busy) toast(`${esc(base(r.data.current))} is still loaded or running on the NP2. Stop it in the run window first.`, true);
  } catch (e) { toast(esc(e.message), true); }
}
let lastCreate = "";
function renderConn() {
  let h = "";
  if (!HAS_BRIDGE) h += chip("bad", "App", "page opened on its own · open the NP2 Protocol Explorer app to connect and edit");
  else if (STATUS?.bridgeDown) h += chip("bad", "Editing off", esc(STATUS.error || "the app's device service isn't responding"));
  else if (STATUS) {
    const pc = STATUS.pc || {}, d = STATUS.device || {};
    // macOS may hide the network name (ssidHidden); then the NP2 answering is what shows we're on npAP.
    const pcOn = pc.state === "connected" || (pc.ssidHidden && d.reachable);
    const onNpap = pcOn && (pc.ssid === "npAP" || (pc.ssidHidden && d.reachable));
    const pcText = pc.ssidHidden ? (d.reachable ? "npAP · reaching the NP2" : "not on npAP")
      : pcOn ? `${esc(pc.ssid)}${pc.signal ? " · " + esc(pc.signal) : ""}` : pc.state === "off" ? "Wi-Fi is off" : "not connected";
    // Not on npAP (e.g. the NP2 was switched on after the app): click the chip to ask the computer to rejoin it.
    h += chip(onNpap ? "ok" : pcOn ? "warn" : "bad", "Wi-Fi",
      wifiBusy ? "connecting to npAP…" : `${pcText}${onNpap ? "" : " · click to connect"}`,
      onNpap ? "" : `data-wifi title="Connect this computer to the NP2's Wi-Fi (npAP)" ${wifiBusy ? "disabled" : ""}`);
    if (d.reachable) {
      const n = rssiBars(d.rssi);
      const bars = `<span class="bars" title="Device signal ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? "on" : ""}" style="height:${2 + i * 2}px"></i>`).join("")}</span>`;
      h += chip("ok", "NP2", `${esc(d.ip)} · ${bars} ${d.rssi} dBm · ${esc(d.mdns)}.local · ${d.latencyMs} ms`);
    } else {
      h += d.error === "DeviceInUse"
        ? chip("bad", "NP2", "in use by another copy of the app · close that one", `title="${esc(d.message || "")}"`)
        : chip("bad", "NP2", `${esc(d.ip || "2.2.2.3")} unreachable`);
    }
    if (STATUS.dryRun) h += chip("warn", "Mode", "dry run · saves and runs are logged, not sent");
    if (STATUS.run?.active) h += chip("warn", "Run", `${esc(base(STATUS.run.name))} · ${esc(STATUS.run.state)} · click to show`, `data-run="${esc(STATUS.run.name)}" title="Show the run window"`);
    h += backupChip(STATUS.backup);
    // Browser version: a newer UI is published that this computer's NP2 Link helper is too old for.
    if (STATUS.helper?.needsNewHelper) h += chip("warn", "Helper", `NP2 Link ${esc(STATUS.helper.version)} is out of date · install the new one to get version ${esc(STATUS.helper.latest)}`);
  } else h += chip("", "NP2", "checking…");
  h += chip(SOURCE.live ? "ok" : "warn", "Files", refreshing ? "refreshing…" : SOURCE.live ? `live from device · ${esc(String(SOURCE.at).slice(11, 16))}` : SOURCE.at ? `snapshot · ${esc(SOURCE.at)}` : "none yet", `data-refresh-chip title="Click to reload every file from the NP2"`);
  $("#conn").innerHTML = h;
  const ok = editingAllowed();
  const create = `<button class="btn" data-go="#new-single" ${ok ? "" : "disabled"}>New single file</button><button class="btn" data-go="#new-batch" ${ok ? "" : "disabled"}>New batch</button>`
    + (HAS_BRIDGE ? `<button class="btn" data-imp="pick" ${ok ? "" : "disabled"} title="Add .vnp0 / .vnp4 files from this computer to the NP2 as new files">Import</button>` : "")
    + (HAS_BRIDGE ? `<button class="btn" data-go="#history" title="Every protocol run from this app, with date, time and how it ended">History</button>` : "")
    + (HAS_BRIDGE ? `<button class="btn" data-export=""${ok && myFiles().length ? "" : "disabled"} title="Save copies of all your files (.vnp0 / .vnp4) to a folder on this computer">Export your files</button>` : "");
  if (create !== lastCreate) { $("#create").innerHTML = create; lastCreate = create; }
}

function editBar(name) {
  if (!HAS_BRIDGE) return "";
  const ok = editingAllowed(), btns = [], why = runBlocked(name);
  btns.push(`<button class="btn" data-run="${esc(name)}" ${why ? `disabled title="${esc(why)}"` : `title="Open a window to run this protocol on the NP2 (right-click a file in the list also works)"`}>Run on NP2…</button>`);
  if (isMine(name)) btns.push(`<button class="btn primary" data-go="#edit/${encodeURIComponent(name)}" ${ok ? "" : "disabled"}>Edit</button>`);
  if (canCopy(name)) btns.push(`<button class="btn" data-go="#copy/${encodeURIComponent(name)}" ${ok ? "" : "disabled"}>Copy to a new file</button>`);
  if (isMine(name)) btns.push(`<button class="btn" data-export="${esc(name)}" ${ok ? "" : "disabled"} title="Save a copy of this file to a folder on this computer">Export</button>`);
  if (isMine(name)) {
    const usedIn = DATA.single[name] ? Object.entries(DATA.batch).filter(([, b]) => b.steps.includes(name)).map(([n]) => base(n)) : [];
    btns.push(usedIn.length
      ? `<button class="btn danger" disabled title="Used in ${esc(usedIn.join(", "))}. Remove it from ${usedIn.length > 1 ? "those batches" : "that batch"} first.">Delete</button>`
      : `<button class="btn danger" data-del="${esc(name)}" ${ok ? "" : "disabled"} title="Double-click to delete this file from the device">Delete</button>`);
  }
  const note = isMine(name) ? "Your file. Saving changes overwrites it on the device, after a backup of the current version."
    : "Vielight original: read-only. Copy it to make your own version; the copy keeps a note that its source was Vielight.";
  return `<div class="actions">${btns.join("")}<span class="hint">${note}${isMine(name) ? " Delete needs a double-click." : ""}${ok ? "" : STATUS?.run?.active ? " Editing is off while a protocol is loaded or running." : " Editing needs the NP2 connected."}</span></div><div id="del-status"></div>`;
}

/* ---------- Editors ---------- */
let draft = null;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-()!?,']{0,21}$/;
const NOTES_RE = /^[A-Za-z0-9\s_\-!?()"'.,]*$/;
function nameProblem(n) {
  const bad = [...new Set(n.replace(/[A-Za-z0-9 _\-()!?,']/g, ""))].map(c => c === " " ? "space" : /\s/.test(c) ? "tab or line break" : `“${c}”`);
  const p = [];
  if (!n) p.push("it's empty");
  else if (!/^[A-Za-z0-9]/.test(n)) p.push(`it starts with “${n[0]}” instead of a letter or number`);
  if (n.length > 22) p.push(`it's ${n.length} characters (the limit is 22)`);
  if (bad.length) p.push(`it contains ${bad.join(", ")}, which ${bad.length > 1 ? "aren't" : "isn't"} allowed`);
  return `Name “${n}” can't be used: ${p.join("; ")}. Names start with a letter or number, have up to 22 characters, and use letters, numbers, spaces and _ - ( ) ! ? , '`;
}
const clone = o => JSON.parse(JSON.stringify(o));
function allNamesLower() {
  return new Set([...Object.keys(DATA.single), ...Object.keys(DATA.batch), ...(DATA.protected || [])].map(n => base(n).toLowerCase()));
}
function freeName(want) {
  const taken = allNamesLower();
  let n = want.slice(0, 22).trim(), i = 2;
  while (taken.has(n.toLowerCase())) { const sfx = ` ${i++}`; n = want.slice(0, 22 - sfx.length).trim() + sfx; }
  return n;
}
const copyName = n => base(n) + " copy";
function blankSingle() {
  return { notes: "",
    frequency: { active: false, startFreq: null, endFreq: null, freqStepSize: null, stepDuration: null },
    power: { active: false, startPower: null, endPower: null, powerStepSize: null, stepDuration: null },
    cross: { active: false, freq: null, couplingDelay: null, stopCoupling: null },
    modules: Array.from({ length: 12 }, (_, i) => ({ module_no: i + 1, active: true, activeRunTime: 10, delayStartTime: 0,
      moduleControl: { phase: 0, dutyCycle: 5 }, freq: 10, power: 50, applyCross: false })) };
}

function openEditor({ kind, mode, from }) {
  const bad = msg => `<section class="card"><h3>Can't open the editor</h3><p>${msg}</p><p><button class="btn" data-go="${from ? esc(from) : ""}">Back</button></p></section>`;
  if (!editingAllowed()) return bad("Editing needs the NP2 connected, so changes go to the live device. Check the connection chips at the top.");
  if (from && !(DATA.single[from] || DATA.batch[from])) return bad("That file isn't on the device.");
  if (mode === "overwrite" && !isMine(from)) return bad("Only your own files (.vnp0 and .vnp4) can be edited. Vielight originals are never changed.");
  if (kind === "single") {
    const file = from ? clone(RAW.single[from]) : blankSingle();
    draft = { kind, mode, from, name: from ? (mode === "overwrite" ? base(from) : freeName(copyName(from))) : freeName("My protocol"),
      notes: file.notes || "", file };
  } else {
    const b = from ? DATA.batch[from] : null;
    draft = { kind, mode, from, name: from ? (mode === "overwrite" ? base(from) : freeName(copyName(from))) : freeName("My batch"),
      notes: b ? b.notes : "", steps: b ? [...b.steps] : Object.keys(DATA.single).slice(0, 1) };
  }
  if (/pre-programmed/.test(draft.notes)) draft.notes = "";
  if (draft.notes && !NOTES_RE.test(draft.notes)) draft.notes = "";
  draft.source = "";
  if (from && !isMine(from)) draft.source = sourceNote(from);
  else { const m = SRC_RE.exec(draft.notes); if (m) { draft.source = m[0].trim(); draft.notes = draft.notes.slice(m[0].length); } }
  return kind === "single" ? singleEditorHTML() : batchEditorHTML();
}

function editorHeader() {
  const ext = draft.kind === "single" ? ".vnp0" : ".vnp4";
  const what = draft.kind === "single" ? "single file" : "batch";
  const eyebrow = draft.mode === "overwrite" ? `Editing your ${what} · ${ext}` : draft.from ? `New ${what} · copy of ${esc(base(draft.from))}` : `New ${what} · ${ext}`;
  return `<header><div class="eyebrow"><span>${eyebrow}</span></div><h2 class="title" id="ed-title">${esc(draft.name)}</h2>
    <p class="lede">${draft.mode === "overwrite" ? "Changes are saved to this file on the controller. A copy of the current version is backed up first." : "Saved as a new file on the controller. Vielight's original files are never changed."}</p></header>`;
}
const notesField = () => `<div class="field" style="grid-column: span 2"><label for="ed-notes">Notes</label>${draft.source
  ? `<p class="hint" style="margin:0 0 6px">Kept at the start of the notes: <b>${esc(draft.source)}</b></p>` : ""}<textarea id="ed-notes" maxlength="${200 - (draft.source ? draft.source.length + 1 : 0)}">${esc(draft.notes)}</textarea></div>`;
const fullNotes = () => [draft.source, draft.notes.trim()].filter(Boolean).join(" ");
const field = (id, label, val, attrs = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${val ?? ""}" ${attrs}></div>`;
const numField = (id, label, val, min, max) => field(id, label, val, `type="number" min="${min}" max="${max}" step="1" inputmode="numeric"`);

function singleEditorHTML() {
  const f = draft.file, fs = f.frequency, ps = f.power, cr = f.cross;
  const sweep = fs.active ? "freq" : ps.active ? "power" : "none";
  const byPos = Object.fromEntries(f.modules.map(m => [POS[m.module_no], m]));
  const rows = ORDER.map(p => { const m = byPos[p], no = m.module_no; return `<tr>
    <td><b>${p}</b><div class="hint">${SHORT[p]}</div></td>
    <td><input type="checkbox" data-mod="${no}" data-k="active" ${m.active ? "checked" : ""} aria-label="${p} on"></td>
    <td><input type="number" data-mod="${no}" data-k="power" value="${m.power ?? ""}" min="0" max="140" aria-label="${p} power %"></td>
    <td><input type="number" data-mod="${no}" data-k="freq" value="${m.freq ?? ""}" min="1" max="9999" aria-label="${p} frequency Hz"></td>
    <td><select data-mod="${no}" data-k="duty" aria-label="${p} light"><option value="5" ${m.moduleControl.dutyCycle === 5 ? "selected" : ""}>pulsed</option><option value="10" ${m.moduleControl.dutyCycle === 10 ? "selected" : ""}>continuous</option><option value="0" ${m.moduleControl.dutyCycle === 0 ? "selected" : ""}>off</option></select></td>
    <td><select data-mod="${no}" data-k="phase" aria-label="${p} phase"><option value="0" ${m.moduleControl.phase ? "" : "selected"}>A</option><option value="1" ${m.moduleControl.phase ? "selected" : ""}>B</option></select></td>
    <td><input type="number" data-mod="${no}" data-k="delay" value="${m.delayStartTime ?? 0}" min="0" max="99" aria-label="${p} delay min"></td>
    <td><input type="number" data-mod="${no}" data-k="run" value="${m.activeRunTime ?? ""}" min="0" max="99" aria-label="${p} run min"></td>
    <td><input type="checkbox" data-mod="${no}" data-k="cross" ${m.applyCross ? "checked" : ""} aria-label="${p} coupled"></td></tr>`; }).join("");
  return `${editorHeader()}
  <section class="card"><h3>File</h3><div class="form-grid">
    ${field("ed-name", "File name", esc(draft.name), 'maxlength="22" autocomplete="off"')}
    ${notesField()}
  </div><p class="hint">Name: starts with a letter or number, up to 22 characters, letters, numbers, spaces and _ - ( ) ! ? , '</p>${/^[0-9]/.test(draft.name) ? `<p class="hint">This name starts with a number. That works here, but the controller's own interface refuses to save changes to single files whose names don't start with a letter, so edit this one in Protocol Explorer.</p>` : ""}</section>
  <section class="card"><h3>Special functions</h3>
    <div class="lbl" style="margin-bottom:6px">Sweep</div>
    <div class="seg" role="radiogroup" aria-label="Sweep">
      <label><input type="radio" name="sweep" value="none" ${sweep === "none" ? "checked" : ""}>None</label>
      <label><input type="radio" name="sweep" value="freq" ${sweep === "freq" ? "checked" : ""}>Frequency sweep</label>
      <label><input type="radio" name="sweep" value="power" ${sweep === "power" ? "checked" : ""}>Power ramp</label>
    </div>
    <div class="form-grid" id="fs-box" style="margin-top:12px" ${sweep === "freq" ? "" : "hidden"}>
      ${numField("fs-start", "Start (Hz)", fs.startFreq, 1, 9999)}${numField("fs-end", "End (Hz)", fs.endFreq, 1, 9999)}
      ${numField("fs-step", "Step size (Hz)", fs.freqStepSize, 1, 9999)}${numField("fs-dur", "Step duration (s)", fs.stepDuration, 1, 999)}</div>
    <div class="form-grid" id="ps-box" style="margin-top:12px" ${sweep === "power" ? "" : "hidden"}>
      ${numField("ps-start", "Start (%)", ps.startPower, 0, 140)}${numField("ps-end", "End (%)", ps.endPower, 0, 140)}
      ${numField("ps-step", "Step size (%)", ps.powerStepSize, 1, 100)}${numField("ps-dur", "Step duration (s)", ps.stepDuration, 1, 999)}</div>
    <p class="hint">Only one sweep can run. It steps the ${sweep === "power" ? "power" : "frequency"} of the lit modules, but each module still needs its own run time to light up: set it to cover the sweep (a module with run time 0 stays dark).</p>
    <h4>Cross-frequency coupling</h4>
    <label><input type="checkbox" id="c-on" ${cr.active ? "checked" : ""}> Layer a second frequency onto the modules ticked “Coupled” below</label>
    <div class="form-grid" id="c-box" style="margin-top:10px" ${cr.active ? "" : "hidden"}>
      ${numField("c-freq", "Coupling frequency (Hz)", cr.freq, 1, 9999)}${numField("c-delay", "Starts after (min)", cr.couplingDelay ?? 0, 0, 99)}${numField("c-stop", "Stops at (min, 0 = no stop)", cr.stopCoupling ?? 0, 0, 99)}</div>
  </section>
  <section class="card"><h3>Modules</h3>
    <div class="actions" style="margin-bottom:10px"><span class="lbl">Set all</span>
      <input type="number" id="all-power" placeholder="power %" min="0" max="140" style="width:90px" aria-label="Power for all">
      <input type="number" id="all-freq" placeholder="Hz" min="1" max="9999" style="width:80px" aria-label="Frequency for all">
      <input type="number" id="all-run" placeholder="run min" min="0" max="99" style="width:80px" aria-label="Run time for all">
      <button class="btn" data-act="all-on">All on</button><button class="btn" data-act="apply-all">Apply to all modules</button></div>
    <div class="tablewrap"><table><thead><tr><th>Pos</th><th>On</th><th>Power %</th><th>Hz</th><th>Light</th><th>Phase</th><th>Delay min</th><th>Run min</th><th>Coupled</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">Power: 0–140% (over 100% is overdrive). Frequency: 1–9,999 Hz. Times: 0–99 minutes. Phase B pulses opposite to phase A.</p>
  </section>
  <div id="preview" style="display:grid;gap:22px"></div>
  <div id="save-area"></div>`;
}

function batchEditorHTML() {
  return `${editorHeader()}
  <section class="card"><h3>Batch</h3><div class="form-grid">
    ${field("ed-name", "Batch name", esc(draft.name), 'maxlength="22" autocomplete="off"')}
    ${notesField()}
  </div></section>
  <section class="card"><h3>Stages</h3><div id="stages" class="stages"></div>
    <p class="hint" style="margin-top:10px">Up to 8 stages run back to back. Any single file on the device can be a stage, including Vielight's. Using one doesn't change it.</p></section>
  <div id="preview" style="display:grid;gap:22px"></div>
  <div id="save-area"></div>`;
}
function stageOptions(sel) {
  const singles = Object.keys(DATA.single);
  const grp = (label, list) => list.length ? `<optgroup label="${label}">${list.map(n => `<option value="${esc(n)}" ${n === sel ? "selected" : ""}>${esc(base(n))} · ${esc(summaryFreq(analyze(n)))} · ${fmtMin(analyze(n).total)}</option>`).join("")}</optgroup>` : "";
  return grp("Your files", singles.filter(n => ext(n) === "vnp0")) + grp("Built-in", singles.filter(n => ext(n) === "vnp1")) +
    grp("Vielight library", singles.filter(n => ext(n) === "vnp2").sort((a, b) => a.localeCompare(b)));
}
function renderStages() {
  $("#stages").innerHTML = draft.steps.map((s, i) => `<div class="stage-row">
    <span class="lbl">${i + 1}</span><select data-stage="${i}" aria-label="Stage ${i + 1}">${stageOptions(s)}</select>
    <span class="actions"><button class="btn" data-act="up" data-i="${i}" ${i ? "" : "disabled"} aria-label="Move stage ${i + 1} up">↑</button><button class="btn" data-act="down" data-i="${i}" ${i < draft.steps.length - 1 ? "" : "disabled"} aria-label="Move stage ${i + 1} down">↓</button></span>
    <button class="btn" data-act="remove" data-i="${i}" ${draft.steps.length > 1 ? "" : "disabled"}>Remove</button></div>`).join("") +
    `<div><button class="btn" data-act="add-stage" ${draft.steps.length < 8 ? "" : "disabled"}>Add stage</button></div>`;
}

const numOrNull = id => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };
function readForm() {
  draft.name = $("#ed-name").value.trim();
  draft.notes = $("#ed-notes").value;
  $("#ed-title").textContent = draft.name || "Untitled";
  if (draft.kind === "batch") return;
  const f = draft.file, sweep = document.querySelector('input[name="sweep"]:checked').value;
  f.frequency = { active: sweep === "freq", startFreq: numOrNull("#fs-start"), endFreq: numOrNull("#fs-end"), freqStepSize: numOrNull("#fs-step"), stepDuration: numOrNull("#fs-dur") };
  f.power = { active: sweep === "power", startPower: numOrNull("#ps-start"), endPower: numOrNull("#ps-end"), powerStepSize: numOrNull("#ps-step"), stepDuration: numOrNull("#ps-dur") };
  f.cross = { active: $("#c-on").checked, freq: numOrNull("#c-freq"), couplingDelay: numOrNull("#c-delay"), stopCoupling: numOrNull("#c-stop") };
  $("#fs-box").hidden = sweep !== "freq"; $("#ps-box").hidden = sweep !== "power"; $("#c-box").hidden = !f.cross.active;
  for (const m of f.modules) {
    const g = k => document.querySelector(`[data-mod="${m.module_no}"][data-k="${k}"]`);
    const n = k => { const v = g(k).value.trim(); return v === "" ? null : Number(v); };
    m.active = g("active").checked; m.power = n("power"); m.freq = n("freq"); m.delayStartTime = n("delay"); m.activeRunTime = n("run");
    m.moduleControl = { phase: Number(g("phase").value), dutyCycle: Number(g("duty").value) };
    m.applyCross = g("cross").checked;
  }
}

function validate() {
  const e = [];
  const whole = (v, lo, hi, label) => { if (v === null || !Number.isInteger(v) || v < lo || v > hi) e.push(`${label} must be a whole number from ${lo} to ${hi}.`); };
  if (!NAME_RE.test(draft.name)) e.push(nameProblem(draft.name));
  if (fullNotes().length > 200) e.push(`Notes are too long: ${fullNotes().length} of 200 characters, including the Vielight source note.`);
  if (!NOTES_RE.test(draft.notes)) e.push("Notes can use letters, numbers, spaces and _ - ! ? ( ) \" ' . ,");
  if (saveMode() === "new" && allNamesLower().has(draft.name.toLowerCase())) e.push(`A file named “${draft.name}” already exists on the device. Choose another name.`);
  if (draft.kind === "batch") {
    if (!draft.steps.length) e.push("Add at least one stage.");
    return e;
  }
  const f = draft.file;
  if (f.frequency.active) {
    const s = f.frequency;
    whole(s.startFreq, 1, 9999, "Sweep start"); whole(s.endFreq, 1, 9999, "Sweep end"); whole(s.freqStepSize, 1, 9999, "Sweep step size"); whole(s.stepDuration, 1, 999, "Sweep step duration");
    if (s.startFreq !== null && s.endFreq !== null && s.startFreq >= s.endFreq) e.push("Sweep start must be lower than the end.");
  }
  if (f.power.active) {
    const s = f.power;
    whole(s.startPower, 0, 140, "Ramp start"); whole(s.endPower, 0, 140, "Ramp end"); whole(s.powerStepSize, 1, 100, "Ramp step size"); whole(s.stepDuration, 1, 999, "Ramp step duration");
    if (s.startPower !== null && s.endPower !== null && s.startPower >= s.endPower) e.push("Ramp start must be lower than the end.");
  }
  if (f.cross.active) {
    whole(f.cross.freq, 1, 9999, "Coupling frequency"); whole(f.cross.couplingDelay, 0, 99, "Coupling start"); whole(f.cross.stopCoupling, 0, 99, "Coupling stop");
    if (!f.modules.some(m => m.active && m.applyCross)) e.push("Coupling is on, but no module that's on is ticked “Coupled”.");
  }
  for (const m of f.modules) {
    const p = POS[m.module_no];
    whole(m.power, 0, 140, `${p} power`); whole(m.freq, 1, 9999, `${p} frequency`); whole(m.delayStartTime, 0, 99, `${p} delay`); whole(m.activeRunTime, 0, 99, `${p} run time`);
  }
  if (!f.modules.some(m => m.active)) e.push("Turn on at least one module.");
  return e;
}
const saveMode = () => draft.mode === "overwrite" && draft.name === base(draft.from) ? "overwrite" : "new";

function refreshEditor() {
  readForm();
  const errs = validate();
  renderPreview(errs);
  renderSaveArea(errs);
}
function renderPreview(errs) {
  const box = $("#preview");
  if (draft.kind === "batch") {
    const st = draft.steps.map(s => analyze(s)), total = st.reduce((t, a) => t + a.total, 0);
    box.innerHTML = `${issuesBox(batchIssues({ steps: draft.steps }, st), "this batch")}<section class="card"><h3>Preview</h3>
      <div class="strip">${st.map((a, i) => `<div style="flex:${a.total || .5};background:${a.rest ? "var(--off)" : bandVar(a.mainFreq)}" title="${esc(draft.steps[i])}">${a.total / total > .12 ? esc(base(draft.steps[i])) : ""}</div>`).join("")}</div>
      <p style="margin-top:10px"><b>${fmtMin(total)}</b> in ${st.length} stage${st.length > 1 ? "s" : ""}: ${esc(st.map(a => a.rest ? "rest" : band(a.mainFreq).name.toLowerCase()).join(" → "))}. ${total > 20.5 ? "That's longer than the manual's 20-minute guidance." : "Within the manual's 20-minute guidance."}</p></section>`;
    return;
  }
  if (errs.some(x => !/already exists|^Name|^Notes/.test(x))) {
    box.innerHTML = `<section class="card"><h3>Preview</h3><p class="hint">The preview appears once the settings below are valid.</p></section>`;
    return;
  }
  const a = analyze(draft.name + ".vnp0", packSingle(draft.file));
  box.innerHTML = `${issuesBox(a.issues, "these settings")}<section class="stats">
      <div class="stat"><div class="k">Duration</div><div class="v">${fmtMin(a.total)}</div><div class="s">${a.sweep ? `${steps(a.sweep)} steps × ${a.sweep.dur}s` : "longest module"}</div></div>
      <div class="stat"><div class="k">Frequency</div><div class="v">${summaryFreq(a)}</div></div>
      <div class="stat"><div class="k">Power</div><div class="v">${a.rest ? "0%" : a.psweep ? `${a.psweep.start}→${a.psweep.end}%` : a.powers.map(p => p + "%").join(" / ")}</div></div>
      <div class="stat"><div class="k">Modules lit</div><div class="v">${a.lit.length} / 12</div></div></section>
    <section class="two"><div class="card headmap"><h3>Preview</h3>${headSVG(a)}</div>
      <div class="card"><h3>How it will drive the NP2</h3>${deviceStory(a).map(p => `<p>${p}</p>`).join("")}</div></section>
    <section class="card chart"><h3>Timeline</h3>${timelineSVG(a)}</section>`;
}
function renderSaveArea(errs) {
  const mode = saveMode(), extn = draft.kind === "single" ? ".vnp0" : ".vnp4";
  const renamed = draft.mode === "overwrite" && mode === "new";
  $("#save-area").innerHTML = `<section class="card">
    ${errs.length ? `<div class="errors"><b>Fix before saving:</b><ul>${errs.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    ${renamed ? `<p class="hint">You changed the name, so this saves a new file. ${esc(draft.from)} stays as it is.</p>` : ""}
    <div class="actions" style="margin-top:10px"><button class="btn primary" data-act="review" ${errs.length ? "disabled" : ""}>${mode === "overwrite" ? `Save changes to ${esc(draft.name + extn)}` : `Create ${esc(draft.name + extn)}`}</button>
    <button class="btn" data-go="${draft.from ? esc(draft.from) : ""}">Cancel</button></div></section>`;
}
function renderConfirm() {
  const mode = saveMode(), extn = draft.kind === "single" ? ".vnp0" : ".vnp4", fname = draft.name + extn;
  const items = [mode === "overwrite"
    ? `Overwrites your file <b>${esc(fname)}</b> on the controller. Its current version is copied to <span class="mono">device-backups\\</span> first.`
    : `Creates <b>${esc(fname)}</b> on the controller and adds it to the device's file list.`];
  if (draft.kind === "batch") {
    const mine = [...new Set(draft.steps.filter(isMine))], orig = [...new Set(draft.steps.filter(s => !isMine(s)))];
    if (mine.length) items.push(`Marks your file${mine.length > 1 ? "s" : ""} ${esc(mine.map(base).join(", "))} as used by a batch, as the controller's own interface does.`);
    if (orig.length) items.push(`Uses ${esc(orig.map(base).join(", "))} as stages without changing ${orig.length > 1 ? "them" : "it"}.`);
  }
  items.push("No Vielight original file is changed. The app refuses any write to them.");
  $("#save-area").innerHTML = `<section class="confirm"><h3>Save to the device?</h3><ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>
    ${STATUS?.dryRun ? `<p class="hint">Dry-run mode: the app logs the device calls but sends none.</p>` : ""}
    <div class="actions"><button class="btn primary" data-act="save">${mode === "overwrite" ? "Save changes" : "Create file"}</button><button class="btn" data-act="back-edit">Back to editing</button></div></section>`;
}
async function doSave() {
  const mode = saveMode();
  const body = draft.kind === "single"
    ? { mode, name: draft.name, file: { ...draft.file, notes: fullNotes() } }
    : { mode, name: draft.name, notes: fullNotes(), steps: draft.steps };
  $("#save-area").innerHTML = `<section class="card"><p>Backing up and saving to the device…</p></section>`;
  let res, j;
  try {
    const r = await window.np2.save(draft.kind, body);
    res = { ok: r.ok }; j = r.ok ? r.data : { error: r.error };
  } catch (e) { j = { error: "The app's device service didn't respond: " + e.message }; res = { ok: false }; }
  if (!res.ok) {
    $("#save-area").innerHTML = `<section class="card"><div class="errors"><b>Not saved.</b> ${esc(j.error)}</div><div class="actions" style="margin-top:10px"><button class="btn" data-act="back-edit">Back to editing</button></div></section>`;
    return;
  }
  if (!j.dryRun) { await loadFiles(false); current = j.file; }   // false: re-reads only what the save touched
  buildIndex();
  const v = j.verified;
  $("#save-area").innerHTML = `<section class="success"><h3>${j.dryRun ? "Dry run complete" : "Saved"}: ${esc(j.file)}</h3>
    ${j.dryRun ? "<p>Nothing was sent to the device. The calls below are what a real save would send.</p>" : `<p${v && !v.ok ? " style=\"color:var(--bad)\"" : ""}>${v ? (v.ok ? "✓ " : "<b>✕ Check failed.</b> ") : ""}${esc(v ? v.detail : "")}</p>`}
    <p class="hint">Backup of the affected files: <span class="mono">${esc(j.backup)}</span></p>
    ${j.skippedOriginals && j.skippedOriginals.length ? `<p class="hint">Not modified (Vielight originals): ${esc(j.skippedOriginals.join(", "))}</p>` : ""}
    <details><summary>Device calls (${j.calls.length})</summary><ol class="mono">${j.calls.map(c => `<li>${esc(c.call.slice(0, 160))}${c.call.length > 160 ? "…" : ""}${c.sent ? ` → ${esc(c.response || "OK")}` : " (not sent)"}</li>`).join("")}</ol></details>
    <div class="actions" style="margin-top:10px">${!j.dryRun && DATA[draft.kind === "single" ? "single" : "batch"][j.file] ? `<button class="btn primary" data-go="${esc(j.file)}">Open ${esc(base(j.file))}</button>` : ""}<button class="btn" data-act="back-edit">Keep editing</button></div></section>`;
  if (!j.dryRun) { draft.mode = "overwrite"; draft.from = j.file; }
}

function bindEditor() {
  if (draft.kind === "batch") renderStages();
  refreshEditor();
}
$("#main").addEventListener("input", e => {
  if (!draft || e.target.closest("#save-area")) return;
  if (e.target.dataset.stage !== undefined) { draft.steps[+e.target.dataset.stage] = e.target.value; }
  if (/^all-/.test(e.target.id)) return;
  refreshEditor();
});
$("#main").addEventListener("change", e => {
  if (draft && (e.target.name === "sweep" || e.target.dataset.stage !== undefined)) refreshEditor();
});
function onAct(act, el) {
  if (act === "apply-all" || act === "all-on") {
    for (let no = 1; no <= 12; no++) {
      const g = k => document.querySelector(`[data-mod="${no}"][data-k="${k}"]`);
      if (act === "all-on") { g("active").checked = true; continue; }
      for (const k of ["power", "freq", "run"]) { const v = $(`#all-${k}`).value.trim(); if (v !== "") g(k).value = v; }
    }
    refreshEditor();
  } else if (act === "add-stage") { draft.steps.push(draft.steps[draft.steps.length - 1] || Object.keys(DATA.single)[0]); renderStages(); refreshEditor(); }
  else if (act === "remove") { draft.steps.splice(+el.dataset.i, 1); renderStages(); refreshEditor(); }
  else if (act === "up" || act === "down") {
    const i = +el.dataset.i, j = act === "up" ? i - 1 : i + 1;
    [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; renderStages(); refreshEditor();
  }
  else if (act === "review") renderConfirm();
  else if (act === "back-edit") refreshEditor();
  else if (act === "save") doSave();
}

/* ---------- Delete ---------- */
let FLASH = "";
async function doDelete(name, btn) {
  if (!editingAllowed() || !isMine(name)) return;
  btn.disabled = true; btn.textContent = "Deleting…";
  const box = $("#del-status");
  let res, j;
  try {
    const r = await window.np2.remove(name);
    res = { ok: r.ok }; j = r.ok ? r.data : { error: r.error };
  } catch (e) { j = { error: "The app's device service didn't respond: " + e.message }; res = { ok: false }; }
  if (!res.ok) {
    box.innerHTML = `<div class="errors" style="margin-top:10px"><b>Not deleted.</b> ${esc(j.error)}</div>`;
    btn.disabled = false; btn.textContent = "Delete";
    return;
  }
  if (!j.dryRun) await loadFiles(false);
  const v = j.verified;
  FLASH = `<section class="success"><h3>${j.dryRun ? "Dry run: not deleted" : "Deleted"}: ${esc(j.file)}</h3>
    ${j.dryRun ? "<p>Nothing was sent to the device.</p>" : `<p${v && !v.ok ? " style=\"color:var(--bad)\"" : ""}>${v ? (v.ok ? "✓ " : "<b>✕ Check failed.</b> ") : ""}${esc(v ? v.detail : "")}</p>`}
    <p class="hint">Backup of the file before deleting: <span class="mono">${esc(j.backup)}</span></p>
    <details><summary>Device calls (${j.calls.length})</summary><ol class="mono">${j.calls.map(c => `<li>${esc(c.call.slice(0, 160))}${c.call.length > 160 ? "…" : ""}${c.sent ? ` → ${esc(c.response || "OK")}` : " (not sent)"}</li>`).join("")}</ol></details></section>`;
  if (location.hash) location.hash = ""; else route();
}
let armTimer = null;
document.addEventListener("click", e => {
  const d = e.target.closest("[data-del]");
  if (!d || d.disabled) return;
  d.classList.add("armed"); d.textContent = "Double-click to delete";
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { if (d.isConnected && !d.disabled) { d.classList.remove("armed"); d.textContent = "Delete"; } }, 2500);
});
document.addEventListener("dblclick", e => {
  const d = e.target.closest("[data-del]");
  if (d && !d.disabled) { clearTimeout(armTimer); doDelete(d.dataset.del, d); }
});

/* ---------- Wi-Fi reconnect and export ---------- */
let toastTimer = null;
function toast(html, bad) {
  const t = $("#toast");
  t.innerHTML = html; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 12000 : 8000);
}
const myFiles = () => [...Object.keys(DATA.single), ...Object.keys(DATA.batch)].filter(isMine).sort();
async function reconnectWifi() {
  if (wifiBusy) return;
  wifiBusy = true; renderConn();
  let r;
  try { r = await window.np2.reconnectWifi(); } catch (e) { r = { ok: false, error: e.message }; }
  const res = r.ok ? r.data : { ok: false, message: r.error };
  if (!res.ok) toast(`<b>Couldn't connect to npAP.</b> ${esc(res.message || "")} Is the NP2 switched on?`, true);
  // The computer takes a few seconds to join and get an address; poll until the device answers or we give up.
  for (let i = 0; i < 6 && res.ok && !STATUS?.device?.reachable; i++) {
    await new Promise(ok => setTimeout(ok, 2500));
    await pollStatus();
  }
  wifiBusy = false;
  await pollStatus();
}
async function exportFiles(names) {
  if (!names.length) return;
  let r;
  try { r = await window.np2.exportFiles(names); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) return toast(`<b>Not exported.</b> ${esc(r.error)}`, true);
  if (r.data.canceled) return;
  toast(`<b>Exported ${r.data.files.length} file${r.data.files.length === 1 ? "" : "s"}</b> to <span class="mono">${esc(r.data.folder)}</span>`);
}
// Browser version only (the app uses File > Choose Data Folder): the helper shows the computer's folder picker,
// which may open behind the browser.
async function chooseProject() {
  toast("Choose your NP2 data folder in the window that opened (it may be behind the browser).");
  let r;
  try { r = await window.np2.chooseProject(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) return toast(`<b>Data folder not changed.</b> ${esc(r.error)}`, true);
  if (r.data.canceled) return;
  if (r.data.warning) toast(esc(r.data.warning), true);
  location.reload();
}
document.addEventListener("click", e => {
  if (e.target.closest("[data-project]")) return chooseProject();
  if (e.target.closest("[data-wifi]:not(:disabled)")) return reconnectWifi();
  const x = e.target.closest("[data-export]");
  if (x && !x.disabled) exportFiles(x.dataset.export ? [x.dataset.export] : myFiles());
});

/* ---------- Full backups ---------- */
// The app backs up the whole device on first connection and checks hourly (main.js); this shows the result.
const hhmm = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
function backupChip(b) {
  if (!b) return "";
  const go = `data-go="#backups" title="Full backups of the NP2: click to see them"`;
  if (b.running) return chip("warn", "Backup", "backing up…", go);
  const l = b.last;
  if (!l) return chip("", "Backup", "waits for the NP2", go);
  if (!l.ok) return chip("warn", "Backup", `not clean, retry at ${hhmm(b.nextAt)}`, go);
  return chip("ok", "Backup", l.saved ? `saved ${hhmm(b.checkedAt)}` : `no changes · checked ${hhmm(b.checkedAt)}`, go);
}
let BACKUPS = null, backupBusy = false;
async function refreshBackups() {
  try { const r = await window.np2.backups(); if (r.ok) BACKUPS = r.data; } catch { /* keep the old list */ }
  if (location.hash === "#backups") $("#main").innerHTML = `<div class="page">${renderBackups()}</div>`;
}
function changeText(c) {
  if (!c) return "First backup";
  const parts = [];
  if (c.added.length) parts.push(`added ${c.added.map(base).join(", ")}`);
  if (c.removed.length) parts.push(`removed ${c.removed.map(base).join(", ")}`);
  if (c.changed.length) parts.push(`changed ${c.changed.map(base).join(", ")}`);
  return parts.length ? parts.join("; ") : "file order or lists changed";
}
function renderBackups() {
  if (!HAS_BRIDGE) return `<section class="card"><h2>Backups</h2><p>Open the NP2 Protocol Explorer app to see backups.</p></section>`;
  const b = BACKUPS, l = b?.last;
  const status = !b ? "Loading…"
    : b.running || backupBusy ? "Backing up now…"
    : !l ? "No check yet this session. The first one runs as soon as the NP2 is connected."
    : !l.ok ? `Last check at ${hhmm(b.checkedAt)} wasn't clean (${esc(l.reason)}), so nothing was kept. Retrying at ${hhmm(b.nextAt)}.`
    : `Last check at ${hhmm(b.checkedAt)}: ${l.saved ? "changes found, new backup saved." : "no changes since the newest backup, so nothing new was saved."} Next check at ${hhmm(b.nextAt)}.`;
  const rows = (b?.list || []).map((x, i) => `<tr><td class="mono">${esc(x.takenAt.replace("T", " "))}${i === 0 ? ' <span class="mine-tag">newest</span>' : ""}</td>
    <td class="num">${x.counts.single} + ${x.counts.batch}</td><td>${esc(changeText(x.changes))}</td><td class="mono hint" title="${esc(x.folder)}">${esc(x.folder.replace(/^device-backups[\\/]/, ""))}</td>
    <td style="white-space:nowrap"><button class="btn" data-restore-plan="${esc(x.id)}" ${editingAllowed() && !RESTORE?.busy && !checkingNow() ? "" : "disabled"} title="Compare every file and the file lists on the device with this backup. Read-only; restoring is a separate step.">${checkingNow() && RESTORE.id === x.id ? `<span class="spin"></span>Checking…` : "Check status"}</button></td></tr>`).join("");
  return `<section class="card"><h2>Backups</h2>
    <p>The app copies everything on the NP2, byte for byte: all single and batch files (yours and Vielight's) and the device's file lists. It checks when the NP2 first connects and then every hour. A backup is kept only if it's clean (every file read twice with identical results, and nothing changed on the device while copying) and something changed since the newest one. The newest 20 are kept; older ones are deleted. The backups taken before each save or delete are separate and never deleted.</p>
    <p><b>${status}</b></p>
    <div class="actions"><button class="btn primary" data-backup-now ${STATUS?.device?.reachable && !(b?.running || backupBusy) ? "" : "disabled"}>Back up now</button>${STATUS?.device?.reachable ? "" : `<span class="hint">Needs the NP2 connected.</span>`}</div>
    ${rows ? `<div class="tablewrap" style="margin-top:14px"><table class="imp"><thead><tr><th>Taken</th><th>Files (single + batch)</th><th>Changes since the previous backup</th><th>Folder</th><th>Device vs backup</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : b ? `<p class="hint" style="margin-top:14px">No full backups yet.</p>` : ""}
    ${renderRestore()}
  </section>
  ${renderDataFolder()}`;
}

// Where the app keeps its records of this NP2. Set up automatically the first time the NP2 answers; changed only
// when moving to another computer or keeping it somewhere else.
function renderDataFolder() {
  const folder = BACKUPS?.folder;
  const change = window.np2.chooseProject
    ? `<div class="actions"><button class="btn" data-project title="Use a different NP2 data folder, e.g. one copied from another computer">Change folder…</button></div>`
    : `<p class="hint">To use a different folder, choose File › Choose Data Folder… in the menu.</p>`;
  return `<section class="card"><h2>Your NP2 data folder</h2>
    <p>Everything the app keeps about your NP2 is in this folder: the copy of the device made the first time it connected (this is how the app knows which files are Vielight's and never lets them be changed), the backups above and those taken before every save or delete, the last files read (shown when the NP2 is off), and the run history.</p>
    <p class="mono">${folder ? esc(folder) : "Not set up yet: it's created the first time the NP2 answers."}</p>
    <p class="hint">The app set this up for you. You only need to change it when moving to a new computer (copy the whole folder across, then choose it here) or to keep it somewhere else, such as a backed-up drive. Keep it safe: without it the app can't tell your files from Vielight's.</p>
    ${change}
  </section>`;
}

document.addEventListener("click", async e => {
  const btn = e.target.closest("[data-backup-now]");
  if (!btn || btn.disabled || backupBusy) return;
  backupBusy = true; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Backing up…`;
  let r;
  try { r = await window.np2.backupNow(); } catch (err) { r = { ok: false, error: err.message }; }
  backupBusy = false;
  if (!r.ok) toast(`<b>Backup didn't run.</b> ${esc(r.error)}`, true);
  else {
    BACKUPS = r.data;
    const l = r.data.last;
    toast(!l.ok ? `<b>Backup not kept:</b> ${esc(l.reason)}` : l.saved ? `<b>Backup saved</b> to <span class="mono">${esc(l.folder)}</span>` : "<b>No changes</b> since the newest backup, so nothing new was saved.", !l.ok);
  }
  refreshBackups(); pollStatus();
});

/* ---------- Check a full backup against the device, and restore from it ---------- */
// "Check status" only reads: every file is compared with the backup's copy, and the file lists with the
// backup's lists. Restoring needs a double-click and writes only your own files (.vnp0 / .vnp4) or list names.
let RESTORE = null;   // { id, takenAt, check, sel:Set, busy, result:{ what, data }, error }
const KIND_LABEL = { single: "Single files", batch: "Batches" };
const STATE_TEXT = {
  changed: ["Changed since this backup", "Expected if you edited it after the backup. If you didn't, it may be damaged."],
  unreadable: ["Damaged: the device can't read it", "Restoring puts the backup's copy back."],
  missing: ["Not on the device", "Expected if you deleted it after the backup. Restoring re-creates it."],
};
const VIELIGHT_NOTE = "Vielight files never change, so this is unexpected. The app can't write Vielight files; keep this backup as the reference copy and contact Vielight.";
const callsList = calls => `<details><summary>Device calls (${calls.length})</summary><ol class="mono">${calls.map(c => `<li>${esc(c.call.slice(0, 160))}${c.call.length > 160 ? "…" : ""}${c.sent ? ` → ${esc(c.response || "OK")}` : " (not sent)"}</li>`).join("")}</ol></details>`;
const verifiedLine = v => v ? `<p${!v.ok ? ' style="color:var(--bad)"' : ""}>${v.ok ? "✓ " : "<b>✕ Check failed.</b> "}${esc(v.detail)}</p>` : "";
function renderRestore() {
  const r = RESTORE;
  if (!r) return "";
  const when = esc((r.takenAt || r.id).replace("T", " "));
  const close = `<button class="btn" data-restore-close>Close</button>`;
  const again = `<button class="btn" data-restore-plan="${esc(r.id)}">Check again</button>`;
  if (r.error) return `<div class="errors" style="margin-top:14px"><b>Stopped.</b> ${esc(r.error)}<div class="actions" style="margin-top:8px">${again}${close}</div></div>`;
  if (r.result) {
    const { what, data: j } = r.result;
    const head = j.dryRun ? "Dry run: nothing sent" : what === "files" ? "Files restored" : j.nothing ? "Nothing to restore" : "File list restored";
    const body = what === "files"
      ? `<p>${j.dryRun ? "Would restore" : "Restored"}: ${j.files.map(n => esc(base(n))).join(", ")}</p>
         ${Object.keys(j.flagFixes || {}).length ? `<p class="hint">Used-by-batch flag set to match the batches on the device: ${Object.entries(j.flagFixes).map(([n, v]) => `${esc(base(n))} → ${v ? "used" : "not used"}`).join(", ")}</p>` : ""}`
      : `<p>${j.dryRun ? "Would put back" : "Put back"}:<br>${Object.entries(j.restored || {}).filter(([, l]) => l.length).map(([k, l]) => `${KIND_LABEL[k]}: ${l.map(esc).join(", ")}`).join("<br>")}</p>`;
    return `<section class="success" style="margin-top:14px"><h3>${head} (from the ${when} backup)</h3>${j.nothing ? "" : body}
      ${j.dryRun ? "" : verifiedLine(j.verified)}
      ${j.backup ? `<p class="hint">Copies from before the restore: <span class="mono">${esc(j.backup)}</span></p>` : ""}
      ${j.calls ? callsList(j.calls) : ""}
      <div class="actions" style="margin-top:10px">${again}${close}</div></section>`;
  }
  if (!r.check) {
    const p = r.progress, pct = p && p.total ? Math.round(100 * p.done / p.total) : 30;
    return `<section class="card" style="margin-top:14px"><p><span class="spin" style="color:var(--nir)"></span><b>Checking every file on the device against the ${when} backup…</b> Nothing is changed. This takes about 30 seconds.</p>
      <div class="progress${p ? "" : " indeterminate"}" id="chk-progress"><div class="bar" id="chk-bar" style="width:${pct}%"></div></div>
      <p class="hint" id="chk-text">${progressText(p)}</p></section>`;
  }
  const F = r.check.files, P = r.check.list, L = Object.entries(P.lists);
  const diffs = F.files.filter(f => f.state !== "same");
  const damaged = diffs.filter(f => f.state === "unreadable"), vielightChanged = diffs.filter(f => !f.mine && f.state !== "unreadable");
  const listMissing = L.reduce((s, [, l]) => s + l.restore.length, 0);
  const problems = [damaged.length && `${damaged.length} damaged file${damaged.length === 1 ? "" : "s"}`,
    vielightChanged.length && `${vielightChanged.length} Vielight file${vielightChanged.length === 1 ? "" : "s"} changed or missing`,
    listMissing && `${listMissing} file${listMissing === 1 ? "" : "s"} missing from the device's file list`].filter(Boolean);
  const verdict = problems.length
    ? `<p style="color:var(--bad);font-size:1.1em"><b>✕ Problems found:</b> ${problems.join("; ")}. Details below.</p>`
    : diffs.length
      ? `<p style="color:var(--ok);font-size:1.1em"><b>✓ Device in good order.</b> Nothing is damaged. The differences below are your own files that changed or were deleted after this backup.</p>`
      : `<p style="color:var(--ok);font-size:1.1em"><b>✓ Device in good order.</b> Every file matches this backup${F.added.length ? " (plus files added since)" : ""}, and the file lists are complete.</p>`;
  // Files
  const rows = diffs.map(f => {
    const [label, note] = STATE_TEXT[f.state];
    return `<tr><td>${f.mine ? `<input type="checkbox" data-restore-pick="${esc(f.name)}" ${r.sel.has(f.name) ? "checked" : ""}>` : ""}</td>
      <td>${esc(base(f.name))} <span class="hint">${f.mine ? "yours" : "Vielight"} · ${f.kind}</span></td>
      <td${f.state === "unreadable" || !f.mine ? ' style="color:var(--bad)"' : ""}><b>${label}</b></td><td class="hint">${f.mine ? note : VIELIGHT_NOTE}</td></tr>`;
  }).join("");
  const picked = [...r.sel];
  const files = `<h4 style="margin-top:16px">Files</h4>
    <p>${F.counts.same} of ${F.files.length} files match this backup exactly${diffs.length ? `; ${diffs.length} differ${diffs.length === 1 ? "s" : ""}:` : "."}</p>
    ${diffs.length ? `<div class="tablewrap"><table class="imp"><thead><tr><th>Restore</th><th>File</th><th>Status</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${F.added.length ? `<p class="hint">Added since this backup (not in it, left alone): ${F.added.map(n => esc(base(n))).join(", ")}</p>` : ""}
    ${diffs.some(f => f.mine) ? `<p>Restoring writes the backup's copy of each ticked file back to the device, exactly as it was. Each file's current version (even a damaged one) is copied to <span class="mono">device-backups\\</span> first, and each restored file is read back and compared with the backup. A batch needs its stage files on the device, so tick those too if they're missing.</p>
      <div class="actions"><button class="btn danger" data-restore-files ${picked.length && editingAllowed() && !r.busy ? "" : "disabled"}>${r.busy === "files" ? "Restoring…" : picked.length ? `Restore ${picked.length} selected file${picked.length === 1 ? "" : "s"}` : "Tick files to restore"}</button></div>` : ""}`;
  // File lists
  const names = (l, empty = "—") => l.length ? l.map(n => esc(base(n))).join(", ") : `<span class="hint">${empty}</span>`;
  const list = `<h4 style="margin-top:18px">File lists (what the controller shows)</h4>
    <div class="tablewrap"><table class="imp"><thead><tr><th></th><th>In both</th><th>Added since this backup</th><th>Deleted since this backup</th><th>Missing from the device's list</th></tr></thead><tbody>
    ${L.map(([k, l]) => `<tr><td><b>${KIND_LABEL[k]}</b></td><td class="num">${l.same}</td><td>${names(l.added)}</td><td>${names(l.gone)}</td>
      <td${l.restore.length ? ' style="color:var(--bad)"' : ""}>${l.restore.length ? `<b>${names(l.restore)}</b>` : names([], "none")}</td></tr>`).join("")}
    </tbody></table></div>
    ${P.needed ? `<p>Restoring the list only adds the files in red back to the device's file lists, so the controller shows them again. Nothing is removed and no file is changed.</p>
      <div class="actions"><button class="btn danger" data-restore-go="${esc(P.id)}" ${editingAllowed() && !r.busy ? "" : "disabled"}>${r.busy === "list" ? "Restoring…" : "Restore list"}</button></div>`
      : `<p class="hint">The lists are complete: nothing to restore.</p>`}`;
  return `<section class="card" style="margin-top:14px"><h3>Backup from ${when} compared with the device now</h3>
    ${verdict}${files}${list}<div class="actions" style="margin-top:14px">${again}${close}</div></section>`;
}
const checkingNow = () => !!(RESTORE && !RESTORE.check && !RESTORE.error && !RESTORE.result);
const progressText = p => !p ? "Reading the device's file lists…"
  : p.step === "lists" ? `All ${p.total} files checked. Comparing the file lists…`
  : `Checked ${p.done} of ${p.total} files (${p.total ? Math.round(100 * p.done / p.total) : 0}%)`;
const rerenderBackups = () => { if (location.hash === "#backups") $("#main").innerHTML = `<div class="page">${renderBackups()}</div>`; };
// Restore buttons: the first click arms, the double-click acts (like Delete).
let restoreArm = null;
function arm(el) {
  const label = el.textContent;
  el.classList.add("armed"); el.textContent = "Double-click to restore";
  clearTimeout(restoreArm);
  restoreArm = setTimeout(() => { if (el.isConnected && !el.disabled) { el.classList.remove("armed"); el.textContent = label; } }, 2500);
}
async function runCheck(id) {
  const row = (BACKUPS?.list || []).find(x => x.id === id);
  const mine = RESTORE = { id, takenAt: row?.takenAt, sel: new Set() };
  rerenderBackups();
  // Move the progress bar in place while the check runs.
  const tick = setInterval(async () => {
    let p;
    try { p = await window.np2.checkProgress(); } catch { return; }
    if (RESTORE !== mine || mine.check || !p.ok || !p.data || p.data.id !== id) return;
    mine.progress = p.data;
    const bar = $("#chk-bar"), box = $("#chk-progress"), txt = $("#chk-text");
    if (box) box.classList.remove("indeterminate");
    if (bar) bar.style.width = (p.data.total ? Math.round(100 * p.data.done / p.data.total) : 0) + "%";
    if (txt) txt.textContent = progressText(p.data);
  }, 400);
  let r;
  try { r = await window.np2.checkBackup(id); } catch (err) { r = { ok: false, error: err.message }; }
  clearInterval(tick);
  if (RESTORE !== mine) return;   // closed or another check started meanwhile
  if (r.ok) { mine.check = r.data; for (const f of r.data.files.files) if (f.mine && f.state === "unreadable") mine.sel.add(f.name); }
  else mine.error = r.error;
  rerenderBackups();
}
document.addEventListener("change", e => {
  const box = e.target.closest("[data-restore-pick]");
  if (!box || !RESTORE) return;
  if (box.checked) RESTORE.sel.add(box.dataset.restorePick); else RESTORE.sel.delete(box.dataset.restorePick);
  rerenderBackups();
});
document.addEventListener("click", e => {
  if (e.target.closest("[data-restore-close]")) { RESTORE = null; rerenderBackups(); return; }
  const go = e.target.closest("[data-restore-go], [data-restore-files]");
  if (go) { if (!go.disabled && !go.classList.contains("armed")) arm(go); return; }
  const btn = e.target.closest("[data-restore-plan]");
  if (!btn || btn.disabled || !editingAllowed() || RESTORE?.busy) return;
  runCheck(btn.dataset.restorePlan);
});
document.addEventListener("dblclick", async e => {
  const go = e.target.closest("[data-restore-go], [data-restore-files]");
  if (!go || go.disabled || !RESTORE || RESTORE.busy || !editingAllowed()) return;
  clearTimeout(restoreArm);
  const what = go.hasAttribute("data-restore-files") ? "files" : "list";
  RESTORE.busy = what; rerenderBackups();
  let r;
  try { r = what === "files" ? await window.np2.restoreFiles(RESTORE.id, [...RESTORE.sel]) : await window.np2.restoreLists(RESTORE.id); }
  catch (err) { r = { ok: false, error: "The app's device service didn't respond: " + err.message }; }
  RESTORE.busy = false;
  if (r.ok) { RESTORE.result = { what, data: r.data }; if (!r.data.dryRun && !r.data.nothing) { await loadFiles(false); buildIndex(); renderConn(); } }
  else RESTORE.error = r.error;
  rerenderBackups();
});

/* ---------- Import ---------- */
// Each picked file becomes a NEW file of yours on the device (never an overwrite), saved through the same
// checked, backed-up path as the editor. Singles go first so batches in the same import can use them.
let IMPORT = null;
async function pickImport() {
  let r;
  try { r = await window.np2.pickImport(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) return toast(`<b>Couldn't open the files.</b> ${esc(r.error)}`, true);
  if (r.data.canceled || !r.data.files.length) return;
  const taken = allNamesLower();
  const items = r.data.files.map(f => {
    const orig = f.data && typeof f.data.filename === "string" && NAME_RE.test(f.data.filename) ? f.data.filename : f.file.replace(/\.vnp\d$/i, "");
    return { ...f, orig, name: "", state: f.error ? "bad" : "ready" };
  });
  // Suggest a free name for each, also avoiding names that earlier files in this import will take.
  for (const it of items) {
    if (it.error) continue;
    let n = it.orig.slice(0, 22).trim(), i = 2;
    while (taken.has(n.toLowerCase())) { const sfx = ` ${i++}`; n = it.orig.slice(0, 22 - sfx.length).trim() + sfx; }
    it.name = n; taken.add(n.toLowerCase());
  }
  items.sort((a, b) => (a.kind === "batch") - (b.kind === "batch"));
  IMPORT = { items, running: false, done: false };
  if (location.hash === "#import") route(); else location.hash = "#import";
}
// A batch stage names either a file on the device or one of the singles in this import (by its original name).
function importStages(it) {
  return (it.data.filenames || []).filter(Boolean).map(s => {
    const twin = IMPORT.items.find(o => o.kind === "single" && !o.error && `${o.orig}.vnp0`.toLowerCase() === String(s).toLowerCase());
    return twin ? { from: s, to: `${twin.name.trim()}.vnp0`, twin } : { from: s, to: s, onDevice: !!DATA.single[s] };
  });
}
function importIssues(it) {
  if (it.error) return [it.error];
  const out = [], n = it.name.trim();
  if (!NAME_RE.test(n)) out.push(nameProblem(n));
  else if (allNamesLower().has(n.toLowerCase())) out.push(`A file named “${n}” is already on the NP2. Choose another name.`);
  else if (IMPORT.items.some(o => o !== it && !o.error && o.name.trim().toLowerCase() === n.toLowerCase())) out.push(`Two files in this import are named “${n}”.`);
  const notes = it.data.notes || "";
  if (typeof notes !== "string" || !NOTES_RE.test(notes) || notes.length > 200) out.push("Its notes use characters the NP2 doesn't accept.");
  if (it.kind === "batch") {
    const st = importStages(it);
    if (st.length < 1 || st.length > 8) out.push("A batch needs 1 to 8 stages.");
    const missing = st.filter(s => !s.twin && !s.onDevice).map(s => base(String(s.from)));
    if (missing.length) out.push(`Stage${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} on the NP2 or in this import. Import ${missing.length > 1 ? "them" : "it"} too.`);
  }
  return out;
}
function importNote(it) {
  const backup = `<div class="hint">Backup: <span class="mono">${esc(it.backup || "")}</span></div>`;
  if (it.state === "saved") return `<span style="color:var(--ok)">✓ Imported</span>${it.verified ? ` · ${esc(it.verified)}` : ""}${backup}`;
  if (it.state === "dry") return `Dry run: nothing sent${backup}`;
  if (it.state === "failed") return `<div class="errors"><b>Not imported.</b> ${esc(it.fail)}</div>`;
  if (it.state === "saving") return "Backing up and saving…";
  if (IMPORT.done) return it.error || importIssues(it).length ? "Skipped." : "Not imported.";
  const iss = importIssues(it);
  if (iss.length) return `<div class="errors">${iss.map(esc).join("<br>")}</div>`;
  const notes = [];
  if (it.name.trim() !== it.orig) notes.push(`“${esc(it.orig)}” is already taken, so a new name is suggested.`);
  if (it.kind === "batch") {
    const ren = importStages(it).filter(s => s.twin && s.to.toLowerCase() !== String(s.from).toLowerCase());
    if (ren.length) notes.push(`Uses the imported ${ren.map(s => `“${esc(base(s.to))}”`).join(", ")} as stage${ren.length > 1 ? "s" : ""}.`);
  }
  return `Ready${notes.length ? `<div class="hint">${notes.join(" ")}</div>` : ""}`;
}
function renderImport() {
  const ready = IMPORT.items.filter(it => it.state === "ready" && !importIssues(it).length).length;
  const blocked = IMPORT.items.some(it => it.state === "ready" && importIssues(it).length);
  const ok = editingAllowed() && !IMPORT.running && ready > 0;
  const editable = !IMPORT.running && !IMPORT.done;
  const rows = IMPORT.items.map((it, i) => `<tr>
    <td class="mono">${esc(it.file)}</td><td>${it.kind === "batch" ? "Batch" : it.kind === "single" ? "Single" : "?"}</td>
    <td>${it.error ? "" : `<input data-imp-name="${i}" value="${esc(it.name)}" maxlength="22" aria-label="Name on the NP2 for ${esc(it.file)}" ${editable ? "" : "disabled"}>`}</td>
    <td id="imp-st-${i}">${importNote(it)}</td></tr>`).join("");
  const actions = IMPORT.done
    ? `<button class="btn primary" data-imp="pick">Import more</button><button class="btn" data-go="">Done</button>`
    : `<button class="btn primary" data-imp="run" ${ok ? "" : "disabled"}>${IMPORT.running ? "Importing…" : `Import ${ready} file${ready === 1 ? "" : "s"}`}</button><button class="btn" data-go="" ${IMPORT.running ? "disabled" : ""}>Cancel</button>`
      + (!editingAllowed() ? `<span class="hint">Importing needs the NP2 connected.</span>` : blocked ? `<span class="hint">Files with a problem are skipped unless you fix them above.</span>` : "");
  return `<section class="card"><h2>Import files to the NP2</h2>
    <p class="hint">Each file is added as a new file of yours. Nothing on the NP2 is overwritten, Vielight originals are never touched, and a backup is taken before each save.</p>
    <table class="imp"><thead><tr><th>File</th><th>Type</th><th>Name on the NP2</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="actions" id="imp-actions" style="margin-top:14px">${actions}</div></section>`;
}
const redrawImport = () => { if (location.hash === "#import" && IMPORT) $("#main").innerHTML = `<div class="page">${renderImport()}</div>`; };
async function runImport() {
  IMPORT.running = true;
  const todo = IMPORT.items.filter(it => it.state === "ready" && !importIssues(it).length);
  todo.forEach(it => { it.name = it.name.trim(); });
  redrawImport();
  for (const it of todo) {
    it.state = "saving"; redrawImport();
    let body;
    if (it.kind === "single") body = { mode: "new", name: it.name, file: it.data };
    else {
      const st = importStages(it), failed = st.find(s => s.twin && s.twin.state !== "saved" && s.twin.state !== "dry");
      if (failed) { it.state = "failed"; it.fail = `Its stage “${base(failed.to)}” wasn't imported.`; continue; }
      body = { mode: "new", name: it.name, notes: it.data.notes || "", steps: st.map(s => s.to) };
    }
    let r;
    try { r = await window.np2.save(it.kind, body); } catch (e) { r = { ok: false, error: "The app's device service didn't respond: " + e.message }; }
    if (!r.ok) { it.state = "failed"; it.fail = r.error; continue; }
    it.state = r.data.dryRun ? "dry" : "saved"; it.backup = r.data.backup;
    if (r.data.verified) it.verified = r.data.verified.detail;
    // Reload so the next file sees this one (batch stages, name checks).
    if (!r.data.dryRun) await loadFiles(false);
  }
  IMPORT.running = false; IMPORT.done = true;
  buildIndex(); redrawImport();
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-imp]");
  if (!b || b.disabled) return;
  if (b.dataset.imp === "pick") pickImport();
  else if (b.dataset.imp === "run" && IMPORT && !IMPORT.running) runImport();
});
$("#main").addEventListener("input", e => {
  const inp = e.target.closest("[data-imp-name]");
  if (!inp || !IMPORT) return;
  IMPORT.items[+inp.dataset.impName].name = inp.value;
  // Update the status cells and buttons without redrawing the inputs, so the cursor stays put.
  IMPORT.items.forEach((it, i) => { const c = $(`#imp-st-${i}`); if (c) c.innerHTML = importNote(it); });
  const tmp = document.createElement("div"); tmp.innerHTML = renderImport();
  $("#imp-actions").innerHTML = tmp.querySelector("#imp-actions").innerHTML;
});

/* ---------- Run history ---------- */
// Every protocol started from the app, newest first (main.js keeps run-history.jsonl in the project folder).
let HISTORY = null;
async function refreshHistory() {
  try { const r = await window.np2.history(); HISTORY = r.ok ? r.data : { error: r.error }; } catch (e) { HISTORY = { error: e.message }; }
  if (location.hash === "#history") $("#main").innerHTML = `<div class="page">${renderHistory()}</div>`;
}
const hmDur = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
const OUTCOME = { ended: "Finished", stopped: "Stopped", failed: "Failed" };
function renderHistory() {
  if (!HAS_BRIDGE) return `<section class="card"><h2>History</h2><p>Open the NP2 Protocol Explorer app to see the run history.</p></section>`;
  const h = HISTORY;
  if (!h) return `<section class="card"><h2>History</h2><p>Loading…</p></section>`;
  if (h.error) return `<section class="card"><h2>History</h2><p>Couldn't read the history: ${esc(h.error)}</p></section>`;
  const list = h.sessions;
  const day = iso => new Date(iso).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  const week = Date.now() - 7 * 864e5;
  const recent = list.filter(x => new Date(x.startedAt).getTime() >= week);
  const stats = list.length ? `<div class="hstats">
    <div><b>${list.length}</b><span>Sessions</span></div>
    <div><b>${hmDur(list.reduce((t, x) => t + (x.ranSec || 0), 0))}</b><span>Total light time</span></div>
    <div><b>${recent.length}</b><span>Last 7 days</span></div>
    <div><b>${hmDur(recent.reduce((t, x) => t + (x.ranSec || 0), 0))}</b><span>Light time, last 7 days</span></div></div>` : "";
  const detail = x => {
    const bits = [];
    if (x.kind === "batch") bits.push(`${x.stagesRun} of ${x.stages.length} stages: ${x.stages.map(s => esc(base(s.name))).join(" → ")}`);
    const cp = x.stages.filter(s => s.coupling && s.startedAt && s.ranSec > s.coupling.startSec);   // only if the run reached it
    if (cp.length) bits.push(`coupling ${[...new Set(cp.map(s => s.coupling.freq))].join(", ")} Hz`);
    const sw = x.stages.filter(s => s.sweep && s.startedAt);
    if (sw.length) bits.push(sw.map(s => `${s.sweep.kind === "freq" ? "frequency" : "power"} sweep ${s.sweep.start}→${s.sweep.end}${s.sweep.unit === "%" ? "%" : " Hz"}`).join(", ") + (x.sweepLocked ? " (locked)" : ""));
    if (x.pauses) bits.push(`paused ${x.pauses}×`);
    bits.push(esc(x.how || ""));
    if (x.error) bits.push(esc(x.error));
    return bits.filter(Boolean).join(" · ");
  };
  const rows = list.map(x => {
    const known = DATA.single[x.name] || DATA.batch[x.name];
    const name = known ? `<a role="link" tabindex="0" style="cursor:pointer;color:inherit;text-decoration:underline;text-decoration-color:var(--line)" data-go="${esc(x.name)}" title="Open ${esc(x.name)}">${esc(base(x.name))}</a>` : esc(base(x.name));
    return `<tr><td style="white-space:nowrap">${esc(day(x.startedAt))}</td>
      <td class="mono" style="white-space:nowrap">${hhmm(x.startedAt)}–${hhmm(x.endedAt)}</td>
      <td><b>${name}</b>${x.dryRun ? ' <span class="mine-tag">dry run</span>' : ""}</td>
      <td class="mono" style="white-space:nowrap">${hmDur(x.ranSec)} / ${hmDur(x.plannedSec)}</td>
      <td><span class="oc ${esc(x.outcome)}">${OUTCOME[x.outcome] || esc(x.outcome)}</span></td>
      <td class="hint">${detail(x)}</td></tr>`;
  }).join("");
  return `<section class="card"><h2>History</h2>
    <p>Every protocol started from this app: when, for how long, and how it ended. Loading a protocol without pressing Run isn't counted, and dry runs aren't recorded.</p>
    ${stats}
    ${rows ? `<div class="tablewrap"><table class="imp"><thead><tr><th>Date</th><th>Time</th><th>Protocol</th><th>Ran / planned</th><th>Result</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="hint">No sessions yet. Each run is added here when it finishes or is stopped.</p>`}
    <p class="hint mono" style="margin-top:12px">${esc(h.file)}</p>
  </section>`;
}

/* ---------- Routing ---------- */
let current = "";
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  draft = null; current = "";
  let html;
  if (h === "import") html = IMPORT ? renderImport() : renderHome();
  else if (h === "backups") { html = renderBackups(); refreshBackups(); }
  else if (h === "history") { html = renderHistory(); refreshHistory(); }
  else if (h === "new-single") html = openEditor({ kind: "single", mode: "new" });
  else if (h === "new-batch") html = openEditor({ kind: "batch", mode: "new" });
  else if (/^(edit|copy)\//.test(h)) {
    const n = h.slice(5);
    html = openEditor({ kind: DATA.batch[n] ? "batch" : "single", mode: h.startsWith("edit/") ? "overwrite" : "new", from: n });
  } else {
    current = DATA.single[h] || DATA.batch[h] ? h : "";
    html = current === "" ? renderHome() : DATA.batch[current] ? renderBatch(current) : renderSingle(current);
  }
  $("#main").innerHTML = `<div class="page">${FLASH}${html}</div>`;
  FLASH = "";
  $("#main").scrollTop = 0;
  buildIndex();
  if (draft) bindEditor();
  document.title = draft ? `${draft.mode === "overwrite" ? "Edit" : "New"} · NP2 Protocol Explorer` : current ? `${base(current)} · NP2 Protocol Explorer` : "NP2 Protocol Explorer";
}
document.addEventListener("click", e => {
  const a = e.target.closest("[data-act]");
  if (a && !a.disabled) { e.preventDefault(); onAct(a.dataset.act, a); return; }
  const b = e.target.closest("[data-go]");
  if (!b || b.disabled) return;
  const go = b.dataset.go;
  const target = go.startsWith("#") ? go : go ? "#" + encodeURIComponent(go) : "";
  if (location.hash === target || (!target && !location.hash.slice(1))) route();
  else location.hash = target;
});
$("#q").addEventListener("input", buildIndex);

/* ---------- Run on NP2 (right-click a protocol, or its Run button) ---------- */
const ctx = $("#ctx");
const closeCtx = () => { ctx.hidden = true; };
document.addEventListener("contextmenu", e => {
  const it = e.target.closest("#index .item[data-go], .stage[data-go]");
  const name = it && it.dataset.go;
  if (!name || !(DATA.single[name] || DATA.batch[name])) { closeCtx(); return; }
  e.preventDefault();
  const why = runBlocked(name);
  ctx.innerHTML = `<button role="menuitem" data-run="${esc(name)}" ${why ? "disabled" : ""}>Run ${esc(base(name))} on NP2…</button>` +
    (why ? `<div class="why">${esc(why)}</div>` : "") + `<button role="menuitem" data-go="${esc(name)}">Show details</button>`;
  ctx.hidden = false;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(e.clientX, innerWidth - w - 8) + "px";
  ctx.style.top = Math.min(e.clientY, innerHeight - h - 8) + "px";
  const first = ctx.querySelector("button:not(:disabled)");
  if (first) first.focus();
});
document.addEventListener("click", e => {
  const r = e.target.closest("[data-run]");
  if (!ctx.contains(e.target) || r || e.target.closest("[data-go]")) closeCtx();
  if (r && !r.disabled) { e.preventDefault(); openRun(r.dataset.run); }
}, true);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeCtx(); });
window.addEventListener("blur", closeCtx);
$("#index").addEventListener("scroll", closeCtx);
window.addEventListener("hashchange", route);

(async function start() {
  // Show the last-seen files at once; switch to the device's live files when they arrive.
  renderConn();
  route();
  if (!HAS_BRIDGE) return;
  reloading = true;
  if (await loadLastSeen() && !draft) { route(); renderConn(); }
  pollStatus(); setInterval(pollStatus, 5000); setInterval(watchLists, 30000);
  if (await loadFiles(false) && !draft) route();
  reloading = false;
  renderConn();
})();
