# Kids Tutor hosting

This optional, private plugin serves the minimal tutor app at `/kids/` on the
existing Gateway origin. It owns only public static files from its adjacent
`assets/` directory. It does not replace the Control UI, register tools, create
sessions, grant permissions, or handle credentials. The browser connects directly
to the Gateway's authenticated WebSocket; configured identity and agent policies
remain authoritative.

The Gateway plugin registry installs and removes the route with the plugin.
Requests run independently with no retained mutable state or background work.
The public file-access SDK bounds each read to 8 MiB, enforces directory
containment, and closes file handles before the response. Only web asset types
are served; source maps, arbitrary JSON, and directory listings are unavailable.
HTML and unhashed assets use `no-store`; Vite assets with content hashes may be
cached immutably. Missing or unsafe assets return 404; a missing entry page
returns 503 with an installation message. A later request can recover after the
build is installed without retaining a failed read.

Build the kids frontend with Vite's base set to `/kids/` and output set to
`extensions/kids-ui/assets`. Install the complete plugin directory, including
those generated assets, using the host's local plugin install workflow. Keep the
Gateway and frontend on the tested release, 2026.10.1. The asset directory is a
build artifact and is intentionally absent from Git.

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

After building and reviewing the assets, install this local plugin on the Gateway
host (installation enables the plugin and changes live configuration):

```sh
openclaw plugins install --link /absolute/path/to/extensions/kids-ui --force --accept-capabilities
```

The `--force` flag confirms a reviewed local source; it does not bypass host
install policy. The linked directory must remain available. Use the normal
Gateway plugin lifecycle to activate the installed route, then verify `/kids/`
and its exact built asset hash. Keep any pre-existing installation record for
rollback; disable `kids-ui` to remove its route without changing the Control UI.

Install the fork's Gateway changes before enabling notifications for restricted
profiles. Assign each child a verified individual identity and a role with
`sessions.others: "none"`, one allowed tutor agent, and only
`operator.sessions.write` plus `operator.talk`. The identity grant and role ceiling
must both allow those scopes. Do not add general read/write or administration.
The default unassigned role stays denied. Device pairing must approve the same
narrow scopes; existing devices may need a scope upgrade approved by the parent.
On iOS, install the page on the Home Screen before enabling browser push.
