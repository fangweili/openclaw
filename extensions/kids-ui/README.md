# Kids Tutor hosting

This optional, private plugin serves the minimal tutor app at `/kids/` on the
existing Gateway origin. It owns public static files from its adjacent
`assets/` directory and bounded private dictation requests. It does not replace the Control UI, register tools, create
sessions, grant permissions, or handle credentials. The browser connects directly
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
