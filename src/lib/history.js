// Undo/redo stacks of serializable design snapshots (spec §3.3).
// Pure factory — capture/apply/fingerprint are injected so node tests run
// without Three.js or the DOM. The app singleton is wired in src/app/boot.js.

export function createHistory({ capture, apply, fingerprint = JSON.stringify, cap = 50, onChange = () => {} }) {
  let past = [];      // oldest → newest
  let present = null; // snapshot matching what's on screen (null until seed/record)
  let future = [];    // redo stack, nearest last
  let busy = false;   // true while apply() replays — record() is a no-op

  const api = {
    get busy() { return busy; },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    // Baseline after model load / design load. Clears both stacks.
    seed() { present = capture(); past = []; future = []; onChange(api); },
    clear() { present = null; past = []; future = []; onChange(api); },
    // Call after each committed design edit.
    record() {
      if (busy) return;
      const snap = capture();
      if (present && fingerprint(snap) === fingerprint(present)) return;
      if (present) { past.push(present); if (past.length > cap) past.shift(); }
      present = snap; future = []; onChange(api);
    },
    async undo() {
      if (busy || !past.length) return;
      busy = true; onChange(api);
      try { future.push(present); present = past.pop(); await apply(present); }
      finally { busy = false; onChange(api); }
    },
    async redo() {
      if (busy || !future.length) return;
      busy = true; onChange(api);
      try { past.push(present); present = future.pop(); await apply(present); }
      finally { busy = false; onChange(api); }
    },
  };
  return api;
}
