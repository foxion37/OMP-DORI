//! The host launch guard a wake must pass: `sampleHost` + `canLaunch` (`host-guard.ts`, `routing.ts`,
//! `cgroup-memory.ts`).
//!
//! `canLaunch` holds on memory, the cgroup budgets, disk and the session count; load and swap only feed the TypeScript
//! alert loop, so they are not sampled here. macOS memory is `src/platform/darwin.ts` `darwinMemFreePct`, read the
//! same way.
//!
//! The session count is every live headless broker; an unknown or failed headless observation makes it unknown (-1),
//! as before.

use std::path::Path;

use serde::Deserialize;

use super::headless;
use crate::util::{RECORD_LIMIT, read_limited};

/// `GuardThresholds` from the loaded config.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Guard {
    pub(super) mem_free_min_pct: f64,
    pub(super) disk_free_min_gb: f64,
    pub(super) panes_max: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Headroom {
    free_pct: f64,
}

#[derive(Debug, Default)]
struct Cgroup {
    hard: Option<Headroom>,
    high: Option<Headroom>,
}

#[derive(Debug)]
struct Sample {
    mem_free_pct: f64,
    cgroup: Option<Cgroup>,
    disk_free_gb: f64,
    panes: i64,
}

fn read(path: &str) -> Option<String> {
    read_limited(Path::new(path), RECORD_LIMIT)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

#[cfg(any(not(target_os = "macos"), test))]
fn meminfo_kb(info: &str, key: &str) -> Option<f64> {
    info.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        let digits = rest
            .trim_start()
            .split(|c: char| !c.is_ascii_digit())
            .next()?;
        if digits.is_empty() {
            None
        } else {
            digits.parse().ok()
        }
    })
}

/// `Math.round(available / total * 100)`, or 100 when unreadable.
#[cfg(not(target_os = "macos"))]
fn mem_free_pct() -> f64 {
    let info = read("/proc/meminfo").unwrap_or_default();
    match (
        meminfo_kb(&info, "MemTotal"),
        meminfo_kb(&info, "MemAvailable"),
    ) {
        (Some(total), Some(available)) if total > 0.0 => (available / total * 100.0).round(),
        _ => 100.0,
    }
}

/// `kern.memorystatus_level`: XNU's `memorystatus_level`, which `memory_pressure` prints as "System-wide memory free
/// percentage".
#[cfg(target_os = "macos")]
const LEVEL: &str = "kern.memorystatus_level";

/// `os.freemem()`/`os.totalmem()` on macOS: `hw.memsize`, then the free and speculative pages `host_statistics` adds
/// into `free_count`, then the kernel page size both count in.
#[cfg(target_os = "macos")]
const FREE_PAGES: [&str; 4] = [
    "hw.memsize",
    "vm.page_free_count",
    "vm.page_speculative_count",
    "vm.pagesize",
];

/// darwin.ts `darwinMemFreePct` over the bounded `/usr/sbin/sysctl` reader.
#[cfg(target_os = "macos")]
fn mem_free_pct() -> f64 {
    use crate::discord::darwin::sysctl;
    f64::from(darwin_mem_free_pct(sysctl(&[LEVEL], 16).as_deref(), || {
        sysctl(&FREE_PAGES, 128)
    }))
}

/// darwin.ts `darwinMemFreePct`: the level when it is a whole percentage, else free pages over physical memory, else
/// 0. Both are kernel interfaces every macOS host has, so neither answering holds the launch instead of admitting it.
#[cfg(any(target_os = "macos", test))]
fn darwin_mem_free_pct(level: Option<&str>, free_pages: impl FnOnce() -> Option<String>) -> u8 {
    level
        .and_then(whole_percent)
        .or_else(|| free_pages().as_deref().and_then(free_page_pct))
        .unwrap_or(0)
}

/// darwin.ts: `/^\d{1,3}$/` after trimming, at most 100.
#[cfg(any(target_os = "macos", test))]
fn whole_percent(text: &str) -> Option<u8> {
    let text = text.trim();
    if text.is_empty() || text.len() > 3 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|level| *level <= 100)
}

/// `Math.round(freemem() / totalmem() * 100)` from the four `FREE_PAGES` lines; `None` unless it is 0 to 100.
#[cfg(any(target_os = "macos", test))]
fn free_page_pct(text: &str) -> Option<u8> {
    let values = text
        .lines()
        .map(|line| line.trim().parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let [memsize, free, speculative, page] = values[..] else {
        return None;
    };
    let free = u128::from(free.checked_add(speculative)?) * u128::from(page);
    let total = u128::from(memsize);
    if total == 0 {
        return None;
    }
    // floor(free * 100 / total + 1/2), in integers.
    u8::try_from((free * 200 + total) / (total * 2))
        .ok()
        .filter(|pct| *pct <= 100)
}

/// `df -k <path>` available space in GB (the TypeScript guard's 1024³ unit). macOS `df` reads `statfs`; its
/// `statvfs` narrows block counts to 32 bits (Libc `emulated/statvfs.c`), which would understate 16 TiB free or more.
fn disk_free_gb(path: &Path) -> f64 {
    #[cfg(target_os = "macos")]
    let available =
        rustix::fs::statfs(path).map(|stat| stat.f_bavail.saturating_mul(u64::from(stat.f_bsize)));
    #[cfg(not(target_os = "macos"))]
    let available =
        rustix::fs::statvfs(path).map(|stat| stat.f_bavail.saturating_mul(stat.f_frsize));
    available.map_or(0.0, |bytes| {
        f64::from(u32::try_from(bytes >> 20).unwrap_or(u32::MAX)) / 1024.0
    })
}

fn decode_mount(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn bytes(value: Option<&str>) -> Option<f64> {
    let text = value?.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: f64 = text.parse().ok()?;
    (number <= 9_007_199_254_740_991.0).then_some(number)
}

fn stat_value(stat: &str, key: &str) -> Option<f64> {
    stat.lines().find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix(' ')?;
        bytes(Some(value))
    })
}

fn posix_join(mount: &str, relative: &str) -> String {
    let mut out: Vec<&str> = mount.split('/').filter(|p| !p.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    format!("/{}", out.join("/"))
}

fn parent_dir(dir: &str) -> String {
    match dir.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(at) => dir[..at].to_owned(),
    }
}

/// `sampleCgroupMemory()` over the visible hierarchy.
fn cgroup() -> Cgroup {
    let mut result = Cgroup::default();
    let (Some(membership), Some(mountinfo)) =
        (read("/proc/self/cgroup"), read("/proc/self/mountinfo"))
    else {
        return result;
    };
    let memberships: Vec<(&str, &str, &str)> = membership
        .lines()
        .filter_map(|line| {
            let (id, rest) = line.split_once(':')?;
            let (controllers, path) = rest.split_once(':')?;
            Some((id, controllers, path))
        })
        .collect();
    let legacy = memberships
        .iter()
        .find(|g| g.1.split(',').any(|c| c == "memory"));
    let Some(group) = legacy.or_else(|| memberships.iter().find(|g| g.0 == "0" && g.1.is_empty()))
    else {
        return result;
    };
    let v1 = legacy.is_some();
    let path = group.2;
    if !path.starts_with('/') || path.split('/').any(|p| p == "..") {
        return result;
    }
    let mut candidates: Vec<(String, String)> = mountinfo
        .lines()
        .filter_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            let fields: Vec<&str> = left.split(' ').collect();
            let fs: Vec<&str> = right.split(' ').collect();
            let (root, mount) = (fields.get(3)?, fields.get(4)?);
            let kind_ok = if v1 {
                fs.first() == Some(&"cgroup")
                    && fs
                        .get(2)
                        .is_some_and(|o| o.split(',').any(|c| c == "memory"))
            } else {
                fs.first() == Some(&"cgroup2")
            };
            let (root, mount) = (decode_mount(root), decode_mount(mount));
            (kind_ok
                && root.starts_with('/')
                && mount.starts_with('/')
                && (root == "/" || path == root || path.starts_with(&format!("{root}/"))))
            .then_some((root, mount))
        })
        .collect();
    candidates.sort_by_key(|(root, _)| root.len());
    let Some((root, mount)) = candidates.into_iter().next() else {
        return result;
    };
    let relative = path.strip_prefix(root.as_str()).unwrap_or(path);
    let leaf = posix_join(&mount, relative);
    let mut dir = leaf.clone();
    loop {
        let at_root = dir == mount;
        let hierarchy = if v1 {
            read(&format!("{dir}/memory.use_hierarchy")).map(|h| h.trim().to_owned())
        } else {
            Some("1".to_owned())
        };
        if !v1 || dir == leaf || hierarchy.as_deref() == Some("1") {
            sample_level(&mut result, &dir, v1, at_root, hierarchy.as_deref());
        }
        if at_root || dir == "/" {
            break;
        }
        dir = parent_dir(&dir);
    }
    result
}

/// Clean, unmapped file cache that can be reclaimed: shared, mapped and in-flight pages are not budget.
fn reclaimable(dir: &str, v1: bool, hierarchy: Option<&str>, used: f64) -> f64 {
    let stat = read(&format!("{dir}/memory.stat")).unwrap_or_default();
    let keys: Vec<String> = if v1 {
        ["cache", "shmem", "mapped_file", "dirty", "writeback"]
            .iter()
            .map(|k| {
                if hierarchy == Some("1") {
                    format!("total_{k}")
                } else {
                    (*k).to_owned()
                }
            })
            .collect()
    } else {
        [
            "file",
            "shmem",
            "file_mapped",
            "file_dirty",
            "file_writeback",
        ]
        .iter()
        .map(|k| (*k).to_owned())
        .collect()
    };
    let counts: Option<Vec<f64>> = keys.iter().map(|k| stat_value(&stat, k)).collect();
    match counts {
        Some(counts) if matches!(hierarchy, Some("0" | "1")) => {
            let net = counts.iter().skip(1).fold(counts[0], |n, v| n - v);
            used.min(net.max(0.0))
        }
        _ => 0.0,
    }
}

/// One cgroup level's hard (`memory.max`/`limit_in_bytes`) and high headroom, keeping the tightest seen.
fn sample_level(result: &mut Cgroup, dir: &str, v1: bool, at_root: bool, hierarchy: Option<&str>) {
    let limits: &[&str] = if v1 {
        &["memory.limit_in_bytes"]
    } else {
        &["memory.max", "memory.high"]
    };
    let current = read(&format!(
        "{dir}/{}",
        if v1 {
            "memory.usage_in_bytes"
        } else {
            "memory.current"
        }
    ));
    let mut reclaim: Option<f64> = None;
    for (index, file) in limits.iter().enumerate() {
        let text = read(&format!("{dir}/{file}")).map(|t| t.trim().to_owned());
        if (at_root && !v1 && text.is_none()) || (!v1 && text.as_deref() == Some("max")) {
            continue;
        }
        if v1
            && text
                .as_deref()
                .is_some_and(|t| t.parse::<u128>().is_ok_and(|n| n >= 1 << 60))
        {
            continue;
        }
        let (Some(limit), Some(used)) = (bytes(text.as_deref()), bytes(current.as_deref())) else {
            continue;
        };
        let reclaim = *reclaim.get_or_insert_with(|| reclaimable(dir, v1, hierarchy, used));
        let free_pct = if limit == 0.0 {
            0.0
        } else {
            ((limit - used + reclaim) / limit * 100.0).max(0.0)
        };
        let slot = if index == 0 {
            &mut result.hard
        } else {
            &mut result.high
        };
        if slot.is_none_or(|seen| free_pct < seen.free_pct) {
            *slot = Some(Headroom { free_pct });
        }
    }
}

/// Live sessions this host runs, or -1 when a headless broker cannot be observed.
async fn sessions(state: &Path) -> i64 {
    let Ok(hosts) = headless::hosts(state).await else {
        return -1;
    };
    if hosts
        .iter()
        .any(|(_, seen)| seen.status == "unknown" || seen.status == "error")
    {
        return -1;
    }
    i64::try_from(hosts.len()).unwrap_or(i64::MAX)
}

async fn sample(state: &Path, cwd: &Path) -> Sample {
    Sample {
        mem_free_pct: mem_free_pct(),
        cgroup: cfg!(target_os = "linux").then(cgroup),
        disk_free_gb: disk_free_gb(cwd),
        panes: sessions(state).await,
    }
}

/// `canLaunch(sample, thresholds).reasons`.
fn reasons(sample: &Sample, guard: &Guard) -> Vec<String> {
    let mut reasons = Vec::new();
    if sample.mem_free_pct < guard.mem_free_min_pct {
        reasons.push("memory".to_owned());
    }
    if let Some(cgroup) = &sample.cgroup {
        for budget in [cgroup.hard, cgroup.high].into_iter().flatten() {
            if budget.free_pct < guard.mem_free_min_pct {
                reasons.push("cgroup".to_owned());
            }
        }
    }
    if sample.disk_free_gb < guard.disk_free_min_gb {
        reasons.push("disk".to_owned());
    }
    let panes = i32::try_from(sample.panes).map_or(f64::MAX, f64::from);
    if guard.panes_max > 0.0 && sample.panes < 0 {
        reasons.push("session count unknown".to_owned());
    }
    if guard.panes_max > 0.0 && panes >= guard.panes_max {
        reasons.push("panes".to_owned());
    }
    reasons
}

/// `canLaunch(await sampleHost(run, cwd, rts), guard).ok`.
pub(super) async fn can_launch(state: &Path, cwd: &Path, guard: &Guard) -> bool {
    reasons(&sample(state, cwd).await, guard).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> Guard {
        Guard {
            mem_free_min_pct: 20.0,
            disk_free_min_gb: 50.0,
            panes_max: 20.0,
        }
    }

    #[test]
    fn launch_reasons_match_can_launch() {
        let ok = Sample {
            mem_free_pct: 50.0,
            cgroup: Some(Cgroup {
                hard: Some(Headroom { free_pct: 30.0 }),
                high: None,
            }),
            disk_free_gb: 100.0,
            panes: 3,
        };
        assert_eq!(reasons(&ok, &guard()), [] as [&str; 0]);
        let full = Sample { panes: 20, ..ok };
        assert_eq!(reasons(&full, &guard()), ["panes"]);
        let unknown = Sample { panes: -1, ..full };
        assert_eq!(reasons(&unknown, &guard()), ["session count unknown"]);
        let squeezed = Sample {
            cgroup: Some(Cgroup {
                hard: None,
                high: Some(Headroom { free_pct: 5.0 }),
            }),
            panes: 0,
            ..unknown
        };
        assert_eq!(reasons(&squeezed, &guard()), ["cgroup"]);
    }

    #[test]
    fn meminfo_and_paths() {
        let info = "MemTotal:       1000 kB\nMemAvailable:    250 kB\n";
        assert_eq!(meminfo_kb(info, "MemTotal"), Some(1000.0));
        assert_eq!(meminfo_kb(info, "MemFree"), None);
        assert_eq!(
            posix_join("/sys/fs/cgroup", "/user.slice/a"),
            "/sys/fs/cgroup/user.slice/a"
        );
        assert_eq!(parent_dir("/sys/fs"), "/sys");
        assert_eq!(decode_mount("/a\\040b"), "/a b");
    }

    /// darwin.ts `darwinMemFreePct`: a whole-percent level wins without reading free pages, a malformed one falls
    /// back to them, and with neither the guard reads 0, which holds the launch.
    #[test]
    fn darwin_memory_policy_matches_darwin_ts() {
        let unread = || -> Option<String> { panic!("a readable level never reads free pages") };
        assert_eq!(darwin_mem_free_pct(Some("72\n"), unread), 72);
        assert_eq!(darwin_mem_free_pct(Some("0"), unread), 0);
        assert_eq!(darwin_mem_free_pct(Some(" 100 "), unread), 100);
        // 131072 free and speculative pages of 16 KiB in 16 GiB is 12.5%, which Math.round takes up.
        let pages = || Some("17179869184\n100000\n31072\n16384\n".to_owned());
        for level in [
            None,
            Some(""),
            Some("garbage"),
            Some("101"),
            Some("-1"),
            Some("7.5"),
            Some("0072"),
            Some("1e2"),
        ] {
            assert_eq!(darwin_mem_free_pct(level, pages), 13, "{level:?}");
        }
        assert_eq!(free_page_pct("8589934592\n0\n0\n4096\n"), Some(0));
        assert_eq!(free_page_pct("8589934592\n2097152\n0\n4096\n"), Some(100));
        for pages in [
            None,
            Some(""),
            Some("1\n2\n3\n"),
            Some("1\n2\n3\n4\n5\n"),
            Some("0\n1\n1\n16384\n"),
            Some("1024\n1\n0\n4096\n"),
            Some("8589934592\n-1\n0\n4096\n"),
        ] {
            assert_eq!(
                darwin_mem_free_pct(None, || pages.map(str::to_owned)),
                0,
                "{pages:?}"
            );
        }
    }

    /// The guard reads what TypeScript reads on this Mac: `darwinMemFreePct` (the level host-guard.ts samples),
    /// `memoryFreePct` (its free-pages fallback) and `df -k` for disk. Memory moves, so each TypeScript value must
    /// fall between two Rust reads taken around it, give or take a small slack.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_readers_match_typescript() {
        use crate::discord::darwin::sysctl;

        let rust = || {
            let level =
                whole_percent(&sysctl(&[LEVEL], 16).expect("kern.memorystatus_level answers"));
            let free =
                free_page_pct(&sysctl(&FREE_PAGES, 128).expect("the free-page sysctls answer"));
            (
                f64::from(level.expect("a whole percentage")),
                f64::from(free.expect("a free-page share")),
            )
        };
        let root = env!("CARGO_MANIFEST_DIR");
        let script = format!(
            r#"import {{ darwinMemFreePct }} from "{root}/src/platform/darwin.ts";
import {{ memoryFreePct }} from "{root}/src/platform/shared.ts";
console.log(JSON.stringify({{ level: darwinMemFreePct(), free: memoryFreePct() }}));"#
        );
        let before = rust();
        let guard = mem_free_pct();
        let out = std::process::Command::new("bun")
            .args(["-e", &script])
            .stdin(std::process::Stdio::null())
            .output()
            .expect("bun runs the TypeScript memory readers");
        let after = rust();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let ts: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let within = |value: f64, a: f64, b: f64, slack: f64| {
            a.min(b) - slack <= value && value <= a.max(b) + slack
        };
        let level = ts["level"].as_f64().unwrap();
        assert!(
            within(level, before.0, after.0, 2.0),
            "TypeScript level {level}, Rust {before:?} then {after:?}"
        );
        assert!(
            within(guard, before.0, after.0, 2.0),
            "guard {guard}, Rust {before:?} then {after:?}"
        );
        // Free pages swing more than the level: bun's own start takes some, so this slack is wider.
        let free = ts["free"].as_f64().unwrap();
        assert!(
            within(free, before.1, after.1, 5.0),
            "TypeScript free pages {free}, Rust {before:?} then {after:?}"
        );

        let df = std::process::Command::new("/bin/df")
            .args(["-k", "/"])
            .env_clear()
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        let kib: f64 = String::from_utf8(df.stdout)
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .split_whitespace()
            .nth(3)
            .unwrap()
            .parse()
            .unwrap();
        let disk = disk_free_gb(Path::new("/"));
        assert!(
            (disk - kib / 1_048_576.0).abs() < 1.0,
            "statfs {disk} GB, df -k {kib} KiB"
        );
    }
}
