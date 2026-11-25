use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::Serialize;

#[cfg(all(unix, feature = "discord"))]
mod discord;
#[cfg(unix)]
mod discord_split;
mod frames;
#[cfg(unix)]
mod harness;
#[cfg(unix)]
mod headless;
#[cfg(unix)]
mod json;
mod omp;
#[cfg(unix)]
mod routing;
mod rpc;
#[cfg(unix)]
mod util;

#[derive(Debug, Parser)]
#[command(version, about = "Cataly Native controller for stock OMP")]
struct Cli {
    /// Separately installed OMP executable (no shell command or arguments).
    #[arg(long, env = "CATALY_OMP", default_value = "omp", global = true)]
    omp: PathBuf,
    /// Working directory for the OMP session.
    #[arg(long, default_value = ".", global = true)]
    cwd: PathBuf,
    /// Model from the configured OMP profile.
    #[arg(long, global = true)]
    model: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Check the installed OMP and its private, ephemeral RPC lifecycle.
    Doctor,
    /// Open the exact saved OMP session, verify its identity, and close it.
    Resume {
        /// Native session file, not an ID prefix or picker.
        session_file: PathBuf,
        /// Native session ID expected in the OMP state response.
        #[arg(long)]
        expect_id: String,
    },
    /// Manage one OMP head and independent OMP lanes using local JSONL on stdin/stdout.
    #[cfg(unix)]
    Harness {
        /// Private directory for Cataly session bindings and native session files.
        #[arg(long)]
        state_dir: PathBuf,
        /// Resident process limit, including the head.
        #[arg(long, default_value_t = 2, value_parser = clap::value_parser!(u8).range(1..=32))]
        max_sessions: u8,
    },
    /// Run the native Discord intake, approvals and reply transport in the foreground.
    #[cfg(all(unix, feature = "discord"))]
    Discord(Box<discord::Options>),
    /// Send or edit Discord text from standard input without launching OMP.
    #[cfg(all(unix, feature = "discord"))]
    DiscordSend(discord::SendOptions),
    /// Keep a Discord bot online without starting the inbox or OMP.
    #[cfg(all(unix, feature = "discord"))]
    DiscordPresence,
    /// Route local Cataly head/ASK records over private stdio; does not launch OMP.
    #[cfg(unix)]
    #[command(hide = true)]
    Routing,
    /// Supervise one reserved headless lane, lead or duty OMP session; reads its start record from stdin.
    #[cfg(unix)]
    #[command(hide = true)]
    HeadlessHost {
        /// The reservation directory `<state>/headless/<uuid>`.
        dir: PathBuf,
    },
}

#[derive(Serialize)]
struct DoctorReport {
    omp_version: Option<String>,
    rpc_protocol: u32,
    host_tools: bool,
}

async fn saved_file(path: &Path) -> Result<PathBuf> {
    let path = tokio::fs::canonicalize(path)
        .await
        .with_context(|| format!("locating OMP session file {}", path.display()))?;
    ensure!(
        tokio::fs::metadata(&path).await?.is_file(),
        "OMP session path must be a regular file"
    );
    Ok(path)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let omp = omp::Executable::new(&cli.omp, &cli.cwd, cli.model.as_deref())?;
    match cli.command {
        Command::Doctor => {
            let omp_version = match omp.version().await {
                Ok(version) => Some(version),
                Err(error) => {
                    eprintln!("OMP version metadata unavailable: {error:#}");
                    None
                }
            };
            let report = omp.inspect(omp::Target::Ephemeral).await?;
            println!(
                "{}",
                serde_json::to_string(&DoctorReport {
                    omp_version,
                    rpc_protocol: report.protocol,
                    host_tools: report.host_tools,
                })?
            );
        }
        Command::Resume {
            session_file,
            expect_id,
        } => {
            ensure!(!expect_id.trim().is_empty(), "expected session ID is empty");
            let file = saved_file(&session_file).await?;
            let report = omp
                .inspect(omp::Target::Saved {
                    file: &file,
                    id: &expect_id,
                })
                .await?;
            println!("{}", serde_json::to_string(&report.state)?);
        }
        #[cfg(unix)]
        Command::Harness {
            state_dir,
            max_sessions,
        } => {
            harness::run(
                &omp,
                harness::Options {
                    cwd: &cli.cwd,
                    root: &state_dir,
                    max_sessions: usize::from(max_sessions),
                },
            )
            .await?;
        }
        #[cfg(all(unix, feature = "discord"))]
        Command::Discord(options) => Box::pin(discord::run(&omp, &cli.cwd, *options)).await?,
        #[cfg(all(unix, feature = "discord"))]
        Command::DiscordSend(options) => Box::pin(discord::send(options)).await?,
        #[cfg(all(unix, feature = "discord"))]
        Command::DiscordPresence => Box::pin(discord::presence()).await?,
        #[cfg(unix)]
        Command::Routing => routing::run()?,
        #[cfg(unix)]
        Command::HeadlessHost { dir } => headless::run(&dir).await?,
    }
    Ok(())
}
