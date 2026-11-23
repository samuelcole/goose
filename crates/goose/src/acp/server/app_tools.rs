use std::sync::Arc;

use agent_client_protocol::{
    Client, ConnectionTo, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, UntypedMessage,
};
use async_trait::async_trait;
use goose_acp_types::custom_notifications::CancelAppToolCallNotification;
use goose_acp_types::custom_requests::{
    AppToolCallResponse, EmptyResponse, RequestAppToolCall, SyncAppToolsRequest,
    REQUEST_APP_TOOL_CALL_METHOD,
};
use tokio::sync::oneshot;

use super::AcpConnection;
use crate::agents::app_tools::{AppToolCaller, APP_TOOLS};

/// Runs app tool calls in the client connection that registered the tools,
/// since that is where the fragment's handlers live.
struct ConnectionAppToolCaller {
    cx: ConnectionTo<Client>,
}

#[async_trait]
impl AppToolCaller for ConnectionAppToolCaller {
    async fn call(&self, request: RequestAppToolCall) -> anyhow::Result<AppToolCallResponse> {
        let (tx, rx) = oneshot::channel();
        self.cx
            .send_request(RequestAppToolCallMessage(request))
            .on_receiving_result(move |result| async move {
                let _ = tx.send(result.map(|response| response.0));
                Ok(())
            })
            .map_err(|e| anyhow::anyhow!("failed to reach the app: {e:?}"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("the app went away before answering"))?
            .map_err(|e| anyhow::anyhow!("the app failed to run the tool: {}", e.message))
    }

    fn cancel(&self, request: &RequestAppToolCall) {
        let notification = CancelAppToolCallNotification {
            session_id: request.session_id.clone(),
            app_instance_id: request.app_instance_id.clone(),
            call_id: request.call_id.clone(),
        };
        if let Err(e) = self.cx.send_notification(notification) {
            tracing::warn!("Failed to send app tool cancel notification: {}", e);
        }
    }
}

impl AcpConnection {
    pub(super) async fn on_sync_app_tools(
        &self,
        cx: &ConnectionTo<Client>,
        req: SyncAppToolsRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        if !self.has_session(&req.session_id) {
            return Err(agent_client_protocol::Error::resource_not_found(Some(
                req.session_id.clone(),
            ))
            .data(format!("Session not found: {}", req.session_id)));
        }
        APP_TOOLS
            .sync(
                self.connection_id,
                &req.session_id,
                &req.app_instance_id,
                &req.extension_name,
                req.tools,
                Arc::new(ConnectionAppToolCaller { cx: cx.clone() }),
            )
            .map_err(|e| agent_client_protocol::Error::invalid_params().data(e.to_string()))?;
        Ok(EmptyResponse {})
    }
}

#[derive(Debug, Clone)]
struct RequestAppToolCallMessage(RequestAppToolCall);

impl JsonRpcMessage for RequestAppToolCallMessage {
    fn matches_method(method: &str) -> bool {
        method == REQUEST_APP_TOOL_CALL_METHOD
    }

    fn method(&self) -> &str {
        REQUEST_APP_TOOL_CALL_METHOD
    }

    fn to_untyped_message(&self) -> Result<UntypedMessage, agent_client_protocol::Error> {
        UntypedMessage::new(REQUEST_APP_TOOL_CALL_METHOD, &self.0)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if !Self::matches_method(method) {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        Ok(Self(agent_client_protocol::util::json_cast_params(params)?))
    }
}

impl JsonRpcRequest for RequestAppToolCallMessage {
    type Response = AppToolCallResponseMessage;
}

#[derive(Debug, Clone)]
struct AppToolCallResponseMessage(AppToolCallResponse);

impl JsonRpcResponse for AppToolCallResponseMessage {
    fn into_json(self, _method: &str) -> Result<serde_json::Value, agent_client_protocol::Error> {
        serde_json::to_value(self.0).map_err(agent_client_protocol::Error::into_internal_error)
    }

    fn from_value(
        _method: &str,
        value: serde_json::Value,
    ) -> Result<Self, agent_client_protocol::Error> {
        Ok(Self(agent_client_protocol::util::json_cast(&value)?))
    }
}
