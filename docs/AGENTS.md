## Documentation

### Content

- Write for the intended audience: users, contributors, developers, or maintainers. 
- Document durable behavior, architecture, interfaces, setup, usage, maintenance, and reproducible verification procedures — how to verify something, not the result of one run.
- Preserve useful technical facts from development work, but rewrite them as stable project documentation rather than session history.

### Exclude from Project Documentation

- Session-specific instructions, agent handoff notes, interactive user checkpoints, statements such as "wait for user confirmation", current-task progress, or temporary acceptance reports.
- Narration of how the current implementation task was carried out.
- Temporary implementation notes, raw validation evidence, checkpoint reports, debugging notes, and AI execution logs — keep these under the gitignored `.local/<phase>/` directory.

### Language and Style

- Write prose in Chinese for project-authored documentation except `AGENTS.md`, `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs, which must be written in English. Commands, field names, JSON keys, code blocks, and paths keep their original English form.
- `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs must preserve the location, naming, structure, and formatting conventions defined by the skill that creates or maintains them.
- Prefer clear, natural, and engaging prose. Preserve the terminology, tone, and level of detail of existing documentation, and avoid unnecessary verbosity or duplication between documents.
- Keep the README readable and product-oriented. Preserve its established narrative where appropriate; put detailed engineering documentation in `docs/` and link to it where useful.