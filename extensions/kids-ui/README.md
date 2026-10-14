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

The six `kids.activity.*` methods are `get`, `start`, `answer`, `hint`, `touch`,
and `image`. All accept the existing app `sessionKey`; Gateway session admission
selects the configured child. Snapshot responses contain only the current
question/options, a requested hint, progress, and opaque image references. Answer
keys and unrevealed explanations stay private. Correct answers advance the
question; incorrect answers stay on it. The answer response includes its feedback,
and a replay returns the same feedback with a fresh snapshot. This keeps devices
consistent without overwriting newer progress with an old response.

The pet becomes bored after 30 minutes and sleeps after two hours without a
meaningful interaction. Accepted chat/voice input, quiz answers, and hints update
the server clock; merely opening or starting an activity does not. Three
consecutive correctly solved questions earn two minutes of excitement. Hints
count toward that celebration, while evidence distinguishes first-try independent
work from help or corrections. Incorrect answers reset the streak and leave the
pet normal. Chat does not clear a streak or interrupt an ongoing celebration.
Mood is derived from saved timestamps, so no durable timers are necessary.

Each morning prepares one batch of exactly three three-question challenges per
child, with two shared daily pictures (normal and excited). Publication is atomic;
retries reuse the saved batch. The app shows one challenge. Completing it keeps
the result visible and offers `nextActivity`; only an explicit `start` advances.
After all three, `nextActivity` is null. A started incomplete challenge remains
resumable across midnight. Once it is finished, the first challenge of the newest
batch appears; yesterday's unstarted extras are no longer offered. `daily` counts
always describe the newest batch, so completing a carryover does not count toward
today's three. The current daily scene is independent of that retained quiz. Model or
image failure preserves the last complete bundle. Fixed bored/sleeping poses use
the agent's generated daily captions. Private image reads require the same
session authority, and no local paths enter browser responses. Generated art is
stored and served as PNG, preserving any provider alpha through the shared image
worker's bounded resizing. The plugin rejects output still exceeding 512 KiB;
compression never flattens it into JPEG. Prompts ask for an isolated pet and small
theme props, without a background, floor, or frame. Actual transparent generation
also requires support from the selected provider; the plugin does not change models.

The store retains 90 days by last activity update. It prunes whole day bundles
and protects a day containing the current unfinished challenge, keeping scene
metadata and all three immutable definitions together. Each activity retains full question counters and the latest
256 detailed attempts. Preparation reads at most 14 activities and 32 detailed
attempts each, reporting `activitiesOmitted` and `attemptsOmitted` explicitly.
Attempt IDs, actual attempt timestamps, selected answer text, hint status, and
completion timestamps let nightly profile/report jobs deduplicate real evidence
instead of treating the activity's publication date as its learning date. A
bounded prompt hook adds the current activity and recent evidence to the matching
tutor conversation and voice consultations with the same host-resolved memory
audience. It also defines help for unfinished activities: one small clue and a
pause for the child's attempt, without revealing the solution on the first help
turn. Previously revealed hints inform the next step; an explicit explanation
request or continued difficulty after a hint can receive a short worked example.
Only the app records quiz progress. Direct realtime small talk does not invoke
that hook.

Private preparation context also carries each recent day's `scenePrompt`, the
saved normal-scene creative plan (up to 3,000 characters). It preserves intended
themes and props across isolated preparation jobs; it is not evidence that every
planned detail appeared in the generated art. This text stays out of browser
snapshots and the per-turn tutor prompt.

Service shutdown closes admission, cancels and joins generation, joins accepted
requests, then closes the worker. A stop during startup joins the opening worker
and closes it without activating. Read responses and prompt enrichment recheck
caller lifetime after awaited work; mutations also recheck at commit. Restart
creates fresh ownership and retained callbacks from a retired service cannot
write through the new instance.
