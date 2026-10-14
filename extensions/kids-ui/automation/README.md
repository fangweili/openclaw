# Daily activities on an existing tutor host

These templates are deployment inputs, not automatic installation actions. They
reuse the existing tutor agents, nightly records owner, invitation jobs and
notification delivery. Installation does not edit a workspace or schedule jobs.
Keep the deployed plugin and these files on the same reviewed release.

## Ownership and activation

The activity plugin owns saved quizzes, answers, attempts, pet clocks and complete
scene publication. Two isolated daily cron jobs ask the existing agents to plan
their child's three three-question challenges and one art pair. Cron owns scheduling, run cancellation and retries. The
plugin's `kids_activity` tool owns image generation through the configured image
runtime, including normal-to-excited reference continuity. The job supplies words
and verified questions; it cannot choose an image path, provider or sibling.

Create one isolated preparation job per configured child, with `delivery.mode`
set to `none`, a 1,200-second job timeout, and tools limited to `read`, `exec`, and
`kids_activity`. Suggested schedules are `0 6 * * *` and `10 6 * * *` in the
children's configured timezone. Point each payload to `cron-daily-prepare.md`.
Record each actual job ID as that child's `preparationJobId` and the job's agent
as `preparationAgentId` when different from the child's tutor. No new agent is
needed. The tool requires that exact agent and isolated `cron:<job>:run:<id>`
context, together with current invocation authority.

The preparation template runs
`node scripts/kids-activity.mjs --days 30 --child <childId>` from the tutor
workspace. Verify that existing read-only collector is installed there before
activation. It reads only the creation-bound child; a failed or partial collection
is reported as limited evidence, not inactivity.

Add existing nightly and weekly job IDs to `activities.evidenceJobs`; retain their
current schedules and delivery settings. Add `kids_activity` to their tool
allowlists if an allowlist is present. Insert the instructions in
`cron-nightly-activities.md` and `cron-weekly-activities.md` into their existing
owned prompts. These are evidence extensions, not replacement profile owners.

Configure `plugins.entries.kids-ui.config` with verified existing app session
keys and the actual job IDs returned when creating the preparation jobs. For
example, this synthetic single-child configuration adds activities to an
existing tutor without changing that child's permissions:

```json
{
  "activities": {
    "children": [
      {
        "childId": "student",
        "agentId": "tutor",
        "sessionKey": "agent:tutor:kids:verified-profile-id",
        "timeZone": "America/Chicago",
        "preparationJobId": "actual-preparation-job-id"
      }
    ],
    "evidenceJobs": [
      {
        "agentId": "records-worker",
        "jobId": "actual-nightly-job-id"
      }
    ]
  }
}
```

Each child, tutor agent, session key, and preparation job must be unique. Leaving
`activities` unset keeps the existing chat/dictation service and creates no
activity database. Never copy production identifiers into these templates.

Keep the current-session invitation job IDs, creation-bound session targets,
Slack backup and push settings. Replace their invitation instructions with
`cron-app-activity-invitation.md`. Before enabling those jobs, extend the existing
read-only collector as described below and seed a complete daily bundle through
the preparation job. A preparation success means `published:true` or an existing
complete date; it does not mean a child received a notification.

## Collector integration

Copy `collect-app-activity.mjs` alongside the existing `kids-activity.mjs` and
apply `collector-integration.patch` after reviewing it against that host's
collector. The patch uses its existing trusted child/profile bindings; it does
not store configuration, credentials, message text or delivery receipts twice.
The adapter reads `kids.activity.get` through the existing authenticated host CLI,
with a 30-second timeout and bounded output. It never reads the activity SQLite
file directly. The CLI's existing owner authentication is required; do not grant
children administrative scopes or copy a Gateway token into the workspace.

Only CLI collection reads the Gateway. The pure `collectActivity` entry point
accepts supplied snapshots, so existing fixture tests stay isolated. Missing or
failed snapshots mark the real CLI result incomplete and block invitations. The
collector's existing cooldown calculation remains authoritative; its last-child-
interaction input becomes the latest verified chat or plugin interaction time.
Chat message counts remain chat counts. `appActivity` carries the saved activity
snapshot so the invitation job can check that unfinished work actually exists.

## Artwork, publication and recovery

`prepare_daily` requires `timeoutMs: 600000`, the host's supported ten-minute
tool-call budget. The larger job budget leaves room for planning and cleanup;
it does not extend that tool limit. A slow provider/fallback sequence may exceed
it. Cancellation fences publication and joins any dispatched provider work;
previous complete bundles remain valid. Context and evidence reads retain the
ordinary tool timeout. Never treat a timeout as proof that a retry is safe before
the prior operation has settled and the saved day has been checked.

The plugin ships approved canonical and fixed pose artwork under `pets/`.
Both children use the same original Rocky mountain character, with distinct
reference, bored, and sleeping poses. Rocky is a soft clay moss-green rounded
mountain with an ivory snowy central top peak, small rounded green arms and feet,
large black-and-ivory eyes; it has no ears, tail, or belly
patch. The fixed files are `rocky-reference.webp`, `rocky-bored.webp`, and
`rocky-sleeping.webp`. Daily normal pictures keep this identity while personalizing
the activity, outfit, equipment, expression and whole-body pose. The planner
prioritizes recent conversations and dated school context already maintained in
the child's profile, falling back to established interests or seasonal ideas.
Excited pictures reference that child's normal picture, continuing its theme,
outfit and core equipment with a distinct action and silhouette. Both captions
and fixed mood captions come from the preparing agent.

The private preparation context retains each day's `scenePrompt` alongside its
captions, so later jobs can remember intended actions, outfits and story details. This is the
requested scene, not a claim that every generated visual detail was verified. It
is omitted from the child's public activity snapshot.

Planner prompts describe scene content and pose while the renderer owns the
canonical character and visual style. Pictures contain no lettering; questions
and numbers belong in the app's text. Bored/sleeping captions can recall or dream
about the daily theme, but do not assert that daily props or costumes appear in
the permanent stock poses.

The runtime chooses the configured image model/fallback; preparation never
overrides them. Before publication, generated pictures are encoded as PNG with alpha preserved,
at most 512 KiB each and durably written beneath the plugin's private media root.
No generated image is exposed by the public static `/kids/` handler. Authenticated
image reads are scoped to one configured child. At most two preparations and
eight image reads run concurrently; shutdown revokes admission and joins them
before releasing dependencies.

Each day contains exactly three challenges of three questions each, plus two
pictures shared by the whole day. The child sees one challenge at a time and can
choose Another challenge or Chat after completion. After all three, the app
shows All done for today. A started unfinished challenge stays resumable across
days; unstarted extras are replaced when the next morning's batch arrives. The
newest day's counts exclude any older carryover. A published day is immutable;
a duplicate preparation returns without generating again. If generation fails, previous complete activities remain usable. A pair
that loses a confirmed publication race is removed. A publication error with an
unknown commit outcome retains the image files; retry checks the saved day before
spending again. Files left by an interrupted/uncertain publication are retained
artifacts, not proof of an activity. Do not guess whether a commit succeeded.

Quiz evidence uses the store's bounded history. Each quiz has its own attempts
and completion; each day contributes only one scene-history entry. Image artifacts are retained until
an operator removes unreferenced files; their maximum normal growth is roughly
1 MiB per prepared child-day. Do not delete images referenced by retained bundles
or an unfinished activity. Generation and publishing never wake the pet, change
its streak, or send notifications.

## Validation before enabling delivery

Run the plugin's focused tests and the host collector's existing fixture suite.
Use synthetic profiles and a no-delivery test configuration for a full preparation
run. Verify normal/excited identity, saved quiz correctness, reload/resume behavior,
inactivity transitions, evidence IDs, cancellation and child isolation. Confirm
nightly evidence distinguishes independent and helped correctness. Activate the
reviewed host edits only after the matching app/plugin release is installed.
