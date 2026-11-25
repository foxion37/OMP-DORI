//! The headless endpoint's HTTP/1.1 over a Unix socket, both ends.
//!
//! The server reproduces `serveHost`'s `Bun.serve({ unix, maxRequestBodySize: 1 MiB })` as its clients observe
//! it: `POST` with the 64-hex `authorization` key or 403, a JSON object with a string `op` or 400, bodies above
//! 1 MiB refused with 413, a 60 s deadline per request, keep-alive, and `{ok,value|error}` envelopes from
//! `Response.json`. Status lines, headers and the parser's refusals match Bun 1.x byte for byte.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

use crate::util::{http_date, now_ms};

/// `maxRequestBodySize`.
pub const BODY_LIMIT: usize = 1024 * 1024;
/// Bun's default `--max-http-header-size`.
const HEAD_LIMIT: usize = 16 * 1024;
/// Bun's default `idleTimeout` before a request reaches the handler.
const IDLE: Duration = Duration::from_secs(10);
/// `server.timeout(req, 60)`.
const REQUEST_DEADLINE: Duration = Duration::from_secs(60);
/// How long shutdown lets admitted operations finish before the socket goes away.
const DRAIN: Duration = Duration::from_secs(1);

const PARSE_ERROR: &[u8] = b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const VERSION_ERROR: &[u8] =
    b"HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n";
const HEAD_TOO_LARGE: &[u8] =
    b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
const LENGTH_TOO_LARGE: &[u8] = b"HTTP/1.1 413 Request Entity Too Large\r\n\r\n";
const CHUNKS_TOO_LARGE: &[u8] = b"HTTP/1.1 413 Payload Too Large\r\n\r\n";

/// An operation's outcome: `Ok(value)` (`None` is `undefined`, omitted from the envelope) or the error message.
pub type Reply = Result<Option<Box<RawValue>>, String>;

#[derive(Serialize)]
struct Envelope<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

/// The running endpoint; [`Server::stop`] drains admitted operations for up to a second, then stops accepting.
pub struct Server {
    in_flight: Arc<AtomicUsize>,
    accept: JoinHandle<()>,
}

impl Server {
    pub(crate) async fn stop(self) {
        let deadline = tokio::time::Instant::now() + DRAIN;
        while self.in_flight.load(Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.accept.abort();
        drop(self.accept.await);
    }
}

/// Serves `handler` on `listener`, authorizing every request with `key`.
pub fn serve<F, Fut>(listener: UnixListener, key: String, handler: F) -> Server
where
    F: Fn(Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Reply> + Send + 'static,
{
    let in_flight = Arc::new(AtomicUsize::new(0));
    let shared = Arc::new((key, handler, Arc::clone(&in_flight)));
    let accept = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(connection(stream, Arc::clone(&shared)));
        }
    });
    Server { in_flight, accept }
}

struct Head {
    method: String,
    keep_alive: bool,
    authorization: Option<String>,
    body: Body,
}

enum Body {
    Length(usize),
    Chunked,
}

enum Refusal {
    /// Write these bytes, then close.
    Respond(&'static [u8]),
    /// Close without a reply.
    Close,
}

fn find(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes.windows(needle.len()).position(|w| w == needle)
}

const fn token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

/// Whether `head` ends a line with LF alone; Bun's parser answers 505 as soon as it sees one.
fn bare_lf(head: &[u8]) -> bool {
    head.iter()
        .enumerate()
        .any(|(at, byte)| *byte == b'\n' && (at == 0 || head[at - 1] != b'\r'))
}

fn parse_head(head: &[u8]) -> Result<Head, Refusal> {
    if bare_lf(head) {
        return Err(Refusal::Respond(VERSION_ERROR));
    }
    let text = std::str::from_utf8(head).map_err(|_| Refusal::Respond(PARSE_ERROR))?;
    let mut lines = text.split("\r\n");
    let mut line = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(_target), Some(version), None) =
        (line.next(), line.next(), line.next(), line.next())
    else {
        return Err(Refusal::Respond(PARSE_ERROR));
    };
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(Refusal::Close);
    }
    let http11 = match version {
        "HTTP/1.1" => true,
        "HTTP/1.0" => false,
        _ => return Err(Refusal::Respond(VERSION_ERROR)),
    };
    let mut host = false;
    let mut close = false;
    let mut authorization: Option<String> = None;
    let mut length: Option<&str> = None;
    let mut encoding: Option<&str> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(Refusal::Respond(PARSE_ERROR));
        };
        if name.is_empty() || !name.bytes().all(token) {
            return Err(Refusal::Respond(PARSE_ERROR));
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("host") {
            host = true;
        } else if name.eq_ignore_ascii_case("connection") {
            close |= value
                .split(',')
                .any(|option| option.trim().eq_ignore_ascii_case("close"));
        } else if name.eq_ignore_ascii_case("authorization") {
            // `Headers.get` joins repeated fields, which then fail the key shape.
            authorization = Some(
                authorization.map_or_else(|| value.to_owned(), |prior| format!("{prior}, {value}")),
            );
        } else if name.eq_ignore_ascii_case("content-length") {
            if value.is_empty()
                || !value.bytes().all(|b| b.is_ascii_digit())
                || length.is_some_and(|prior| prior != value)
            {
                return Err(Refusal::Respond(PARSE_ERROR));
            }
            length = Some(value);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if !value.eq_ignore_ascii_case("chunked") || encoding.is_some() {
                return Err(Refusal::Respond(PARSE_ERROR));
            }
            encoding = Some(value);
        }
    }
    if http11 && !host {
        return Err(Refusal::Respond(PARSE_ERROR));
    }
    let body = match (length, encoding) {
        (Some(_), Some(_)) => return Err(Refusal::Respond(PARSE_ERROR)),
        (None, Some(_)) => Body::Chunked,
        (Some(length), None) => match length.parse::<usize>() {
            Ok(length) if length <= BODY_LIMIT => Body::Length(length),
            _ => return Err(Refusal::Respond(LENGTH_TOO_LARGE)),
        },
        (None, None) => Body::Length(0),
    };
    Ok(Head {
        method: method.to_owned(),
        keep_alive: http11 && !close,
        authorization,
        body,
    })
}

/// Reads more bytes into `buffer` within `idle`; `false` at EOF, error or timeout.
async fn fill(stream: &mut UnixStream, buffer: &mut Vec<u8>, idle: Duration) -> bool {
    matches!(
        tokio::time::timeout(idle, stream.read_buf(buffer)).await,
        Ok(Ok(read)) if read > 0
    )
}

/// The body at the front of `buffer`, consuming it; `Err` carries the refusal for an oversized chunked body.
async fn read_body(
    stream: &mut UnixStream,
    buffer: &mut Vec<u8>,
    body: &Body,
) -> Result<Option<Vec<u8>>, &'static [u8]> {
    match *body {
        Body::Length(length) => {
            while buffer.len() < length {
                if !fill(stream, buffer, REQUEST_DEADLINE).await {
                    return Ok(None);
                }
            }
            Ok(Some(buffer.drain(..length).collect()))
        }
        Body::Chunked => {
            let mut out = Vec::new();
            let mut at = 0;
            loop {
                let Some(line) = find(&buffer[at..], b"\r\n") else {
                    if buffer.len() - at > HEAD_LIMIT {
                        return Ok(None);
                    }
                    if !fill(stream, buffer, REQUEST_DEADLINE).await {
                        return Ok(None);
                    }
                    continue;
                };
                let size = std::str::from_utf8(&buffer[at..at + line])
                    .ok()
                    .and_then(|text| {
                        usize::from_str_radix(text.split(';').next()?.trim(), 16).ok()
                    });
                let Some(size) = size else {
                    return Ok(None);
                };
                // Checked: a size near `usize::MAX` must refuse, not wrap past the limit.
                if out
                    .len()
                    .checked_add(size)
                    .is_none_or(|total| total > BODY_LIMIT)
                {
                    return Err(CHUNKS_TOO_LARGE);
                }
                let start = at + line + 2;
                // A zero chunk ends with the (empty) trailer section, held to the header limit.
                let end = if size == 0 {
                    let mut trailers = 0;
                    loop {
                        if let Some(trailer) = find(&buffer[start..], b"\r\n") {
                            if trailer == 0 {
                                break start + 2;
                            }
                            // Trailer fields are not used; skip them.
                            trailers += trailer + 2;
                            buffer.drain(start..start + trailer + 2);
                        } else if trailers + buffer.len() - start > HEAD_LIMIT
                            || !fill(stream, buffer, REQUEST_DEADLINE).await
                        {
                            return Ok(None);
                        }
                        if trailers > HEAD_LIMIT {
                            return Ok(None);
                        }
                    }
                } else {
                    let Some(chunk_end) =
                        start.checked_add(size).and_then(|end| end.checked_add(2))
                    else {
                        return Err(CHUNKS_TOO_LARGE);
                    };
                    while buffer.len() < chunk_end {
                        if !fill(stream, buffer, REQUEST_DEADLINE).await {
                            return Ok(None);
                        }
                    }
                    if &buffer[chunk_end - 2..chunk_end] != b"\r\n" {
                        return Ok(None);
                    }
                    out.extend_from_slice(&buffer[start..chunk_end - 2]);
                    at = chunk_end;
                    continue;
                };
                buffer.drain(..end);
                return Ok(Some(out));
            }
        }
    }
}

fn empty(status: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nDate: {}\r\nContent-Length: 0\r\n\r\n",
        http_date(now_ms())
    )
    .into_bytes()
}

fn json(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json;charset=utf-8\r\nDate: {}\r\nContent-Length: {}\r\n\r\n{body}",
        http_date(now_ms()),
        body.len()
    )
    .into_bytes()
}

/// `timingSafeEqual` over the two keys once the provided one has the 64-hex shape.
fn authorized(provided: Option<&str>, key: &str) -> bool {
    let Some(provided) = provided else {
        return false;
    };
    provided.len() == 64
        && provided
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && provided.len() == key.len()
        && provided
            .bytes()
            .zip(key.bytes())
            .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

async fn connection<F, Fut>(mut stream: UnixStream, shared: Arc<(String, F, Arc<AtomicUsize>)>)
where
    F: Fn(Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Reply> + Send + 'static,
{
    let mut buffer = Vec::new();
    loop {
        let end = loop {
            if let Some(end) = find(&buffer, b"\r\n\r\n") {
                break end;
            }
            if bare_lf(&buffer) {
                drop(stream.write_all(VERSION_ERROR).await);
                return;
            }
            if buffer.len() > HEAD_LIMIT {
                drop(stream.write_all(HEAD_TOO_LARGE).await);
                return;
            }
            if !fill(&mut stream, &mut buffer, IDLE).await {
                return;
            }
        };
        if end > HEAD_LIMIT {
            drop(stream.write_all(HEAD_TOO_LARGE).await);
            return;
        }
        let head = match parse_head(&buffer[..end]) {
            Ok(head) => head,
            Err(Refusal::Respond(reply)) => {
                drop(stream.write_all(reply).await);
                return;
            }
            Err(Refusal::Close) => return,
        };
        buffer.drain(..end + 4);
        let body = match read_body(&mut stream, &mut buffer, &head.body).await {
            Ok(Some(body)) => body,
            Ok(None) => return,
            Err(reply) => {
                drop(stream.write_all(reply).await);
                return;
            }
        };
        let (key, _, _) = &*shared;
        let reply = if head.method != "POST" || !authorized(head.authorization.as_deref(), key) {
            empty("403 Forbidden")
        } else {
            let request = crate::json::parse_js::<Value>(&body)
                .ok()
                .filter(|request| request.get("op").is_some_and(Value::is_string));
            match request {
                None => empty("400 Bad Request"),
                Some(request) => {
                    let shared = Arc::clone(&shared);
                    // The operation runs to completion even if its connection times out, as an awaited Bun
                    // handler does after its socket closes.
                    let operation = tokio::spawn(async move {
                        let (_, handler, in_flight) = &*shared;
                        in_flight.fetch_add(1, Ordering::SeqCst);
                        let reply = handler(request).await;
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        reply
                    });
                    let Ok(Ok(reply)) = tokio::time::timeout(REQUEST_DEADLINE, operation).await
                    else {
                        return;
                    };
                    let envelope = match &reply {
                        Ok(value) => Envelope {
                            ok: true,
                            value: value.as_deref(),
                            error: None,
                        },
                        Err(error) => Envelope {
                            ok: false,
                            value: None,
                            error: Some(error),
                        },
                    };
                    json(&serde_json::to_string(&envelope).unwrap_or_default())
                }
            }
        };
        if stream.write_all(&reply).await.is_err() || !head.keep_alive {
            return;
        }
    }
}

/// The Rust client of the endpoint (`requestHost`), used by the Discord lane checks.
#[cfg(any(test, feature = "discord"))]
pub mod client {
    use std::time::Duration;

    use anyhow::{Context as _, Result, anyhow, bail, ensure};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::super::record::{Entry, read_private};
    use crate::json::Json;

    const OBSERVE_DEADLINE: Duration = Duration::from_secs(20);
    const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;

    /// The socket and key of a valid `endpoint.json`.
    pub fn endpoint_socket(endpoint: &Json) -> Option<(&str, &str)> {
        let socket = endpoint.str("socket")?;
        let name = socket
            .strip_prefix("/tmp/cataly-rpc-")?
            .strip_suffix("/socket")?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        endpoint.str("key").map(|key| (socket, key))
    }

    /// One HTTP/1.1 POST over the host's Unix socket; returns the reply body.
    async fn post(socket: &str, key: &str, body: &str) -> Result<Vec<u8>> {
        let mut stream = tokio::net::UnixStream::connect(socket).await?;
        let request = format!(
            "POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: {key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await?;
        let mut bytes = Vec::new();
        let mut chunk = vec![0_u8; 16 * 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            ensure!(
                bytes.len() + read <= RESPONSE_LIMIT,
                "headless reply too large"
            );
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(body) = complete_body(&bytes, false)? {
                return Ok(body);
            }
        }
        complete_body(&bytes, true)?.ok_or_else(|| anyhow!("incomplete headless reply"))
    }

    /// The body of a complete HTTP response in `bytes`, or `None` while more bytes are needed. At `eof`, a
    /// response without a length runs to the end of the stream.
    pub fn complete_body(bytes: &[u8], eof: bool) -> Result<Option<Vec<u8>>> {
        let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            return Ok(None);
        };
        let head = std::str::from_utf8(&bytes[..end])?;
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap_or_default();
        let code = status.split(' ').nth(1).unwrap_or_default();
        ensure!(code.starts_with('2'), "HTTP {code}");
        let mut length = None;
        let mut chunked = false;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                length = Some(value.parse::<usize>()?);
            } else if name.eq_ignore_ascii_case("transfer-encoding")
                && value.eq_ignore_ascii_case("chunked")
            {
                chunked = true;
            }
        }
        let rest = &bytes[end + 4..];
        if chunked {
            let mut body = Vec::new();
            let mut at = 0;
            loop {
                let Some(line) = rest[at..].windows(2).position(|w| w == b"\r\n") else {
                    return Ok(None);
                };
                let size_text = std::str::from_utf8(&rest[at..at + line])?;
                let size =
                    usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)?;
                at += line + 2;
                if size == 0 {
                    return Ok(Some(body));
                }
                if rest.len() < at + size + 2 {
                    return Ok(None);
                }
                body.extend_from_slice(&rest[at..at + size]);
                at += size + 2;
            }
        }
        let complete = length.map_or(eof, |length| rest.len() >= length);
        Ok(complete.then(|| rest[..length.unwrap_or(rest.len())].to_vec()))
    }

    /// `requestHost(stateDir, ref, request)`; transport failures are errors.
    pub async fn request_host(entry: &Entry, request: &Json) -> Result<Json> {
        let endpoint = read_private(&entry.dir.join("endpoint.json"))?
            .ok_or_else(|| anyhow!("headless host endpoint missing or invalid"))?;
        let (socket, key) = endpoint_socket(&endpoint)
            .ok_or_else(|| anyhow!("headless host endpoint missing or invalid"))?;
        let body = tokio::time::timeout(OBSERVE_DEADLINE, post(socket, key, &request.compact()))
            .await
            .context("headless local transport unconfirmed")??;
        let reply: Json = serde_json::from_slice(&body).context("invalid response")?;
        match reply.get("ok") {
            Some(Json::Bool(true)) => Ok(reply.get("value").cloned().unwrap_or(Json::Null)),
            Some(Json::Bool(false)) => {
                bail!("{}", reply.str("error").unwrap_or("headless host error"))
            }
            _ => bail!("invalid response"),
        }
    }
}

#[cfg(test)]
mod tests;
