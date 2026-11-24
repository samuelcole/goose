//! A web pane the client shows beside a chat. Clients that can show one register
//! per session; the agent's pane tools then ask that client to open or close it.
//! Pages loaded there offer tools through the app tools registry.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use crate::agents::extension::{ExtensionConfig, DEFAULT_EXTENSION_TIMEOUT};
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use goose_acp_types::custom_requests::WebPaneOpenResponse;
use tokio_util::sync::CancellationToken;

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(120);

#[async_trait]
pub trait WebPaneClient: Send + Sync {
    async fn open(&self, session_id: &str, url: &str) -> Result<WebPaneOpenResponse>;
    async fn close(&self, session_id: &str) -> Result<()>;
}

struct Registration {
    connection_id: u64,
    client: Arc<dyn WebPaneClient>,
}

#[derive(Default)]
pub struct WebPaneRegistry {
    sessions: Mutex<HashMap<String, Registration>>,
    /// The extension key of the MCP server of the site open in each chat's pane.
    site_servers: Mutex<HashMap<String, String>>,
}

pub static WEB_PANES: LazyLock<WebPaneRegistry> = LazyLock::new(WebPaneRegistry::default);

/// The extension for a site's own MCP server, named after its host.
pub fn site_server_config(url: &str, title: &str) -> Result<ExtensionConfig> {
    let url = validate_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("the server URL has no host"))?
        .to_string();
    let label = match title.trim() {
        "" => host.as_str(),
        title => title,
    };
    let description = format!(
        "{label}: the MCP server of {}, the site open in the web pane.",
        url.origin().ascii_serialization()
    );
    Ok(ExtensionConfig::streamable_http(
        host.clone(),
        url.to_string(),
        description,
        DEFAULT_EXTENSION_TIMEOUT,
    ))
}

pub fn validate_url(url: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(url).map_err(|e| anyhow!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("only http and https URLs can be opened in the web pane");
    }
    Ok(parsed)
}

impl WebPaneRegistry {
    pub fn register(&self, connection_id: u64, session_id: &str, client: Arc<dyn WebPaneClient>) {
        self.sessions
            .lock()
            .expect("web pane registry poisoned")
            .insert(
                session_id.to_string(),
                Registration {
                    connection_id,
                    client,
                },
            );
    }

    pub fn drop_connection(&self, connection_id: u64) {
        self.sessions
            .lock()
            .expect("web pane registry poisoned")
            .retain(|_, registration| registration.connection_id != connection_id);
    }

    /// Records the chat's site server, returning the one it replaces.
    pub fn set_site_server(&self, session_id: &str, key: Option<String>) -> Option<String> {
        let mut servers = self
            .site_servers
            .lock()
            .expect("web pane registry poisoned");
        match key {
            Some(key) => servers.insert(session_id.to_string(), key),
            None => servers.remove(session_id),
        }
    }

    pub fn site_server(&self, session_id: &str) -> Option<String> {
        self.site_servers
            .lock()
            .expect("web pane registry poisoned")
            .get(session_id)
            .cloned()
    }

    pub fn is_site_server(&self, session_id: &str, extension_key: &str) -> bool {
        self.site_servers
            .lock()
            .expect("web pane registry poisoned")
            .get(session_id)
            .is_some_and(|key| key == extension_key)
    }

    pub fn is_available(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .expect("web pane registry poisoned")
            .contains_key(session_id)
    }

    fn client(&self, session_id: &str) -> Result<Arc<dyn WebPaneClient>> {
        self.sessions
            .lock()
            .expect("web pane registry poisoned")
            .get(session_id)
            .map(|registration| registration.client.clone())
            .ok_or_else(|| anyhow!("no web pane is available for this chat"))
    }

    pub async fn open(
        &self,
        session_id: &str,
        url: &str,
        cancel: CancellationToken,
    ) -> Result<WebPaneOpenResponse> {
        let url = validate_url(url)?;
        let client = self.client(session_id)?;
        tokio::select! {
            result = tokio::time::timeout(OPEN_TIMEOUT, client.open(session_id, url.as_str())) => {
                result.map_err(|_| anyhow!("opening {url} timed out"))?
            }
            _ = cancel.cancelled() => bail!("opening {url} was cancelled"),
        }
    }

    pub async fn close(&self, session_id: &str) -> Result<()> {
        self.client(session_id)?.close(session_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingClient {
        opened: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl WebPaneClient for RecordingClient {
        async fn open(&self, _session_id: &str, url: &str) -> Result<WebPaneOpenResponse> {
            self.opened.lock().unwrap().push(url.to_string());
            Ok(WebPaneOpenResponse {
                url: url.to_string(),
                title: "Page".to_string(),
            })
        }

        async fn close(&self, _session_id: &str) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn site_server_is_named_after_its_host() {
        let config = site_server_config("https://tale.fyi/api/mcp", "tale.fyi").unwrap();
        assert_eq!(config.key(), "tale_fyi");
        assert!(site_server_config("file:///tmp/mcp", "").is_err());

        let registry = WebPaneRegistry::default();
        assert_eq!(registry.set_site_server("s1", Some(config.key())), None);
        assert!(registry.is_site_server("s1", "tale_fyi"));
        assert!(!registry.is_site_server("s2", "tale_fyi"));
        assert_eq!(
            registry.set_site_server("s1", None),
            Some("tale_fyi".to_string())
        );
        assert!(!registry.is_site_server("s1", "tale_fyi"));
    }

    #[test]
    fn only_http_urls_are_allowed() {
        assert!(validate_url("https://tale.fyi/all-quiet").is_ok());
        assert!(validate_url("http://localhost:3000/").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "goose://x",
            "not a url",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn opens_through_the_registered_client_until_its_connection_drops() {
        let registry = WebPaneRegistry::default();
        let client = Arc::new(RecordingClient {
            opened: Mutex::new(Vec::new()),
        });
        registry.register(7, "s1", client.clone());
        assert!(registry.is_available("s1"));

        registry
            .open("s1", "https://tale.fyi/all-quiet", CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            *client.opened.lock().unwrap(),
            vec!["https://tale.fyi/all-quiet"]
        );

        registry.drop_connection(7);
        assert!(!registry.is_available("s1"));
        assert!(registry
            .open("s1", "https://tale.fyi/", CancellationToken::new())
            .await
            .is_err());
    }
}
