# Rocky has moved

The Rocky kids app, activity plugin, fixed art, automation templates, and shared
activity contract now live in [fangweili/kids-claw](https://github.com/fangweili/kids-claw).
This directory is a migration pointer, not a bundled plugin.

Install the standalone package using its deployment guide before upgrading a
Gateway that previously loaded this bundled plugin. Keep plugin ID `kids-ui`, its
existing configuration, session bindings, and state directories. The extraction
does not migrate or delete conversations, learning records, or activity progress.

The app uses a separate HTTPS origin with the existing Gateway. Add its exact
origin to the Gateway allowlist and pair each device. Do not broaden child
permissions. See the standalone repository's dependency audit before replacing
the host fork with upstream.

Custom kids and parent Web Push alerts are removed, including foreground claims
and automation-completion pushes. The Gateway retains upstream generic push
with its standard operator scopes. Disable existing device subscriptions during
deployment; retaining their disabled preferences prevents automatic browser
reconciliation from re-enabling them. The private parent-notice copy overlay is
also retired. Archive its two alert conversations and keep Discord delivery.
