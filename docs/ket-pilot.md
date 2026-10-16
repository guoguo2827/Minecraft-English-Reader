# KET1500: 100-word pilot

## Delivery and content review

The feature implements the first 100-word pilot, not the full 1,500-word course.
The UI shows the target and actual published denominator separately. There are
10 units of 10 stable-ID entries. UK/US variants share an entry. Source reference:
https://www.cambridgeenglish.org/images/506886-a2-key-2020-vocabulary-list.pdf

The examples and translations are original project copy. Graphics are local,
unmodified Twemoji 14.0.2 PNGs under CC-BY 4.0; attribution is visible on the page
and in outputs/ket-assets/ATTRIBUTION.md. They are illustrative symbols, not
licensed textbook scans. Field/ID/asset checks are automated; a teacher should
review meanings, pictures, example pronunciation and age appropriateness before
opening the feature to learners. Do not claim Cambridge endorsement or complete
exam coverage. The other 1,400 entries are deliberately not fabricated.

To expand, append reviewed units to lib/ket-content.js, retain existing IDs,
increment entry/content versions, and run content and asset checks. Do not remove
or rename IDs that have learner data. Update copies without replacing IDs.

## Integration and behavior

- /ket is authenticated and opens learning immediately, resuming an unfinished
  session or creating today's next group. Legacy #home maps to #study. The route,
  word library, progress and daily goal live in a persistent desktop sidebar or
  a dismissible mobile drawer. Explicit #library/#progress links remain usable.
  Opening the drawer cancels pending speech/advance timers; returning resumes
  the saved question. It reuses existing Express accounts and Tencent TTS.
- KET_ACCESS=admin (default) previews with admins; full enables eligible English
  users; off blocks learning APIs without deleting progress. Free trials get the
  first two units. Founder/full-English users get all published units. Existing
  founder access has no expiry, matching the current account model.
- Five additive ket_* tables are independent of existing progress, mistakes,
  rewards, friendships and speaking data. No previous mastery is imported.
- ts-fsrs 5.4.2 (MIT) schedules recognition and listening independently, using
  default model weights, 0.9 retention and day-level scheduling. Group retries
  are separate; no personalized weight training is performed.
- Formal new-word quota defaults to 5 (options 10/15). Starting a group reserves
  its words, preventing parallel devices from exceeding the quota. Up to five
  new words / ten initial questions per group; wrong-answer repairs may extend
  it. A single active session is resumed before any new/free session is created.
- Wrong answers insert a retry after three other questions, or at the tail when
  fewer remain. These repairs and free practice do not advance FSRS or mastery.
- Mastery requires each skill to succeed on two distinct dates, at least three
  practice dates in total, and a successful check seven days or more after first
  contact (the clock alone never promotes a word). A formal
  later error makes the word need consolidation; both skills must succeed after
  the failure to restore mastery. Previously mastered timestamps remain stored.
- Contact, current mastery, historical mastery, due review, first-attempt
  accuracy, repairs and free practice are distinct. KET never issues emeralds.
- Natural days use Asia/Shanghai; timestamps use UTC. Audio is authenticated,
  limited to curated word/example IDs and uses the shared server cache. There is
  no browser-system-voice fallback and no recording or assessment endpoint.

## Interfaces

- GET /api/ket/catalog, /report, /sessions/:id
- POST /api/ket/settings {dailyNew:5|10|15}
- POST /api/ket/sessions {mode:"formal"|"free",unitId?}
- POST /api/ket/exposure {wordId}
- POST /api/ket/answer {sessionId,questionId,selected?,reveal?:boolean}
- POST /api/ket/next {sessionId,questionId}
- GET /api/ket/audio/:id?part=word|example
- GET /api/admin/ket-summary?page=1&phone=... and /ket-users/:id

Answers are transactionally idempotent by question ID; mismatched replays return
409. A replayed next request returns the current question instead of skipping.
Sessions are owned by the authenticated user, and every route rechecks access.
An audio failure only changes voice status. A failed answer stays unconfirmed;
retry retains the original selection. Reconnection reloads committed state.

## Validation

Run npm ci, npm run check, node scripts/verify-ket-ui.js. UI tests use a temporary
database and mocked unavailable audio, never real children or paid TTS calls.
On Windows the script uses installed Edge; on other systems install Playwright
Chromium first. Screenshots are in ignored work/ket-qa. It checks 320x568,
360x800, 390x844, 430x932, 1024x768 and 1440x900 layouts and interaction recovery.
Actual iPhone/iPad Safari, Huawei WebView and Android app tests, real Tencent audio
quality, and teacher content approval are release gates, not covered by emulation.

For an isolated local preview: node scripts/preview-ket.js. It binds loopback
port 3010, writes only work/ket-preview, and prints a numeric local-only account.
Never deploy its credentials or preview script as the production process.

## Deployment and rollback

Do not deploy automatically. Back up data/app.db with SQLite's .backup command
and check the backup integrity before applying migrations. Preserve .env and
the existing PM2 ecosystem configuration. Install locked dependencies, run
npm run migrate, then restart the existing process with KET_ACCESS=admin.
Validate login, original courses, rewards, friends, speaking and admin reporting
before setting KET_ACCESS=full. Set KET_ACCESS=off and restart to disable KET;
keep the additive tables when reverting code, and do not restore an old live DB
over newer user activity.

The dependency audit at implementation time reports four existing advisories
in Express's dependency tree (proxy-addr critical; qs/body-parser/express
moderate), not in ts-fsrs. They were not auto-upgraded in this feature change;
review and patch these separately before public production rollout.
