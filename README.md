<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omp-dori

[Dori mode](https://github.com/sisyphuslabs/dori-superagent/tree/main/skills/dori-mode) on [omp](https://github.com/can1357/oh-my-pi), running the omo model prompts.

English | [한국어](README.ko.md)

A Dori is one agent session that stays up, listens to its owner on Telegram, Discord or Slack, and gets work done by opening a [herdr](https://herdr.dev) tab per job (a lane), tracking it in a registry, and closing it only after the work is proven done. The original runs on omo (senpi). omp-dori keeps its behavior and its rules, and changes one thing: the Dori and every lane run in omp, with the omo model prompts that [omp-ulw](https://github.com/dbc-hbin/omp-ulw) ports to omp.

## What is different from the original

| | Original Dori mode | omp-dori |
|---|---|---|
| Agent | `omo` | `omp`; the Dori runs as `omp --dori-role dori`, lanes as `omp --dori-role lane` |
| Model prompts | built into omo | omp-ulw's omo presets, applied only to Dori and lane sessions |
| Lane goal | the lane creates its goal with `create_goal` | the lane creates its goal with omp's `goal` tool, which omp-dori turns on in lane sessions |
| Persistent monitors | the host's monitor tool | the `monitor` tool from the omp-dori extension |
| Session id lookup | `--session`, `PI_SESSION_ID`, session file time | a state file the session writes itself, then session file time |
| `dori pause` / `resume` readback | `Goal paused` / `Goal active` on screen | the goal state the session records |
| herdr integration | `pi` | `omp` |

Everything else (routing, threads, the done protocol, `Done =` signals, the registry, the sweeps, the messenger scripts) is the original code and text.

## How it fits into omp

The extension is installed once, globally (`~/.omp/agent/extensions/omp-dori`), and does nothing in a session that was not started with `--dori-role`. A role is stored in the session itself, so `omp --resume=<id>`, herdr restoring a pane after a restart, and reopened lanes keep it without the flag.

In a Dori or lane session the extension:

- applies omp-ulw (omo model presets, ULW, and its workflow commands), including the presets for subagents those sessions spawn;
- writes the pane's state file (`~/.dori/state/sessions/<pane>.json`): session id, goal state, and whether a tool approval prompt is open, so `dori` never types into an approval prompt;
- turns on omp's `goal` tool in lanes that have no goal yet;
- turns on the `monitor` tool in the Dori session, and restarts the monitors that session had running when it is resumed (herdr restoring it after a restart, `omp --resume`), so the messenger poller comes back without anyone asking.

Your other omp sessions keep their prompts, tools and behavior. Two differences remain, because omp lets an extension add but not remove registrations:

- omp-ulw's commands (`/ulw`, `/review-work`, ...) are registered when omp loads, before the session's role is known, so they can show up in the command list of any session. Outside a Dori or lane session they only print a notice and do nothing.
- Once an omp process has hosted a Dori or lane session, omp-dori listens for tool approval prompts until that process exits. omp turns off read speculation while anything listens for them, so a normal session reached from a Dori or lane session with `/resume` or `/new` runs without it. Processes that never host a Dori or lane session are unaffected.

Lanes follow their brief's own instructions to create a goal and to run `dori claim-done`, so they need a model that keeps to them. With the default `anthropic/claude-opus-5-5` lanes did both; a Haiku 4.5 lane did the work but skipped the goal and the claim.

omp pauses a goal when a session is resumed in a new process. A lane reopened with `omp --resume=<id>` or restored by herdr keeps its role and its omo prompts, but its goal waits for `/goal resume` (`references/sessions.md`).

## Install

Needs git, bun 1.3+, omp 18.14.2+ and herdr.

```sh
curl -fsSL https://raw.githubusercontent.com/foxion37/OMP-DORI/main/install.sh | bash
```

This clones omp-dori to `~/.dori/src` and omp-ulw (at the commit pinned in `omp-ulw.lock`) to `~/.dori/omp-ulw`, links the skill into `~/.agents/skills/dori-mode` and the extension into `~/.omp/agent/extensions/omp-dori`, puts `dori` on your PATH, and writes `~/.dori/config.json`. Run it again to update. Set `OMP_ULW_SRC` to use your own omp-ulw checkout.

Then:

```sh
herdr integration install omp
$EDITOR ~/.dori/config.json        # leadPane, laneWorkspace, defaultCwd, hooks
omp --dori-role dori               # in a herdr pane
```

and tell it "Dori mode". The skill walks through the messenger, the bot and onboarding (`skills/dori-mode/references/setup.md`).

## Uninstall

```sh
rm ~/.omp/agent/extensions/omp-dori ~/.agents/skills/dori-mode
(cd ~/.dori/src/skills/dori-mode/scripts && bun unlink)
rm -rf ~/.dori/src ~/.dori/omp-ulw     # ~/.dori/config.json and ~/.dori/state hold your config and lane registry
```

## Develop

```sh
cd skills/dori-mode/scripts && bun install && bun test && bunx tsc --noEmit
cd extension && bun test && bunx tsc --noEmit
```

The extension reads omp-ulw from `ompUlwPath` in `~/.dori/config.json`. To try a working copy without installing it globally, start omp with `omp -e ./extension/index.ts --dori-role dori`.

Changes from the original are kept small and in the original paths, so upstream fixes can be picked from `sisyphuslabs/dori-superagent` (`git remote add upstream https://github.com/sisyphuslabs/dori-superagent.git`).

## License

MIT, as the original. omp-ulw is not vendored; the installer fetches it from its own repository.
