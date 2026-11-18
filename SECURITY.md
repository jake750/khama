# Security · الأمان

## Reporting a vulnerability · الإبلاغ عن ثغرة

Please don't open a public issue. Use GitHub's private report instead: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/jake750/khama/security/advisories/new)).

Include the version (Settings → About), your system, and the steps or file that trigger it. You'll get a reply within a week. Fixed issues are credited in the release notes unless you'd rather not.

لا تفتح بلاغًا عامًا. استعمل البلاغ الخاص في GitHub: **Security ← Report a vulnerability** في هذا المستودع. اذكر النسخة ونظامك والخطوات أو الملف الذي يسبّبها، وسيصلك رد خلال أسبوع.

## Supported versions · النسخ المدعومة

Only the latest release gets fixes. Khama checks for updates on start (it can be turned off in Settings).

## Scope · النطاق

In scope: anything that lets a link, a downloaded file, a cookies file or a page make Khama run code, read or write files outside what you chose, or send your data somewhere.

Out of scope: bugs in yt-dlp or FFmpeg themselves (report them upstream; Khama ships updates for them), and what the sites you download from do.

How the app is locked down (content policy, file access, checksums) is in [docs/SECURITY.md](docs/SECURITY.md).
