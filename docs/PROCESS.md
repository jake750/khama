# How Khama is built · طريقة العمل

How the work is planned, done, checked and shipped. It started informally and changed after the first review (November 2026); this file is the agreed way from now on.

كيف يُخطَّط العمل ويُنفَّذ ويُفحص ويُنشر. بدأ بلا قواعد مكتوبة وتغيّر بعد المراجعة الأولى (نوفمبر 2026)، وهذا الملف هو الطريقة المتفق عليها من الآن.

## History in numbers · التاريخ بالأرقام

| | |
|---|---|
| First commit | 2026-11-07 |
| Phases 1–3 of the brief done | 2026-11-11 (0.2.0, 0.3.0) |
| Review and fixes | 2026-11-14 → 2026-11-18 (0.3.4 → 0.3.15) |
| Code today | ~27,600 lines (TypeScript, CSS, Rust), 240+ commits |
| Largest commits | 6,283 and 4,593 lines added (early feature drops) |

The first week moved fast: the three phases of the brief, then the converter, Android and Spotify, which the brief didn't ask for, landed within five days, several of them in very large commits. The review that followed found what that speed skipped: no written priorities or tests per phase, commits too large to review or revert, no record of decisions. The rules below are the answer. How the work was done and what tools helped (including AI assistance) is described by the author in the project report.

## Scope · النطاق

[PROJECT_BRIEF.md](../PROJECT_BRIEF.md) is the specification. It changes when the scope changes: anything added beyond it gets a line in its change log, with the reason, before work starts.

**Priorities (MoSCoW)** for the current version:

| Must | Should | Could | Won't (now) |
|---|---|---|---|
| Paste a link and download at the best quality on every system | Converter presets for editing and publishing | Watch folders | Bypassing DRM, paid or signed-in-only content |
| Clear errors in Arabic and English | Trim and clips before download | Spotify playlists | Accounts, cloud sync, analytics |
| Updating yt-dlp from inside the app | Editor-ready output (constant frame rate) | AI clean-up | Browser extension |
| Installers built by CI for every system | Subtitles, thumbnails, history, queue | Android app | iOS |

Every new feature request is placed in this table first. A "Could" doesn't start while a "Must" or "Should" has open bugs.

## Definition of done · متى تكون الميزة «مكتملة»

A change is done when all of these are true:

1. It does what its issue or item says, including the error and empty states.
2. Automated tests cover its logic (Vitest for the interface, `cargo test` for Rust), and every check in CI passes.
3. Every visible text is in both languages and follows [STYLE.md](STYLE.md); the layout works right-to-left, light and dark, and on a narrow window.
4. It was tried by hand on at least one desktop system (and on a phone if it touches Android), and the result is in the test log ([TESTING.md](TESTING.md)).
5. Docs are updated where they describe it (README for users; IPC, ERRORS, DATA for developers; DECISIONS if a choice was made).

## Commits · الالتزامات

- **One change per commit.** A feature, its tests and its text go together; a redesign, a new feature and a version bump don't. If the message needs "and" between unrelated things, split it.
- **The release is its own commit** ("الإصدار X.Y.Z"), made by `npm run release`.
- **Message**: a short title saying what changed, in the language of the person writing it, starting with the area (`المحوّل:`, `التنزيل:`, `CI:`, `docs:`), then the review IDs it closes in brackets. The body says *why* if it isn't obvious. This keeps the generated changelog readable without a strict Conventional Commits format.
- **CI fixes are reproduced first**: when a build fails on a system, reproduce it (locally or with a manual `workflow_dispatch` run of `build.yml`, which builds without releasing) before pushing guesses to `main`.

## Branches and review · الفروع والمراجعة

There is one maintainer, so changes go straight to `main` instead of through pull requests; a pull request with no second reviewer only adds waiting. What replaces review:

- the pre-commit hook and the CI checks on every push;
- releases are separate from pushes: `main` can have unreleased commits, and only `npm run release` ships them, after the checks pass;
- a review pass (by a person or a review tool) before each minor release, over everything since the last one;
- pull requests from contributors are reviewed and must pass CI ([CONTRIBUTING.md](../CONTRIBUTING.md)).

When a second regular contributor joins, `main` gets protection: pull requests required, CI must pass, no force-push.

## Phases and retrospectives · المراحل والمراجعة بعدها

Work is planned in phases (the brief's phases, then each minor release). Each phase has:

- **a plan**: what's in it, from the MoSCoW table, with a target date;
- **done means tested**: the release checklist in [TESTING.md](TESTING.md) passes before the next phase starts;
- **a short retrospective** in the table below: what worked, what didn't, what changes.

| Phase | Planned | Done | What worked | What didn't | Change |
|---|---|---|---|---|---|
| 1. Download basics | — | 2026-11-07 | Bundling the tools made the first run work everywhere | Phases 2 and 3 started the same day, before phase 1 was tested by hand on macOS and Linux; Linux CI fixed by trial (three commits) | Test before the next phase (definition of done) |
| 2. For editors | — | 2026-11-07 → 11 | Trim, queue, editor-ready output | Released together with a redesign in one commit | One change per commit |
| 3. Advanced + additions | — | 2026-11-07 → 11 | AI clean-up, Android | Scope grew past the brief without writing it down | Brief change log, MoSCoW |
| Review fixes | 2026-11-14 | 2026-11-18 | Item IDs in every commit, releases from CI only | 400+ items: too much at once | Review per minor release |

## Workload · عبء الصيانة

One person maintains ~27,600 lines on six platforms. To keep that possible:

- yt-dlp updates (the most frequent need) don't need a Khama release.
- A release costs one command; CI does the 40 minutes of building.
- The "Could" column stays small: a feature that needs regular attention on every platform needs a reason to exist.
- A rough budget per minor release: one day of manual testing across systems.

## Before a presentation · قبل العرض

Feature freeze one week before: fixes only. The demo runs on a published release at least two days old, on the machine that will be used, with the test files and links prepared offline as a fallback.
