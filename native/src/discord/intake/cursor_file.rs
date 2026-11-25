//! The per-channel cursor file the TypeScript intake writes (discord-inbound-state.ts), read and mirrored here.

use std::fs::File;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use anyhow::{Context, Result, ensure};
use rustix::fs::{AtFlags, Mode, OFlags, open, openat, renameat, unlinkat};
use rustix::io::Errno;
use serde::{Deserialize, Serialize};

use super::Snowflake;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPosition {
    version: u8,
    channel_id: Snowflake,
    #[serde(rename = "cursor")]
    position: String,
}

pub(in crate::discord) fn read(
    dir: Option<&Path>,
    channel: Snowflake,
) -> Result<Option<Snowflake>> {
    let Some(dir) = dir else {
        return Ok(None);
    };
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let directory = match open(dir, flags | OFlags::DIRECTORY, Mode::empty()) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error).context("opening the Discord inbound cursor directory"),
    };
    let uid = rustix::process::geteuid().as_raw();
    let meta = directory.metadata()?;
    ensure!(
        meta.uid() == uid && meta.mode().trailing_zeros() >= 6,
        "Discord inbound cursor directory is not private"
    );
    let file = match openat(
        &directory,
        format!("{channel}.json"),
        flags | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error).context("opening the Discord inbound cursor"),
    };
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == uid
            && meta.mode().trailing_zeros() >= 6
            && meta.nlink() == 1,
        "Discord inbound cursor is not a private regular file"
    );
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024,
        "Discord inbound cursor exceeded its limit"
    );
    let cursor: SavedPosition =
        serde_json::from_slice(&bytes).context("invalid Discord inbound cursor")?;
    ensure!(
        cursor.version == 1 && cursor.channel_id == channel,
        "Discord inbound cursor does not match the channel"
    );
    Ok(Some(if cursor.position == "0" {
        Snowflake::FLOOR
    } else {
        Snowflake::try_from(cursor.position).map_err(anyhow::Error::msg)?
    }))
}

pub(in crate::discord) fn write(
    dir: Option<&Path>,
    channel: Snowflake,
    cursor: Snowflake,
) -> Result<()> {
    let Some(dir) = dir else { return Ok(()) };
    if read(Some(dir), channel)?.is_some_and(|prior| prior >= cursor) {
        return Ok(());
    }
    let handle = match open(
        dir,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::DIRECTORY,
        Mode::empty(),
    ) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let meta = handle.metadata()?;
    ensure!(
        meta.uid() == rustix::process::geteuid().as_raw() && meta.mode().trailing_zeros() >= 6,
        "Discord inbound cursor directory is not private"
    );
    let path = format!("{channel}.json");
    let temporary = format!(".{channel}.cataly-native.tmp");
    match unlinkat(&handle, temporary.as_str(), AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => {}
        Err(error) => return Err(error.into()),
    }
    let mut file = File::from(openat(
        &handle,
        temporary.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?);
    serde_json::to_writer(
        &mut file,
        &SavedPosition {
            version: 1,
            channel_id: channel,
            // The TS store writes "0" for a channel without messages; FLOOR reads back from "0".
            position: if cursor == Snowflake::FLOOR {
                "0".to_owned()
            } else {
                cursor.to_string()
            },
        },
    )?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    renameat(&handle, temporary.as_str(), &handle, path.as_str())?;
    handle.sync_all()?;
    Ok(())
}
