<p align="center">
  <img src="docs/cataly-portrait.webp" width="320" alt="Cataly character portrait: silver hair and a crimson halo">
</p>

<h1 align="center">Cataly</h1>

<p align="center">
  <strong>Capire l'intento. Leggere il contesto. Portare il lavoro fino in fondo.</strong>
</p>

<p align="center">
  Cataly è un compagno di squadra AI che porta il lavoro dall'obiettivo al completamento.
  Digli cosa vuoi realizzare: si fa carico dei passi successivi, tiene conto del
  contesto e prosegue fino a un risultato che puoi verificare.
</p>

<p align="center">
  <a href="https://github.com/vntrevx/Cataly/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/vntrevx/Cataly?include_prereleases&label=release&labelColor=2b2d33&color=c8102e"></a>
  <a href="https://github.com/vntrevx/Cataly/actions/workflows/ci.yml?query=branch%3Amain"><img alt="CI on main" src="https://img.shields.io/github/actions/workflow/status/vntrevx/Cataly/ci.yml?branch=main&label=ci&labelColor=2b2d33"></a>
  <a href="LICENSING.md"><img alt="License: SUL 1.0 with a scoped MIT notice" src="https://img.shields.io/badge/license-SUL%201.0%20%2B%20scoped%20MIT-8b9099?labelColor=2b2d33"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.4 or later" src="https://img.shields.io/badge/bun-%E2%89%A51.4.4-8b9099?labelColor=2b2d33&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="#per-iniziare"><strong>Per iniziare</strong></a> ·
  <a href="#come-funziona"><strong>Come funziona</strong></a> ·
  <a href="#documentazione"><strong>Documentazione</strong></a> ·
  <a href="#contribuire"><strong>Contribuire</strong></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a><br>
  <a href="README.de.md">Deutsch</a> · <strong>Italiano</strong> · <a href="README.zh.md">中文</a>
</p>

## La filosofia

L'ambizione non è soltanto seguire le istruzioni, ma esercitare buon giudizio:
riconoscere ciò che conta, collegare i dettagli e gestire il lavoro senza
dover essere guidato un passo alla volta.

<table>
  <tr>
    <td width="50%" valign="top">
      <h4>Farsi carico del risultato</h4>
      Lavorare per raggiungere l'obiettivo, non per spuntare un elenco di attività.
    </td>
    <td width="50%" valign="top">
      <h4>Capire il contesto</h4>
      Tenere presenti la conversazione, le convenzioni del progetto, i vincoli e
      le preferenze dell'utente.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h4>Prendere iniziative ponderate</h4>
      Gestire autonomamente le decisioni ordinarie. Chiedere quando un vero
      compromesso o un permesso mancante richiedono il giudizio dell'utente.
    </td>
    <td width="50%" valign="top">
      <h4>Portare il lavoro fino in fondo</h4>
      Indagare, implementare, verificare e riferire ciò che è realmente accaduto.
      Una spiegazione convincente non sostituisce un risultato funzionante.
    </td>
  </tr>
</table>

Questo è il criterio su cui si fonda Cataly: la capacità di agire, l'attenzione
necessaria per capire e la responsabilità del risultato.

## Come funziona

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/how-it-works-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/how-it-works-light.svg">
  <img src="docs/how-it-works-light.svg" width="100%" alt="Workflow: a request arrives, the lead assigns it, a lane works and reports, and completion is checked before a result you can verify, with its evidence, comes back to you.">
</picture>

Cataly collega le conversazioni nelle app di messaggistica a un runtime nativo
per coding agent e a lane di lavoro tracciate:

- Il lead gestisce direttamente le piccole richieste e assegna ai lavori più lunghi
  un brief, una sessione dedicata e un responsabile che ne risponde.
- Worklog, checkpoint e registri rendono i progressi consultabili anche dopo i riavvii.
- La ricezione da Discord porta nel lavoro il contesto delle risposte e i metadati degli allegati.
- I record di sessione e approvazione legati al processo proteggono la consegna all'agente previsto.
- I controlli di completamento possono verificare segnali concreti, come comandi
  riusciti, file corrispondenti, pull request integrate o versioni pubblicate.
- Pianificazione, monitor e supervisione facoltativi supportano il lavoro
  continuativo quando vengono abilitati esplicitamente.

L'implementazione deriva da
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent) e si basa su
[oh-my-pi](https://github.com/can1357/oh-my-pi). Autori, licenze e provenienza
dei sorgenti restano parte del progetto.

## Principi operativi

Cataly lavora con gli account e i permessi che fornisci. Le azioni con effetti
esterni richiedono l'autorizzazione pertinente: ritenere utile un'azione
non conferisce il permesso di eseguirla. Abilita soltanto le sessioni, i monitor
e i servizi che intendi usare.

La verifica ha dei limiti. Un segnale di completamento soddisfatto è una prova
di quel segnale, non una garanzia su ogni risultato. I rapporti dovrebbero
distinguere i risultati osservati, l'incertezza residua e il lavoro non svolto.

Tieni credenziali, conversazioni private e dati degli account fuori da patch
e rapporti pubblici. La telemetria è disattivata per impostazione predefinita.
`CATALY_TELEMETRY=1` la attiva; `DO_NOT_TRACK=1` ha la precedenza.

## Per iniziare

<table width="100%"><tr><td>

**Cataly è un nuovo prodotto, non un aggiornamento di omp-dori**

Questa versione rimuove ogni nome omp-dori, i runtime terminale herdr e hc e
l'overlay omp-ulw, e anche se il codice omp-dori non si aggiorna sul posto è
l'installer a fare il passaggio: importa configurazione, token e profilo del
proprietario di una directory `~/.dori` o `~/.omp-dori` precedente nella nuova
directory, senza sovrascrivere le impostazioni già presenti, poi elimina quella
precedente e i link e le cache lasciati dalla versione precedente quando nulla di
essa è più in esecuzione
([come funziona il passaggio](docs/releases.md#cataly-is-a-new-product-moving-from-omp-dori)).

I comandi attuali sono `cataly`, `cataly-harness` e `omp-cataly` (installazione
separata). Le nuove installazioni usano `~/.cataly` oppure `~/.omp-cataly`.
Cataly funziona su OMP headless per impostazione predefinita in macOS e Linux; Tern è il runtime terminale opzionale.

</td></tr></table>

### Usare una release pubblicata

Segui la [guida verificata a una release corrente](docs/releases.md#install-a-current-release).
Include prerequisiti, checksum, installazione, la tua autenticazione,
avvio esplicito e monitor Discord da abilitare su scelta dell'utente.
Non sostituire una release esatta con un installer arbitrario di `main`.

### Lavorare dai sorgenti

Installa prima git e Bun 1.4.4+ su Linux o macOS; non serve un server terminale. Consulta i
[prerequisiti della versione sorgente](docs/releases.md#current-source-bundle).
Tern è il runtime terminale opzionale; consulta [Tern](docs/runtime.md#tern).

Usa un checkout separato, non un'installazione in esecuzione o una release utente congelata:

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
CATALY_INSTALL_MODE=side CATALY_NO_PULL=1 CATALY_SRC="$PWD" bash scripts/install-source.sh
```

L'installer da sorgente prepara OMP 19.0.1 con le modifiche e i vincoli del progetto;
un `omp` standard nel `PATH` non può sostituirlo. La modalità side
usa per impostazione predefinita `~/.omp-cataly`, mantiene wrapper e configurazione
propri e lascia intatta l'installazione primaria `~/.cataly`.
L'installazione non avvia agenti, ricevitori di messaggi o servizi.

Leggi la [guida all'installazione da sorgente](docs/releases.md#source-checkouts-for-maintainers)
per isolamento, configurazione e avvio esplicito. Le sessioni native
usano la tua autenticazione presso il provider e la tua quota di utilizzo.

<table width="100%"><tr><td>

**Importante**

L'implementazione per gli utenti supporta anche profili headless isolati macOS arm64
quando un manifest di release verificato li dichiara. Questo non significa che sia
stata pubblicata una release macOS. Slack e Telegram restano funzionalità della versione sorgente.

</td></tr></table>

## Documentazione

- [Installazione, supporto, aggiornamenti e rollback](docs/releases.md)
- [Skill e regole operative](skills/cataly-mode/SKILL.md)
- [Configurazione della messaggistica](skills/cataly-mode/references/setup.md)
- [Adattatori runtime e contratti delle sessioni](docs/runtime.md)
- [Configurazione dei container](docs/container.md)
- [Pianificazione e backlog](docs/hourly-loop.md)
- [Lock condivisi e priorità delle lane](docs/locks.md)
- [Contribuire](CONTRIBUTING.md)
- [Registro delle modifiche](CHANGELOG.md)
- [Licenze e attribuzione dei sorgenti](LICENSE) · [Guida alle licenze](LICENSING.md) · [Avviso sulla copia modificata](NOTICE)

## Contribuire

Porta un obiettivo chiaro, una modifica mirata e prove del suo funzionamento.
Parti dalla [guida ai contributi](CONTRIBUTING.md), controlla le
[issue esistenti](https://github.com/vntrevx/Cataly/issues) e le
[pull request](https://github.com/vntrevx/Cataly/pulls) e conserva il contesto
che ha reso necessaria la modifica.

## Licenza

Le licenze seguono la provenienza di ogni componente. Il materiale derivato da
dori-superagent conserva la [Sustainable Use License 1.0](LICENSE);
l'integrazione OMP preesistente conserva la propria
[licenza MIT e gli avvisi di copyright](LICENSE.integration).
Gli altri componenti mantengono le rispettive condizioni. L'avviso MIT non
attribuisce una nuova licenza all'intero repository. [NOTICE](NOTICE) registra
le revisioni importate e l'attribuzione della copia modificata.
