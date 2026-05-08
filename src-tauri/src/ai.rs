use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

const SYSTEM_PROMPT: &str = "\
You are a sharp, concise on-screen assistant. \
The user's FIRST message includes image(s) showing what they need help with. \
For follow-up questions draw freely on your knowledge — never refuse just because something isn't visible in the images.\
\n\n\
Response rules (strictly follow):\n\
- Be SHORT and DIRECT. No lengthy preambles, no filler, no re-stating the question.\n\
- For math/physics/logic: key insight + numbered solution steps. Wrap ALL math in LaTeX ($...$ inline, $$...$$ block).\n\
- For code: one-line summary + relevant fixes or explanation.\n\
- For factual/general questions: 1-3 sentences max.\n\
- Prefer bullet points or numbered steps over prose paragraphs.\n\
- If you don't know something, say so in one sentence.\
";

const PROXY_BASE:      &str  = "https://snigma-api.protobuben.workers.dev";
const SUMMARIZE_AFTER: usize = 8;
const KEEP_RECENT:     usize = 4;

#[derive(Serialize, Deserialize, Clone)]
pub struct AiMessage {
    pub role:    String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResponse {
    pub text:                 String,
    pub new_summary:          Option<String>,
    pub new_summarized_count: usize,
}

// -----------------------------------------------------------------------------
// Helpers

/// Non-streaming call routed through the Snigma proxy (/generate).
/// Used for background tasks like summarization — does not count against quota.
async fn proxy_call(
    client:      &reqwest::Client,
    license_key: &str,
    body:        &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/generate", PROXY_BASE);

    let mut attempts = 0u8;
    loop {
        attempts += 1;
        let resp = client
            .post(&url)
            .bearer_auth(license_key)
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        if status == 503 && attempts < 3 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        if !status.is_success() {
            return Err(format!("Proxy error {}: {}", status, resp.text().await.unwrap_or_default()));
        }
        return resp.json().await.map_err(|e| e.to_string());
    }
}

async fn update_summary(
    client:      &reqwest::Client,
    license_key: &str,
    existing:    Option<&str>,
    new_msgs:    &[AiMessage],
) -> Result<String, String> {
    let new_dialogue = new_msgs
        .iter()
        .map(|m| {
            let label = if m.role == "assistant" { "AI" } else { "User" };
            format!("{}: {}", label, m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let prompt = match existing {
        Some(s) => format!(
            "Update this running summary of a tutoring conversation by integrating the new exchange below. \
             Keep it 3-5 sentences total. Preserve: topic/problem, what's been figured out, key concepts, open questions. \
             Be specific, not generic.\n\n\
             EXISTING SUMMARY:\n{}\n\n\
             NEW EXCHANGE:\n{}",
            s, new_dialogue
        ),
        None => format!(
            "Summarize this earlier portion of a tutoring conversation in 3-5 sentences. \
             Preserve: topic/problem, what's been figured out, key concepts, open questions. \
             Be specific, not generic.\n\n\
             CONVERSATION:\n{}",
            new_dialogue
        ),
    };

    let body = json!({
        "contents":         [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.2, "maxOutputTokens": 512 }
    });

    let json = proxy_call(client, license_key, &body).await?;
    json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Summarization failed".to_string())
}

fn friendly_error(status: u16, body: &str) -> String {
    match status {
        401 => "No license key found — please enter your Snigma license key in settings.".to_string(),
        403 => "Invalid or inactive license key — check your subscription at snigma.github.io".to_string(),
        429 => {
            // Worker returns JSON: { error, tier, used, limit }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                let used  = v["used"].as_u64().unwrap_or(0);
                let limit = v["limit"].as_u64().unwrap_or(0);
                let tier  = v["tier"].as_str().unwrap_or("basic");
                format!(
                    "Monthly message limit reached ({}/{} on {} plan). \
                     Upgrade to Unbounded at snigma.github.io",
                    used, limit, tier
                )
            } else {
                "Monthly message limit reached — upgrade at snigma.github.io".to_string()
            }
        }
        _ => format!("API error {}: {}", status, body),
    }
}

// -----------------------------------------------------------------------------
// Command

#[tauri::command]
pub async fn send_to_ai(
    app:              AppHandle,
    license_key:      String,
    focus_b64:        String,
    focus_mime:       String,
    context_b64:      String,
    history:          Vec<AiMessage>,
    prompt:           String,
    summary:          Option<String>,
    summarized_count: usize,
) -> Result<AiResponse, String> {
    let client = reqwest::Client::new();

    let target = if history.len() > SUMMARIZE_AFTER {
        history.len() - KEEP_RECENT
    } else {
        summarized_count
    };

    let (final_summary, final_count) = if target > summarized_count {
        let new_msgs = &history[summarized_count..target];
        match update_summary(&client, &license_key, summary.as_deref(), new_msgs).await {
            Ok(s)  => (Some(s), target),
            Err(_) => (summary.clone(), summarized_count),
        }
    } else {
        (summary.clone(), summarized_count)
    };

    let mut contents: Vec<serde_json::Value> = vec![];
    if let Some(s) = &final_summary {
        contents.push(json!({
            "role":  "user",
            "parts": [{ "text": format!("[Summary of earlier conversation]\n{}", s) }]
        }));
        contents.push(json!({
            "role":  "model",
            "parts": [{ "text": "Got it — continuing from there." }]
        }));
    }
    for m in &history[final_count..] {
        let role = if m.role == "assistant" { "model" } else { "user" };
        contents.push(json!({ "role": role, "parts": [{ "text": m.content }] }));
    }

    let user_text = if prompt.is_empty() {
        "What is this?".to_string()
    } else {
        prompt
    };

    // Images are only included with the first message of a session.
    // Follow-up questions rely on the conversation history for context,
    // which saves significant tokens on multi-turn sessions.
    let mut parts: Vec<serde_json::Value> = vec![];
    if history.is_empty() {
        parts.push(json!({ "inline_data": { "mime_type": focus_mime, "data": focus_b64 } }));
        if !context_b64.is_empty() {
            parts.push(json!({ "inline_data": { "mime_type": "image/jpeg", "data": context_b64 } }));
        }
    }
    parts.push(json!({ "text": user_text }));
    contents.push(json!({ "role": "user", "parts": parts }));

    let body = json!({
        "system_instruction": { "parts": [{ "text": SYSTEM_PROMPT }] },
        "contents":           contents,
        "generationConfig":   { "temperature": 0.4, "maxOutputTokens": 2048 }
    });

    let resp = client
        .post(format!("{}/chat", PROXY_BASE))
        .bearer_auth(&license_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text   = resp.text().await.unwrap_or_default();
        return Err(friendly_error(status, &text));
    }

    let mut stream       = resp.bytes_stream();
    let mut buffer       = String::new();
    let mut full_text    = String::new();
    let mut finish_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buffer.find('\n') {
            let line_str: String = buffer.drain(..idx + 1).collect();
            let line = line_str.trim_end_matches(['\r', '\n']);

            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim_start();
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else { continue };

            if let Some(t) = json["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                full_text.push_str(t);
                let _ = app.emit("chat:stream", json!({ "chunk": t }));
            }
            if let Some(r) = json["candidates"][0]["finishReason"].as_str() {
                finish_reason = Some(r.to_string());
            }
        }
    }

    if finish_reason.as_deref() == Some("MAX_TOKENS") {
        let trail = "\n\n*— response truncated, ask me to continue —*";
        full_text.push_str(trail);
        let _ = app.emit("chat:stream", json!({ "chunk": trail }));
    }

    Ok(AiResponse {
        text:                 full_text,
        new_summary:          final_summary,
        new_summarized_count: final_count,
    })
}
