use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use reqwest::{Client, Method, Url, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{BotProfile, Message, Snowflake};

mod extra;
mod http;
pub(in crate::discord) use extra::{PartPost, RestStatus};

#[derive(Clone)]
pub(super) struct DiscordApi {
    client: Client,
    base: Url,
    authorization: header::HeaderValue,
}

#[derive(Deserialize)]
pub(super) struct Receipt {
    pub(super) id: Snowflake,
    channel_id: Snowflake,
    message_reference: Option<Reference>,
    #[serde(rename = "type")]
    kind: Option<u8>,
}

#[derive(Deserialize)]
struct Reference {
    message_id: Snowflake,
    channel_id: Option<Snowflake>,
}

impl Receipt {
    pub(super) fn references(&self, channel: Snowflake, message: Snowflake) -> bool {
        self.message_reference.as_ref().is_some_and(|reference| {
            reference.message_id == message && reference.channel_id == Some(channel)
        })
    }

    pub(super) fn confirms_reply(&self, channel: Snowflake, message: Snowflake) -> bool {
        self.kind == Some(19)
            && self.message_reference.as_ref().is_some_and(|reference| {
                reference.message_id == message
                    && reference.channel_id.is_none_or(|id| id == channel)
            })
    }
}

impl DiscordApi {
    pub(super) fn new(base: Url, token: &str) -> Result<Self> {
        let mut authorization = header::HeaderValue::from_str(&format!("Bot {token}"))
            .context("invalid Discord bot token")?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()?;
        Ok(Self {
            client,
            base,
            authorization,
        })
    }

    pub(super) async fn identity(&self) -> Result<BotProfile> {
        self.get("users/@me").await
    }

    pub(super) async fn require_message_content(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Application {
            flags: u64,
        }
        let app: Application = self.get("applications/@me").await?;
        ensure!(
            (app.flags & ((1 << 18) | (1 << 19))) != 0,
            "Enable Discord Message Content Intent before starting native intake"
        );
        Ok(())
    }

    pub(super) async fn set_default_avatar(&self, path: &Path) -> Result<()> {
        use tokio::io::AsyncReadExt as _;
        let file = tokio::fs::File::open(path).await?;
        let mut bytes = Vec::new();
        file.take(512 * 1024 + 1).read_to_end(&mut bytes).await?;
        ensure!(
            bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.len() <= 512 * 1024,
            "invalid default Discord JPEG"
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.call(
            Method::PATCH,
            "users/@me",
            Some(&json!({ "avatar": format!("data:image/jpeg;base64,{encoded}") })),
            true,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn history(
        &self,
        channel: Snowflake,
        before: Option<Snowflake>,
        limit: u8,
    ) -> Result<Vec<Message>> {
        let mut path = format!("channels/{channel}/messages?limit={limit}");
        if let Some(before) = before {
            use std::fmt::Write as _;
            write!(path, "&before={before}")?;
        }
        let page: Vec<Message> = self.get(&path).await?;
        ensure!(
            page.len() <= usize::from(limit)
                && page.iter().all(|message| message.channel_id == channel),
            "Discord history response did not match its channel or page limit"
        );
        Ok(page)
    }

    /// One raw history page for TS-parity intake (`messagePage`, discord-inbound-api.ts:109-128).
    pub(super) async fn history_raw(
        &self,
        channel: Snowflake,
        before: Option<Snowflake>,
        limit: u8,
    ) -> Result<Vec<Value>> {
        let mut path = format!("channels/{channel}/messages?limit={limit}");
        if let Some(before) = before {
            use std::fmt::Write as _;
            write!(path, "&before={before}")?;
        }
        let Value::Array(page) = self.get::<Value>(&path).await? else {
            anyhow::bail!("Discord inbound message response is invalid");
        };
        ensure!(
            page.len() <= usize::from(limit)
                && page.iter().all(|message| message
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| Snowflake::try_from(id.to_owned()).is_ok())),
            "Discord inbound message response is invalid"
        );
        Ok(page)
    }

    pub(super) async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        serde_json::from_slice(&self.call(Method::GET, path, None, true).await?)
            .context("invalid Discord REST response")
    }

    pub(super) async fn typing(&self, channel: Snowflake) -> Result<()> {
        self.call(
            Method::POST,
            &format!("channels/{channel}/typing"),
            None,
            true,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn reply(
        &self,
        origin: Destination,
        content: &str,
        extras: ReplyExtras<'_>,
    ) -> Result<Snowflake> {
        let mut body = text_body(origin.channel, Some(origin.message), content);
        match extras {
            ReplyExtras::Part { nonce } => {
                body["nonce"] = json!(nonce);
                body["enforce_nonce"] = json!(true);
            }
            ReplyExtras::Approval { stamp } => {
                body["components"] = json!([{
                    "type": 1,
                    "components": [
                        {"type": 2, "style": 3, "label": "Approve", "custom_id": format!("cataly-readme:{stamp}:approve")},
                        {"type": 2, "style": 4, "label": "Deny", "custom_id": format!("cataly-readme:{stamp}:deny")}
                    ]
                }]);
            }
        }
        let receipt = self.post(origin.channel, &body).await?;
        ensure!(
            receipt.references(origin.channel, origin.message),
            "Discord reply destination did not match its source"
        );
        Ok(receipt.id)
    }

    pub(super) async fn post_text(
        &self,
        channel: Snowflake,
        reference: Option<Snowflake>,
        content: &str,
    ) -> Result<Receipt> {
        self.post(channel, &text_body(channel, reference, content))
            .await
    }

    async fn post(&self, channel: Snowflake, body: &Value) -> Result<Receipt> {
        let path = format!("channels/{channel}/messages");
        let receipt: Receipt =
            serde_json::from_slice(&self.call(Method::POST, &path, Some(body), true).await?)
                .context("Discord did not confirm the posted message")?;
        ensure!(
            receipt.channel_id == channel,
            "Discord returned a message in another channel"
        );
        Ok(receipt)
    }

    pub(super) async fn edit_text(
        &self,
        channel: Snowflake,
        message: Snowflake,
        content: &str,
    ) -> Result<()> {
        let path = format!("channels/{channel}/messages/{message}");
        let receipt: Receipt = serde_json::from_slice(
            &self
                .call(
                    Method::PATCH,
                    &path,
                    Some(&text_body(channel, None, content)),
                    true,
                )
                .await?,
        )
        .context("Discord did not confirm the edited message")?;
        ensure!(
            receipt.channel_id == channel && receipt.id == message,
            "Discord returned another edited message"
        );
        Ok(())
    }

    pub(super) async fn clear(&self, channel: Snowflake, message: Snowflake) -> Result<()> {
        self.call(
            Method::PATCH,
            &format!("channels/{channel}/messages/{message}"),
            Some(&json!({"components": []})),
            true,
        )
        .await?;
        Ok(())
    }

    pub(super) async fn callback(&self, event: &super::Interaction, accepted: bool) -> Result<()> {
        let path = format!("interactions/{}/{}/callback", event.id, event.token);
        let body = if accepted {
            json!({"type": 7, "data": {"components": []}})
        } else {
            json!({"type": 4, "data": {"content": "This approval is inactive or not yours.", "flags": 64}})
        };
        // The callback uses its own token, not the bot authorization header.
        tokio::time::timeout(
            Duration::from_millis(2_500),
            self.call(Method::POST, &path, Some(&body), false),
        )
        .await??;
        Ok(())
    }
}

fn text_body(channel: Snowflake, reference: Option<Snowflake>, content: &str) -> Value {
    let mut body =
        json!({ "content": content, "allowed_mentions": { "parse": [], "replied_user": false } });
    if let Some(message) = reference {
        body["message_reference"] =
            json!({ "message_id": message, "channel_id": channel, "fail_if_not_exists": true });
    }
    body
}

#[derive(Clone, Copy, Serialize)]
pub struct Destination {
    pub(crate) channel: Snowflake,
    pub(crate) message: Snowflake,
}

pub enum ReplyExtras<'a> {
    Part { nonce: &'a str },
    Approval { stamp: &'a str },
}
