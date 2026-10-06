## Project Direction

- Treat the EngramWeave overall design as the architecture baseline.
- Follow the current phase implementation plan and TODO as the execution scope.
- Do not redesign established architecture unless there is a concrete conflict or implementation blocker. Report such conflicts before changing the design.
- If project documents conflict, do not silently choose one interpretation; identify the conflict and use the narrowest change that preserves established architecture.

## Implementation

- Prefer the smallest implementation that satisfies the current contract and acceptance criteria.
- Reuse existing project utilities and mature dependencies before introducing new infrastructure.
- Do not create empty future packages, generic frameworks, compatibility layers, or abstractions without a current concrete use case.
- Avoid unrelated refactors while implementing a scoped task.
- Keep modules cohesive; split code when a file begins to own multiple unrelated responsibilities.
- New dependencies must have a clear current-purpose justification.

## Local conventions

- Use English for code, comments, identifiers, commits, and code blocks.
- Keep local implementation artifacts out of committed documentation. Raw test reports, AI execution logs, checkpoint reports, debugging notes, temporary evidence, and similar phase-specific materials belong under the gitignored `.local/<phase>/` directory, such as `.local/p1/`.
- Reserve `docs/` for stable, intentional project documentation that is meant to be maintained and committed.
- Local-only fixture notes, provenance records, validation evidence, or temporary fixture documentation also belong under `.local/<phase>/`, unless they describe committed, reusable fixtures and are intended to be permanent repository documentation.

## Testing

- Add or update tests when needed to protect behavior, contracts, safety, persistence, recovery, or meaningful regressions.
- Keep automated tests and test-only fixtures/helpers under `tests/`.
- For test changes or changes to the code they cover, follow `tests/AGENTS.md`, even when no test edit is planned.

## Documentation

- All committed project documentation, including all `README.md` files, should follow the documentation principles in `docs/AGENTS.md`, even when it is outside `docs/`.