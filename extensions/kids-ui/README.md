# Kids Tutor hosting

This optional, private plugin serves the minimal tutor app at `/kids/` on the
existing Gateway origin. It owns public static files from its adjacent
`assets/` directory, bounded private dictation, and optional saved daily activities.
Its manifest declares `kids_activity` for host discovery; the registered factory
exposes it only to configured background jobs. It does not replace
the Control UI, create child conversations, grant permissions, or handle credentials. The browser connects directly
to the Gateway's authenticated WebSocket; configured identity and agent policies
remain authoritative.

The Gateway plugin registry installs and removes the route with the plugin.
Static requests run independently with no retained mutable state or background work.
The public file-access SDK bounds each read to 8 MiB, enforces directory
containment, and closes file handles before the response. Only web asset types
are served; source maps, arbitrary JSON, and directory listings are unavailable.
HTML and unhashed assets use `no-store`; Vite assets with content hashes may be
cached immutably. Missing or unsafe assets return 404; a missing entry page
returns 503 with an installation message. A later request can recover after the
build is installed without retaining a failed read.

The kids frontend is an optional, separate build with Vite's base set to `/kids/`.
Vite writes `extensions/kids-ui/assets`; deployment copies that tree beside the
compiled bundled plugin at `dist/extensions/kids-ui/assets`. These generated
assets are intentionally absent from Git. Keep the Gateway and frontend on the
same reviewed source release and build identity.

## Recorded dictation

`kids.transcribe` accepts only `{ audioBase64, mimeType }` and returns `{ text }`.
It requires an authenticated connection and the existing `operator.talk` scope.
Its profile-independent registration is intentional: it processes only the
caller's uploaded recording and never selects, reads, or writes a user profile,
conversation, memory, or message. The browser owns inserting the result into an
editable draft; sending remains an explicit chat action.

The service admits one request per connection and at most four total. It accepts
canonical base64 containing at most 1 MiB of WebM, MP4, or Ogg audio. Each request
owns a mode-700 temporary directory and mode-600 recording, removed after the
configured media-understanding runtime settles. Provider selection, credentials,
transcription instructions, and fallback behavior remain with that runtime; the
plugin never calls a provider directly or changes configuration. Errors expose
fixed recovery instructions instead of provider details or recording contents.

Authority and service lifetime are checked after preparation and before invoking
the runtime and returning text. Disconnect or revocation discards the result.
Service shutdown closes admission and joins accepted work and file cleanup;
restart creates fresh capacity. The runtime receives a 30-second timeout hint.
Its configured per-model timeout and fallback behavior remain authoritative, so
this is not a total request deadline. The SDK cannot cancel an admitted provider
call; shutdown and file cleanup therefore wait for it to settle.

The static route uses `auth: "plugin"` because there is no private data in its
response. It is accessible wherever the Gateway HTTP listener is reachable;
deployment retains the existing Tailscale-only network boundary. Loading the
page grants no session access. Never embed a shared Gateway token or family
profile data in these files.

Browser push uses the Gateway's existing subscription owner. This fork admits
own-device registration and preferences with session scopes, while completion
delivery rechecks the paired device, current profile role, allowed agent, and
session ownership. The hosting plugin does not grant or proxy those scopes.
Creation-bound `current` cron completions can notify offline browsers through the
same owner. Configure challenge jobs to commit to the child's authenticated app
conversation; existing Slack-only jobs are not migrated by plugin installation.

## Deployment

Prepare the reviewed source release in an isolated checkout whose build outputs
are not used by a running Gateway. From that checkout's repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir ui exec vite build --config vite.kids.config.ts
mkdir -p dist/extensions/kids-ui/assets
cp -R extensions/kids-ui/assets/. dist/extensions/kids-ui/assets/
```

Build the Gateway first: the kids build validates and embeds its exact
`dist/build-info.json` identity. Keep the commit and build environment unchanged
through the build and copy steps. After rebuilding the Gateway, rebuild and copy
the kids assets again. Do all preparation in the isolated checkout; never rebuild
or copy build output into a checkout serving a running Gateway.

Deploy the complete matching Gateway installation tree through the host's normal
deployment workflow, including the full `dist` tree and copied kids assets. The
compiled plugin imports shared modules from the Gateway's `dist` root, so copying
only `dist/extensions/kids-ui` is not a standalone plugin installation. Linking
the source plugin is also unsupported here: its workspace SDK dependency resolves
outside the plugin root checked by the installer.

Once the matching Gateway tree is installed, enable its bundled plugin on the
Gateway host (this changes live configuration):

```sh
openclaw plugins enable kids-ui --accept-capabilities
```

Verify `/kids/` and the exact built assets it references. Retain the previous
complete Gateway installation for rollback; `openclaw plugins disable kids-ui`
removes the route without changing the Control UI.

Install the fork's Gateway changes before enabling notifications for restricted
profiles. Assign each child a verified individual identity and a role with
`sessions.others: "none"`, one allowed tutor agent, and only
`operator.sessions.write` plus `operator.talk`. The identity grant and role ceiling
must both allow those scopes. Do not add general read/write or administration.
The default unassigned role stays denied. Device pairing must approve the same
narrow scopes; existing devices may need a scope upgrade approved by the parent.
On iOS, install the page on the Home Screen before enabling browser push.

## Daily activities and pets

The optional `activities` configuration binds each child to one existing tutor
agent and app conversation. The plugin owns published quizzes, their grading and
learning evidence, daily pet scenes, and pet clocks. Both children share the
original Rocky mountain character and three fixed poses; there is no per-child
character choice. Each child's daily themes, progress, and private images remain
independent. Existing Gateway profile,
agent, and session participation policy remains the authority for access. No
Gateway/core changes or new child-visible sessions are required.

`@openclaw/kids-activity-contract` owns the public, data-only browser shapes.
The UI and plugin import that dependency-free workspace package; neither imports
the other's private implementation. `activity-contract.ts` keeps publication,
evidence, and binding shapes private to the plugin. `activity-service.ts`
owns one SQLite worker and up to 32 accepted operations. `activity-store.worker.ts`
is the sole database writer. It uses Kysely and synchronous transactions on the
worker, with host authorization after transaction entry and immediately before
commit. The database is private at
`<stateDir>/plugins/kids-ui/activities.sqlite`; schema admission rejects newer
versions. A committed write may outlive its response; callers retry the same
request ID to retrieve its outcome. The newest 512 request receipts per child are
retained, and a solved question cannot award progress again under a fresh ID.

The child-facing `kids.activity.*` methods are `get`, `start`, `answer`, `hint`,
`touch`, `continue`, and `image`. All accept the existing app `sessionKey`; Gateway session admission
selects the configured child. Snapshot responses contain only the current
question/options, a requested hint, progress, and opaque image references. Answer
keys, explanation rubrics, and unrevealed explanations stay private. Questions
declare `choice`, `numeric`, or `explanation`; submitted answers carry the same
kind. Correct answers advance the question; incorrect answers stay on it.
The answer response includes its feedback,
and a replay returns the same feedback with a fresh snapshot. This keeps devices
consistent without overwriting newer progress with an old response.

Choice and numeric answers are checked directly in the worker. Numbers accept a
signed integer, decimal (including `.5`), or fraction of signed integers such as
`3/4`, at most 40 characters; whitespace around the fraction slash is allowed.
Comparison uses exact integer ratios, without rounding tolerance, expression
evaluation, scientific notation, words, or units. The displayed unit sits outside
the answer input. Malformed numeric input asks for clarification without counting
a wrong attempt.

Explanation answers contain at most 600 characters. The service owns at most one
in-flight grading operation per child; identical retries join it and different
submissions are refused until it settles. A read-only preflight checks current progress
and committed receipts before inference. `activity-grading.ts` sends only the
question, private rubric, and answer to `api.runtime.llm.complete` using the
bound child's configured agent/model, low reasoning, and a fresh isolated runtime
with no supplied tools or conversation history. The SDK call has a 30-second
timeout and an advisory 256-token output cap. The plugin requires the operator's
`plugins.entries.kids-ui.llm.allowAgentIdOverride` grant; no model override is used.
Use a configured isolated runtime that enforces zero tools; the Agents API helper
exception does not satisfy that requirement.

The service joins the SDK's public completion promise. After timeout or abort,
the SDK may still own physical provider cleanup; that work cannot publish a late
grade into the activity database. The per-child limit bounds unsettled SDK
requests, not noncooperative provider cleanup owned by the host.

The model returns `correct`, `revise`, or `clarify` with a short child-facing
explanation. Missing/ambiguous reasoning without a wrong claim asks a neutral
clarification; it does not count wrong, clear a streak, or advance progress.
Clarification does not supply a conceptual hint. Provider failures, timeouts, or
malformed output reject without any learning verdict or receipt; retry uses the
same request ID. Before committing, the worker rereads current progress and the
host rechecks live authority. Hints used during inference therefore affect
independence, and a late grade cannot overwrite a different current question.
The submitted text, verdict, feedback, progress, pet clock, and receipt commit
together. Only graded attempts affect attempt counts; a separate submission
counter includes clarifications for accurate evidence omission counts.

The pet becomes bored after 30 minutes and sleeps after two hours without a
meaningful interaction. Accepted chat/voice input, quiz answers, and hints update
the server clock; merely opening or starting an activity does not. Three
consecutive correctly solved questions earn two minutes of excitement. Hints
count toward that celebration, while evidence distinguishes first-try independent
work from help or corrections. Incorrect answers reset the streak and leave the
pet normal. Chat does not clear a streak or interrupt an ongoing celebration.
Mood is derived from saved timestamps, so no durable timers are necessary.

Each morning prepares one ten-question daily goal per child (at least eight free
answers) and attempts four shared daily pictures (normal, excited, bored, sleeping).
Normal and excited are required; resting pictures can use fixed fallbacks.
Publication is atomic and immutable. Existing three-by-three days and parent
single-question practice retain their definitions and original scheduled count.

After the current batch, Keep going either starts an existing `nextActivity` or
requests `continue` with its completed predecessor ID. The service reads saved
results before inference, generates ten questions, then appends and starts one
successor atomically. A per-child in-flight operation joins concurrent requests
for the same predecessor; a unique child/date/ordinal prevents duplicate successors
across retries and service lifetimes. Recovery checks the saved successor before
spending again, even after request-receipt expiry. New publication rechecks the
local date and predecessor at commit; a call crossing midnight cannot add work to
yesterday. Failure leaves the completed recap available with Try again.

`activity-next-generation.ts` owns stateless prompt assembly and strict output
admission. It combines the daily `learningBrief` snapshot of profile/learning notes,
full preceding-batch evidence, up to fourteen bounded older activities, and an
optional text-only tail of the child's own canonical chat (at most forty messages
and 12,000 characters). That read explicitly requests `operator.sessions.read`;
the host retains the child's own-session boundary without requiring broad read
permissions. Conversation fills gaps since notes were updated, especially
read-only voice; it is unscored context, never another independent success.
Saved Talk turns retain both speakers; voice input has unspecified attribution
and tutor replies are teaching, so neither establishes independent child success.
Missing or truncated sources remain explicit coverage limits. The daily preparer
owns the brief; it is not a second editable profile. Nightly remains the sole
profile/recent-activity writer and deduplicates Solve attempts with linked chat help.

Generation uses the child's configured model through `runtime.llm.complete` in
isolated-agent-runtime mode,
with no tools, model override, new retained session, artwork or message delivery.
The service permits one outstanding generation per child, joining the SDK
completion promise before closing the database. The SDK can settle a timeout or
cancellation before physical provider cleanup; that remaining work is host-owned
and cannot publish a late batch. The provider timeout hint is ninety seconds,
with an advisory 8,192-token output budget. The caller/service signal and authority checks fence every publication.
One generation per child is admitted; a failed or invalid generation records no
learning result. The server assigns activity/question IDs and the shared validator
admits exactly ten questions with no more than two choice items.

A started incomplete activity remains resumable across midnight. Completing it
moves to the newest day's work; old unstarted extras are not offered. `daily`
contains only the newest day's originally scheduled work, including its
`questionTotal`. Extras never enlarge that goal. `extras` totals solved questions,
first-try correctness and hinted questions across all optional batches belonging
to that same prepared day, including partial work. Adding `daily` and `extras`
gives the day's overall results; selected-batch counters describe only that batch. Counters
use complete saved per-question progress, not truncated attempt history.
`firstTryCorrect` includes hinted first answers; `hintedQuestions` counts distinct
hinted questions. Clarification is ungraded. `correctStreak` remains the pet's
cross-day answer streak, not a daily best. The app labels a recap today only when
its date matches the local date.

`perfectDayStreak` is separate from that pet answer streak. A perfect local day
means every originally scheduled challenge is finished on its scheduled date,
with every question correct on its first graded attempt and no hint opened.
Clarifications are ungraded; corrected wrong answers and hinted answers cannot
make a perfect day. Optional practice batches neither earn nor break this
streak. The immutable scheduled count comes from the original published batch,
not a hardcoded number in the streak rules.

An incorrect graded answer or hint on today's scheduled work immediately resets
the perfect-day streak. A clean unfinished today keeps yesterday's streak until
local midnight; an unfinished or missing calendar day then breaks the chain.
Finishing a carryover never retroactively earns its old day. Reads derive expiry
from the server's configured local date without timers or writes. The worker
commits the compact checkpoint with progress, evidence and the receipt, so retries
cannot award twice and authority failure cannot leave a partial award.

The current daily scene is independent of that retained quiz. Model or
required-image failure preserves the last complete bundle. Resting pictures and
their daily captions are selected only for the child's current local date; without
a current batch, the fixed originals use timeless captions. Older saved batches
without daily resting art still use their fixed poses. Private image reads require the same
session authority, and no local paths enter browser responses. Generated art is
stored and served as PNG, preserving any provider alpha through the shared image
worker's bounded resizing. The plugin rejects output still exceeding 512 KiB;
compression never flattens it into JPEG. Prompts preserve Rocky's anatomy, colors
and clay material while allowing contextual activities, costumes, expressions and
whole-body poses. The planner prioritizes recent conversation and dated school
context maintained in the child's profile, with established interests or seasonal
ideas as a fallback. It can revisit a relevant topic through a fresh moment rather
than forcing a new theme. All three mood variations reference the exact daily normal
image. The excited image continues the normal image's theme, outfit
and core equipment with a distinct action and silhouette; its composition can
change. Resting poses preserve the theme and outfit while showing comfortable
daydreaming or sleep. All remain isolated cutouts with only necessary equipment and small
props or action cues, without a background, floor, or frame. Actual transparent generation
also requires support from the selected provider; the plugin does not change models.

The optional rest-render phase runs both moods concurrently for at most three
minutes, ending no later than nine minutes after preparation starts. If required
work already used that window, both resting pictures use fixed fallbacks. At that
deadline, the owner freezes completed results and publishes once; late results
cannot write files or change the saved scene. It still joins admitted provider
calls before the tool settles or shutdown completes, so challenges can become
ready before the preparation tool returns. Provider timeouts and fallback chains
remain provider-owned; the existing ten-minute tool watchdog is not a guarantee
that all cleanup ends within ten minutes. Required work can itself overrun that
budget, and authority loss always prevents subsequent publication.

Daily resting IDs live in an optional private `restImages` field beside the
existing `stateText` captions. Resting art alone remains an optional JSON field;
older saved days without it remain readable. Browser
responses retain the existing selected `pet.image` contract. Refresh the daily
preparation prompt with this release to supply both resting scene directions.

Adaptive batches reuse schema 3 without migration. New days store one required
activity containing ten questions; older required counts and definitions remain
unchanged. The private optional `learningBrief` field is required for new daily
publication but absent on old saved days, where generation adapts conservatively
from saved results.

Schema 3 adds `kids_day.required_count` and the `kids_pet.perfect_day_streak` /
`last_perfect_date` checkpoint. The existing database, worker, authority and
transaction remain the owners. Schema-1 upgrades first migrate old choice kinds,
attempt evidence and request receipts; schema-2 progress, definitions, receipts,
images, timestamps and pet clocks remain byte-for-byte unchanged. Shipped older
schemas always had three scheduled activities, so admission backfills that count;
new publication saves the actual bundle length.

Admission seeds the day checkpoint once from retained question counters and
completion timestamps in each configured child's timezone. Its initial tracking
baseline is the oldest retained day; already-pruned days receive no inferred
credit. Missing days, hinted or retried work, and late completion break the seeded
chain. An unconfigured stored child keeps all data with a zero initial checkpoint.
After migration, the compact streak survives the 90-day history cleanup and
restarts without recomputing history. Schema migration is atomic; a failure leaves
the prior version intact and prevents service activation.

Take a coordinated SQLite backup before deployment. Older plugin binaries refuse
schema 3. To roll back to schema 2 without losing new quiz work: stop the writer,
back up the latest database, work on a consolidated copy, verify every
`required_count` is still 3, drop only the three additive columns, set
`PRAGMA user_version = 2`, and verify integrity before replacing the stopped
writer's database and starting the old release. This discards only perfect-day
tracking. If required counts differ, that downgrade is incompatible and must not
proceed. Restoring a pre-upgrade backup is an alternative but loses later work;
never restore automatically after a failed activation.

A parent can call `kids.activity.offerPractice` with `{sessionKey,date,activity}`
for one optional, one-question practice activity after today's scheduled goal
is complete, before any optional batch has been appended. It requires `operator.admin` **and** prepared session write access
for the configured child; the child's own-session scope cannot call it. The host
requires all session-resource descriptors to declare `operator.write`, so the
request-bound assertion additionally checks the authenticated connection's admin
scope at entry, after awaits and at worker commit. `activity`
uses the same bounded private definition schema (including the grading answer or
rubric) as daily preparation, with exactly one question. The store admits at most
one extra per child/local date in its existing transaction, returns
`{published,snapshot}`, and leaves all previous rows, artwork, receipts, selected
activity and pet clocks untouched. The activity appears through the existing
`nextActivity`/explicit start flow; foreground app polling refreshes within 15
seconds. It sends no chat or push notification.

Retry an uncertain offer with the same ID, date and complete definition. Exact
replays return `published:false` with current state, even after the question has
been answered or the local day changes; changed content under that ID is rejected.
A fresh offer for any date except the child's current local date is rejected.
Optional practice uses normal grading, evidence, carryover and retention: a started
unfinished question carries over; an unstarted one stops being offered when a newer
daily batch appears. The preparation lookup still returns only the original scheduled
activities, while snapshots and learning evidence include practice. This adds no
schema version, migration, timer, worker or privileged browser capability.

The store retains 90 days by last activity update. It prunes whole day bundles
and protects a day containing the current unfinished challenge, keeping scene
metadata and every immutable definition together. Each activity retains full question counters and the latest
256 detailed attempts. Preparation reads at most 14 activities and 32 detailed
attempts each, reporting `activitiesOmitted` and `attemptsOmitted` explicitly.
Attempt IDs, actual attempt timestamps, selected answer text, hint status, and
completion timestamps let nightly profile/report jobs deduplicate real evidence
instead of treating the activity's publication date as its learning date. A
bounded prompt hook adds the current activity, counters, and the last two submitted
answers/feedback from each of at most three recent activities to the matching
tutor conversation and voice consultations with the same host-resolved memory
audience. It also defines help for unfinished activities: one small clue and a
pause for the child's attempt, without revealing the solution on the first help
turn. Previously revealed hints inform the next step; an explicit explanation
request or continued difficulty after a hint can receive a short worked example.
Only the app records quiz progress. Direct realtime small talk does not invoke
that hook.

Private preparation context also carries each recent day's `scenePrompt`, the
saved normal-scene creative plan (up to 3,000 characters). It preserves intended
themes, actions, outfits and compositions across isolated preparation jobs so the
planner can vary more than props; it is not evidence that every
planned detail appeared in the generated art. This text stays out of browser
snapshots and the per-turn tutor prompt.

Service shutdown closes admission, aborts grading, cancels and joins generation, joins accepted
requests, then closes the worker. A stop during startup joins the opening worker
and closes it without activating. Read responses and prompt enrichment recheck
caller lifetime after awaited work; mutations also recheck at commit. Restart
creates fresh ownership and retained callbacks from a retired service cannot
write through the new instance.
