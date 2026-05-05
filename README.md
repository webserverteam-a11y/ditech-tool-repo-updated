# Ditech CRM — Bundle Fixes (V5.1)

This repo is the **Ditech CRM tool** with two sets of fixes applied to the committed frontend bundle:

- **V5 (B1 + B2)**: Timer race fix — eliminates timer rollback when switching tabs fast, prevents concurrent users from silently overwriting each other's clicks.
- **Pass A**: Department-based dept gating on Action Board Pause/End/Resume buttons. Only users whose role matches the task's department (or admin) can click these buttons.

## Bugs fixed

### Timer race (V5)
- Timer rolling back to "Start" (00:00:00) after clicking Start and switching tabs fast
- Concurrent users silently overwriting each other's clicks
- Assignments/doc attachments occasionally not persisting

### Button dept gating (Pass A)
- Pause button was clickable by any user regardless of department → users of the wrong team could pause tasks they weren't assigned to
- Same issue for End Task and Resume buttons
- Only Start already had dept gating — now all timer buttons in Action Board do

## What's applied

| # | Fix | Layer |
|---|---|---|
| B1a | `_pendingSaves` tracker on `_saveTaskById` | internal state |
| B1b | `P()` flush handler skips bulk PUT if single-saves pending | flush behavior |
| B2 | Bulk-save debounce 150ms → 1200ms, skip A0 if pending | debounce timing |
| A1 | Icon variant In Progress block (Pause + End) wrapped in IIFE with `canAct` | JSX |
| A2 | Icon variant Paused block (Resume + End) wrapped in IIFE with `canAct` | JSX |
| A3 | Labeled variant In Progress block (Pause + End) wrapped in IIFE with `canAct` | JSX |
| A4 | Labeled variant Paused block (Resume + End) wrapped in IIFE with `canAct` | JSX |

Marker: `BUNDLE_FIXES_V5_1_APPLIED` — grep the bundle to verify.

## How Pass A works (and why it's safe)

The pristine Start button already had the correct IIFE pattern:

```js
(u.executionState === "Not Started") && (() => {
  const userDept = (i?.role === "content") ? "Content"
                 : (i?.role === "web")     ? "Web"
                 : "SEO";
  const canStart = g || u.currentOwner === userDept;
  return <button disabled={!canStart} onClick={() => canStart && Te(...)}>...</button>
})()
```

Pass A mirrors this pattern exactly for Pause/End (In Progress block) and Resume/End (Paused block), in both icon and labeled layouts. `canAct` is computed inside each IIFE — no dependency on outer scope, no shared helpers, no handler-level guards. This is the safe approach that `canStart` already proved works.

When a user of the wrong department is viewing a task:
- Buttons render greyed-out (slate colors, `cursor-not-allowed`)
- Buttons are `disabled={!canAct}` — clicks are blocked at the DOM level
- `onClick` has `canAct &&` guard as belt-and-suspenders
- Labeled variant shows "(SEO)" / "(Content)" / "(Web)" hint text
- Hover tooltip says "This task is currently with the X team"

## What's deliberately NOT in this patch (learned from V3/V4)

- **No `executionState` rank logic** — V3 used rank to protect state during merges. This broke legitimate state transitions (resuming a paused task). Pristine merge behavior (timeEvents-only) is preserved.
- **No visibilitychange merge changes** — same rank problem would have broken tab-return refetch.
- **No handler-level guards in Te/Qe/Xe** — V4 did this and crashed because the user variable (`i`, `g`) wasn't always what it needed to be. Pass A only touches button JSX.
- **No `_canUserAct` or `_deptBlockedToast` helpers** — V4 injected these globally and they conflicted with the bundle's existing variable scoping. Pass A uses only inline `canAct` inside IIFEs.
- **WorkHub panels not touched** — Pass A is Action Board only. SEO WorkHub and Non-SEO WorkHub use different handlers (`Qe`, `Xe`) with different scoping rules. Those panels can be addressed in a later patch.

## Upgrade path

The patcher is upgrade-safe:
- V5.1 marker present → exits with "Already patched"
- V5 marker present (B1+B2 only) → applies only Pass A + upgrades marker to V5.1
- No marker → applies all 7 fixes (B1a, B2, B1b, A1-A4)

## Manual re-apply

```bash
npm run patch-bundle
```

## Rollback

Each run creates a timestamped backup (e.g. `dist/assets/index-xUiSJVv5.js.bak-2026-04-18T03-55`). To roll back:

```bash
cp dist/assets/index-xUiSJVv5.js.bak-<timestamp> dist/assets/index-xUiSJVv5.js
```

Backups are gitignored.

## Local development

```bash
npm install          # postinstall auto-applies the patcher
cp .env.example .env # edit with your DB creds
npm start
```

## Deploying to Hostinger

```bash
git add .
git commit -m "V5.1: timer race fix + Action Board dept gating"
git push
```

Hostinger auto-deploys. Users hard-refresh (Ctrl+Shift+R / Cmd+Shift+R) once to bypass browser cache.

## Known remaining issues (out of V5.1 scope)

- **WorkHub dept gating** — not applied; use separate patch later
- **Keyword panel typing bug** — inline-edit inputs lose focus after one character (not fixed in V5.1)
- **Missing Upload CSV button** in Keywords panel (not fixed in V5.1)
- **Server-side `task_time_events` race** — theoretical, low impact

Those three are independent and safe to address in a follow-up patch once V5.1 is verified stable in production.
