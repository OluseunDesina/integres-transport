Write a session handoff before I compact this conversation with `/summarize`.

Assume the reader is me, tomorrow, with no memory of this session and no access
to the messages above. Write it so I could resume cold.

Output exactly these sections, in prose and short bullets — no preamble, no
restating this instruction:

**Goal** — what this session set out to accomplish, in one or two sentences.

**Done** — what actually landed, with file paths. Distinguish committed work
from uncommitted edits still in the working tree.

**Decisions** — choices made and the reasoning, especially anything that
contradicts an obvious default or that a fresh reader would otherwise
second-guess. Flag anything that belongs in `docs/adr/` or a spec but has not
been written down yet.

**Open** — unresolved questions, known-broken state, failing tests, things I
said I would come back to. Mark anything blocking.

**Next** — the next three concrete steps, in order, each specific enough to
start on without rereading this session.

**Files** — every file created or modified, one per line, with a few words on
what changed in each.

Be accurate over complete. If you are unsure whether something landed, say so
rather than asserting it.
