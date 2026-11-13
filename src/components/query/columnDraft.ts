/** Visible authoring text is not the normalized SelectColumns IR. */
export interface ColumnDraft {
  text: string;
  selected: string[];
}

export function chooseColumns(columns: string[]): ColumnDraft {
  return { text: columns.join(", "), selected: [...columns] };
}

export function editColumnText(text: string): ColumnDraft {
  return { text, selected: text.split(",").map(column => column.trim()).filter(Boolean) };
}

export function toggleColumn(draft: ColumnDraft, name: string): ColumnDraft {
  return chooseColumns(draft.selected.includes(name)
    ? draft.selected.filter(column => column !== name)
    : [...draft.selected, name]);
}
