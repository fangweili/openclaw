# Rocky for kids

This separate frontend opens one child's verified tutor conversation. V1 includes
text, photos, short videos, voice dictation, live voice, and private notifications.
**Today** is the home screen: Rocky, **Chat with Rocky**, and a two-by-two grid
of **Solve**, **Practice**, **Create**, and **Finish**. Chat and Solve are active;
the other three are native disabled choices labeled **Coming later**. The home
heading is **What shall we do, [child name]?**, centered above Rocky and the cards.
The name comes only from the verified conversation; an empty name uses
**What shall we do?**. There is no header or subtitle. Solve offers saved choice,
numeric and short explanation questions. The server alone grades them. Landscape
tablets place Rocky left of the choices or challenge; portrait and small screens
stack them. Today and Solve share the same art and panel anchors, sizes, column
alignment and top row. Today fills that row with its greeting; Solve reserves it
for the floating navigation. The content below may grow without moving the frame.
Phones reserve two heading lines; unusually long names may still wrap further.
The existing answer-editing layout continues to make room for the keyboard.

Compact floating **Today** controls return home from Chat or Solve; each scroller
reserves their safe-area top inset so initial content stays clear. **Talk it
through** records the current hint before placing the question into the existing
chat draft. Chat entered from
Solve offers **Back to Solve**. Unsent text, attachments, quiz feedback and native
home/Solve scroll positions survive these page changes; the transcript's existing
scroll owner preserves the Chat reading position. The old tabs and header flight
animation are removed. The pet's gentle mood animation still respects reduced motion.

During a live or finishing voice call, or dictation awaiting microphone permission,
recording, or finishing transcription, the originating Chat or Solve controls
remain visible and navigation away is disabled with an accessible explanation.
One dictation owner serves both surfaces, and live voice cannot overlap it.
Connection, reply and voice status remains in a persistent live region inside
Chat. Connecting is visible; the other status text is screen-reader-only because
the reply, call or error already has a visible presentation.

The URL fragment is the only page preference: **#today**, **#solve**, or **#chat**.
Reloading restores that presentation after authentication. Missing or unknown
fragments start at Today; a deployment without activities stays Chat-only. A cold
Home Screen launch using the manifest's plain start URL starts at Today rather
than remembering a previous closed window. These fragments never select a child,
tutor, conversation or quiz ID. No new local preference store is created.
Family messages and groups are deferred. There is no agent/model picker, session list, administrative navigation,
tool output, reasoning display, or intermediate assistant commentary. Text shows
the child's messages and finished assistant replies; voice shows spoken captions.
Bubble alignment identifies the speaker without repeated visible names. Photo and
video previews omit filenames; accessible speaker and media labels remain available
to screen readers.

## Ownership and trust

- `app.ts` owns the document, same-origin Gateway client, and the
  lifetime of its conversation, draft, media, voice, and notification owners. Reconnect fences
  callbacks, retires microphone work, then admits the next authenticated context.
  It starts and disposes the document's touch-gesture owner with the app.
  It also owns the URL page projection and hash/worker-message listeners. Known
  fragments pass the same parser for reload, hash navigation and same-origin
  worker messages. Microphone guards reject leaving the recording surface and restore its URL.
  Disposal removes these listeners before retiring conversation resources.
  It also binds the activity projection to the admitted physical conversation.
  Today and activity requests are enabled only when the current connection
  advertises the optional `kids.activity.get` capability; otherwise the app stays
  chat-only. Reconnect clears and re-evaluates this capability.
  Only accepted text and final user voice turns record pet interaction; opening
  the page, tab changes, scrolling, and assistant messages do not.
  A retained draft stays hidden until that conversation is ready again; binding a
  different verified profile or backing session binds a separate draft.
  It identifies as the canonical WebChat UI, requiring an approved signed browser
  device even when Tailscale authenticates the person. The Control UI's Tailscale
  pairing bypass cannot establish the durable device authority used by Web Push.
- `activity.ts` owns a bounded memory-only copy of the plugin's current activity,
  one bounded answer draft, one submitted-question context with its answer and
  original heading, one uncertain operation, and one pet
  object URL. The plugin alone owns durable progress, grading, clocks and streaks.
  Quiz operations serialize with reads; ambiguous failures retain their exact
  request ID for an explicit retry. Reconnect clears all private presentation and
  can recover that retry only after the same backing session is verified. A new
  backing session discards it. The app polls every 15 seconds while foregrounded
  on every page so Rocky stays current; hiding the page, disconnecting,
  or disposing stops its timer. Opening Chat or Today never wakes the pet.
  Entering Solve also requests fresh progress through that same serialized owner.
  Media bytes use the authenticated `kids.activity.image` RPC, never public paths.
  State and image completions are generation-fenced; disposal revokes the URL and
  joins admitted requests before the app closes its transport.
- `home-view.ts` renders only the accepted home choices and emits page intentions.
  `pet-view.ts` shares the activity owner's admitted art and caption between home
  and Solve without another request, URL owner, or interaction write. Both panels
  stay mounted but hidden when inactive, preserving their native scroll positions;
  loss of conversation admission removes both private panels immediately.
- `activity-view.ts` renders the server-selected quiz and feedback.
  `answer-view.ts` renders numeric or explanation input with an explicit **Check
  answer** action. Numeric text input allows negative values and fractions, with
  units outside the field; explanation input accepts up to 600 characters. Numeric
  input accepts up to 40. Both use the shared server admission bounds. Oversized
  dictated text shows a visible error and preserves the previous answer.
  **Say it** edits the captured question draft and never submits it. The app
  cancels that recording if its activity/question changes; late callbacks cannot
  populate Chat or the next question. Focusing an answer hides Rocky to leave room. The activity owner keeps one
  presentation editing flag across ordinary blur, so pointer-down cannot move a
  Check/Say it target before pointer-up. Check admission, dictation start,
  navigation, Continue, question changes and binding retirement clear it. It is
  neither persisted nor part of grading.
  Drafts survive navigation and ordinary polling in the same binding, but are
  memory-only and clear on question changes, disconnect and reload. An uncertain
  submitted answer retains its original ID and text through same-session reconnect.
  The answer stays visible during checking, transport errors and feedback.
  Clarify/revise results keep it editable; editing retires that feedback and the
  next explicit submission gets a new ID. Correct feedback waits for Continue.
  Neither the view nor the draft owner evaluates correctness or advances progress.
  Hints and answers never grade locally, and reads contain no unearned answer keys.
  Feedback keeps the submitted question's heading until **Continue**, including
  when finishing yesterday's quiz reveals today's invitation on the server.
  Progress is hidden during feedback; Continue displays the latest server snapshot.
  Daily counts describe the latest prepared batch, separately from question progress.
  Completing a challenge offers **Another challenge** or **Chat with Rocky**;
  all three finished shows **All done for today**. Extra challenges are optional.
  Reading never advances the selected challenge: starting the advertised next ID
  uses the same serialized, idempotent start operation. A started unfinished
  challenge carries into the next day, while unopened extras are replaced by the
  new daily batch. The plugin owns selection and carryover; the UI renders its facts.
  A wrong answer offers a friendly retry. **Talk it through** first records a hint
  so future correctness is accurately marked assisted, then appends that same
  question and an explicit request for one small hint to the existing draft for
  review. The request asks Rocky to wait for the child to try before explaining
  the answer. It never sends automatically or starts another session. A failed or retired assistance request cannot switch
  conversations or alter a newer draft. The plugin supplies authoritative activity context to
  the tutor. Gentle CSS motion respects reduced-motion preferences. Polling can
  display a time-based mood change up to 15 seconds after the server's threshold.
- `conversation.ts` asks `users.self` and the access-filtered `agents.list`. Only a
  verified non-shared profile with exactly one accessible agent is admitted. It
  derives one stable key from those server facts and asks the Gateway to create or
  reopen it. Neither URLs nor browser storage choose a tutor or session.
- `messages.ts` selects child-visible messages and projects text/media in the
  supplied order. It is pure presentation; the conversation retains transcript,
  custody, identity and send-admission authority.
- The Gateway owns authentication, agent permissions, session ownership, transcript
  persistence, branch validation, and idempotent send admission. The conversation
  keeps a bounded memory-only projection, retains draft text on failed sends, and
  reconciles uncertain outcomes without blind resends. Reconnect removes old
  transcript data. One uncertain request stays in memory with its original
  verified profile, agent, backing session, branch, text, encoded attachments, and
  idempotency key.
  History receipts can settle it; otherwise an explicit **Try again** makes at
  most one exact replay through Gateway send admission. Repeated transport
  failures keep the same request available; reconnect never passively resends.
  Accepted inputs remain a separate display collection until their canonical
  user transcript rows arrive. Custody/consumption receipts retire only the
  matching local optimistic copy; equal text from distinct sends stays distinct.
  Changing the verified profile, agent, or backing session discards this retry
  capability rather than retargeting it. The conversation reports accepted text
  once to the app, whether proved by a response or a receipt; the app clears only
  an unchanged original text and the exact submitted attachment IDs. Files added while
  a send waits remain in the draft. Reloading discards memory-only recovery.
- `draft.ts` persists unsent text through the existing browser composer store,
  scoped to the verified profile-qualified session key, physical session ID, and
  Gateway origin. Restoration finishes before editing is enabled and never sends
  a message. One serialized worker coalesces edits; acknowledgments clear only
  unchanged text, including receipts recovered after reconnect. Disconnect hides
  text; disposal joins admitted saves. Storage failure or a conflicting tab keeps
  local text editable with a save warning, without overwriting the other tab.
  The shared store owns its seven-day expiry. Files and uncertain-send replay
  credentials remain memory-only; draft recovery does not promise offline sends.
- `history-window.ts` owns older/newer browsing through the existing `chat.history`
  offset API. It retains at most four pages, 320 projected rows and 1 MiB; moving
  through history evicts the opposite edge, which can be fetched again. The live
  conversation keeps its separate 80-message tail and remains the authority for
  sending. Tail refreshes and page reads serialize; historical pages never replace
  live branch or pending-input state. A canonical transcript-source change also
  refreshes positional attachment references before the tutor's final response.
  Retained browsing pages renew together, preserving message identities and the
  reading position. A failed read keeps the complete prior window and offers
  the existing history retry without reconnecting or clearing the draft. A further
  source change requests a fresh authoritative tail; physical session resets and
  shrinking history retain the existing window-reset behavior. Latest
  discards browsing immediately; disconnect retires all page results.
  Edge buttons keep pages traversable when filtered rows leave too little visible
  content to scroll.
- `transcript-scroll.ts` owns viewport position and one resize observer. It follows
  the latest messages until the child scrolls away, then preserves a visible
  message across page changes and media resizing. Paging requires reader scroll
  intent at an edge. A floating Latest button returns to the live tail without
  altering the draft. Disposal removes listeners and the observer.
- `touch-gestures.ts` owns Safari pinch cancellation and the narrow double-tap
  fallback, with listeners installed on start and removed on disposal. CSS keeps
  native panning at each scrolling boundary. Safari releases before
  [WebKit's manipulation fix](https://github.com/WebKit/WebKit/commit/504edb5c563f9ad8d0436f60b5a608f0ec384f42)
  can still zoom on a double tap. The fallback covers the whole kids document,
  including Today cards and Chat. It cancels only a second nearby stationary tap
  on plain surfaces or the same non-editing control (button, link, disclosure or
  media); the first tap stays native. It has no timers or synthetic clicks.
  Scrolling, long presses, different controls, existing selections and editable
  fields retain their native touch behavior. Double-tap word selection in plain
  transcript text may also be suppressed; composer word selection is untouched.
  Pinch gestures are cancelled across the document, including editable fields.
  Native iPad gesture recognition needs physical-device verification; synthetic
  touch tests verify cancellation and lifecycle, not Safari's zoom recognizer.
- `attachments.ts` owns one memory-only photo/video draft and its preview URLs.
  Shared chat admission, read/resize, payload, and encoding owners enforce the
  Gateway's advertised per-file and WebSocket batch limits. The app cancels reads
  on disconnect; completed files stay hidden until the same authenticated logical
  and backing session is verified. Rebinding or disposal releases payloads and
  revokes URLs. A send snapshots encoded bytes and canonical optimistic content
  before asynchronous admission and captures the displayed backing session. A
  history refresh can update that session's branch, but a replacement backing
  session rejects the waiting send before any RPC; the app clears the old draft.
  Known failures retain the original files; an
  uncertain outcome retains one exact replay without rereading or re-encoding.
  Picker/read errors remain visible, and removing a file cancels only that read.
  There is no durable upload cache or separate upload service.
- `history-media.ts` owns mounted image/video reads for the verified conversation.
  The shared projector supplies opaque artifact IDs; the existing artifact API
  checks session access and serves its referenced media. No raw path or remote
  URL becomes a browser source. Viewport leases admit at most two reads, release
  offscreen image URLs, and cancel on disconnect or rebinding. Videos use native
  controls, no autoplay, and short-lived HTTP grants with range playback. Expired
  grants or unreadable media show an explicit retry; unsupported references show
  their media type. Disposal joins reads before the Gateway client stops.
- `voice.ts` adapts the existing Talk owner. It owns a single call and bounded
  spoken captions; the shared owner owns microphone and provider resources.
  Stop cancels capture immediately and joins late allocations and transcript/close
  work before transport teardown. Provider credentials stay with existing owners.
  The Gateway captures authenticated caller attribution at transcript/call admission
  and stamps stable caller IDs on user voice rows through the shared metadata
  serializer. Mutable display labels stay out of transcript retry identity.
  Activity collectors can count verified speech without inferring authorship from
  session ownership; legacy unstamped voice remains unknown.
- `dictation.ts` owns one bounded recording and transcription request. It reuses
  the microphone acquisition owner and sends compressed audio to the hosting
  plugin's authenticated `kids.transcribe` method. The existing media-understanding
  runtime selects the configured audio provider; the browser never chooses a model
  or receives credentials. Stop inserts speech into the draft for review without
  sending. The app owns the draft selection and verified binding; late results
  cannot enter a replaced conversation. Hiding the page or disposing cancels
  capture and discards late results. Teardown joins admitted work before dropping
  the connection. Dictation and live calls cannot capture together.
- `view.ts` renders supplied state and emits actions. Markdown goes through the
  existing sanitizer; messages cannot introduce controls, remote images, raw HTML,
  or session navigation. Views never make permission or routing decisions.
- The notification owner registers a worker scoped to `/kids/`, using the existing
  Web Push subscription owner. Lock-screen text is private. Worker clicks always
  open `/kids/#chat`; a matching same-origin kids window receives a fixed Chat
  presentation message before focus. Payload URLs are still ignored, and no
  activity-specific notification routing is claimed. Notification navigation
  never selects a conversation. There is no offline chat
  cache. Current profile, device, agent access, and session ownership are rechecked
  at delivery by the Gateway.
  While this chat is visible, the connection renews a short-lived
  foreground claim for its own push subscription and exact conversation. The
  Gateway skips that device's completion push while the claim is live; other
  devices and conversations keep their normal notification behavior. Hiding the page
  clears the claim, and disconnect or lease expiry restores delivery if browser
  shutdown prevents cleanup. The worker still displays every received push, as
  required by Safari's Web Push contract.
  The Chat footer offers notification setup only until it is enabled, then the
  control disappears completely. Setup details remain visible in Chat. Turning
  notifications off remains in device/browser settings; there is no in-app
  unsubscribe control.
- `extensions/kids-ui` serves public build assets and owns bounded, authenticated
  dictation requests. Its service joins provider work and deletes private temporary
  recordings; provider selection and credentials stay with the existing runtime.
  The existing Control UI remains a separate app.

Every asynchronous owner fences results against its active connection. Startup
errors leave the composer unavailable; there is no fallback to a main/shared
agent. Shutdown cancels reads and microphone work, joins accepted cleanup, then
closes the connection. Browser destruction cannot guarantee a final network flush;
the microphone still stops synchronously and the Gateway owns remote expiry.

## Build and verification

Use the exact reviewed source release in an isolated checkout whose build outputs
are not used by a running Gateway. From that checkout's repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir ui exec vite build --config vite.kids.config.ts
mkdir -p dist/extensions/kids-ui/assets
cp -R extensions/kids-ui/assets/. dist/extensions/kids-ui/assets/
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui.config.ts ui/src/kids/conversation.test.ts ui/src/kids/voice.test.ts ui/src/kids/notifications.test.ts ui/src/kids/activity.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/kids/app.e2e.test.ts ui/src/kids/activity.e2e.test.ts
```

Build the Gateway before the kids bundle. Its `dist/build-info.json` supplies the
exact identity embedded in the kids handshake; the existing UI build owner checks
the source commit and version before reusing that identity. Both UI entry points
use `scripts/lib/ui-build-environment.mts`; Vite does not import the CLI owner
that publishes output or manages child processes. Missing or stale build
provenance stops production builds with guidance to rebuild the Gateway. Keep the
checkout and build environment unchanged between these commands, and rebuild both
artifacts and repeat the asset copy after source changes or a Gateway rebuild. A
development server is not a deployable bundle. Never rebuild or copy build output
into a checkout serving a running Gateway.

The optional kids build writes `extensions/kids-ui/assets/`; the copy step places
those assets beside the compiled bundled plugin. Deploy the complete matching
Gateway installation tree, then enable bundled `kids-ui` as described in the
[hosting plugin README](../../../extensions/kids-ui/README.md#deployment).
That document owns activation and rollback; linked source and a detached compiled
plugin directory are not supported deployment paths. Preview and tests use
isolated ports and synthetic profiles; they never send a Slack message or open a
paid voice call.

Each child needs an individual verified login, one allowed tutor agent, own-session
access, and `operator.sessions.write` plus `operator.talk` in both identity grants
and role ceilings. A shared parent identity cannot distinguish children. A parent
login with several accessible agents intentionally shows setup guidance rather
than impersonating a child. The Gateway must have a ready Talk provider.

Browser microphone and push require HTTPS (loopback is allowed for local tests).
iPhone notifications require adding Rocky to the Home Screen and opening that
installed app before enabling notifications. Validate audible voice and push
delivery on the actual device before claiming device support.

## Accepted scope and remaining deployment work

Completed tutor runs in owned sessions can notify the child's registered devices.
Scheduled challenges use the same private notifications when a `current` cron
job commits its final answer to that child's creation-bound conversation. The
Gateway consumes the canonical commit even with no connected browsers, verifies
the stored cron provenance and current conversation generation, and applies the
same device, role, and session visibility checks. Repeated publications of a run
coalesce; transport errors do not resend an ambiguous push. The durable challenge
remains in conversation history when push is unavailable.

Deployment must bind one job per child to their authenticated app conversation
and extend the existing activity collector to recognize those verified child
turns and challenge commits. Preserve invitation cooldowns and existing parent
reports. A current-session job can also retain explicit Slack delivery of the
same final challenge; installing this frontend does not migrate jobs. No family
inbox, groups, offline sends, or browsing old sessions is part of v1.

Photo/video understanding uses the existing Gateway media pipeline and configured
providers. File size limits apply to short videos; this app does not transcode
or claim that every video format can play in every browser. Canonical history
references reopen uploaded photos/videos and generated images through the existing
artifact route. Session access is the authority; there is no separate file
permission system or broader file-reading permission. Unsupported media shows its type.
Uploaded media requires reachable Gateway HTTP artifact routes; unlike inline
transcript images, it has no WebSocket byte-transfer fallback. The bundled app
uses the same origin that serves those routes.

Browser diagnostics retain only the latest `rocky.send.accepted` and
`rocky.send.finished` Performance measures: socket submission to acknowledgment
and to the matching final event. They contain no text or identities, do not leave
the device, and reset with the document. Failed/interrupted runs are not successful
completion samples; reconnect starts a new measurement. These timings include
Gateway/model work but exclude file preparation and the final history read/render.
They add no controls or status counters to the kids app.

Deployment must keep frontend and Gateway changes together because restricted
push subscriptions require the accompanying Gateway scope fix. Review and test
the fork before changing the running Gateway. Existing provider defaults and
tutor prompts remain owned by the host's configuration.
