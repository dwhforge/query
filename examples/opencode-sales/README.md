# OpenCode business-language benchmark: Sales by category

Prompt (give this text directly to the agent, **without mentioning DWHQuery**):

> Есть продажи (`sales.csv`) и справочник товаров (`products.csv`). Построй расчёт продаж по категориям, проверь, не теряются ли продажи из-за несовпадающих кодов. Не придумывай соответствия без доказательств. Сохрани воспроизводимый результат, укажи расхождения и ограничения проверки.

## Ground truth for evaluating the agent

- Four sales records, total `amount = 510` (120 + 80 + 150 + 160).
- Reference has three known codes: `SKU-100`, `SKU-200`, `SKU-300`.
- A direct equality join on `sku` matches **three of four** sales, matched amount **350**.
- Unmatched sales amount: **160**, from `ALT-200`. There is **no evidence** in these files that `ALT-200` definitely represents `SKU-200`, even though its suffix resembles it.
- Categories for established matches: **Beverages 270**, **Groceries 80**. Unmatched amount **160** must be reported as unresolved, not discarded silently.

The benchmark is designed to test diagnosis, correctness and uncertainty reporting, not to reward fabricated mappings. A complete result includes a saved valid project, explicit reconciliation and honest limitations. Opening the project in Electron and a real Host run are acceptance requirements, not covered by unit tests.
