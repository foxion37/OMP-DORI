<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="은빛 머리와 붉은 광륜이 있는 Cataly 캐릭터 초상">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>의도를 이해하고 맥락을 읽어 끝까지 해냅니다.</strong>
</p>

<p align="center">
  Cataly는 개발 업무를 함께하는 AI 동료입니다.
  단계별 지시 대신 목표와 지켜야 할 조건을 알려주세요.
  Discord에서 요청을 받아 전용 코딩 세션에서 작업하고,
  직접 확인할 수 있는 결과를 돌려줍니다.
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases"><img alt="최신 릴리스" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=release&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="main 브랜치 CI" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="라이선스: SUL 1.0과 범위가 정해진 MIT 고지" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 이상" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#시작하기"><strong>시작하기</strong></a> ·
  <a href="#작동-방식"><strong>작동 방식</strong></a> ·
  <a href="#문서"><strong>문서</strong></a> ·
  <a href="#기여하기"><strong>기여하기</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>한국어</strong> · <a href="README.ja.md">日本語</a><br>
  <a href="README.de.md">Deutsch</a> · <a href="README.it.md">Italiano</a> · <a href="README.zh.md">中文</a>
</p>

## 목표부터 알려주세요

<table width="100%"><tr><td>

**요청 예시**

*로그인 테스트가 간헐적으로 실패하는 이유를 찾아줘. 공개 API는 그대로 두고,
관련 테스트를 돌린 다음 원인과 검증 결과를 담아 PR을 열어줘.*

</td></tr></table>

<table>
  <tr>
    <td width="33%" valign="top">
      <h4>의도를 이해합니다</h4>
      간헐적 실패는 증상입니다. 공개 API를 유지하면서 검토할 수 있는 수정안을
      만드는 것이 목표입니다. 목표가 조사 범위를 결정합니다.
    </td>
    <td width="33%" valign="top">
      <h4>맥락을 읽습니다</h4>
      대화, 저장소 관례, 제약, 사용자가 밝힌 선호를 함께 고려합니다. 일상적인
      판단은 Cataly가 맡고, 실질적인 절충이나 권한 판단이 필요할 때는 묻습니다.
    </td>
    <td width="33%" valign="top">
      <h4>끝까지 완수합니다</h4>
      패치를 만드는 것으로 끝내지 않습니다. 합의한 결과를 확인하고, 근거와 아직
      확인하지 못한 부분을 함께 보고합니다.
    </td>
  </tr>
</table>

차이는 채팅 화면이 아니라, 요청과 실제 작업 세션, 그리고 완료를 뒷받침하는 근거가
서로 연결된다는 데 있습니다.

## 작동 방식

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works.ko-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works.ko-light.svg">
  <img src="docs/how-it-works.ko-light.svg" width="100%" alt="작업 흐름: 요청을 받고, 리드가 작업을 맡기고, 레인이 작업하고 보고하며, 완료를 검증한 뒤 확인할 수 있는 결과와 근거를 돌려줍니다.">
</picture>

아래는 현재 `main`의 작업 흐름입니다.

1. **요청을 받습니다.** Discord 수신을 켜면 지정한 사용자의 메시지를 읽고,
   확인할 수 있는 답장 맥락과 첨부 파일 메타데이터를 함께 전달합니다.
2. **리드가 작업을 맡깁니다.** 간단한 요청은 직접 처리합니다. 긴 작업에는 브리프와
   명시적인 `Done` 조건을 붙여 **레인**을 엽니다. 레인은 전용
   [oh-my-pi(OMP)](https://github.com/can1357/oh-my-pi) 코딩 세션이며, 터미널 없이 실행됩니다.
   레지스트리는 작업을 세션과 메신저 스레드에 연결합니다.
3. **레인이 작업하고 보고합니다.** 작업 로그·보고·체크포인트를 통해 재시작 후에도
   진행 상황을 확인할 수 있습니다. Discord 채널이 레인 하나에 연결돼
   있으면 일반 채팅은 해당 레인의 OMP 세션으로 전달됩니다. 지원되는 ASK 양식에
   직접 답장하면 새 작업을 시작하는 대신 열린 질문에 답합니다.
4. **완료를 검증합니다.** 레인의 완료 보고 자체가 증거는 아닙니다. Done 절차는
   명령 실행 결과, 파일 상태, PR 병합, 패키지 버전 게시 등을 확인할 수 있습니다.
   검증을 통과했다는 것은 확인한 항목의 증거이지 모든 결과를 보장한다는 뜻은 아닙니다.

## 통제권은 사용자에게 있습니다

- Cataly는 사용자가 제공한 계정과 권한으로 작동합니다. 도움이 될 것이라는 판단만으로
  외부 작업 권한이 생기지는 않습니다.
- 설치만으로 에이전트·메신저 수신기·서비스가 시작되지는 않습니다. 원하는 기능만
  활성화하세요.
- 인증 정보와 비공개 대화는 공개 보고에서 제외하세요.
- 텔레메트리는 기본적으로 꺼져 있습니다. `CATALY_TELEMETRY=1`로 동의한 경우에만
  전송하며, `DO_NOT_TRACK=1`이 우선합니다.

## 시작하기

<table width="100%"><tr><td>

**Cataly는 omp-dori의 업그레이드가 아닌 새 제품입니다**

이 버전에서 omp-dori라는 이름 전부와 herdr·hc 터미널 런타임, omp-ulw 오버레이가
제거됐습니다. omp-dori 코드를 제자리에서 업그레이드할 수는 없지만 이전은 설치
프로그램이 합니다. 이전 `~/.dori` 또는 `~/.omp-dori` 홈의 설정, 토큰, 소유자
프로필을 새 홈으로 가져오고(이미 있는 설정은 덮어쓰지 않습니다), 그 홈에서 실행
중인 것이 없으면 이전 홈과 이전 버전이 남긴 링크와 캐시를 삭제합니다
([이전 방법](docs/releases.md#cataly-is-a-new-product-moving-from-omp-dori)).

운영 명령은 `cataly`, 독립 하네스는 `cataly-harness`, 별도 설치 래퍼는
`omp-cataly`입니다. 새 설치의 기본 홈은 기본 모드 `~/.cataly`, Side 모드
`~/.omp-cataly`입니다.
[검증된 현재 릴리스 설치](docs/releases.md#install-a-current-release)를 참고하세요.
Cataly는 macOS와 Linux에서 기본적으로 headless OMP로 실행되며, Tern은 선택 사항인 터미널 런타임입니다.

</td></tr></table>

### npm 패키지 설치

`PATH`에서 Bun 1.4.4 이상을 실행할 수 있는 상태에서 프로젝트 디렉터리로
이동한 뒤 다음 두 명령 중 하나를 실행하세요.

```bash
npm install cataly
# 또는 Bun을 사용하는 경우:
bun add cataly
```

이 버전에서 설치되는 하네스 명령은 `cataly-harness`입니다.

```bash
./node_modules/.bin/cataly-harness --help
```

이 방법은 하네스 CLI만 설치합니다. OMP와 메신저까지 설정하려면
[검증된 릴리스를 설치](docs/releases.md#install-a-current-release)하거나 현재 소스에서
시작하세요.

### 현재 소스에서 시작하기

git, Bun 1.4.4 이상, [rustup](https://rustup.rs)으로 설치한 Rust 툴체인을 준비해 별도 체크아웃을 사용하세요. Linux와 macOS에서 세션은
기본적으로 headless OMP로 실행되며 터미널 서버가 필요 없습니다. 소스 설치기는 고정된 패치 버전 **OMP 19.0.1**을
준비합니다. 기본 설치에는 사전에 설치한 OMP가 필요 없고, 일반 배포판 `omp`로
이 구성을 대체하지 않습니다. 설치기는 필수 네이티브 Cataly 바이너리를 Cargo로 빌드하며,
Rust 툴체인이 없거나 빌드가 실패하면 링크·래퍼·설정을 바꾸기 전에 중단합니다. 릴리스에는 Linux x64와 macOS arm64용 바이너리가 포함됩니다.
선택 사항인 터미널 런타임으로 Tern을 쓸 수 있습니다. [Tern](docs/runtime.md#tern)을 참고하세요.

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" \
  bash scripts/install-source.sh
```

Side 모드는 기본적으로 `~/.omp-cataly`를 사용하며 기존 `~/.cataly` 설치를 건드리지
않습니다. `omp-cataly omp`로 바인딩된 OMP를 열어 모델 제공업체를 설정하고,
`omp-cataly harness up`으로 하네스를 명시적으로 시작하세요. 메신저별
구성과 실행은 [소스 설치 가이드](docs/releases.md#source-checkouts-for-maintainers)를
참고하세요. `omp-cataly doctor`는 설정을 읽기 전용으로 점검하고, `omp-cataly status`는
레인 상태를 보여줍니다.

`cataly harness status`에서 `RUNTIME headless (from default)`를 확인할 수 있습니다.

### 순정 OMP용 Rust 컨트롤러 개발

이 CLI는 위의 기본 소스 설치를 바꾸지 않습니다. Cargo로 빌드한 뒤 설치된
`cataly` 명령과 충돌하지 않도록 바이너리 경로로 실행하세요.

```bash
cargo build --locked --release
./target/release/cataly --omp "$(command -v omp)" doctor
./target/release/cataly --omp "$(command -v omp)" harness --state-dir ./.cataly-native <<'JSON'
{"op":"run","id":"request-1","key":"review","prompt":"이 작업을 한 문단으로 설명해줘."}
{"op":"receipt","id":"request-1"}
JSON
```

`doctor`는 프롬프트 없이 RPC를 점검하고 `resume`은 세션 파일과 ID가 정확히
일치하는지 확인합니다. Unix에서 `harness`는 필요한 레인을 열고 별도 상태
디렉터리에 저장한 세션을 다음 요청에서 재개합니다. `open`, `status`, `close`로
상주 세션을 관리할 수도 있습니다. 같은 ID와 입력은 모델 재호출 없이 저장된
결과를 반환하고, 결과가 불명확한 요청은 재실행하지 않습니다. `run`은 OMP에
설정된 모델을 사용하며 현재 도구 실행·승인·메신저 회신 없이 텍스트만 반환합니다.

대화형 클라이언트에서는 `run`과 같은 필드로 `run_controlled`를 실행할 수
있습니다. 실행 중 같은 스트림에서 `{"op":"run_status","id":"request-1"}` 또는
`{"op":"cancel","id":"request-1"}`을 보내세요. 제어 응답의 `control` 값은
`"running"` 또는 `"cancelling"`이며, 실행 결과는 별도로 도착합니다. 전송
전에 취소하면 실행 기록을 남기지 않습니다. 전송 뒤에 취소하면 해당 레인의
OMP 프로세스를 닫습니다. 결과가 불명확하면 롤백된 것으로 간주하지 않으며,
자동으로 다시 실행하지 않습니다.

`run_with_tools`는 같은 필드로 새 레인이나 멈춰 둔 레인을 열고 읽기 전용
도구 `cataly_read_readme`만 노출합니다. OMP가 도구를 요청하면 Cataly가
`{"id":"request-1","approval_id":"…","tool":"cataly_read_readme"}`을 보냅니다.
같은 스트림에 `{"op":"decide","id":"request-1","approval_id":"…","decision":"approve"}`
또는 `"deny"`를 보내세요. 현재 대기 중인 승인 ID에만 답할 수 있습니다.
승인 결정과 최종 실행 결과는 별도로 도착합니다. 승인하면 레인 안의
`README.md`만 읽습니다. 최대 16 KiB의 UTF-8 일반 파일을 지원하며,
심볼릭 링크와 하드 링크는 읽지 않습니다. 승인 전에 거절하거나 연결이
끊기면 파일 내용을 전달하지 않습니다. `run`과 `run_controlled`는
기존 텍스트 전용 경로를 유지합니다.

`cargo build --release`로 빌드하세요. Unix에서는 Bun 없이 Rust 명령을 직접
실행할 수 있습니다: `target/release/cataly --cwd "$WORKSPACE" discord --state-dir "$STATE_DIR" --channel "$CHANNEL_ID" --gateway`.
환경에 `CATALY_DISCORD_TOKEN`과 `CATALY_DISCORD_OWNER_ID`를 설정하세요.
`--gateway`를 빼면 REST로 폴링하고, `--poll-seconds 0`이면 한 번만 폴링합니다.
기존 `cataly inbound discord` 명령에서 Rust 모니터를 실행하는 설정은 아래와 같습니다.

| 설정 | 값 |
| --- | --- |
| `CATALY_DISCORD_NATIVE_BIN` | 선택 사항. 네이티브 Cataly 바이너리의 절대 경로로, Discord 인입과 headless 레인·리드·듀티 호스트가 사용합니다. `off`는 TypeScript Discord 전송·프레즌스·라우팅을 유지하고 Discord 인입은 시작을 거부하며, headless 호스트는 계속 번들 또는 설치된 바이너리를 사용합니다. |
| `CATALY_DISCORD_NATIVE_WORKSPACE` | 선택 사항. 네이티브 작업 디렉터리의 절대 경로. 생략하면 `laneWorkspace`를 사용합니다. |
| `CATALY_DISCORD_NATIVE_CHANNEL_ID` | 선택 사항. 인입 목록의 채널 또는 스레드 하나를 지정합니다. 생략하면 명시적으로 등록한 인입 채널 전체를 루트로 사용합니다. |
| `CATALY_DISCORD_THREADS` | 기본적으로 루트 아래의 활성 스레드를 따라갑니다. `off`면 명시한 ID만 처리합니다. Rust를 직접 실행할 때는 `--follow-threads`를 씁니다. |
| `CATALY_OMP` / `CATALY_DISCORD_NATIVE_MODEL` | 필요할 때만 지정하는 OMP 실행 파일과 모델 |

Rust가 Gateway 하트비트와 재연결, REST 조회·전송, 버튼, OMP 레인을 맡습니다.
찾은 스레드마다 커서, 레인, 답장 위치가 따로 있습니다. 전환 전에 같은 상태를 쓰는
다른 Discord 수신기를 중지하세요. `cataly inbound discord`는 첫 실행 때 TypeScript
수신기의 커서를 가져옵니다. 네이티브 바이너리가
있으면 감독형 모니터는 OMP 감독자마다 필요할 때 Rust 프로세스 하나를 띄워 ASK
답변과 head 승인을 저장된 OMP 영수증으로 판정합니다. 활성 세션, 승인 대기열,
`message_end` 전달은 여전히 OMP 확장이 맡습니다. 중단된 라우팅 요청은 몰래 다시
보내거나 head로 돌리지 않습니다. Discord 수신은 Rust 전용입니다. OMP `monitor` 도구 아래에서 `cataly inbound discord`(필터
`^INBOUND`)는 같은 PID, stdout, IPC 채널을 유지한 채 `cataly discord --supervised`로 자신을
대체합니다. `CATALY_DISCORD_SCOPE=all`, `--context`, `--activity-file`, recall, `--wake-lanes`도
모두 Rust에서 실행되며, `--wake-lanes`는 lane OMP를 headless로 직접 시작합니다. 라이브
세션은 계속 OMP 확장이 소유합니다. 네이티브 바이너리가 없으면 `cataly inbound discord`는
빌드 명령(`cargo build --locked --release`)을 안내하며 실패합니다.

head 전체를 Rust가 맡게 하려면 `--head-channel "$CHANNEL_ID"`와 명시적인
`--channel "$CHANNEL_ID"`로 별도 수신기를 실행하세요. 그 대화만 head로 가고,
다른 채널과 스레드는 독립 레인을 유지합니다. 수신기는 `--state-dir`에 저장된
`head` 세션을 그대로 불러오거나 첫 실행 때 만들고, 실행이 끝나면 OMP를 다시
내립니다. 같은 네이티브 상태나 기록 파일을 다른 OMP 프로세스에서 열지 마세요.
기존 ASK 답변을 먼저 처리하려면 `--ask-state "$CATALY_STATE_DIR"`(절대 경로)를
넘기세요.

설치된 CLI에서는 `CATALY_DISCORD_HEAD_CHANNEL_ID`를 명시한 인입 채널 중 하나로
정하고, 대화형 OMP 모니터 밖에서 `cataly inbound discord --gateway`를 실행합니다.
상태는 `$CATALY_STATE_DIR/discord-head`에 저장됩니다. 전환 전에 기존 수신기를
중지하세요. Rust는 `$CATALY_STATE_DIR/discord-inbound`의 `gateway.sqlite` 큐와
커서를 이어받습니다. 미확정 head 승인은 원래 OMP 영수증으로만 확정하고, 영수증이
없으면 큐를 그대로 둡니다. 실행 중인 대화형 OMP 세션은 가져오지 않습니다.

Rust 바이너리가 설치되거나 배포본에 포함되어 있으면 `cataly send discord`와
`cataly presence discord`가 자동으로 Rust를 선택합니다. Bun과 OMP 없이
`target/release/cataly discord-send --thread "$THREAD_ID" < reply.txt`로
직접 호출할 수도 있습니다. 답장은 `--reply MESSAGE_ID`, 기존 메시지 편집은
`--edit MESSAGE_ID`를 사용합니다. `--to`에는 채널 ID 또는
`CATALY_DISCORD_GUILD_ID` 안의 고유한 채널 이름을 지정합니다. 직접 호출은
JSON 전송 영수증을 반환합니다. 긴 코드 블록은 UTF-16 경계를 지키며 조각마다
닫고 다시 엽니다. 온라인 상태만 유지하려면 `target/release/cataly discord-presence`를 사용하세요.
Linux x64와 macOS arm64 배포본에는 체크섬으로 검증하는 Rust 바이너리가 포함됩니다.
소스 설치는 Cargo로 직접 빌드하며, Rust 툴체인이 없거나 빌드가 실패하면
링크·래퍼·설정을 바꾸기 전에 중단합니다.

소유자의 일반 텍스트는 도구 없이 실행하고, 첨부 파일은 다운로드하지 않습니다.
같은 채널·스레드에서 저장된 세션을 재사용하되, 실행이 끝나면 OMP 프로세스는
닫습니다. OMP가 호스트 도구를 지원할 때, Gateway에서 `!cataly <요청>`으로
승인 기반 README 도구를 사용할 수 있습니다. 결과는 원래 메시지에 답장으로
달리며 채널 구성원에게 보입니다.

Rust는 답장 각 부분을 보내기 전에 전송 의도를 기록하고, 확인 뒤에는 Discord가
반환한 메시지 ID를 저장합니다. 재시작해도 완료된 요청이나 확인된 답장을
반복하지 않습니다. 전송 여부가 불명확하면 해당 부분부터 보류합니다.
`DISCORD_REPLY_HELD`가 기록되면 원래 Discord 스레드와 네이티브 상태 기록을
확인하세요.

#### 네이티브 Discord의 로컬 메모리

`~/.local/bin/ai-memory`가 설치되어 있으면 Rust 모니터가 사용합니다.
다른 절대 경로는 `CATALY_MEMORY_BIN`으로 지정하고, 빈 값으로 설정하면
체크포인트를 끕니다. 메모리 전용 로컬 워커가 추가 모델 호출 없이
`127.0.0.1:49374`에 색인합니다. 서버가 내려가도 로컬 체크포인트는 남습니다.

일반 대화는 방에만 기록합니다. 새 메모 8개, 10분 주기 또는 세션 파일
16 MB 도달 시 저장하여 20 MB 전에 여유를 둡니다. 오래 남길 내용은
`!remember room …`, `!remember person …`, `!remember project …`,
`!remember common …` 중 하나로 범위를 지정하세요. 명시 저장은 OMP를
띄우지 않고 로컬에서 처리합니다. 공통 메모리도 같은 상태 디렉터리와
같은 봇·소유자 범위 안에서만 프로젝트를 넘나듭니다. 사람 메모리는 채널 응답에
섞지 않고 로컬 ai-memory에서 읽습니다. 승인한 도구 출력과 첨부 파일은
수집하지 않으며, 원본 OMP 세션 파일은 자르거나 삭제하지 않습니다.

Cataly는 OMP 버전 문자열이나 SDK, 코어 패치가 아닌 공개 RPC에 의존합니다.
`Cataly Native` CI는 변경 시 기준 버전을 검사하고, 최신 공식 Linux 릴리스는
매일 별도로 검증합니다. `cataly doctor`로 설치된 RPC와 호스트 도구 지원 여부를
확인할 수 있습니다. 공개 RPC가 깨지면 어댑터를 수정해야 하며, 결과를 확인하지
못한 실행은 자동으로 반복하지 않습니다. Discord 네트워크 라이브러리 없이
OMP 하네스만 빌드하려면 `--no-default-features`를 사용하세요.

<table width="100%"><tr><td>

**중요**

**지원 범위:** Slack과 Telegram은 소스에 남아 있는 연동 기능이며 소비자 릴리스의
지원 범위에 포함되지 않습니다. 호환 릴리스 매니페스트에 명시된 경우 격리된
macOS arm64 headless 설치가 가능하지만, 해당 배포본이 게시됐다는 뜻은 아닙니다.
`main` 병합만으로 게시된 릴리스가 업데이트되지는 않습니다.

</td></tr></table>

## 문서

| 설치와 운영                                                         | 더 알아보기                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [설치, 지원, 업데이트와 롤백](docs/releases.md)                     | [런타임 어댑터와 세션 계약](docs/runtime.md)                        |
| [메신저 설정](skills/cataly-mode/references/setup.md)                 | [소스 개발용 컨테이너](docs/container.md)                           |
| [Cataly 운영 규칙](skills/cataly-mode/SKILL.md)                         | [스케줄링과 백로그](docs/hourly-loop.md)                            |
| [레인 명령과 설정](skills/cataly-mode/references/scripts.md)          | [공유 잠금과 레인 우선순위](docs/locks.md)                          |
| [완료 검증 절차](skills/cataly-mode/references/done-protocol.md)      | [선택형 유료 Discord 음성 도우미(현재 소스)](docs/discord-voice.md) |
| [변경 기록](CHANGELOG.md)                                           |                                                                     |

## 기여하기

[기여 안내](CONTRIBUTING.md)에서 시작하고
[이슈](https://github.com/vntrevx/Cataly/issues)와
[PR](https://github.com/vntrevx/Cataly/pulls)을 확인하세요. 변경 범위를 분명히 하고,
작동을 확인한 근거를 함께 남겨주세요.

## 라이선스와 출처

Cataly는 [dori-superagent](https://github.com/sisyphuslabs/dori-superagent)에서 파생됐으며
[oh-my-pi](https://github.com/can1357/oh-my-pi)를 기반으로 합니다. dori-superagent에서
파생된 부분은 [Sustainable Use License 1.0](LICENSE)을 따릅니다. 기존 OMP 통합
부분은 [MIT 라이선스와 저작권 고지](LICENSE.integration)를 유지하며, 이 MIT 고지는
저장소 전체에 적용되지 않습니다. 다른 구성 요소에는 각각의 조건이 적용됩니다.
가져온 소스의 리비전과 수정본 출처는 [라이선스 안내](LICENSING.md)와 [NOTICE](NOTICE)를
참고하세요.
