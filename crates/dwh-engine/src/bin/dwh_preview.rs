use dwh_engine::{preview_pipeline, preview_workspace, DbSession};
use dwh_pipeline::{JoinType, QueryDef, TransformationStep, Workspace};
use std::env;
use std::process;

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!(
            "Usage:\n  dwh-preview <csv> [where]\n  dwh-preview --join <left.csv> <right.csv> <key> [where]"
        );
        process::exit(1);
    }

    let db = DbSession::new().unwrap_or_else(|e| {
        eprintln!("DuckDB init failed: {e}");
        process::exit(1);
    });

    let result = if args[0] == "--join" {
        if args.len() < 4 {
            eprintln!("Usage: dwh-preview --join <left.csv> <right.csv> <key> [where]");
            process::exit(1);
        }
        let left = args[1].clone();
        let right = args[2].clone();
        let key = args[3].clone();
        let filter = args.get(4).cloned();
        let mut fact_steps = vec![
            TransformationStep::LoadCsv { path: left },
            TransformationStep::Join {
                right_query_id: "right".into(),
                join_type: JoinType::Inner,
                left_on: vec![key.clone()],
                right_on: vec![key],
            },
        ];
        if let Some(condition) = filter {
            fact_steps.push(TransformationStep::Filter { condition });
        }
        let ws = Workspace {
            queries: vec![
                QueryDef {
                    id: "right".into(),
                    name: "right".into(),
                    steps: vec![TransformationStep::LoadCsv { path: right }],
                 execution: Default::default(),
},
                QueryDef {
                    id: "left".into(),
                    name: "left".into(),
                    steps: fact_steps,
                 execution: Default::default(),
},
            ],
            focus_query_id: "left".into(),
        };
        preview_workspace(&db, &ws, &[])
    } else {
        let path = args.remove(0);
        let filter = args.first().cloned();
        let mut steps = vec![TransformationStep::LoadCsv { path }];
        if let Some(condition) = filter {
            steps.push(TransformationStep::Filter { condition });
        }
        preview_pipeline(&db, &steps, &[])
    };

    match result {
        Ok(r) => {
            println!("sql:\n{}\n", r.sql);
            println!(
                "columns: {}",
                r.columns
                    .iter()
                    .map(|c| format!("{}:{}", c.name, c.col_type))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            println!("rows: {}", r.rows.len());
            for (i, row) in r.rows.iter().enumerate() {
                println!("{i}: {row:?}");
            }
        }
        Err(e) => {
            eprintln!("preview failed: {e}");
            process::exit(1);
        }
    }
}
