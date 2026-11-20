<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>意図を理解し、文脈を読み取り、最後までやり遂げる。</strong>
</p>

<p align="center">
  Cataly は、目標を成果へとつなげ、仕事を最後までやり遂げる AI のチームメイトです。達成したいことを伝えると、次の段取りを引き受け、周囲の文脈を踏まえながら、ユーザーが確かめられる成果に至るまで取り組みます。
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases/tag/v0.1.2"><img alt="Published preview" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=preview&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#はじめに"><strong>はじめに</strong></a> ·
  <a href="#仕組み"><strong>仕組み</strong></a> ·
  <a href="#ドキュメント"><strong>ドキュメント</strong></a> ·
  <a href="#貢献するには"><strong>貢献するには</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <strong>日本語</strong><br>
  <a href="README.de.md">Deutsch</a> · <a href="README.it.md">Italiano</a> · <a href="README.zh.md">中文</a>
</p>

## 基本となる考え方

目指すのは、単に指示に従うことではありません。重要な点に気づき、細部を結びつけ、
一つひとつ管理してもらわなくても仕事を進める、適切な判断力を発揮することです。

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>結果に責任を持つ</h4>
      作業項目を消化するのではなく、目標の達成に向けて動きます。
    </td>
    <td width="50%" valign="top">
      <h4>文脈を理解する</h4>
      会話、プロジェクトの慣習、制約、ユーザーの好みを念頭に置きます。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>よく考えて主体的に動く</h4>
      日常的な判断は自ら行います。実質的なトレードオフや許可の不足によりユーザーの判断が必要なときは質問します。
    </td>
    <td width="50%" valign="top">
      <h4>最後までやり遂げる</h4>
      調査、実装、検証を行い、実際に何が起きたかを報告します。説得力のある説明は、動く成果の代わりにはなりません。
    </td>
  </tr>
</table>

Cataly はこの基準を軸に作られています。行動できる力、文脈を理解する注意深さ、
そして結果への責任を備えることです。

## 仕組み

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Cataly は、メッセンジャーでの会話をネイティブのコーディングエージェント
ランタイムと、進捗を追跡できる作業レーンにつなぎます。

- リードは小さな依頼を直接処理し、長い作業には作業概要、専用セッション、
  責任を持つ担当者を割り当てます。
- 作業ログ、チェックポイント、レジストリにより、再起動を挟んでも進捗を確認できます。
- Discord の受信処理は、返信の文脈と添付ファイルのメタデータを作業に引き継ぎます。
- プロセスに結びついたセッション記録と承認記録が、意図したエージェントへの配信を守ります。
- 完了チェックでは、正常終了したコマンド、一致するファイル、マージ済みの
  プルリクエスト、公開済みのバージョンなど、具体的なシグナルを検証できます。
- 任意のスケジューリング、モニター、監督機能は、明示的に有効にした場合に
  継続的な作業を支えます。

この実装は、
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent)、
[oh-my-pi](https://github.com/can1357/oh-my-pi)、
[omp-ulw](https://github.com/dbc-hbin/omp-ulw)を組み合わせています。各プロジェクトの
著作者、ライセンス、ソースの由来は、引き続きこのプロジェクトの一部として保持されます。

## 運用原則

Cataly は、ユーザーが提供するアカウントと権限で動作します。外部に影響する操作には
該当する許可が必要です。役に立つと判断しただけで権限を得ることはありません。
実行するつもりのセッション、モニター、サービスだけを有効にしてください。

検証には限界があります。完了シグナルの条件を満たしたことは、そのシグナルの証拠であり、
あらゆる結果の保証ではありません。報告では、観測した結果、残る不確実性、
実施しなかった作業を区別する必要があります。

認証情報、非公開の会話、アカウントデータを、公開パッチや報告に含めないでください。
任意のテレメトリーは `DORI_TELEMETRY=0` または `DO_NOT_TRACK=1` で
無効にできます。

## はじめに

<table width="100%"><tr><td>

**注記**

Cataly はプロジェクト名です。既存の `dori`、`omp-dori`、`omp` コマンド、
インストール先のホーム、公開済みアセットの名前は変更していません。

</td></tr></table>

### 公開済みリリースを使う

既存の **v0.1.2 プレリリース**では、Linux x64 / herdr / Discord を対象とする
契約が固定されています。リポジトリ名を変えても、それらのアセットが更新されたり、
新しいプラットフォームがサポート対象になったりするわけではありません。

[検証済みの特定リリース導入手順](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#prerequisites-and-trust)に従ってください。
前提条件、チェックサム、インストール、自分の認証、明示的な起動、任意で有効にする
Discord モニターを説明しています。特定のリリースを、任意の `main`
インストーラーで代用しないでください。

### ソースから作業する

先に git、Bun 1.4.4+、herdr または hc をインストールしてください。
詳しくは[ソース版の前提条件](docs/releases.md#current-source-bundle)を参照してください。

稼働中のインストールや固定された利用者向けリリースではなく、別のチェックアウトを使ってください。

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

ソースインストーラーは、プロジェクト指定の修正版 OMP 18.20.0 と ULW オーバーレイを
準備します。`PATH` 上にある標準の `omp` は代わりになりません。side モードは
既定で `~/.omp-dori` を使い、専用のラッパーと設定を持ち、メインの
`~/.dori` インストールには触れません。インストールによってエージェント、
メッセンジャー受信プロセス、サービスが起動することはありません。

環境の分離、設定、明示的な起動については、
[ソースインストールガイド](docs/releases.md#source-checkouts-for-maintainers)を
参照してください。ネイティブセッションは、自分のプロバイダー認証と利用枠を使います。

<table width="100%"><tr><td>

**重要**

利用者向けの実装は、検証済みリリースマニフェストに明記されている場合、
分離された macOS arm64 / hc プロファイルにも対応します。これは macOS リリースが
公開済みだという意味ではありません。Slack と Telegram は引き続きソース版の機能です。

</td></tr></table>

## ドキュメント

- [インストール、サポート、更新、ロールバック](docs/releases.md)
- [スキルと運用ルール](skills/dori-mode/SKILL.md)
- [メッセンジャーの設定](skills/dori-mode/references/setup.md)
- [ランタイムアダプターとセッションの契約](docs/runtime.md)
- [コンテナの設定](docs/container.md)
- [スケジューリングとバックログ](docs/hourly-loop.md)
- [共有ロックとレーンの優先順位](docs/locks.md)
- [貢献ガイド](CONTRIBUTING.md)
- [変更履歴](CHANGELOG.md)
- [ライセンスとソースの帰属表示](LICENSE) · [ライセンスガイド](LICENSING.md) · [修正版の告知](NOTICE)

## 貢献するには

明確な目標、焦点を絞った変更、動作の証拠を用意してください。
[貢献ガイド](CONTRIBUTING.md)から始め、
[既存の Issue](https://github.com/vntrevx/Cataly/issues) と
[プルリクエスト](https://github.com/vntrevx/Cataly/pulls)を確認し、
変更が必要になった背景を残してください。

## ライセンス

ライセンスは各コンポーネントの由来に従います。dori-superagent 由来の素材には
[Sustainable Use License 1.0](LICENSE) が引き続き適用され、既存の OMP
統合部分は [MIT ライセンスと著作権表示](LICENSE.omp-dori)を保持します。
ほかのコンポーネントも、それぞれの条件を維持します。MIT の表示は、
リポジトリ全体を再ライセンスするものではありません。[NOTICE](NOTICE) に、
取り込んだリビジョンと修正版の帰属表示を記録しています。
