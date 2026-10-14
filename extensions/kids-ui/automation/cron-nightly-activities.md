# Additional evidence for the existing nightly records owner

Keep the existing nightly ownership and no-delivery instructions. For each child,
also call `kids_activity(action="evidence", childId=...)`. This is a read-only
snapshot of saved quiz work, attempts and scenes, not a new learning-record owner.

Use attempts within the same evidence window as the conversation collector.
Honor `activitiesOmitted` and each activity's `attemptsOmitted`: details are bounded,
so omissions are coverage limits, not evidence that no other work occurred.
Identify each attempt by its stable ID. The activity ID, question ID, ordinal,
timestamp, hintUsed, outcome and independent fields describe actual work. An
activity's preparation date is not its attempt date. Distinguish unanswered
published questions, started activities, assisted/retried correctness and correct
first answers without hints. Read the submitted answer and feedback when available;
explanation grading is a model assessment against that question's rubric, not a
new mastery level. An `outcome: "clarify"` submission is ungraded, not a wrong
answer or an extra scored attempt. Distinguish missing detail from a demonstrated
misconception. Never turn the celebration streak into mastery.
Each daily batch contains three distinct optional challenges. Count completions
per activity ID, not per prepared day or image pair. A started challenge may carry
over from an earlier day; use its actual attempts and completion timestamp. The
child need not finish all three, and unstarted earlier-day extras are not overdue
work. Keep optional future ideas in challenge notes; scheduled reminders now point
to saved Today challenges rather than generating another quiz in chat.

Deduplicate attempts by ID. Combine conversation help and its scored activity as
one learning episode; conversation discussion is not a second correct answer.
When a transcript does not link to an activity/attempt, describe its evidence
separately and do not infer a match merely from a similar topic. Preserve source
IDs in concise dated summaries so a later run can re-derive without double counting.

Include actual quiz work in recent-activity, skill calibration and optional next
steps. Keep chat message counts as message counts; derive overall active days from
the union of authenticated conversation dates and attempt dates in the child's
timezone. Generated pictures/captions are pet fiction, not evidence the child
performed or learned something. If this tool fails, preserve existing conclusions
and report a quiz-coverage gap; don't claim zero attempts.

Continue preserving parent-owned sections and live daily logs. Never modify the
activity database directly or publish a daily quiz from the nightly update.
