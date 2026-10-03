## Documentation

### Content

- Write for the intended audience: users, contributors, developers, or maintainers. Clearly distinguish current supported behavior from planned, proposed, or future behavior.
- Document durable behavior, architecture, interfaces, setup, usage, maintenance, and reproducible verification procedures — how to verify something, not the result of one run.
- Preserve useful technical facts from development work, but rewrite them as stable project documentation rather than session history.

### Exclude from Project Documentation

- Session-specific instructions, agent handoff notes, interactive user checkpoints, statements such as "wait for user confirmation", current-task progress, or temporary acceptance reports.
- Narration of how the current implementation task was carried out.
- Temporary implementation notes, raw validation evidence, checkpoint reports, debugging notes, and AI execution logs — keep these under the gitignored `.local/<phase>/` directory.

### Language and Style

- Write prose in Chinese for project-authored documentation except `AGENTS.md` files. Commands, field names, JSON keys, code blocks, and paths keep their original English form.
- Prefer concise, direct prose. Match the terminology and style of existing documentation unless it conflicts with this file, and avoid unnecessary duplication between documents.
- Ensure commands, paths, configuration examples, and described behavior match the current implementation before treating the documentation as complete.