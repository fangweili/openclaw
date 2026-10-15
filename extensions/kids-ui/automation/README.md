# Solve and Rocky artwork on an existing tutor host

These templates are deployment inputs, not automatic installation actions.
The existing tutor agents plan content; cron owns scheduling and retries; the
kids plugin owns publication, progress, images and lifecycle. No new agent,
child conversation, learning log, or Gateway core capability is needed.

## Separate jobs and inputs

Configure two isolated jobs per child, both with `delivery.mode: none`:

- Solve: existing `preparationJobId` (and optional `preparationAgentId`), reading
  `cron-daily-prepare.md`. It publishes one ten-question daily goal and its bounded
  teaching brief. Profile, learning notes, saved results and recent conversation
  inform level and topic. Keep going independently generates another ten questions
  using results and recent context; it does not generate pictures.
- Artwork: `artworkJobId` (using the same configured preparation agent), reading
  `cron-daily-artwork.md`. It publishes normal/excited/bored/sleeping pictures and
  captions independently of questions. Keep it daily for now. The separate job
  permits a future frequency change without changing Solve scheduling.

Allow only `read`, `exec`, and `kids_activity` for these jobs. A 1,200-second
artwork job budget allows planning plus the tool's 600,000-ms image budget and
cleanup. Suggested daily times are Solve at 06:00/06:10 and artwork at 05:40/05:50
in each child's configured timezone. Jobs need not finish in that order:
questions can publish without pictures, and pictures can publish without a goal.

Tool discovery checks the actual isolated `agent:<id>:cron:<job>:run:<id>` identity,
never a claimed child in prompt text. Solve jobs cannot generate artwork; artwork
jobs cannot publish questions. Read-only nightly/weekly evidence bindings retain
their existing schedules and authority. Keep both job IDs in the plugin config;
leaving the artwork binding absent disables artwork preparation for that child.

For example, this synthetic binding extends an existing tutor:

```json
{
  "activities": {
    "children": [
      {
        "childId": "student",
        "agentId": "tutor",
        "sessionKey": "agent:tutor:kids:verified-profile-id",
        "timeZone": "America/Chicago",
        "preparationJobId": "actual-solve-job-id",
        "artworkJobId": "actual-art-job-id"
      }
    ],
    "evidenceJobs": [{ "agentId": "records-worker", "jobId": "nightly-job-id" }]
  }
}
```

Use actual returned job IDs and verified app bindings during installation; never
copy production identities into these templates. Empty activities configuration
keeps chat and dictation available without opening an activity database. Keep
`plugins.entries.kids-ui.llm.allowAgentIdOverride: true` for explanation grading
and adaptive question generation through the child's configured model. Browser
input cannot choose a model, provider or sibling.

## Fresh artwork context

Artwork does not read the learning profile. It receives a bounded recent view:
latest verified text/voice turns within 24 hours, recent Solve attempt summaries,
and a few previous scene descriptions to avoid repetition. Relevant verified
holidays/events can set the costume/theme; recent interaction shapes the action,
props, expression and caption. If school information lives in a profile, extract
only its Current School Context section. No weather lookup is needed. A quiet
window can inspire a playful fictional Rocky moment without claiming the child
experienced it. Planned events are not completed experiences.

Install the host's read-only collector with
`node scripts/kids-activity.mjs --recent --child <childId>`. It returns a small
newest-message selection, not a whole-day report. Source completeness/warnings
remain distinct from intentional selection omissions. Read it separately from
profile files; do not combine large files into one tool response. Source gaps
are never evidence of inactivity. The existing `--days` mode and invitation
cooldown behavior remain unchanged. The host collector owns trusted provenance;
this repository's `collect-app-activity.mjs` adapter does not duplicate it.

Rocky's fixed reference defines the original soft clay moss-green mountain body,
ivory snowy central peak, small green arms/feet and black-and-ivory eyes, with no
ears, tail or belly patch. Scenes may vary pose, costume, action and viewpoint.
Normal is an everyday moment; excitement is a different whole-body action in the
same theme. Bored and sleeping remain clearly readable, comfortable resting
states without guilt, distress or feeding requirements. All images use genuine
transparency, minimal props and no text or full scenery. Rest captions also fit
the original fixed fallback poses. Generated art is fiction, never learning proof.

## Publication, lifecycle and recovery

`prepare_daily` accepts only date, one ten-question activity (at least eight free
answers) and a nonblank teaching brief up to 8,000 characters. Publication is
atomic and immutable per child/date; existing work is a no-op. It makes no image
calls and cannot change artwork. The brief supplements profile/history for later
optional batches; it is not a second learning-record writer.

`prepare_art` accepts date, four prompts/captions and `timeoutMs: 600000`.
The renderer owns provider selection, the approved reference, compression and
private file adoption. It renders normal then excited, and attempts both resting
images concurrently within the remaining budget (at most 180 seconds, cutoff
540 seconds from start). It publishes once with fixed resting fallbacks when
necessary, then joins late optional calls; late results cannot adopt files.
Cancellation revokes later effects and joins admitted calls. Shutdown joins this
owner before closing the activity worker. At most two children generate art and
eight private image reads run concurrently.

Ordinary art publication is once per child/date. A parent-requested refresh uses
`replaceImageId` from the current art context. Both preflight and commit compare
that current normal-image ID; stale/missing matches are no-ops. Only today's art
can be refreshed. A lost acknowledgement is not permission to generate again:
retry the same expected ID, which cannot overwrite a newer picture. Confirmed
losing publication removes its staged files; uncertain publication retains them
because the database may already reference them. No refresh alters questions,
learning briefs, results, pet clocks, receipts or streaks.

Images are immutable PNG user artifacts, at most 512 KiB each, under the plugin's
private media directory. Authenticated reads use the child's existing session
admission. Static `/kids/` hosting never exposes these files. Normal/excited art
may fall back to the previous available scene; daily resting art is shown only
on its own date, otherwise the fixed pose is used. Art failure never blocks Solve.

Schema 4 separates art into `kids_art` under the existing SQLite worker. Upgrade
atomically moves saved art out of day content without moving image files or
changing quiz/results. Back up before activation; an older plugin cannot open
schema 4. See the main [upgrade and rollback contract](../README.md#daily-activities-and-pets).
Do not restore an old whole database over work accepted after activation.

## Existing learning and notifications

The nightly owner combines retained conversations and saved Solve results into
existing profiles and recent-activity summaries. Live tutors do not create new
progress logs. Add `cron-nightly-activities.md`/`cron-weekly-activities.md` evidence
guidance to the existing owned jobs, preserving their schedules and deliveries.
Evidence omissions remain explicit; count stable attempt IDs once and separate
independent success from hints/retries.

Invitation jobs retain existing app conversation targets, push settings and
Slack backup. Use `cron-app-activity-invitation.md` and the existing collector's
cooldown decision. Install `collect-app-activity.mjs` with the reviewed
`collector-integration.diff` for `--days` CLI snapshots. Only that CLI mode calls
the authenticated Gateway; pure collector fixtures remain isolated. Failed
snapshots mark collection incomplete and block invitations. Preparation success
means saved content, not a notification delivery.

## Validation

Use focused plugin/store tests and the host collector fixtures. Verify independent
art/Solve publication in both orders, refresh preservation and stale retries,
existing-data migration, child/job isolation, cancellation, provider failures,
fixed mood fallbacks, and current-date resting images. Check configured jobs
through their real no-delivery boundary after deployment. Keep code, prompts,
configuration and job payloads on the same reviewed release. A physical iPad
check remains distinct from store, provider and browser evidence.
