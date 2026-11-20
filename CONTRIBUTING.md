# Contributing

```bash
pnpm install
pnpm check          # build, typecheck, test
```

[SPEC.md](./SPEC.md) is the design; read it before changing behavior, and
[AGENTS.md](./AGENTS.md) for the rules the code keeps.

- Every change comes with a test that fails without it. Break what the test
  claims to check and see it fail.
- Tests use real SQLite in a temp folder and injected clocks. They mock nothing
  of muster's own.
- A change people will notice updates its page in `packages/muster/docs`.
  Releases are cut by hand: see "Releases" in [AGENTS.md](./AGENTS.md).
- One change per pull request, titled `<type>(<area>): <what it does>`.
