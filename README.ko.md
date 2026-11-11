<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# omp-dori

[Dori 모드](https://github.com/sisyphuslabs/dori-superagent/tree/main/skills/dori-mode)를 [omp](https://github.com/can1357/oh-my-pi) 위에서 omo 모델 프롬프트로 돌립니다.

[English](README.md) | 한국어

Dori는 늘 켜져 있는 에이전트 세션 하나입니다. Telegram, Discord, Slack으로 주인의 요청을 받고, 일마다 [herdr](https://herdr.dev) 탭(레인)을 열어 맡깁니다. 레인은 장부에 기록해 두고, 일이 끝났다는 증거를 확인한 뒤에만 닫습니다. 원본은 omo(senpi) 위에서 돕니다. omp-dori는 원본의 동작과 규칙을 그대로 두고 한 가지만 바꿉니다. Dori와 모든 레인이 omp에서 돌고, 모델 프롬프트로는 [omp-ulw](https://github.com/dbc-hbin/omp-ulw)가 omp로 옮긴 omo 프롬프트를 씁니다.

## 원본과 다른 점

| | 원본 Dori 모드 | omp-dori |
|---|---|---|
| 에이전트 | `omo` | `omp`. Dori는 `omp --dori-role dori`, 레인은 `omp --dori-role lane` |
| 모델 프롬프트 | omo에 내장 | omp-ulw의 omo 프리셋. Dori와 레인 세션에만 적용 |
| 레인 goal | 레인이 `create_goal`로 직접 만듦 | 레인이 omp의 `goal` 도구로 직접 만듦. omp-dori가 레인 세션에서 이 도구를 켬 |
| 상시 모니터 | 호스트의 monitor 도구 | omp-dori 확장의 `monitor` 도구 |
| 세션 ID 찾기 | `--session`, `PI_SESSION_ID`, 세션 파일 시각 | 세션이 직접 쓰는 상태 파일, 그다음 세션 파일 시각 |
| `dori pause` / `resume` 확인 | 화면의 `Goal paused` / `Goal active` | 세션이 기록한 goal 상태 |
| herdr 통합 | `pi` | `omp` |

나머지(요청 분류, 스레드, done 프로토콜, `Done =` 신호, 장부, 점검 루프, 메신저 스크립트)는 원본 코드와 문서 그대로입니다.

## omp와 맞물리는 방식

확장은 전역(`~/.omp/agent/extensions/omp-dori`)에 한 번 설치됩니다. `--dori-role` 없이 시작한 세션에서는 아무 일도 하지 않습니다. 역할은 세션 안에 저장됩니다. 그래서 `omp --resume=<id>`로 다시 열거나, herdr가 재시작 후 pane을 복원하거나, 닫았던 레인을 다시 열어도 플래그 없이 역할이 유지됩니다.

Dori나 레인 세션에서 확장이 하는 일:

- omp-ulw를 적용합니다(omo 모델 프리셋, ULW, 워크플로 명령). 이 세션들이 띄우는 서브에이전트의 프리셋도 포함합니다.
- pane 상태 파일(`~/.dori/state/sessions/<pane>.json`)을 씁니다. 세션 ID, goal 상태, 도구 승인 창이 열려 있는지가 들어갑니다. 그래서 `dori`는 승인 창에 글자를 입력하지 않습니다.
- goal이 아직 없는 레인에서 omp의 `goal` 도구를 켭니다.
- Dori 세션에서 `monitor` 도구를 켭니다. 세션이 재개되면(herdr가 재시작 후 복원하거나 `omp --resume`으로 다시 열면) 그 세션이 켜 두었던 모니터를 다시 띄웁니다. 그래서 메신저 수신기가 누가 시키지 않아도 돌아옵니다.

다른 omp 세션의 프롬프트, 도구, 동작은 그대로입니다. 다만 omp는 확장이 등록한 것을 지울 수 없게 되어 있어서, 차이가 두 가지 남습니다.

- omp-ulw의 명령(`/ulw`, `/review-work` 등)은 세션 역할이 정해지기 전, omp가 확장을 불러오는 시점에 등록됩니다. 그래서 어느 세션의 명령 목록에나 보일 수 있습니다. Dori나 레인이 아닌 세션에서 실행하면 안내만 띄우고 아무 일도 하지 않습니다.
- omp 프로세스 하나가 Dori나 레인 세션을 한 번이라도 띄우면, 그 프로세스가 끝날 때까지 omp-dori가 도구 승인 창을 지켜봅니다. 무언가 승인 창을 지켜보는 동안 omp는 읽기 추측 실행(read speculation)을 끕니다. 그래서 Dori나 레인 세션에서 `/resume`이나 `/new`로 넘어간 평소 세션은 이 기능 없이 돕니다. Dori나 레인 세션을 띄운 적 없는 프로세스는 영향이 없습니다.

레인은 브리프의 지시를 따라 스스로 goal을 만들고 `dori claim-done`을 실행합니다. 그래서 지시를 잘 지키는 모델이 필요합니다. 기본값 `anthropic/claude-opus-5-5` 레인은 둘 다 해냈고, Haiku 4.5 레인은 일은 했지만 goal과 claim을 건너뛰었습니다.

omp는 세션을 새 프로세스로 재개하면 goal을 일시정지 상태로 되돌립니다. `omp --resume=<id>`로 다시 열거나 herdr가 복원한 레인은 역할과 omo 프롬프트는 유지하지만, goal은 `/goal resume`을 보내야 다시 돕니다(`references/sessions.md`).

## 설치

git, bun 1.3 이상, omp 18.14.2 이상, herdr가 필요합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/foxion37/OMP-DORI/main/install.sh | bash
```

설치 스크립트가 하는 일:

- omp-dori를 `~/.dori/src`에, omp-ulw를 `omp-ulw.lock`에 고정된 커밋으로 `~/.dori/omp-ulw`에 받습니다.
- 스킬을 `~/.agents/skills/dori-mode`에, 확장을 `~/.omp/agent/extensions/omp-dori`에 연결합니다.
- `dori`를 PATH에 올리고 `~/.dori/config.json`을 씁니다.

같은 명령을 다시 실행하면 갱신됩니다. 직접 받아 둔 omp-ulw를 쓰려면 `OMP_ULW_SRC`를 지정하세요.

설치 후:

```sh
herdr integration install omp
$EDITOR ~/.dori/config.json        # leadPane, laneWorkspace, defaultCwd, hooks
omp --dori-role dori               # herdr pane 안에서
```

그리고 "Dori mode"라고 말하면 됩니다. 메신저, 봇, 온보딩 과정은 스킬이 안내합니다(`skills/dori-mode/references/setup.md`).

## 제거

```sh
rm ~/.omp/agent/extensions/omp-dori ~/.agents/skills/dori-mode
(cd ~/.dori/src/skills/dori-mode/scripts && bun unlink)
rm -rf ~/.dori/src ~/.dori/omp-ulw     # ~/.dori/config.json과 ~/.dori/state에는 설정과 레인 장부가 있습니다
```

## 개발

```sh
cd skills/dori-mode/scripts && bun install && bun test && bunx tsc --noEmit
cd extension && bun test && bunx tsc --noEmit
```

확장은 `~/.dori/config.json`의 `ompUlwPath`에서 omp-ulw를 읽습니다. 전역 설치 없이 작업본을 써 보려면 `omp -e ./extension/index.ts --dori-role dori`로 시작하세요.

원본에서 바꾼 부분은 작게, 원본 경로 그대로 둡니다. 그래서 `sisyphuslabs/dori-superagent`의 수정을 골라 받아올 수 있습니다(`git remote add upstream https://github.com/sisyphuslabs/dori-superagent.git`).

## 라이선스

원본과 같은 MIT입니다. omp-ulw는 저장소에 포함하지 않고, 설치 스크립트가 원래 저장소에서 받습니다.
