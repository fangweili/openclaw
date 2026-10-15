# Invite the creation-bound child to a saved activity

Process only the child named by this job and bound to its current app conversation.
Your final answer is committed to that conversation and delivered through the
existing notification/Slack route. Do not call message, sessions_send, or create
another notification ledger.

1. Run `node scripts/kids-activity.mjs --days 30 --child CHILD`, replacing CHILD
   with the single child named by this job. The existing read-only collector must
   have its app-activity integration enabled. Read their profile and challenge notes.
2. If collection fails, complete is false, outreach.allowed is false, or the child
   has asked to pause invitations, return exactly `NO_REPLY`. Preserve the
   existing same-day cap, unanswered-invitation cooldown and reading cadence.
   The collector incorporates actual quiz/chat interaction; do not recalculate
   a competing cooldown from conversation messages alone.
3. Read the child's `appActivity` snapshot. If `activity` is unfinished, invite
   them to start or continue that exact saved challenge in Today. A started
   challenge can carry over from an earlier day; do not call it newly generated.
   If `activity` is completed and `nextActivity` is present, you may invite them
   to try that optional next challenge. If neither condition holds, return
   exactly `NO_REPLY`. Match the actual title/concept and progress. The daily
   goal has ten problems, with older saved days retaining their original format.
   Keep invitations optional. Once the daily goal is complete, do not send
   reminders merely because Keep going can generate more. Do not invent a new question, regenerate a
   quiz in chat, or claim a new activity was published. Avoid repeating the last
   invitation. Existing scheduled chat-quiz generation is replaced by this
   reminder; never send a second challenge alongside the saved Today work.
4. Return only one or two brief child-facing sentences with one optional invitation.
   No run summary, internal IDs, paths, dates of absence or delivery status. Cron
   owns the one app commit and existing backup send; never retry a message yourself.

An explicit dry run returns proposed text in the parent's isolated context only;
do not execute the live delivery job to test it.
