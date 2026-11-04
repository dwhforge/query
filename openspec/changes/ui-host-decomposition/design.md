# Design — ui-host-decomposition (checks)

```text
src/app/mappingChecks/
  service.ts     # pure plans / IR patches (ADR-0027)
  service.test.ts
  index.ts
```

`App.tsx` calls service functions, then applies `setProject` / UI side effects (lens, progress).

Domain helpers stay in `src/lib/mappingCheck.ts`; service composes them into use-cases.
