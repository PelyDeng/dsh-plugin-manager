# DSH Plugin Manager

[中文](README.md) · [Deploy a packaged app](#deploy-a-packaged-app) · [Develop your own app](#develop-your-own-app) · [Author guide](doc/plugin-development.md) · [Deployment guide](doc/first-deployment.md) · [Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases)

DSH Plugin Manager is a delivery and operations framework for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins. Authors build and package apps in their own repositories; deployers receive a standard release directory and do not need the author's source code.

This is an independent community project, not an official DeepSeek product or recommendation.

## Choose your role

| Role | What you do | Start here | You do not need first |
| --- | --- | --- | --- |
| Plugin author | Write, check, and package a plugin | [Author guide](doc/plugin-development.md) and starter README | Site recovery, migration, and server source releases |
| Deployer | Install, update, and verify packaged apps | [Deployment guide](doc/first-deployment.md) | Plugin source and author build tooling |
| Site maintainer | Maintain source deployments, recover releases, migrate data | [Deployment and operations](deploy/README.md) | Each app's internal implementation |

Most task guides linked from this page are currently written in Chinese; the commands and release artifacts use the same versions documented there.

## Deploy a packaged app

Use this path when an author provides a complete release directory containing `manifest.json` and every referenced `.tgz`.

1. Download and extract `dsh-plugin-manager-deployment-<version>.zip` from one [Release](https://github.com/PelyDeng/dsh-plugin-manager/releases).
2. Put each app's complete release directory under `incoming/<app>/`.
3. If shared authentication is required and the release does not already include auth, copy the bundled `optional/auth` directory to `incoming/auth`.
4. From the extracted deployment directory, run:

   ```sh
   bash build.sh
   ```

   On Windows PowerShell, run `.\build.ps1`.
5. Open the address reported by build and request the actual endpoint documented by the plugin README.

The deployment machine needs Node.js, system tar, and a local Linux Docker engine with Compose. An arbitrary source ZIP, single npm archive, or frontend-only dist bundle is not a standard release directory. See the [deployment guide](doc/first-deployment.md) for configuration, updates, and recovery.

## Develop your own app

Start with the `dsh-plugin-manager-starters-<version>.zip` asset:

| Starter | Use it for |
| --- | --- |
| [standalone-plugin](examples/standalone-plugin/README.md) | A public readiness endpoint without kit or login |
| [standalone-kit](examples/standalone-kit/README.md) | Shared login, app authorization, and a trusted account identity |

Create a separate tools directory outside your author project and install the matching manager archive:

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-<version>.tgz
```

In the author project, run:

```sh
pnpm install --ignore-workspace
```

From the tools directory, run:

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

`pack` installs locked dependencies, runs build/check, verifies the archive, and writes `manifest.json`. Deliver the entire output directory; do not extract only its tgz files. The direct workflow supports an independent pnpm single package. npm, yarn, and monorepo layouts are not promised the same one-step path.

## What can be integrated

| Existing project | Integration path |
| --- | --- |
| Your own DSH plugin | Keep it in an independent repository or framework `plugins/*`, then follow the declaration and packaging contract |
| Third-party DSH plugin or official Bundle | Verify host compatibility; an existing compliant release directory can be deployed directly |
| Existing Node.js project | Adapt it to an official Cordis plugin with a Bundle entry and build output |
| Java, Python, or existing HTTP service | Keep the service independently deployed and call it from a DSH adapter plugin |

## What it does not do

- It does not turn arbitrary source ZIP files, jars, frontend bundles, or ordinary npm packages into runnable plugins.
- Declaring permissions does not automatically protect routes; apps must implement access and data checks.
- Build success, health checks, login, and model availability are separate from business acceptance.
- It does not automatically roll back business data; backups remain an operational responsibility.
- Deployers do not build or inspect author projects.

## Advanced entry points

| Goal | Documentation |
| --- | --- |
| Try auth/example login and chat | [Getting started](doc/getting-started.md) · [Visual tour](doc/quick-tour.md) |
| Plugin declarations and instance configuration | [Configuration](doc/plugin-configuration.md) · [kit](packages/plugin-kit/README.md) |
| Manual release composition or host management | [Standalone CLI delivery](packages/plugin-manager/DELIVERY.md) |
| Source releases, selective reuse, resume/recover | [Deployment and operations](deploy/README.md) |
| Site fields, credentials, and defaults | [Framework configuration](doc/framework-configuration.md) |
| Troubleshooting and verification boundaries | [FAQ](doc/FAQ.md) · [Host compatibility](doc/host-compatibility.md) · [Verification](packages/plugin-manager/VERIFICATION.md) |
| All documentation | [Documentation index](doc/README.md) |

## Contribution and license

Shared libraries live in `packages/*`, built-in example apps in `plugins/*`, and independent starters in `examples/*`. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture guide](doc/architecture.md) before framework development. The project uses [Apache-2.0](LICENSE); third-party sources are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
