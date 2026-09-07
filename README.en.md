# DSH Plugin Manager

[中文](README.md) · [Visual tour (Chinese)](doc/quick-tour.md) · [Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases) · [Report an issue](https://github.com/PelyDeng/dsh-plugin-manager/issues)

**Deliver DeepSeek Harness plugins as apps for your team: shared login, app access control, independent packaging, and deployment.**

Build your app in its own repository, declare how it is packaged and configured, and run it on official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). DSH Plugin Manager uses Cordis plugins, Bundles, and Agents without modifying the host source. Authentication is optional.

> Unofficial project, independently developed and maintained by community members. This is not a DeepSeek product or endorsement.

![Developer assistant with suggested questions and personal conversation history](doc/assets/developer-assistant.png)

## Where it fits

| Component | Responsibility |
| --- | --- |
| Official DeepSeek Harness | Plugin runtime, Bundle composition, Agents, models, and sessions |
| DSH Plugin Manager | Plugin declarations, packaging, release composition, configuration, installation, and controlled lifecycle |
| Optional `dsh-auth` | Accounts, login, and app access grants |
| Your app | Tools, pages, business rules, and data authorization |

For one personal tool, an official Bundle may be enough. This project is useful when you need to deliver several apps to a team or customer. App access does not grant access to every business record: each app must still enforce its own data permissions.

## Start with the included apps

The default source deployment includes `dsh-auth` and `dsh-example`, a developer assistant demonstrating streaming chat, personal history, and optional authentication. Its interface and most detailed guides are currently in Chinese.

On Linux, prepare Git, Node.js `^22.19.0 || >=24`, npm, Docker with the Compose plugin and named build context support, `tar`, and `flock`. The deployment script installs the pinned pnpm version when needed. It does not install system packages, configure a firewall, or set up a reverse proxy.

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
bash deploy/build.sh
```

1. Open `http://127.0.0.1:7902/auth`, sign in using the initial administrator procedure in the [auth guide](plugins/dsh-auth/README.md), and change the initial password.
2. Create a regular account and grant it access to `example`.
3. For the default DeepSeek provider, open the administrator's **模型设置** (Model settings) menu and enter your own API key. Saving applies to subsequent requests without a restart. The page returns only configuration status and a SHA-256 fingerprint, never the original key. A configured key has not necessarily been validated by the model provider.
4. Open `/example` as the regular user and send a question. Check the streamed answer and restored conversation history. Default model selection and other providers remain in the official model settings.

The listener binds to loopback by default. For a remote server, use an SSH tunnel or configure a reverse proxy and the matching `publicOrigin`/`publicUrl`. The [deployment guide](doc/first-deployment.md) covers prerequisites, URLs, backups, and recovery. First builds require access to package and image sources; model use requires your own provider account and may incur charges.

Authentication at `/auth`, the official console at `/`, and the model API key are separate. An official console authentication error is not an API-key error. See the [FAQ](doc/FAQ.md).

## Develop and distribute your own app

| Starting point | Use it for |
| --- | --- |
| [Minimal standalone Bundle](examples/standalone-plugin/README.md) | Packaging and delivery without the kit |
| [Shared identity example](examples/standalone-kit/README.md) | Login and app access integration |
| [Full chat app](doc/plugin-development.md#复制完整问答应用到独立仓库) | Streaming, history, and developer knowledge examples |

Install the versioned manager tool archive as described in the [delivery guide](packages/plugin-manager/DELIVERY.md); package names do not imply availability on npm. From the tools directory:

```sh
pnpm exec dsh-plugin-manager list --root /path/to/author-project --package .
pnpm exec dsh-plugin-manager pack --root /path/to/author-project --package . --output .local/artifacts/release
```

External projects currently support pnpm single-package projects and release deployment. Source-free release composition lets an operator combine archives from multiple authors. Internal `plugins/*` workspaces remain supported. See the [author guide](doc/plugin-development.md).

## Update and verify

For an existing source deployment, preserve its checkout, configuration, `.local/data`, `.local/artifacts`, and backups:

```sh
git pull --ff-only --recurse-submodules
bash deploy/build.sh
```

Do not delete `.local` to recover a failed deployment. Follow the [recovery instructions](doc/first-deployment.md#更新与恢复).

Host compatibility is verified against specific versions; arbitrary community plugins and host versions are not automatically supported. Build checks, archive-consumption checks, browser checks, and real-model acceptance are distinct. See each release's evidence and limitations.

## Contribute

Bug reports should include the commit or release, environment, reproduction steps, and redacted error output. Never share API keys, console authentication URLs, passwords, or customer data. See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and the [documentation index](doc/README.md).

Repository-owned code is licensed under [Apache-2.0](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
