# Accessibility · الوصول

## Review 2026-11-18 · مراجعة

Done on the interface in the browser preview (`npm run dev`), both languages, all four tabs, with an automated scan of every control plus keyboard-only use.

| Check | Result |
|---|---|
| Every button, link and field has an accessible name | ✓ after fixing the project name field (it had a placeholder only) |
| Images have `alt` (decorative ones empty) | ✓ |
| No positive `tabindex`, no duplicate IDs | ✓ |
| Page language and direction (`lang`, `dir`) follow the interface language | ✓ |
| One `h1`, headings in order | ✓ after making the app name the `h1` (there was none) |
| Visible focus on every control with the keyboard | ✓ (`:focus-visible` ring; segmented controls and tabs move it to their sliding pill) |
| Dialogs keep focus inside | ✓ after adding `src/focusTrap.ts`: Tab and Shift+Tab cycle inside the open dialog |
| Esc closes dialogs and menus | ✓ |
| Colour contrast of text and controls | ✓ WCAG AA, measured per token pair in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) |
| Reduced motion | ✓ animations shortened under `prefers-reduced-motion` |
| Messages announced | Toasts are a `role="status"` live region. Job card progress is not announced; a screen reader user moves to the card to hear it |

## Keyboard and contrast, 0.3.46 · لوحة المفاتيح والتباين

- Segmented controls: arrow keys move the choice (reversed in Arabic, so → always goes to the next item on screen), Home and End jump to the ends. Folder menu: focus starts on the first item, arrows/Home/End move, Esc returns focus to the button.
- Shortcuts: Ctrl+1…5 (Guide included), F1 Guide, Ctrl+Enter starts the download or conversion from anywhere, Ctrl+F or / searches the history, Esc clears the link or the search field. The list is under `?`.
- Toggles: the explanation is linked with `aria-describedby`, so it is no longer part of the switch's name. `Hint` sets `aria-controls` only while open.
- The tab bar has a name, and the "jobs running" dot has hidden text for screen readers; the window title shows overall progress and the tab name.
- Windows high contrast (`forced-colors`): buttons, the current tab, selected presets and segmented choices keep a border or the system highlight colour.
- Time fields say what is wrong (`aria-invalid` plus a message) instead of only turning red.

## Not yet checked · لم يُفحص بعد

- A full pass with a real screen reader (NVDA on Windows, VoiceOver on macOS, TalkBack on Android). Expect issues in the trim timeline, which is built for the mouse and arrow keys.
- axe-core in CI: needs a browser test runner, which the project doesn't have yet.

Repeat this review when a screen is added or redesigned, and record it here.
