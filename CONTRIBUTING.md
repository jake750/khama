# Contributing · المساهمة

Thanks for helping. Bug reports with the details the form asks for are the most useful thing you can send.

شكرًا لمساعدتك. البلاغ الذي فيه التفاصيل التي يطلبها النموذج هو أنفع ما يمكن إرساله.

## Reporting a problem · الإبلاغ عن مشكلة

Use **Issues → New issue** and pick the form. For a download that fails, first update yt-dlp (Settings → Tools): most failures are a site change that a newer yt-dlp already fixes. Security problems go through [SECURITY.md](SECURITY.md), not issues.

## Changing the code · تعديل الكود

1. Set up the project: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
2. Keep a change to one thing. Explain the why in the commit message.
3. Before pushing, these must pass (the pre-commit hook runs the quick ones):

```bash
npx tsc --noEmit && npx eslint src && npx vitest run && npx prettier -l src
```

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo test -q --manifest-path src-tauri/Cargo.toml
```

4. Any text you add goes in both languages in `src/i18n.ts`, following [docs/STYLE.md](docs/STYLE.md).
5. New commands or events between the interface and Rust: update [docs/IPC.md](docs/IPC.md). New error codes: [docs/ERRORS.md](docs/ERRORS.md).
6. Interface changes: check both languages (right-to-left too), light and dark, and a narrow window. Add a screenshot to the pull request.

## Not accepted · ما لا يُقبل

- Ways around DRM or paid content.
- Tracking, analytics or ads.
- A new dependency without a reason it can't be done in a few lines ([docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)).

By contributing you agree your work is released under the project's license ([LICENSE](LICENSE)).
