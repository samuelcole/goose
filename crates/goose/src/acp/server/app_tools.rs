use std::sync::Arc;

use agent_client_protocol::{
    Client, ConnectionTo, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, UntypedMessage,
};
use async_trait::async_trait;
use goose_acp_types::custom_notifications::CancelAppToolCallNotification;
use goose_acp_types::custom_requests::{
    AppToolCallResponse, EmptyResponse, RegisterWebPaneRequest, RequestAppToolCall,
    RequestWebPaneClose, RequestWebPaneOpen, SyncAppToolsRequest, WebPaneOpenResponse,
    REQUEST_APP_TOOL_CALL_METHOD, REQUEST_WEB_PANE_CLOSE_METHOD, REQUEST_WEB_PANE_OPEN_METHOD,
};
use tokio::sync::oneshot;

use super::AcpConnection;
use crate::agents::app_tools::{AppToolCaller, APP_TOOLS};
use crate::agents::web_pane::{WebPaneClient, WEB_PANES};

/// Defines typed wrappers for a goose agent → client request, so it can be sent
/// with `ConnectionTo::send_request`.
macro_rules! agent_request {
    ($message:ident, $response_message:ident, $params:ty, $response:ty, $method:expr) => {
        #[derive(Debug, Clone)]
        struct $message($params);

        impl JsonRpcMessage for $message {
            fn matches_method(method: &str) -> bool {
                method == $method
            }

            fn method(&self) -> &str {
                $method
            }

            fn to_untyped_message(&self) -> Result<UntypedMessage, agent_client_protocol::Error> {
                UntypedMessage::new($method, &self.0)
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

        impl JsonRpcRequest for $message {
            type Response = $response_message;
        }

        #[derive(Debug, Clone)]
        struct $response_message($response);

        impl JsonRpcResponse for $response_message {
            fn into_json(
                self,
                _method: &str,
            ) -> Result<serde_json::Value, agent_client_protocol::Error> {
                serde_json::to_value(self.0)
                    .map_err(agent_client_protocol::Error::into_internal_error)
            }

            fn from_value(
                _method: &str,
                value: serde_json::Value,
            ) -> Result<Self, agent_client_protocol::Error> {
                Ok(Self(agent_client_protocol::util::json_cast(&value)?))
            }
        }
    };
}

agent_request!(
    RequestAppToolCallMessage,
    AppToolCallResponseMessage,
    RequestAppToolCall,
    AppToolCallResponse,
    REQUEST_APP_TOOL_CALL_METHOD
);
agent_request!(
    RequestWebPaneOpenMessage,
    WebPaneOpenResponseMessage,
    RequestWebPaneOpen,
    WebPaneOpenResponse,
    REQUEST_WEB_PANE_OPEN_METHOD
);
agent_request!(
    RequestWebPaneCloseMessage,
    WebPaneCloseResponseMessage,
    RequestWebPaneClose,
    EmptyResponse,
    REQUEST_WEB_PANE_CLOSE_METHOD
);

async fn send<M>(cx: &ConnectionTo<Client>, message: M) -> anyhow::Result<M::Response>
where
    M: JsonRpcRequest + Send + 'static,
    M::Response: Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    cx.send_request(message)
        .on_receiving_result(move |result| async move {
            let _ = tx.send(result);
            Ok(())
        })
        .map_err(|e| anyhow::anyhow!("failed to reach the client: {e:?}"))?;
    rx.await
        .map_err(|_| anyhow::anyhow!("the client went away before answering"))?
        .map_err(|e| anyhow::anyhow!("{}", e.message))
}

/// Runs requests in the client connection that registered them, since that is
/// where the fragment's handlers and the web pane live.
struct ConnectionClient {
    cx: ConnectionTo<Client>,
}

#[async_trait]
impl AppToolCaller for ConnectionClient {
    async fn call(&self, request: RequestAppToolCall) -> anyhow::Result<AppToolCallResponse> {
        Ok(send(&self.cx, RequestAppToolCallMessage(request)).await?.0)
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

#[async_trait]
impl WebPaneClient for ConnectionClient {
    async fn open(&self, session_id: &str, url: &str) -> anyhow::Result<WebPaneOpenResponse> {
        let request = RequestWebPaneOpen {
            session_id: session_id.to_string(),
            url: url.to_string(),
        };
        Ok(send(&self.cx, RequestWebPaneOpenMessage(request)).await?.0)
    }

    async fn close(&self, session_id: &str) -> anyhow::Result<()> {
        let request = RequestWebPaneClose {
            session_id: session_id.to_string(),
        };
        send(&self.cx, RequestWebPaneCloseMessage(request)).await?;
        Ok(())
    }
}

impl AcpConnection {
    fn require_session(&self, session_id: &str) -> Result<(), agent_client_protocol::Error> {
        if self.has_session(session_id) {
            return Ok(());
        }
        Err(
            agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                .data(format!("Session not found: {session_id}")),
        )
    }

    pub(super) async fn on_sync_app_tools(
        &self,
        cx: &ConnectionTo<Client>,
        req: SyncAppToolsRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.require_session(&req.session_id)?;
        APP_TOOLS
            .sync(
                self.connection_id,
                &req.session_id,
                &req.app_instance_id,
                &req.extension_name,
                req.tools,
                Arc::new(ConnectionClient { cx: cx.clone() }),
            )
            .map_err(|e| agent_client_protocol::Error::invalid_params().data(e.to_string()))?;
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_register_web_pane(
        &self,
        cx: &ConnectionTo<Client>,
        req: RegisterWebPaneRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        self.require_session(&req.session_id)?;
        WEB_PANES.register(
            self.connection_id,
            &req.session_id,
            Arc::new(ConnectionClient { cx: cx.clone() }),
        );
        Ok(EmptyResponse {})
    }
}
