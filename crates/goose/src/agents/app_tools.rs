//! Tools that MCP App fragments register with WebMCP's `registerTool`.
//!
//! A fragment's handlers run inside its iframe in the client, so the registry
//! only keeps descriptors plus a way to call back into the client that synced
//! them. Each sync replaces that fragment's whole list; an empty list removes it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use goose_acp_types::custom_requests::{
    AppToolCallResponse, AppToolDescriptor, RequestAppToolCall,
};
use tokio_util::sync::CancellationToken;

pub const MAX_TOOLS_PER_APP: usize = 64;
const MAX_TOOL_NAME_LEN: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 4 * 1024;
const MAX_INPUT_SCHEMA_BYTES: usize = 64 * 1024;
const MAX_EXPOSED_NAME_LEN: usize = 48;
pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[async_trait]
pub trait AppToolCaller: Send + Sync {
    async fn call(&self, request: RequestAppToolCall) -> Result<AppToolCallResponse>;

    /// Best effort: tells the app to abort a call goose stopped waiting for.
    fn cancel(&self, request: &RequestAppToolCall);
}

struct AppEntry {
    connection_id: u64,
    extension_name: String,
    tools: Vec<AppToolDescriptor>,
    caller: Arc<dyn AppToolCaller>,
    synced_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExposedAppTool {
    pub exposed_name: String,
    pub app_instance_id: String,
    pub descriptor: AppToolDescriptor,
}

#[derive(Default)]
pub struct AppToolsRegistry {
    sessions: Mutex<HashMap<String, HashMap<String, AppEntry>>>,
    sync_counter: AtomicU64,
}

pub static APP_TOOLS: LazyLock<AppToolsRegistry> = LazyLock::new(AppToolsRegistry::default);

fn validate(tools: &[AppToolDescriptor]) -> Result<()> {
    if tools.len() > MAX_TOOLS_PER_APP {
        bail!("an app may register at most {MAX_TOOLS_PER_APP} tools");
    }
    let mut seen = std::collections::HashSet::new();
    for tool in tools {
        let name_ok = !tool.name.is_empty()
            && tool.name.len() <= MAX_TOOL_NAME_LEN
            && tool
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        if !name_ok {
            bail!("invalid app tool name");
        }
        if !seen.insert(tool.name.as_str()) {
            bail!("duplicate app tool name");
        }
        if tool.description.trim().is_empty() || tool.description.len() > MAX_DESCRIPTION_BYTES {
            bail!("app tool description must be 1 to {MAX_DESCRIPTION_BYTES} bytes");
        }
        if let Some(schema) = &tool.input_schema {
            if serde_json::to_vec(schema)?.len() > MAX_INPUT_SCHEMA_BYTES {
                bail!("app tool input schema exceeds {MAX_INPUT_SCHEMA_BYTES} bytes");
            }
        }
    }
    Ok(())
}

// Provider tool names allow only [A-Za-z0-9_-] and are length-limited, so the
// app's name and the tool's name are folded into that alphabet.
fn exposed_name(extension_name: &str, tool_name: &str) -> String {
    let sanitized: String = format!("{extension_name}_{tool_name}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    sanitized.chars().take(MAX_EXPOSED_NAME_LEN).collect()
}

impl AppToolsRegistry {
    pub fn sync(
        &self,
        connection_id: u64,
        session_id: &str,
        app_instance_id: &str,
        extension_name: &str,
        tools: Vec<AppToolDescriptor>,
        caller: Arc<dyn AppToolCaller>,
    ) -> Result<()> {
        validate(&tools)?;
        let mut sessions = self.sessions.lock().expect("app tools registry poisoned");
        let apps = sessions.entry(session_id.to_string()).or_default();
        if tools.is_empty() {
            apps.remove(app_instance_id);
            if apps.is_empty() {
                sessions.remove(session_id);
            }
            return Ok(());
        }
        let synced_at = self.sync_counter.fetch_add(1, Ordering::Relaxed);
        apps.insert(
            app_instance_id.to_string(),
            AppEntry {
                connection_id,
                extension_name: extension_name.to_string(),
                tools,
                caller,
                synced_at,
            },
        );
        Ok(())
    }

    /// A client connection that went away takes its fragments' tools with it, so a
    /// reloaded window can't leave registrations behind. Entries synced over other
    /// connections stay, even if that connection closes after a newer one opened.
    pub fn drop_connection(&self, connection_id: u64) {
        let mut sessions = self.sessions.lock().expect("app tools registry poisoned");
        for apps in sessions.values_mut() {
            apps.retain(|_, entry| entry.connection_id != connection_id);
        }
        sessions.retain(|_, apps| !apps.is_empty());
    }

    /// When two fragments expose the same name, the most recently synced one wins,
    /// so the agent reaches the fragment the user opened last.
    pub fn list(&self, session_id: &str) -> Vec<ExposedAppTool> {
        let sessions = self.sessions.lock().expect("app tools registry poisoned");
        let Some(apps) = sessions.get(session_id) else {
            return Vec::new();
        };
        let mut entries: Vec<(&String, &AppEntry)> = apps.iter().collect();
        entries.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.synced_at));

        let mut seen = std::collections::HashSet::new();
        let mut exposed = Vec::new();
        for (instance_id, entry) in entries {
            for tool in &entry.tools {
                let name = exposed_name(&entry.extension_name, &tool.name);
                if seen.insert(name.clone()) {
                    exposed.push(ExposedAppTool {
                        exposed_name: name,
                        app_instance_id: instance_id.clone(),
                        descriptor: tool.clone(),
                    });
                }
            }
        }
        exposed.sort_by(|a, b| a.exposed_name.cmp(&b.exposed_name));
        exposed
    }

    pub async fn call(
        &self,
        session_id: &str,
        exposed: &str,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
        cancel: CancellationToken,
    ) -> Result<AppToolCallResponse> {
        let tool = self
            .list(session_id)
            .into_iter()
            .find(|tool| tool.exposed_name == exposed)
            .ok_or_else(|| anyhow!("app tool {exposed} is no longer available"))?;
        let caller = {
            let sessions = self.sessions.lock().expect("app tools registry poisoned");
            sessions
                .get(session_id)
                .and_then(|apps| apps.get(&tool.app_instance_id))
                .map(|entry| entry.caller.clone())
                .ok_or_else(|| anyhow!("app tool {exposed} is no longer available"))?
        };
        let request = RequestAppToolCall {
            session_id: session_id.to_string(),
            app_instance_id: tool.app_instance_id,
            call_id: uuid::Uuid::now_v7().to_string(),
            name: tool.descriptor.name,
            arguments,
        };
        tokio::select! {
            result = tokio::time::timeout(CALL_TIMEOUT, caller.call(request.clone())) => match result {
                Ok(response) => response,
                Err(_) => {
                    caller.cancel(&request);
                    bail!("app tool {exposed} timed out")
                }
            },
            _ = cancel.cancelled() => {
                caller.cancel(&request);
                bail!("app tool {exposed} was cancelled")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoCaller;

    #[async_trait]
    impl AppToolCaller for EchoCaller {
        async fn call(&self, request: RequestAppToolCall) -> Result<AppToolCallResponse> {
            Ok(AppToolCallResponse {
                text: format!("{}:{}", request.app_instance_id, request.name),
                ..Default::default()
            })
        }

        fn cancel(&self, _request: &RequestAppToolCall) {}
    }

    #[derive(Default)]
    struct HangingCaller {
        cancelled: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl AppToolCaller for HangingCaller {
        async fn call(&self, _request: RequestAppToolCall) -> Result<AppToolCallResponse> {
            std::future::pending().await
        }

        fn cancel(&self, request: &RequestAppToolCall) {
            self.cancelled.lock().unwrap().push(request.call_id.clone());
        }
    }

    fn tool(name: &str) -> AppToolDescriptor {
        AppToolDescriptor {
            name: name.to_string(),
            description: "does a thing".to_string(),
            input_schema: None,
        }
    }

    fn sync(registry: &AppToolsRegistry, instance: &str, tools: Vec<AppToolDescriptor>) {
        sync_on(registry, 1, instance, tools);
    }

    fn sync_on(
        registry: &AppToolsRegistry,
        connection_id: u64,
        instance: &str,
        tools: Vec<AppToolDescriptor>,
    ) {
        registry
            .sync(
                connection_id,
                "s1",
                instance,
                "tale",
                tools,
                Arc::new(EchoCaller),
            )
            .unwrap();
    }

    #[test]
    fn sync_replaces_and_empty_removes() {
        let registry = AppToolsRegistry::default();
        sync(&registry, "a", vec![tool("one"), tool("two")]);
        sync(&registry, "a", vec![tool("three")]);
        let names: Vec<_> = registry
            .list("s1")
            .into_iter()
            .map(|t| t.exposed_name)
            .collect();
        assert_eq!(names, vec!["tale_three"]);

        sync(&registry, "a", vec![]);
        assert!(registry.list("s1").is_empty());
    }

    #[test]
    fn rejects_bad_descriptors_as_a_whole() {
        let registry = AppToolsRegistry::default();
        let too_many: Vec<_> = (0..=MAX_TOOLS_PER_APP)
            .map(|i| tool(&format!("t{i}")))
            .collect();
        let long_description = AppToolDescriptor {
            description: "x".repeat(MAX_DESCRIPTION_BYTES + 1),
            ..tool("ok")
        };
        for tools in [
            vec![tool("has space")],
            vec![tool("")],
            vec![tool("dup"), tool("dup")],
            vec![tool("ok"), long_description],
            too_many,
        ] {
            assert!(registry
                .sync(1, "s1", "a", "tale", tools, Arc::new(EchoCaller))
                .is_err());
        }
        assert!(registry.list("s1").is_empty());
    }

    #[test]
    fn exposed_names_fit_provider_rules() {
        assert_eq!(
            exposed_name("tale", "reading.position"),
            "tale_reading_position"
        );
        assert_eq!(
            exposed_name("tale", &"x".repeat(100)).len(),
            MAX_EXPOSED_NAME_LEN
        );
    }

    #[tokio::test]
    async fn latest_fragment_wins_and_calls_route_to_it() {
        let registry = AppToolsRegistry::default();
        sync(&registry, "old", vec![tool("position")]);
        sync(&registry, "new", vec![tool("position")]);

        let listed = registry.list("s1");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].app_instance_id, "new");

        let response = registry
            .call("s1", "tale_position", None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.text, "new:position");

        sync(&registry, "new", vec![]);
        let response = registry
            .call("s1", "tale_position", None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(response.text, "old:position");
    }

    #[test]
    fn closing_a_connection_drops_only_its_registrations() {
        let registry = AppToolsRegistry::default();
        sync_on(&registry, 1, "old-window", vec![tool("position")]);
        sync_on(&registry, 2, "new-window", vec![tool("chapters")]);

        registry.drop_connection(1);

        let names: Vec<_> = registry
            .list("s1")
            .into_iter()
            .map(|t| t.exposed_name)
            .collect();
        assert_eq!(names, vec!["tale_chapters"]);
    }

    #[tokio::test]
    async fn cancelling_a_call_tells_the_app() {
        let registry = AppToolsRegistry::default();
        let caller = Arc::new(HangingCaller::default());
        registry
            .sync(1, "s1", "a", "tale", vec![tool("position")], caller.clone())
            .unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let error = registry
            .call("s1", "tale_position", None, cancel)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        assert_eq!(caller.cancelled.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn calling_a_withdrawn_tool_fails() {
        let registry = AppToolsRegistry::default();
        let error = registry
            .call("s1", "tale_position", None, CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("no longer available"));
    }
}
