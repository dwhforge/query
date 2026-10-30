//! OpenAI-compatible chat completions.
//!
//! Connection lives in `~/.dwhforge-query/settings.json` under `llm`
//! (`base_url`, `model`, `api_key`). The key is not returned by get_app_settings.

use crate::settings_io::LlmSettings;
use serde_json::{json, Value};
use std::time::Duration;

/// Build `{base}/chat/completions`, or keep a URL that already ends there.
pub fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("llm.base_url is empty".into());
    }
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("llm.base_url must start with http:// or https://".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

pub fn complete_chat(settings: &LlmSettings, messages: &[Value]) -> Result<String, String> {
    let key = settings.api_key.trim();
    // Empty key is allowed for local OpenAI-compatible servers without auth.
    let model = settings.model.trim();
    if model.is_empty() {
        return Err("llm.model is empty. Set it in ~/.dwhforge-query/settings.json.".into());
    }
    if messages.is_empty() {
        return Err("llm_chat: messages is empty".into());
    }
    if messages.len() > 32 {
        return Err("llm_chat: at most 32 messages".into());
    }
    let mut clean = Vec::with_capacity(messages.len());
    for (i, msg) in messages.iter().enumerate() {
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !matches!(role, "system" | "user" | "assistant") {
            return Err(format!("llm_chat: message {i} role must be system, user, or assistant"));
        }
        let content = msg
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if content.chars().count() > 12_000 {
            return Err(format!("llm_chat: message {i} is longer than 12000 characters"));
        }
        if content.trim().is_empty() {
            return Err(format!("llm_chat: message {i} is empty"));
        }
        clean.push(json!({ "role": role, "content": content }));
    }
    let url = chat_completions_url(&settings.base_url)?;
    let body = json!({
        "model": model,
        "temperature": 0.2,
        "messages": clean,
    });
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(90))
        .build();
    let mut req = agent
        .post(&url)
        .set("Content-Type", "application/json");
    if !key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    let response = req.send_json(body).map_err(|e| match e {
        ureq::Error::Status(code, resp) => {
            let text = resp.into_string().unwrap_or_default();
            let snippet: String = text.chars().take(400).collect();
            if code == 401 || code == 403 {
                "LLM rejected credentials. Set llm.api_key or use a no-auth local endpoint."
                    .to_string()
            } else {
                format!("LLM HTTP {code}: {snippet}")
            }
        }
        other => format!("LLM request failed: {other}"),
    })?;
    let parsed: Value = response
        .into_json()
        .map_err(|e| format!("LLM response was not JSON: {e}"))?;
    message_text(&parsed)
}

fn message_text(parsed: &Value) -> Result<String, String> {
    let content = &parsed["choices"][0]["message"]["content"];
    if let Some(s) = content.as_str() {
        if !s.trim().is_empty() {
            return Ok(s.to_string());
        }
    }
    if let Some(parts) = content.as_array() {
        let mut out = String::new();
        for part in parts {
            if let Some(t) = part.as_str() {
                out.push_str(t);
            } else if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                out.push_str(t);
            }
        }
        if !out.trim().is_empty() {
            return Ok(out);
        }
    }
    Err("LLM response had no message content".into())
}

#[cfg(test)]
mod tests {
    use super::chat_completions_url;

    #[test]
    fn appends_chat_completions() {
        assert_eq!(
            chat_completions_url("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://127.0.0.1:11434/v1/chat/completions").unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );
        assert!(chat_completions_url("ftp://nope").is_err());
    }
}
