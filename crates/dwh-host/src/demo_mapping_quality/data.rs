//! Deterministic moderate-scale data. Regenerate privately, then publish the complete directory.
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const FAMILIES: [&str; 6] = ["Urea", "NPK", "Ammonia", "Sulfur", "Methanol", "Phosphate"];
const VERSION: &str = "mapping-quality-v1";
pub const POSITIONS: usize = 100_000;

pub struct Files {
    pub commercial: PathBuf,
    pub catalog: PathBuf,
    pub mapping: PathBuf,
}
fn files(root: &Path) -> Files {
    Files {
        commercial: root.join("commercial.csv"),
        catalog: root.join("catalog.csv"),
        mapping: root.join("mapping.csv"),
    }
}
fn complete(root: &Path) -> bool {
    let files = files(root);
    root.join("complete").is_file()
        && files.commercial.is_file()
        && files.catalog.is_file()
        && files.mapping.is_file()
}

pub fn ensure(cache: &Path) -> io::Result<Files> {
    fs::create_dir_all(cache)?;
    let destination = cache.join(VERSION);
    if complete(&destination) {
        return Ok(files(&destination));
    }
    // Never overwrite an incomplete/user-edited cache silently.
    if destination.exists() {
        return Err(io::Error::other(
            "Incomplete demo cache; rename it before regenerating",
        ));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let staging = cache.join(format!(".{VERSION}-{}-{nonce}", std::process::id()));
    fs::create_dir(&staging)?;
    if let Err(error) = generate(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        let _ = fs::remove_dir_all(&staging);
        if !complete(&destination) {
            return Err(error);
        }
    }
    Ok(files(&destination))
}

fn canonical(family: usize, grade: &str, number: usize) -> String {
    format!("P{family}-{grade}-{number:03}")
}

fn generate(root: &Path) -> io::Result<()> {
    let paths = files(root);
    let mut commercial = BufWriter::new(File::create(paths.commercial)?);
    let mut catalog = BufWriter::new(File::create(paths.catalog)?);
    let mut mapping = BufWriter::new(File::create(paths.mapping)?);
    writeln!(commercial, "commercial_sku,source_family,source_grade,packaging,decision_method,similarity_score,runner_up_gap,revenue")?;
    writeln!(
        catalog,
        "product_id,target_family,target_grade,product_name"
    )?;
    writeln!(mapping, "from,to")?;
    for (family, name) in FAMILIES.iter().enumerate() {
        for grade in ["A", "B"] {
            for product in 0..200 {
                writeln!(
                    catalog,
                    "{},{name},{grade},{name} grade {grade} product {product}",
                    canonical(family, grade, product)
                )?;
            }
        }
    }
    for i in 0..POSITIONS {
        let grade = if (i / 6) % 2 == 0 { "A" } else { "B" };
        let (source_family, source_grade, target_family, target_grade, product, method, score, gap) =
            match i {
                0..40_000 => (i % 6, grade, i % 6, grade, (i / 12) % 200, "rule", "", ""),
                40_000..55_000 => (1, "B", 1, "A", i % 200, "rule", "", ""),
                55_000..65_000 => (3, "A", 0, "A", i % 200, "manual", "", ""),
                65_000..75_000 => (
                    2,
                    if i % 2 == 0 { "A" } else { "B" },
                    2,
                    "A",
                    0,
                    "manual",
                    "",
                    "",
                ),
                75_000..85_000 => (4, grade, 4, grade, i % 200, "fuzzy", "0.89", "0.12"),
                85_000..95_000 => (5, grade, 5, grade, i % 200, "fuzzy", "0.93", "0.005"),
                _ => (i % 6, grade, i % 6, grade, i % 200, "none", "", ""),
            };
        let sku = format!("C{i:06}");
        let package = ["bulk", "bag_25kg", "bag_50kg", "big_bag"][(i / 2400) % 4];
        let revenue = (100 + i % 500) * 10;
        writeln!(
            commercial,
            "{sku},{},{source_grade},{package},{method},{score},{gap},{revenue}",
            FAMILIES[source_family]
        )?;
        if i < 95_000 {
            writeln!(
                mapping,
                "{sku},{}",
                canonical(target_family, target_grade, product)
            )?;
        }
    }
    commercial.flush()?;
    catalog.flush()?;
    mapping.flush()?;
    fs::write(root.join("complete"), format!("{VERSION}\n{POSITIONS}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_is_complete_and_reusable() {
        let root = std::env::temp_dir().join(format!("dwh-quality-data-{}", std::process::id()));
        let first = ensure(&root).unwrap();
        let second = ensure(&root).unwrap();
        assert_eq!(first.commercial, second.commercial);
        assert_eq!(
            fs::read_to_string(first.commercial)
                .unwrap()
                .lines()
                .count(),
            POSITIONS + 1
        );
        assert_eq!(
            fs::read_to_string(first.mapping).unwrap().lines().count(),
            95_001
        );
        assert_eq!(
            fs::read_to_string(first.catalog).unwrap().lines().count(),
            2_401
        );
        fs::remove_dir_all(root).unwrap();
    }
}
