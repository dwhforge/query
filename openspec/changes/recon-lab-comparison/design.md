# Design: Existing query destinations

Add three semantic destination definitions to the existing scenario module, not
the discovery catalog. Resolve actual step indices on each render; original uses
its Join, examples and reconciliation use the current final step. Reuse the same
selection/editor/Data actions as Show me. Comparison navigation turns off hints
so it does not fight the user's chosen investigation path. Do not change focus
publication, graph steps, Mapping semantics or preview sampling policy.

Provide concise partial-example and sample/recompute instructions. No metrics
are added because no live before/after diagnostic snapshot is owned by this card.
Unit target-resolution tests and Electron actual query/preview navigation are
the objective gate. Mapping correction uses the existing editor, not tutorial automation.
