pub mod dbt;

pub use dbt::{preview_dbt_model_sql, DbtProducer, PreviewDbtModel};

use crate::model::Workspace;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DbtTarget {
    #[default]
    V1,
    V2,
}

impl DbtTarget {
    pub fn require_dbt_version(&self) -> &'static str {
        match self {
            DbtTarget::V1 => "\">=1.7.0,<2.0.0\"",
            DbtTarget::V2 => "\">=2.0.0,<3.0.0\"",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            DbtTarget::V1 => "v1",
            DbtTarget::V2 => "v2",
        }
    }
}

pub trait OutputProducer {
    fn produce(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
        target: DbtTarget,
    ) -> Result<String, String>;
}
