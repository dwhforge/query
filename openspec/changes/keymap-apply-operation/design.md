# Design — keymap-apply-operation

## ApplyPlan (TypeScript application layer)

```ts
ApplyUserChoice = {
  side, mapId,
  bindings: { map_column, destination_column }[],  // included outputs only
  joinRewrite?: { leftOn, rightOn },               // after keep+join toggles
}

ApplyPlan = {
  map, side,
  leftCols, rightCols,
  outputBindingsLeft?, outputBindingsRight?,
  joinIdentity?, joinRewrite?,
  mapRevision: string,  // fingerprint for stale refuse
}
```

`resolveApplyPlan(choice, joinCtx, workspace)` owns side routing and refuses incomplete Join rewrite without identity. `applyKeyMapOntoProject` takes the plan (or intent derived 1:1 from it).

## Engine

| API | Does |
|-----|------|
| `prepare_operation` | seeds + schemas + sql_models (+ listed query maps) |
| `validate_prepared` | `validate_query_backed_maps_for_root` |
| `compile_focus_sql` / `compile_ctes_from` | SQL only (caller must validate when executing Apply path) |
| `preview_workspace` | prepare → validate → compile → run |

## ApplyEmitSpec (Rust)

Built by compiler from step + `EmitSchemaOpts`; passed into `emit_apply_key_map`. No binding defaults inside emit beyond empty→error.
