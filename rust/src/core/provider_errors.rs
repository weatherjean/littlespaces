//! Bounded provider-error normalization. Never expose raw provider text or credentials.
use super::*;
use serde_json::Value;
pub(crate) fn classify(status: u16, value: &Value) -> Error {
    let error = value.get("error").unwrap_or(value);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.get("type").and_then(Value::as_str))
        .or_else(|| error.as_str())
        .unwrap_or("");
    match code {
        "subscription_sharing_usage_limit_exceeded"
        | "insufficient_quota"
        | "billing_hard_limit_reached"
        | "credit_balance_exhausted"
        | "organization_spend_limit_exceeded"
        | "project_spend_limit_exceeded"
        | "organization_usage_limit_exceeded" => Error::UsageLimit,
        "subscription_sharing_user_not_eligible" => Error::UsageUnavailable,
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            Error::ProviderUnavailable
        }
        "subscription_sharing_unsupported_capability"
        | "subscription_sharing_route_not_supported" => Error::ProviderRequest,
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => {
            Error::ProviderAccess
        }
        "invalid_api_key"
        | "invalid_token"
        | "token_expired"
        | "invalid_grant"
        | "invalid_refresh_token"
        | "refresh_token_expired"
        | "refresh_token_invalidated"
        | "refresh_token_reused"
        | "subscription_sharing_invalid_user"
        | "invalid_client"
        | "authentication_error" => Error::Authentication,
        "access_denied"
        | "permission_denied"
        | "permission_error"
        | "unsupported_country_region_territory" => Error::ProviderAccess,
        "rate_limit_exceeded" | "rate_limit_error" | "slow_down" => Error::RateLimited,
        "server_error"
        | "internal_server_error"
        | "service_unavailable"
        | "overloaded_error"
        | "server_is_overloaded"
        | "service_unavailable_error" => Error::ProviderUnavailable,
        "context_length_exceeded" => Error::ContextLimit,
        "model_not_found" | "unsupported_model" => Error::ModelUnavailable,
        "content_filter" | "content_policy_violation" | "safety_violation" => Error::ContentBlocked,
        "invalid_request_error"
        | "invalid_value"
        | "unsupported_parameter"
        | "unsupported_value"
        | "missing_required_parameter" => Error::ProviderRequest,
        _ => match status {
            401 => Error::Authentication,
            403 => Error::ProviderAccess,
            404 => Error::ModelUnavailable,
            408 | 504 => Error::ModelTimeout,
            413 => Error::ContextLimit,
            429 => Error::RateLimited,
            500..=599 => Error::ProviderUnavailable,
            400 | 422 => Error::ProviderRequest,
            _ => Error::Model,
        },
    }
}
pub(crate) async fn response_failure(mut response: reqwest::Response) -> (Error, Value) {
    let status = response.status().as_u16();
    let body = async {
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 32768 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    let value = tokio::time::timeout(std::time::Duration::from_secs(5), body)
        .await
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let safe = |v: &Value| {
        v.as_str()
            .filter(|s| {
                s.len() <= 128
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.[]-".contains(&b))
            })
            .map(str::to_owned)
    };
    let details = serde_json::json!({"code":safe(&value["error"]["code"]),"parameter":safe(&value["error"]["param"]),"shape":if value.get("detail").is_some() { "detail" } else if value.get("error").is_some() { "error" } else { "other" }});
    (classify(status, &value), details)
}
impl Error {
    pub(crate) fn retryable(self) -> bool {
        matches!(
            self,
            Self::Network
                | Self::ModelTimeout
                | Self::StreamInterrupted
                | Self::RateLimited
                | Self::ProviderUnavailable
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn distinguishes_retryable_outages_from_terminal_plan_and_request_failures() {
        for (status, code, expected, retry) in [
            (429, "rate_limit_exceeded", Error::RateLimited, true),
            (
                429,
                "subscription_sharing_usage_limit_exceeded",
                Error::UsageLimit,
                false,
            ),
            (
                503,
                "subscription_sharing_usage_unavailable",
                Error::ProviderUnavailable,
                true,
            ),
            (
                503,
                "subscription_sharing_user_unavailable",
                Error::ProviderUnavailable,
                true,
            ),
            (
                403,
                "subscription_sharing_user_not_eligible",
                Error::UsageUnavailable,
                false,
            ),
            (
                400,
                "subscription_sharing_unsupported_capability",
                Error::ProviderRequest,
                false,
            ),
            (
                403,
                "subscription_sharing_route_not_supported",
                Error::ProviderRequest,
                false,
            ),
            (
                403,
                "chatpass_v2_scope_not_authorized",
                Error::ProviderAccess,
                false,
            ),
            (
                401,
                "subscription_sharing_invalid_user",
                Error::Authentication,
                false,
            ),
            (400, "refresh_token_reused", Error::Authentication, false),
            (400, "context_length_exceeded", Error::ContextLimit, false),
            (
                429,
                "project_spend_limit_exceeded",
                Error::UsageLimit,
                false,
            ),
        ] {
            let actual = classify(
                status,
                &json!({"error":{"code":code,"message":"private diagnostic"}}),
            );
            assert_eq!(actual, expected, "{code}");
            assert_eq!(actual.retryable(), retry, "{code}");
        }
        assert_eq!(
            classify(503, &json!({"detail":"not a stable machine code"})),
            Error::ProviderUnavailable
        );
        assert_eq!(
            classify(403, &json!({"detail":"restricted"})),
            Error::ProviderAccess
        );
        assert_eq!(classify(200, &json!({"code":"future_error"})), Error::Model);
    }
}
