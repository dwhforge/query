pub mod dbt;

pub use dbt::DbtProducer;

use crate::model::Workspace;

pub trait OutputProducer {
    fn produce(
        &self,
        pipeline_name: &str,
        workspace: &Workspace,
        output_dir: &str,
    ) -> Result<String, String>;
}
