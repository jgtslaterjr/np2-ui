
"use strict";
const MAIN = location.hash === "#main";
const STATE = { idle: "Standby", loading: "Loading", loaded: "Ready", running: "Running", paused: "Paused", ended: "Finished", stopped: "Stopped", failed: "Couldn't run" };
const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
const line = document.getElementById("line"), sub = document.getElementById("sub");

let leaving = false;
function leave() { if (leaving) return; leaving = true; window.np2run.blackoutEnd(); }
// Ignore input for a moment, so the click that opened the blackout doesn't close it.
setTimeout(() => {
  addEventListener("mousedown", leave);
  addEventListener("keydown", e => { e.preventDefault(); leave(); });
}, 600);

// Same progress as the run window: earlier stages in full, the current one by its clock.
function show(S) {
  const cur = S.current, st = S.state;
  const stages = S.stages && S.stages.length ? S.stages : (cur ? [{ totalSec: cur.totalSec }] : []);
  const all = stages.reduce((t, s) => t + (s.totalSec || 0), 0);
  const el = cur ? (st === "ended" ? cur.totalSec : cur.elapsedSec) : 0;
  const done = st === "ended" ? all : stages.slice(0, S.stage).reduce((t, s) => t + (s.totalSec || 0), 0) + el;
  const parts = [STATE[st] || st];
  if (all) parts.push(`${Math.min(100, Math.floor(done / all * 100))}%`, `${clock(all - done)} left`);
  line.textContent = parts.join(" · ");
}

if (MAIN) {
  line.hidden = false; sub.hidden = false;
  setTimeout(() => sub.classList.add("gone"), 4000);
  const poll = async () => { try { const r = await window.np2run.state(); if (r.ok) show(r.data); } catch { /* next tick */ } };
  poll(); setInterval(poll, 2000);
}
