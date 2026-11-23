use agent_client_protocol::JsonRpcRequest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::EmptyResponse;

pub const REQUEST_APP_TOOL_CALL_METHOD: &str = "_goose/unstable/session/app-tools/call";

/// A tool an MCP App fragment registered with WebMCP's `registerTool`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppToolDescriptor {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Replace the tools one MCP App fragment offers the agent. An empty list
/// withdraws them, e.g. when the fragment's document goes away.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/session/app-tools/sync",
    response = EmptyResponse
)]
#[serde(rename_all = "camelCase")]
pub struct SyncAppToolsRequest {
    pub session_id: String,
    /// Identifies one loaded fragment document. A reload gets a new id.
    pub app_instance_id: String,
    pub extension_name: String,
    #[serde(default)]
    pub tools: Vec<AppToolDescriptor>,
}

/// Ask the client to run a tool inside the fragment that registered it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestAppToolCall {
    pub session_id: String,
    pub app_instance_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppToolCallResponse {
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub is_error: bool,
}
