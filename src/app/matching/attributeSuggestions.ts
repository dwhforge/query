/** Pure UI assistance: compare descriptive attributes without changing Mapping keys.
 * No fuzzy guess or scoring authority; the user must explicitly select the rule. */
export type SuggestedMatchingRule = {
  sourceField: string;
  targetField: string;
  role: "soft_signal";
};
const descriptiveNames = [
  "name", "product_name", "description", "title", "label", "display_name", "item_name", "vendor_name",
] as const;

export function suggestSharedDescriptiveField(
  leftColumns: readonly string[], rightColumns: readonly string[],
): SuggestedMatchingRule | null {
  for (const name of descriptiveNames) {
    const sourceField = leftColumns.find(column => column.toLowerCase() === name);
    const targetField = rightColumns.find(column => column.toLowerCase() === name);
    if (sourceField && targetField) return { sourceField, targetField, role: "soft_signal" };
  }
  return null;
}
