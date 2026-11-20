<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>Die Absicht verstehen. Den Kontext erfassen. Die Arbeit zu Ende bringen.</strong>
</p>

<p align="center">
  Cataly ist ein KI-Teammitglied, das aus einem Ziel ein fertiges Ergebnis macht.
  Sag ihm, was du erreichen möchtest: Es übernimmt die nächsten Schritte,
  berücksichtigt den Kontext und führt die Arbeit bis zu einem überprüfbaren Ergebnis.
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases/tag/v0.1.2"><img alt="Published preview" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=preview&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#erste-schritte"><strong>Erste Schritte</strong></a> ·
  <a href="#so-funktioniert-es"><strong>So funktioniert es</strong></a> ·
  <a href="#dokumentation"><strong>Dokumentation</strong></a> ·
  <a href="#mitwirken"><strong>Mitwirken</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a><br>
  <strong>Deutsch</strong> · <a href="README.it.md">Italiano</a> · <a href="README.zh.md">中文</a>
</p>

## Die Philosophie

Der Anspruch geht über das Befolgen von Anweisungen hinaus. Es geht um gutes
Urteilsvermögen: erkennen, worauf es ankommt, Details miteinander verbinden und
die Arbeit erledigen, ohne bei jedem Schritt angeleitet werden zu müssen.

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Verantwortung für das Ergebnis übernehmen</h4>
      Auf das Ziel hinarbeiten, statt eine Liste von Tätigkeiten abzuhaken.
    </td>
    <td width="50%" valign="top">
      <h4>Den Kontext verstehen</h4>
      Gespräch, Projektkonventionen, Einschränkungen und die Vorlieben des Nutzers
      im Blick behalten.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>Überlegt die Initiative ergreifen</h4>
      Alltägliche Entscheidungen selbst treffen. Nachfragen, wenn eine echte
      Abwägung oder eine fehlende Erlaubnis das Urteil des Nutzers erfordert.
    </td>
    <td width="50%" valign="top">
      <h4>Die Arbeit zu Ende bringen</h4>
      Untersuchen, umsetzen, prüfen und berichten, was tatsächlich passiert ist.
      Eine überzeugende Erklärung ersetzt kein funktionierendes Ergebnis.
    </td>
  </tr>
</table>

An diesem Maßstab orientiert sich Cataly: fähig genug, um zu handeln, aufmerksam
genug, um zu verstehen, und verantwortlich für das Ergebnis.

## So funktioniert es

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Cataly verbindet Messenger-Unterhaltungen mit einer nativen Laufzeit für
Coding-Agents und nachverfolgbaren Arbeits-Lanes:

- Der Lead erledigt kleine Anfragen direkt und gibt längeren Aufgaben ein Briefing,
  eine eigene Session und einen klar benannten Verantwortlichen.
- Arbeitsprotokolle, Checkpoints und Registries halten den Fortschritt auch über Neustarts hinweg einsehbar.
- Die Discord-Annahme übernimmt den Antwortkontext und Metadaten von Anhängen in die Arbeit.
- Prozessgebundene Session- und Freigabeeinträge sichern die Zustellung an den vorgesehenen Agenten ab.
- Abschlussprüfungen können konkrete Signale prüfen, etwa erfolgreiche Befehle,
  übereinstimmende Dateien, gemergte Pull Requests oder veröffentlichte Versionen.
- Optionale Zeitplanung, Monitore und übergeordnete Überwachung unterstützen
  laufende Arbeit, wenn sie ausdrücklich aktiviert werden.

Die Implementierung vereint
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi) und
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). Ihre Autoren, Lizenzen und
Quellnachweise bleiben Bestandteil des Projekts.

## Betriebsgrundsätze

Cataly arbeitet mit den Konten und Berechtigungen, die du bereitstellst.
Externe Auswirkungen erfordern die jeweils nötige Autorisierung; die Einschätzung,
dass eine Aktion hilfreich wäre, erteilt keine Erlaubnis. Aktiviere nur die
Sessions, Monitore und Dienste, die du ausführen möchtest.

Prüfungen haben Grenzen. Ein erfülltes Abschlusssignal ist ein Beleg für dieses
Signal, keine Garantie für sämtliche Ergebnisse. Berichte sollten beobachtete
Ergebnisse, verbleibende Unsicherheit und nicht ausgeführte Arbeiten unterscheiden.

Halte Zugangsdaten, private Unterhaltungen und Kontodaten aus öffentlichen Patches
und Berichten heraus. Die optionale Telemetrie lässt sich mit `DORI_TELEMETRY=0`
oder `DO_NOT_TRACK=1` deaktivieren.

## Erste Schritte

<table width="100%"><tr><td>

**Hinweis**

Cataly ist der Projektname. Die bestehenden Befehle `dori`, `omp-dori` und `omp`,
Installationsverzeichnisse und Namen veröffentlichter Assets wurden nicht umbenannt.

</td></tr></table>

### Ein veröffentlichtes Release nutzen

Das bestehende **Prerelease v0.1.2** hat einen unveränderlichen Vertrag für
Linux x64 / herdr / Discord. Eine Umbenennung des Repositorys aktualisiert diese
Assets nicht und begründet keine Unterstützung für neue Plattformen.

Folge der [geprüften Anleitung für das exakte Release](https://github.com/vntrevx/Cataly/blob/v0.1.2/docs/releases.md#prerequisites-and-trust).
Sie behandelt Voraussetzungen, Prüfsummen, Installation, deine eigene
Authentifizierung, den ausdrücklichen Start und optional aktivierte Discord-Monitore.
Ersetze ein exaktes Release nicht durch einen beliebigen Installer von `main`.

### Mit dem Quellcode arbeiten

Installiere zuerst git, Bun 1.4.4+ und herdr oder hc; siehe die
[Voraussetzungen für die Quellcode-Version](docs/releases.md#current-source-bundle).

Verwende einen separaten Checkout, keine laufende Installation und kein eingefrorenes Endnutzer-Release:

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

Der Source-Installer richtet das fest zugeordnete, gepatchte OMP 18.20.0 und das
ULW-Overlay ein; ein unverändertes `omp` auf `PATH` ist kein Ersatz. Der Side-Modus
verwendet standardmäßig `~/.omp-dori`, hat eigene Wrapper und eine eigene
Konfiguration und lässt die primäre Installation unter `~/.dori` unberührt.
Die Installation startet weder Agenten noch Messenger-Empfänger oder Dienste.

Lies die [Anleitung zur Source-Installation](docs/releases.md#source-checkouts-for-maintainers)
zu Isolation, Konfiguration und ausdrücklichem Start.
Native Sessions nutzen deine eigene Provider-Authentifizierung und dein Nutzungskontingent.

<table width="100%"><tr><td>

**Wichtig**

Die Endnutzer-Implementierung unterstützt auch isolierte macOS-arm64/hc-Profile,
wenn ein geprüftes Release-Manifest sie ausweist. Das bedeutet nicht, dass ein
macOS-Release veröffentlicht wurde. Slack und Telegram bleiben Funktionen der Quellcode-Version.

</td></tr></table>

## Dokumentation

- [Installation, Support, Updates und Rollback](docs/releases.md)
- [Skill und Betriebsregeln](skills/dori-mode/SKILL.md)
- [Messenger-Einrichtung](skills/dori-mode/references/setup.md)
- [Laufzeitadapter und Session-Verträge](docs/runtime.md)
- [Container-Einrichtung](docs/container.md)
- [Zeitplanung und Backlog](docs/hourly-loop.md)
- [Gemeinsame Sperren und Lane-Priorität](docs/locks.md)
- [Mitwirken](CONTRIBUTING.md)
- [Änderungsprotokoll](CHANGELOG.md)
- [Lizenzen und Quellnachweise](LICENSE) · [Lizenzleitfaden](LICENSING.md) · [Hinweis zur modifizierten Kopie](NOTICE)

## Mitwirken

Bring ein klares Ziel, eine gezielte Änderung und Belege dafür mit, dass sie funktioniert.
Beginne mit dem [Beitragsleitfaden](CONTRIBUTING.md), prüfe
[bestehende Issues](https://github.com/vntrevx/Cataly/issues) und
[Pull Requests](https://github.com/vntrevx/Cataly/pulls) und bewahre den Kontext,
der die Änderung nötig gemacht hat.

## Lizenz

Die Lizenzierung richtet sich nach der Herkunft der einzelnen Komponenten.
Von dori-superagent abgeleitetes Material behält die
[Sustainable Use License 1.0](LICENSE); die bereits bestehende OMP-Integration
behält ihre [MIT-Lizenz und Urheberrechtshinweise](LICENSE.omp-dori).
Andere Komponenten behalten ihre eigenen Bedingungen. Der MIT-Hinweis lizenziert
nicht das gesamte Repository neu. [NOTICE](NOTICE) dokumentiert die importierten
Revisionen und die Urheber- und Herkunftsangaben zur modifizierten Kopie.
