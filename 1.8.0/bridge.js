"use strict";
/*
 * Browser version of the app's bridge (preload.js and run-preload.js in the Electron app). Each page gets the
 * same window.np2 / window.np2run calls, answered by the NP2 Link helper on this computer. The page never
 * talks to the NP2 itself: the helper checks and backs up every write.
 *
 * The things Electron did with its own windows (the run window, blackout, dark mode, file pickers) are done here
 * with the browser's own features.
 */
(function () {
  const TOKEN = (document.querySelector('meta[name="np2-token"]') || {}).content || "";
  const PAGE = location.pathname.split("/").pop() || "index.html";
  const DOWN = "The NP2 Link helper isn't answering. Make sure it's running, then reload this page.";

  function call(channel, args = [], { keepalive = false } = {}) {
    return fetch("/api/call", {
      method: "POST", keepalive, cache: "no-store",
      headers: { "Content-Type": "application/json", "X-NP2-Token": TOKEN },
      body: JSON.stringify({ channel, args }),
    }).then(r => r.json().catch(() => ({ ok: false, error: `The helper answered ${r.status}.` })),
      () => { throw new Error(DOWN); });
  }
  const ok = data => Promise.resolve({ ok: true, data });

  /* ---------- dark mode: shared by the app's pages in this browser ---------- */
  const DARK_KEY = "np2-dark";
  const store = {
    get: () => { try { return localStorage.getItem(DARK_KEY) === "1"; } catch { return false; } },
    set: on => { try { on ? localStorage.setItem(DARK_KEY, "1") : localStorage.removeItem(DARK_KEY); } catch { /* private mode */ } },
  };
  const applyDark = () => { if (PAGE !== "blackout.html") { if (store.get()) document.documentElement.setAttribute("data-theme", "dark"); else document.documentElement.removeAttribute("data-theme"); } };
  applyDark();
  addEventListener("storage", e => { if (e.key === DARK_KEY || e.key === null) applyDark(); });
  const setDark = on => { store.set(on); applyDark(); };

  /* ---------- the explorer page ---------- */
  if (PAGE === "index.html") {
    // The run window opens centered over this page (on whichever screen the page is on), 760 × 760 or smaller.
    function runFeatures() {
      const w = Math.min(760, outerWidth), h = Math.min(760, outerHeight);
      const left = Math.round(screenX + (outerWidth - w) / 2), top = Math.round(screenY + (outerHeight - h) / 2);
      return `popup,width=${w},height=${h},left=${left},top=${top}`;
    }
    let runWin = null;
    const runUrl = name => `run.html?t=${Date.now()}#${encodeURIComponent(name)}`;

    window.np2 = {
      web: true,
      info: () => call("np2:info"),
      status: () => call("np2:status"),
      files: refresh => call("np2:files", [refresh === true]),
      lastSeen: () => call("np2:lastSeen"),
      backups: () => call("np2:backups"),
      backupNow: () => call("np2:backupNow"),
      save: (kind, body) => call("np2:save", [kind, body]),
      remove: name => call("np2:delete", [name]),
      restorePlan: id => call("np2:restorePlan", [id]),
      restoreLists: id => call("np2:restoreLists", [id]),
      checkBackup: id => call("np2:checkBackup", [id]),
      restoreFiles: (id, names) => call("np2:restoreFiles", [id, names]),
      checkProgress: () => call("np2:checkProgress"),
      listsKey: () => call("np2:listsKey"),
      reconnectWifi: () => call("np2:wifi"),
      exportFiles: names => call("np2:export", [names]),
      history: () => call("np2:history"),
      chooseProject: () => call("np2:chooseProject"),
      quit: () => call("np2:quit"),

      // One run window at a time, since the controller runs one protocol at a time. The window is opened before
      // asking the helper, while the click still counts as the user's (otherwise the browser blocks the pop-up).
      async openRun(name) {
        if (typeof name !== "string" || !name) return { ok: false, error: "No protocol chosen." };
        const had = runWin && !runWin.closed;
        const w = had ? runWin : window.open("", "np2run", runFeatures());
        if (!w) return { ok: false, error: "The browser blocked the run window. Allow pop-ups for this page, then try again." };
        runWin = w;
        let blank = false;
        try { blank = w.location.href === "about:blank"; } catch { /* not ours yet */ }
        const r = await call("np2:openRun", [name]);
        if (!r.ok) { if (blank) w.close(); return r; }
        if (r.data.active && !blank) {
          w.focus();
          return { ok: true, data: { opened: false, busy: r.data.current !== name, current: r.data.current } };
        }
        w.location.href = runUrl(name);
        w.focus();
        return { ok: true, data: { opened: true } };
      },

      // Import step 1: the browser's own file picker. It must open during the click, so no waiting before it.
      pickImport() {
        return new Promise(resolve => {
          const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, accept: ".vnp0,.vnp4" });
          input.style.display = "none";
          document.body.appendChild(input);
          const finish = v => { input.remove(); resolve(v); };
          input.addEventListener("cancel", () => finish({ ok: true, data: { canceled: true } }));
          input.addEventListener("change", async () => {
            const picked = [...input.files];
            if (!picked.length) return finish({ ok: true, data: { canceled: true } });
            // Large files aren't read at all; the helper rejects them by size.
            const list = await Promise.all(picked.map(async f => ({ file: f.name, size: f.size, text: f.size > 65536 ? "" : await f.text() })));
            try { finish(await call("np2:parseImport", [list])); } catch (e) { finish({ ok: false, error: e.message }); }
          });
          input.click();
        });
      },
    };
  }

  /* ---------- the run window ---------- */
  if (PAGE === "run.html") {
    let last = null;   // the latest run state seen, for leaving the page
    const tracked = p => p.then(r => { if (r && r.ok && r.data && r.data.state) last = r.data.state; return r; });
    const run = ch => () => tracked(call(ch));

    let overlay = null;
    function endBlackout() {
      if (!overlay) return;
      const o = overlay; overlay = null;
      o.remove();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      focus();
    }
    // Blackout: the black page fills this window's screen. A click, any key, or leaving full screen lifts it.
    // (The Electron app could also black out other monitors; a browser can only cover the screen the run window is on.)
    function startBlackout() {
      if (overlay) return ok({ blackout: true });
      overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000";
      const frame = Object.assign(document.createElement("iframe"), { src: "blackout.html#main", title: "Blackout" });
      frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:#000";
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
      if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});
      frame.addEventListener("load", () => frame.contentWindow && frame.contentWindow.focus());
      return ok({ blackout: true });
    }
    document.addEventListener("DOMContentLoaded", () => {
      const b = document.getElementById("blackBtn");
      if (b) b.title = "Black out the screen this window is on, showing only a dim progress line. Click or press any key to come back.";
    });
    document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && overlay) endBlackout(); });
    addEventListener("message", e => { if (e.origin === location.origin && e.data === "np2:blackoutEnd") endBlackout(); });

    window.np2run = {
      load: name => tracked(call("np2run:load", [name])),
      start: run("np2run:start"),
      pause: run("np2run:pause"),
      resume: run("np2run:resume"),
      lock: run("np2run:lock"),
      stop: run("np2run:stop"),
      state: run("np2run:state"),
      // Dark mode switches every app page in this browser to the dark theme, until it's switched off or this window closes.
      darkMode: on => { if (typeof on === "boolean") setDark(on); return ok({ dark: store.get() }); },
      blackout: () => startBlackout(),
      blackoutEnd: () => { endBlackout(); return ok({ blackout: false }); },
    };

    // Closing the window: a running or paused protocol asks first (the browser shows its own question; the helper
    // keeps the run going either way). One that's only loaded is cleared, as the controller's own Exit button does.
    addEventListener("beforeunload", e => { if (last === "running" || last === "paused") { e.preventDefault(); e.returnValue = ""; } });
    addEventListener("pagehide", () => {
      if (last === "loaded" || last === "loading") call("np2run:stop", [], { keepalive: true }).catch(() => {});
      setDark(false);
    });
  }

  /* ---------- the blackout page (inside the run window) ---------- */
  if (PAGE === "blackout.html") {
    window.np2run = {
      state: () => call("np2run:state"),
      blackoutEnd: () => { if (parent !== window) parent.postMessage("np2:blackoutEnd", location.origin); return ok({ blackout: false }); },
    };
  }
})();
