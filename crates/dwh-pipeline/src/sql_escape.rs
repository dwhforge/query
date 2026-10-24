/// Escape a string for use inside a single-quoted SQL literal.
pub fn escape_sql_string(value: &str) -> String {
    value.replace('\'', "''")
}

/// Quote an identifier with double quotes, escaping embedded quotes.
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Sanitize query id for CTE names: alnum + underscore.
pub fn sanitize_cte_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if s.is_empty() {
        "q".into()
    } else if s.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("q_{s}")
    } else {
        s
    }
}

pub fn cte_name(query_id: &str, step_idx: usize) -> String {
    format!("q_{}_s{}", sanitize_cte_id(query_id), step_idx)
}
