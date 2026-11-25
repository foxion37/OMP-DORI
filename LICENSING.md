# Licensing in Cataly

Cataly is a maintained integration of separately licensed work. The project
name is shared; the licenses are not interchangeable. This guide explains the
existing scope without claiming a new license for someone else's material.

## Which terms apply?

| Material | Applicable terms | Where to read them |
| --- | --- | --- |
| dori-superagent code and its derived changes | Sustainable Use License 1.0 | [LICENSE](LICENSE) |
| Pre-existing omp-dori material incorporated from the local source, including its extension and OMP integration changes | MIT | [LICENSE.integration](LICENSE.integration) |
| oh-my-pi and other third-party components | Their respective upstream licenses | The component's own license and [NOTICE](NOTICE) |

These are source-provenance boundaries, not a claim that every file in a directory
shares one license. An integration, dependency pin, or patch does not convert
upstream material to MIT. Check the material's origin before assigning its terms.

## The MIT-covered integration

The standard MIT grant and disclaimer are reproduced in
[LICENSE.integration](LICENSE.integration). They permit use, modification, distribution,
and other stated uses of the covered material, subject to retaining the copyright
and permission notice. The YeonGyu Kim, betive37, and vntrevx notices are preserved.

Current source packages that unchanged notice as `LICENSE.integration`; historical
releases packaged it as `LICENSE.omp-dori`. The notice covers the integration,
not the entire repository.

## The inherited Sustainable Use License

[LICENSE](LICENSE) reproduces Sustainable Use License 1.0 for the
dori-superagent-derived material. Its grant, internal-business/personal/
non-commercial use limits, redistribution conditions, notice requirements, and
other provisions remain in force. The complete terms, not this summary, govern
that material.

Cataly is a modified copy derived from dori-superagent. [NOTICE](NOTICE)
identifies the imported revisions, local integration, and bound source overlay.
Keep the modified-copy notice and the applicable license with redistributed
material.

## Dependencies and prepared source

The native OMP lock and patch bind an exact upstream base and modified source
identity. They are not a replacement for that project's license.
Copyright and license notices in upstream source and patch excerpts remain
applicable. The official native addon also keeps its own license.

A change to a source pin must update the relevant provenance without dropping
required notices. Release packaging includes `LICENSE`, `LICENSE.integration`, and
`NOTICE`; this guide accompanies them.

## Contributions

Contribute only material you have the right to provide. Changes to existing work
retain the license applicable to that work; a copyright line or a new project name
does not override it. See [CONTRIBUTING.md](CONTRIBUTING.md).

Cataly does not require a CLA signature. The retained [upstream CLA](CLA.md)
belongs to `sisyphuslabs/dori-superagent`; it is not a separate agreement granting
Cataly new rights over contributions.
