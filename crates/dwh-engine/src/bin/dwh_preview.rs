use dwh_engine::{preview_pipeline, DbSession};
use dwh_pipeline::TransformationStep;
use std::env;
use std::process;

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().unwrap_or_else(|| {
        eprintln!("Usage: dwh-preview <csv-path> [sql-where-condition]");
        process::exit(1);
    });
    let filter = args.next();

    let mut steps = vec![TransformationStep::LoadCsv { path }];
    if let Some(condition) = filter {
        steps.push(TransformationStep::Filter { condition });
    }

    let db = DbSession::new().unwrap_or_else(|e| {
        eprintln!("DuckDB init failed: {e}");
        process::exit(1);
    });

    match preview_pipeline(&db, &steps) {
        Ok(result) => {
            println!("sql:\n{}\n", result.sql);
            println!(
                "columns: {}",
                result
                    .columns
                    .iter()
                    .map(|c| format!("{}:{}", c.name, c.col_type))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            println!("rows: {}", result.rows.len());
            for (i, row) in result.rows.iter().enumerate() {
                println!("{i}: {row:?}");
            }
        }
        Err(e) => {
            eprintln!("preview failed: {e}");
            process::exit(1);
        }
    }
}
