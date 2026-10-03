## Testing

### Testing Strategy

- Tests exist to protect behavior, invariants, contracts, persistence, safety, recovery, idempotency, parsing boundaries, and meaningful regressions — not to maximize test count or coverage.
- Prefer manual smoke tests for obvious user-facing UI/Desktop behavior when it can be verified faster and more reliably by direct use. Automate it only when protecting an important regression, contract, or safety invariant.
- Keep E2E tests few, thin, and focused on critical cross-component paths.
- Do not duplicate the same behavior across unit, integration, and E2E layers without a specific regression risk.
- At checkpoints involving user-visible behavior, provide a short manual acceptance checklist.

### Test Organization

- Organize tests by subsystem and behavior. Do not create monolithic catch-all test files; split files that grow to cover unrelated behaviors or subsystems.
- Move reusable fixtures and helpers into dedicated modules rather than expanding E2E or integration test files.
- Reuse Vitest and existing repository test utilities.
- Tests should verify externally observable behavior and invariants rather than reproduce production implementation logic.
- Prefer the smallest targeted test that proves the change, then run broader regression tests as needed.

### Testing Infrastructure

- Do not create custom test frameworks, validation projects/apps, DSLs, temporary test applications, benchmark projects, or large testing harnesses unless explicitly required or the existing test stack is technically insufficient.
- If substantial new validation infrastructure appears necessary, stop and explain why before creating it.