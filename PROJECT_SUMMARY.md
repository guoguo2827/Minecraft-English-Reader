# Minecraft English Learning - Project Summary

## Product

The service contains two Minecraft-style language courses sharing one phone account:

- English Reader: 17 themes for Chinese-speaking learners.
- Chinese Reader: 10 themes and 210 words for English-speaking learners.
- Speaking Quest: 5 chapters and 100 English sentences, unlocked permanently after 80% of the English vocabulary is mastered.

Course progress, review queues and emerald rewards remain isolated. Existing users are preserved as founder-trial users during the public-beta migration.

## Architecture

- Runtime: Node.js 22+, Express 4, native HTML/CSS/JavaScript.
- Business database: SQLite at `data/app.db`, using WAL and `better-sqlite3`.
- Sessions: separate SQLite database at `data/sessions.db`.
- Reverse proxy: Nginx terminates HTTPS and proxies only to `127.0.0.1:3000`.
- Process manager: PM2 with `ecosystem.config.cjs`.
- TTS: authenticated Tencent Cloud TTS with canonical vocabulary validation, private file caching and rate limits.
- Speaking assessment: Tencent Cloud SOE-N sentence mode through a server-signed WSS connection. Browser PCM audio stays in memory and is never written to disk or the database.

## Public Beta Access

`users.status` still means `active/disabled`. Experience access uses separate fields:

- `founder_trial`: full primary-course access, no expiry.
- `free_trial`: 14-day access to selected themes.
- `expired`: progress and friends remain visible; study, quiz and TTS are blocked.

`ACCESS_CONTROL_ENFORCED=false` is the safe deployment default. It runs migrations and exposes inferred account data without locking courses. Enable it only after administrators verify existing users' primary courses.

## Social Features

Users can create a revocable referral link with a lifetime maximum of 20 approved friends. Referral registration creates a pending application. Approval creates the user, starts the 14-day trial and creates the friendship in one transaction.

Weekly PK uses primary-course emerald events from Monday 00:00 Asia/Shanghai. The joint challenge requires both friends to study three days and answer 30 questions; its 20-point bonus is stored separately and never changes either course's emerald balance.

## Data Safety

Migration `2026-08-09-public-beta-v1` only adds columns and tables. Existing progress, review, reward, whitelist and account rows are not moved or recalculated. All administrator account, whitelist, access, review and password-reset actions are logged with redacted details and hashed IP addresses for 90 days.

Migration `2026-08-10-admin-dashboard-v1` adds only the daily successful-login table and query indexes. Historical learning totals are calculated from the existing course tables; login users and login counts are explicitly tracked only from this migration's deployment date and are never backfilled.

The administrator workspace is split into overview, users and access, courses and learning, invitations and access, read-only social operations, and security logs. Its overview provides Beijing-time daily activity, seven-day trends, historical totals and operational reminders without changing course records.

Migration `2026-08-21-speaking-assessment-v1` adds only speaking eligibility, phrase progress, assessment attempts and speaking badge tables. Speaking scores and badges never write to either course's emerald reward tables. The service enforces 20 attempts per user per day, five attempts per phrase per day and a package reserve before opening a Tencent Cloud assessment connection.

Before every production update, stop the English PM2 process, run `deploy/backup-sqlite.sh`, verify the backup, pull code, install locked dependencies, run `npm run migrate`, then restart and smoke-test.
