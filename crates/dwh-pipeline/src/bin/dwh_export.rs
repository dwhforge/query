//! CLI twin of UI `export_dbt` — same Project/Workspace IR → dbt tree.

use dwh_pipeline::{
    list_export_tree, DbtProducer, DbtTarget, OutputProducer, Project,
};
use std::env;
use std::fs;
use std::process;

fn usage() -> ! {
    eprintln!(
        "Usage:\n  \
         dwh-export <project.json|.dwhproj.json> <output_dir> [--name NAME] [--target v1|v2]\n\n\
         Reads Project (workspace + dbt_target), writes a dbt project under output_dir/<name>/\n\
         and prints the relative file tree."
    );
    process::exit(1);
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 2 {
        usage();
    }

    let project_path = args.remove(0);
    let output_dir = args.remove(0);

    let mut name_override: Option<String> = None;
    let mut target_override: Option<DbtTarget> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--name" => {
                i += 1;
                name_override = Some(args.get(i).cloned().unwrap_or_else(|| usage()));
            }
            "--target" => {
                i += 1;
                let t = args.get(i).map(|s| s.as_str()).unwrap_or_else(|| usage());
                target_override = Some(match t {
                    "v1" => DbtTarget::V1,
                    "v2" => DbtTarget::V2,
                    _ => {
                        eprintln!("Unknown --target {t} (use v1 or v2)");
                        process::exit(1);
                    }
                });
            }
            "-h" | "--help" => usage(),
            other => {
                eprintln!("Unknown argument: {other}");
                usage();
            }
        }
        i += 1;
    }

    let raw = fs::read_to_string(&project_path).unwrap_or_else(|e| {
        eprintln!("Failed to read {project_path}: {e}");
        process::exit(1);
    });
    let project = Project::from_json(&raw).unwrap_or_else(|e| {
        eprintln!("Invalid project JSON: {e}");
        process::exit(1);
    });

    if project.workspace.queries.is_empty() {
        eprintln!("Project has no queries");
        process::exit(1);
    }

    let pipeline_name = name_override.unwrap_or_else(|| {
        let n = project.name.trim();
        if n.is_empty() || n == "Untitled" {
            "dwh_rs_query".into()
        } else {
            n.replace(|c: char| c.is_whitespace(), "_").to_lowercase()
        }
    });
    let target = target_override.unwrap_or(project.dbt_target);

    let path = DbtProducer
        .produce(
            &pipeline_name,
            &project.workspace,
            &output_dir,
            target,
        )
        .unwrap_or_else(|e| {
            eprintln!("export failed: {e}");
            process::exit(1);
        });

    let files = list_export_tree(&path).unwrap_or_else(|e| {
        eprintln!("export wrote {path} but tree listing failed: {e}");
        process::exit(1);
    });

    println!("dbt {} → {}", target.as_str(), path);
    for f in &files {
        println!("  {f}");
    }
}
