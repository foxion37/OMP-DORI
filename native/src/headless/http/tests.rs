use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::PathBuf;

use super::client::{complete_body, endpoint_socket, request_host};
use super::*;
use crate::headless::record::{self, Entry};
use crate::json::Json;
use crate::util::remove_any;

const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Endpoint {
    entry: Entry,
    sock_dir: PathBuf,
    socket: PathBuf,
    server: Option<Server>,
}

impl Endpoint {
    /// A served endpoint and a lane directory whose `endpoint.json` names it. The handler echoes `op`, fails on
    /// `op: "fail"`, and answers `undefined` for `op: "none"`.
    fn start() -> Self {
        let lane =
            std::env::temp_dir().join(format!("cataly-http-{}", crate::util::uuid().unwrap()));
        DirBuilder::new().mode(0o700).create(&lane).unwrap();
        let sock_dir = record::socket_dir().unwrap();
        let socket = sock_dir.join("socket");
        record::write_private(
            &lane.join("endpoint.json"),
            &record::endpoint(socket.to_str().unwrap(), KEY, 1),
        )
        .unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let server = serve(listener, KEY.to_owned(), |request: Value| async move {
            match request["op"].as_str() {
                Some("fail") => Err("refused here".to_owned()),
                Some("none") => Ok(None),
                Some("slow") => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    Ok(Some(RawValue::from_string("\"slow\"".to_owned()).unwrap()))
                }
                op => Ok(Some(
                    serde_json::value::to_raw_value(&serde_json::json!({ "op": op, "é": 1 }))
                        .unwrap(),
                )),
            }
        });
        Self {
            entry: Entry {
                dir: lane,
                reservation: Json::Null,
            },
            sock_dir,
            socket,
            server: Some(server),
        }
    }

    /// Writes `request` on a fresh connection and returns every byte until the server closes or goes idle.
    async fn raw(&self, request: &[u8]) -> String {
        let mut stream = UnixStream::connect(&self.socket).await.unwrap();
        stream.write_all(request).await.unwrap();
        let mut out = Vec::new();
        let mut chunk = [0_u8; 4096];
        while let Ok(Ok(read)) =
            tokio::time::timeout(Duration::from_millis(500), stream.read(&mut chunk)).await
        {
            if read == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8(out).unwrap()
    }

    async fn stop(mut self) {
        if let Some(server) = self.server.take() {
            server.stop().await;
        }
        remove_any(&self.sock_dir).unwrap();
        remove_any(&self.entry.dir).unwrap();
    }
}

/// The response with its `Date` value blanked, after checking it is an IMF-fixdate.
fn undated(reply: &str) -> String {
    reply
        .split("\r\n")
        .map(|line| {
            line.strip_prefix("Date: ").map_or(line, |date| {
                assert!(date.ends_with(" GMT") && date.len() == 29, "{date}");
                "Date: -"
            })
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn post(body: &str, extra: &str) -> Vec<u8> {
    format!(
        "POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: {KEY}\r\nContent-Length: {}\r\n{extra}\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[tokio::test]
async fn the_rust_client_round_trips_envelopes() {
    let endpoint = Endpoint::start();
    let request = |op: &str| Json::object(vec![("op", Json::string(op))]);
    assert_eq!(
        request_host(&endpoint.entry, &request("observe"))
            .await
            .unwrap()
            .compact(),
        r#"{"op":"observe","é":1}"#
    );
    assert_eq!(
        request_host(&endpoint.entry, &request("fail"))
            .await
            .unwrap_err()
            .to_string(),
        "refused here"
    );
    assert_eq!(
        request_host(&endpoint.entry, &request("none"))
            .await
            .unwrap(),
        Json::Null
    );
    endpoint.stop().await;
}

#[tokio::test]
async fn replies_match_bun_serve_byte_for_byte() {
    let endpoint = Endpoint::start();
    let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json;charset=utf-8\r\nDate: -\r\nContent-Length: 37\r\n\r\n{\"ok\":true,\"value\":{\"op\":\"x\",\"é\":1}}";
    assert_eq!(
        undated(
            &endpoint
                .raw(&post(r#"{"op":"x"}"#, "Connection: close\r\n"))
                .await
        ),
        ok
    );
    assert_eq!(
        undated(
            &endpoint
                .raw(&post(r#"{"op":"none"}"#, "Connection: close\r\n"))
                .await
        ),
        "HTTP/1.1 200 OK\r\nContent-Type: application/json;charset=utf-8\r\nDate: -\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"
    );
    assert_eq!(
        undated(
            &endpoint
                .raw(&post(r#"{"op":"fail"}"#, "Connection: close\r\n"))
                .await
        ),
        "HTTP/1.1 200 OK\r\nContent-Type: application/json;charset=utf-8\r\nDate: -\r\nContent-Length: 35\r\n\r\n{\"ok\":false,\"error\":\"refused here\"}"
    );
    // Keep-alive and pipelining: both replies on one connection.
    let mut pipelined = post(r#"{"op":"x"}"#, "");
    pipelined.extend(post(r#"{"op":"none"}"#, "Connection: close\r\n"));
    let both = undated(&endpoint.raw(&pipelined).await);
    assert!(
        both.starts_with(ok) && both.ends_with("\r\n\r\n{\"ok\":true}"),
        "{both}"
    );
    // Chunked request bodies and HTTP/1.0 without Host.
    let chunked = format!(
        "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nA\r\n{{\"op\":\"x\"}}\r\n0\r\n\r\n"
    );
    assert_eq!(undated(&endpoint.raw(chunked.as_bytes()).await), ok);
    let old = format!(
        "POST / HTTP/1.0\r\nAuthorization: {KEY}\r\nContent-Length: 10\r\n\r\n{{\"op\":\"x\"}}"
    );
    assert_eq!(undated(&endpoint.raw(old.as_bytes()).await), ok);
    endpoint.stop().await;
}

#[tokio::test]
async fn refusals_match_bun_serve() {
    let endpoint = Endpoint::start();
    let forbidden = "HTTP/1.1 403 Forbidden\r\nDate: -\r\nContent-Length: 0\r\n\r\n";
    let bad = "HTTP/1.1 400 Bad Request\r\nDate: -\r\nContent-Length: 0\r\n\r\n";
    let refusals: [(Vec<u8>, &str); 12] = [
        (
            b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_vec(),
            forbidden,
        ),
        (
            format!("PUT / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{{\"op\":\"x\"}}").into_bytes(),
            forbidden,
        ),
        (
            b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{\"op\":\"x\"}".to_vec(),
            forbidden,
        ),
        (
            format!("POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{{\"op\":\"x\"}}", KEY.replace('0', "1")).into_bytes(),
            forbidden,
        ),
        (
            format!("POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{{\"op\":\"x\"}}", KEY.to_uppercase()).into_bytes(),
            forbidden,
        ),
        (
            format!("POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nAuthorization: {KEY}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{{\"op\":\"x\"}}").into_bytes(),
            forbidden,
        ),
        (post("[1]", "Connection: close\r\n"), bad),
        (post("", "Connection: close\r\n"), bad),
        (post(r#"{"op":1}"#, "Connection: close\r\n"), bad),
        (post("{", "Connection: close\r\n"), bad),
        (
            format!("POST / HTTP/1.1\r\nAuthorization: {KEY}\r\nContent-Length: 10\r\nConnection: close\r\n\r\n{{\"op\":\"x\"}}").into_bytes(),
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
        ),
        (
            format!("POST / HTTP/1.1\nHost: x\nAuthorization: {KEY}\nContent-Length: 10\n\n{{\"op\":\"x\"}}").into_bytes(),
            "HTTP/1.1 505 HTTP Version Not Supported\r\nConnection: close\r\n\r\n",
        ),
    ];
    for (request, expected) in refusals {
        assert_eq!(
            undated(&endpoint.raw(&request).await),
            expected,
            "{}",
            String::from_utf8_lossy(&request)
        );
    }
    endpoint.stop().await;
}

#[tokio::test]
async fn bodies_above_one_mebibyte_get_413() {
    let endpoint = Endpoint::start();
    let padded = |size: usize| {
        let open = r#"{"op":"x","p":""#;
        format!("{open}{}\"}}", "x".repeat(size - open.len() - 2))
    };
    let exact = endpoint
        .raw(&post(&padded(BODY_LIMIT), "Connection: close\r\n"))
        .await;
    assert!(exact.starts_with("HTTP/1.1 200 OK\r\n"), "{exact}");
    let declared = format!(
        "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        BODY_LIMIT + 1
    );
    assert_eq!(
        endpoint.raw(declared.as_bytes()).await,
        "HTTP/1.1 413 Request Entity Too Large\r\n\r\n"
    );
    let chunked = format!(
        "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n80000\r\n{}\r\n80001\r\n",
        "x".repeat(0x80000)
    );
    assert_eq!(
        endpoint.raw(chunked.as_bytes()).await,
        "HTTP/1.1 413 Payload Too Large\r\n\r\n"
    );
    endpoint.stop().await;
}

#[tokio::test]
async fn chunk_sizes_that_would_wrap_get_413() {
    let endpoint = Endpoint::start();
    let wrapping = format!(
        "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nab\r\nfffffffffffffffe\r\n"
    );
    assert_eq!(
        endpoint.raw(wrapping.as_bytes()).await,
        "HTTP/1.1 413 Payload Too Large\r\n\r\n"
    );
    endpoint.stop().await;
}

#[tokio::test]
async fn chunked_trailers_are_held_to_the_header_limit() {
    let endpoint = Endpoint::start();
    let mut stream = UnixStream::connect(&endpoint.socket).await.unwrap();
    let request = format!(
        "POST / HTTP/1.1\r\nHost: x\r\nAuthorization: {KEY}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n{}",
        "x".repeat(HEAD_LIMIT + 1024)
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut chunk = [0_u8; 64];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await;
    assert!(
        matches!(read, Ok(Ok(0))),
        "an endless trailer closes the connection"
    );
    endpoint.stop().await;
}

#[tokio::test]
async fn request_bodies_accept_lone_surrogates_like_json_parse() {
    let endpoint = Endpoint::start();
    let reply = endpoint
        .raw(&post(r#"{"op":"x\ud83d"}"#, "Connection: close\r\n"))
        .await;
    assert!(
        reply.ends_with("{\"ok\":true,\"value\":{\"op\":\"x\u{fffd}\",\"é\":1}}"),
        "{reply}"
    );
    endpoint.stop().await;
}

#[tokio::test]
async fn stop_drains_admitted_operations() {
    let endpoint = Endpoint::start();
    let socket = endpoint.socket.clone();
    let slow = tokio::spawn(async move {
        let mut stream = UnixStream::connect(&socket).await.unwrap();
        stream
            .write_all(&post(r#"{"op":"slow"}"#, "Connection: close\r\n"))
            .await
            .unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        reply
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let socket = endpoint.socket.clone();
    endpoint.stop().await;
    assert!(
        slow.await
            .unwrap()
            .ends_with("{\"ok\":true,\"value\":\"slow\"}")
    );
    assert!(UnixStream::connect(&socket).await.is_err());
}

#[test]
fn client_bodies_and_endpoints() {
    let reply = b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";
    assert_eq!(
        complete_body(reply, false).unwrap().unwrap(),
        b"{\"ok\":true}"
    );
    assert!(
        complete_body(&reply[..reply.len() - 1], false)
            .unwrap()
            .is_none()
    );
    let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
    assert_eq!(complete_body(chunked, false).unwrap().unwrap(), b"abc");
    assert!(
        complete_body(
            b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n",
            false
        )
        .is_err()
    );
    assert_eq!(
        complete_body(b"HTTP/1.1 200 OK\r\n\r\n{}", true)
            .unwrap()
            .unwrap(),
        b"{}"
    );
    let ok: Json =
        serde_json::from_str(r#"{"socket":"/tmp/cataly-rpc-Ab1/socket","key":"k"}"#).unwrap();
    assert_eq!(
        endpoint_socket(&ok),
        Some(("/tmp/cataly-rpc-Ab1/socket", "k"))
    );
    let bad: Json = serde_json::from_str(r#"{"socket":"/tmp/x/socket","key":"k"}"#).unwrap();
    assert_eq!(endpoint_socket(&bad), None);
    assert_eq!(
        crate::util::http_date(1_795_000_000_123),
        "Wed, 18 Nov 2026 11:06:40 GMT"
    );
}
