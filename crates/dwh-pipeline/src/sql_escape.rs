/// Escape a string for use inside a single-quoted SQL literal.
pub fn escape_sql_string(value: &str) -> String {
    value.replace('\'', "''")
}

/// Quote an identifier with double quotes, escaping embedded quotes.
pub fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}
