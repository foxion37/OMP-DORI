//! Native headless host: a drop-in for `bun src/runtime/headless-broker.ts <dir>` for the OMP-owning roles
//! (`lane`, `lead`, `duty`). Records and the Unix-socket protocol are byte-compatible with the TypeScript clients.
//!
//! `cataly headless-host <dir>` reads the `HostStart` record from standard input to EOF, then behaves like
//! `serveHost(dir, reservation => new Broker(reservation))`: `host.yml`, the endpoint socket and `endpoint.json`,
//! the OMP child for the life of the process, and `stopped.json` once it exits. No signal handler is installed: a
//! host killed by a signal leaves no `stopped.json`, exactly like the Bun broker.

mod broker;
mod events;
pub mod http;
mod launch_model;
mod protocol;
pub mod record;
mod remote;
mod rpc;

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context as _, Result, anyhow, bail};
use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;

use crate::json::Json;
use crate::util::remove_any;

/// The two roles `src/runtime/headless-loop.ts` serves without an OMP child.
const LOOP_ROLES: [&str; 2] = ["duty-loop", "hourly-loop"];

/// `cataly headless-host <dir>`: `serveHost(dir, make)` with the native broker, the start record on stdin.
pub async fn run(dir: &Path) -> Result<()> {
    let reservation = admit(dir)?;
    let mut input = Vec::new();
    tokio::io::stdin()
        .read_to_end(&mut input)
        .await
        .context("reading the headless start record")?;
    serve(dir, reservation, &input).await
}

/// The private reservation this host serves; loop roles stay on the Bun host.
fn admit(dir: &Path) -> Result<Json> {
    record::private_dir(dir)?;
    let reservation = record::read_private(&dir.join("reservation.json"))?
        .ok_or_else(|| anyhow!("headless reservation missing"))?;
    if reservation
        .str("role")
        .is_some_and(|role| LOOP_ROLES.contains(&role))
    {
        bail!("headless-host serves lane, lead and duty; loop roles run on Bun");
    }
    Ok(reservation)
}

/// Everything after the start record arrives: records, endpoint, OMP, and `stopped.json` once it exits.
async fn serve(dir: &Path, reservation: Json, input: &[u8]) -> Result<()> {
    let start = record::HostStart::parse(input)?;
    let config = record::write_host_config(dir)?;
    let sock_dir = record::socket_dir()?;
    let socket = sock_dir.join("socket");
    let socket_text = socket
        .to_str()
        .ok_or_else(|| anyhow!("headless socket path is not UTF-8"))?
        .to_owned();
    let key = record::endpoint_key()?;
    let broker = Arc::new(broker::Broker::new(reservation));
    let listener = UnixListener::bind(&socket).context("binding the headless endpoint")?;
    let handler = Arc::clone(&broker);
    let server = http::serve(listener, key.clone(), move |request| {
        let broker = Arc::clone(&handler);
        async move { broker.handle(request).await }
    });
    let stopped = dir.join("stopped.json");
    let outcome = async {
        record::write_private(
            &dir.join("endpoint.json"),
            &record::endpoint(&socket_text, &key, std::process::id()),
        )?;
        let code = broker.start(&start, &config).await?;
        let detail = (code != 0).then(|| format!("headless process exited ({code})"));
        record::write_private(
            &stopped,
            &record::stop_receipt(detail.as_deref(), broker.closed_session_id().as_deref()),
        )
    }
    .await;
    let written = outcome.or_else(|error| {
        record::write_private(
            &stopped,
            &record::stop_receipt(Some(&error.to_string()), None),
        )
    });
    broker.receipt_published();
    // Let the operation waiting on native EOF receive its reply before taking the socket down.
    server.stop().await;
    remove_any(&sock_dir)?;
    written
}

#[cfg(test)]
mod tests;
