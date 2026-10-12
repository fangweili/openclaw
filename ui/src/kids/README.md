# Rocky for kids

This separate frontend opens one child's verified tutor conversation. V1 includes
plain text, live voice, and private notifications. Family messages and groups are
deferred. There is no agent/model picker, session list, administrative navigation,
tool output, reasoning display, or intermediate assistant commentary. Text shows
the child's messages and finished assistant replies; voice shows spoken captions.

## Ownership and trust

- `app.ts` owns the document, same-origin Gateway client, in-memory draft, and the
  lifetime of its conversation, voice, and notification owners. Reconnect fences
  callbacks, retires microphone work, then admits the next authenticated context.
  A retained draft stays hidden until that conversation is ready again; binding a
  different verified session clears it.
- `conversation.ts` asks `users.self` and the access-filtered `agents.list`. Only a
  verified non-shared profile with exactly one accessible agent is admitted. It
  derives one stable key from those server facts and asks the Gateway to create or
  reopen it. Neither URLs nor browser storage choose a tutor or session.
- The Gateway owns authentication, agent permissions, session ownership, transcript
  persistence, branch validation, and idempotent send admission. The conversation
  keeps a bounded memory-only projection, retains draft text on failed sends, and
  reconciles uncertain outcomes without blind resends. Reconnect removes old
  transcript data. One uncertain request stays in memory with its original
  verified profile, agent, backing session, branch, text, and idempotency key.
  History receipts can settle it; otherwise an explicit **Try again** makes at
  most one exact replay through Gateway send admission. Repeated transport
  failures keep the same request available; reconnect never passively resends.
  Changing the verified profile, agent, or backing session discards this retry
  capability rather than retargeting it. The conversation reports accepted text
  once to the app, whether proved by a response or a receipt; the app clears only
  an unchanged original draft. Reloading discards memory-only recovery.
- `voice.ts` adapts the existing Talk owner. It owns a single call and bounded
  spoken captions; the shared owner owns microphone and provider resources.
  Stop cancels capture immediately and joins late allocations and transcript/close
  work before transport teardown. Provider credentials stay with existing owners.
  The Gateway captures authenticated caller attribution at transcript/call admission
  and stamps stable caller IDs on user voice rows through the shared metadata
  serializer. Mutable display labels stay out of transcript retry identity.
  Activity collectors can count verified speech without inferring authorship from
  session ownership; legacy unstamped voice remains unknown.
- `view.ts` renders supplied state and emits actions. Markdown goes through the
  existing sanitizer; messages cannot introduce controls, remote images, raw HTML,
  or session navigation. Views never make permission or routing decisions.
- The notification owner registers a worker scoped to `/kids/`, using the existing
  Web Push subscription owner. Lock-screen text is private. Worker clicks always
  open `/kids/`; payload URLs never select a conversation. There is no offline chat
  cache. Current profile, device, agent access, and session ownership are rechecked
  at delivery by the Gateway.
- `extensions/kids-ui` serves only public build assets. It neither handles secrets
  nor proxies privileged calls. The existing Control UI remains a separate app.

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
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui.config.ts ui/src/kids/conversation.test.ts ui/src/kids/voice.test.ts ui/src/kids/notifications.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/kids/app.e2e.test.ts
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
inbox, groups, attachment upload,
offline sends, or browsing old sessions is part of v1.

Deployment must keep frontend and Gateway changes together because restricted
push subscriptions require the accompanying Gateway scope fix. Review and test
the fork before changing the running Gateway. Existing provider defaults and
tutor prompts remain owned by the host's configuration.
