# Shared locks and lane priority

Some work can run only one at a time on a host: a rate-limited account, a slow build, a single device. `dori harness lock` runs one command at a time per lock name, in the order the lanes' priorities set.

```
dori harness lock <name> --lane K [--priority 1-9] -- CMD [ARG ...]
dori harness lock <name> --list
dori harness start <key> --brief FILE [--priority 1-9]
dori harness priority <key> <1-9>
```

## Turn order

Each waiter writes a ticket `state/locks/<name>/<id>.json` under `DORI_HOME` with its lane, pid, arrival time, priority and place in line. The head of the line is the lowest priority number (1 first, 9 last), then the earliest place in line, so a p1 that arrives after two p5 waiters goes next, and the two p5 waiters follow in arrival order, even when they arrive in the same millisecond. Only the head tries to take the lock; every waiter checks again every 2 seconds.

Getting in line and taking the lock happen under the queue's guard file `state/locks/<name>/.guard`, one waiter at a time. A waiter's place is one past the highest place in line when it gets the guard. The head checks that it is still the head and takes the lock without letting the guard go, so a p1 that gets in line just as a p5 takes the lock is either in line before the p5 checks (and goes first) or comes after the p5 has the lock. A waiter that finds the guard held tries again on its next check.

The priority of a turn is `--priority`, else the lane's recorded priority (`start --priority`, `priority <key> N`, or the backlog item's priority when the hourly loop opened the lane), else 5. A value outside 1-9 is refused, and so is a `--lane` that is not a lane key (the same rule as `start <key>`), including the reserved role names `lead`, `duty`, `duty-loop` and `hourly-loop`, since the lane is written into the owner line. A valid key need not already have a lane record.

## The lock itself

The lock is the directory `state/<name>.lock`, created with `mkdir`, with an `owner` line `<lane> <YYYY-MM-DD HH:MM:SS> pid=<pid> cmd=<pid>` in local time: `pid` is the waiting `dori harness lock` process and `cmd` is its command. This is the same directory and owner line a shell `mkdir` lock uses (a shell lock has only `pid=`), so while both holders run, a shell waiter of the same name and `dori harness lock` exclude each other. A shell waiter does not take a ticket: it may win a free lock between two queued turns, and it is never turned away. A shell waiter clears a lock the way its own script does, so the guarantees below about a killed wrapper and clearing hold between `dori harness lock` waiters only (see Limits).

`state/` is shared with other tools (it is also OMP's default runtime state directory), and some of them keep plain lock files there that also end in `.lock`. Only a directory is a lock of this kind: a lock name whose `state/<name>.lock` is a file (or a symlink) is refused with `is not a lock directory`, and the file is left untouched.

The command is started held, its pid is added to the owner line, and only then does it run. The lock stays held while any pid on the owner line is alive, so a `dori harness lock` killed with SIGKILL does not free the lock while its command still runs.

A lock whose every owner pid is dead, or a lock directory older than 60 seconds with no owner line, is cleared and the clearing is logged. The directory is removed in place, never moved: a waiter that judged it left behind first takes the sibling claim file `state/.lock-claim-<sha256>`, then removes the directory only if it still holds that same owner line. The full SHA256 covers the target basename, a NUL separator and the complete observed owner line. Waiters that judged the same dead owner need the same claim, so only one of them clears it, and a waiter that paused after reading the dead owner never removes a lock someone took meanwhile. The guard and claim files hold the pid of the process that made them; one whose pid is dead (or that has no pid and is older than 60 seconds) is taken over under its own same-directory `.lock-claim-<sha256>`, hashing its basename and observed contents the same way. Claim components stay 76 bytes through recursive recovery, and aliases of the same physical parent and target basename share one claim namespace.

The holder's command runs with the terminal's stdin, stdout and stderr; `lock` exits with its exit code and prints its own `LOCK` lines to stderr. SIGTERM or SIGINT while waiting withdraws the ticket and exits 128 + the signal without running the command, and so does one that comes as the lock is taken, before the command is started: the lock is released and nothing runs. While the command runs, the signal goes to the command and the lock is released when it exits. A Ctrl-C at the terminal is the exception: the command is in the same process group, so the terminal has already sent it, and it is not sent again. A command that treats a second Ctrl-C as "force quit" sees one Ctrl-C, not two.

## Seeing the line

`dori harness lock <name> --list` and the end of `dori harness status` print one line per lock that is held or has waiters, within 120 columns. `status` lists the lock directories and queues under `state/` whose names are lock names, shell `mkdir` locks included; other tools' plain `*.lock` files are not listed:

```
lock build: held by lane-a 12m (pid 4242) | queue: 1) lane-c p1 3m 2) lane-b p5 9m +2 more
```

Waiters that do not fit are counted in `+N more`. Tickets of dead waiters are removed when the line is read.

## Limits

- Locks are local to one host and one `DORI_HOME`.
- A ticket written by a waiter killed with SIGKILL stays until its pid is seen dead; a reused pid can keep it in line longer.
- Owner times are local wall-clock seconds, as a shell `date` writes them, so a clock change shifts the holder age that `--list` shows.
- A shell waiter is held off only by what its own script checks. A script that reads just `pid=` from the owner line (and clears a lock with `rm -rf`, without the claim) treats a lock whose `dori harness lock` was killed with SIGKILL as stale while its command still runs, and can remove a lock a `dori harness lock` waiter took between its read and its `rm`. Such a script should keep the lock while any `pid=` or `cmd=` on the line is alive.
