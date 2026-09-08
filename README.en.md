# DSH Plugin Manager

[中文](README.md) · [Visual tour (Chinese)](doc/quick-tour.md) · [Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases) · [Report an issue](https://github.com/PelyDeng/dsh-plugin-manager/issues)

**Build your own DeepSeek Harness apps and manage their installation, updates, and configuration in one place.**

Build plugins and AI applications in your own repository using the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ecosystem: knowledge assistants, reporting assistants, business tools, or agent applications with their own pages. The framework packages and installs your plugins, manages their settings, and starts, stops, or updates them. Combine multiple plugins into a deployment for personal use or delivery to teams and customers.

Use official Cordis plugins, Bundles, and Agents without modifying DSH or manager source. Develop and package plugins independently, deploy releases without author source code, and optionally reuse shared login and app access control to reduce repeated development and operational work. Integration requires supported plugin declarations and compatibility verification against the target host version.

> Unofficial project, independently developed and maintained by community members. This is not a DeepSeek product or endorsement.

![Developer assistant with suggested questions and personal conversation history](doc/assets/developer-assistant.png)

## Where it fits

| Component | Responsibility |
| --- | --- |
| Official DeepSeek Harness | Plugin runtime, Bundle composition, Agents, models, and sessions |
| DSH Plugin Manager | Plugin declarations, packaging, release composition, configuration, installation, startup, and shutdown |
| Optional `dsh-auth` | Accounts, login, and app access grants |
| Your app | Tools, pages, business rules, and data authorization |

For one personal tool, an official Bundle may be enough. This project is useful when you need consistent packaging, installation, updates, and management for your own plugins, or need to deliver several apps to a team or customer. Plugin installation and updates use the manager CLI and deployment workflows; the authentication UI manages accounts and app access grants. App access does not grant access to every business record: each app must still enforce its own data permissions.

## Start with the included apps

The default source deployment includes `dsh-auth` and `dsh-example`, a developer assistant demonstrating streaming chat, personal history, and optional authentication. Its interface and most detailed guides are currently in Chinese.

On Windows, macOS, or Linux, prepare Git, Node.js `^22.19.0 || >=24` with npm, system `tar`, and a working local Linux Docker engine with Compose and named build context support. The deployment script prepares the pinned pnpm version when needed. It does not install system packages, configure a firewall, or set up a reverse proxy.

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
./build.sh
```

Use `.\build.ps1` for the last command in Windows PowerShell; Bash is not required on Windows. macOS and Linux use `./build.sh`. The existing `bash deploy/build.sh` entry remains compatible. Only local Docker unix/npipe endpoints are accepted; remote or TCP endpoints and Windows containers are rejected. A real Docker site deployment on macOS has not been validated; passing CI does not show that a site has been deployed successfully.

1. Open `http://127.0.0.1:7902/auth`, sign in using the initial administrator procedure in the [auth guide](plugins/dsh-auth/README.md), and change the initial password.
2. Create a regular account and grant it access to `example`.
3. Check the private `.local/env.conf` URL and trusted hosts. The public root template contains fixed, nonsecret defaults; real site values belong in the private file. First-run initialization writes the local platform defaults and preserves existing configuration. Nonempty DeepSeek/Zhipu keys in the private file take precedence and make those credential fields read-only; apply file changes through a controlled restart. Blank values preserve official credential sources, including inherited environment overrides. Without an override, administrators can manage DeepSeek or Zhipu in **模型设置** (Model settings); updates to the official store normally apply without a restart. The page returns only configuration status and a SHA-256 fingerprint, never the original key. A configured key has not necessarily been validated by the model provider.
4. In **模型设置**, select a compact model card to set the default for new conversations. The choice is saved through the official host settings without a restart. Existing conversations and branches retain their recorded model selection. Other providers still require their credentials and routes in the official settings or patches.
5. Open `/example` as the regular user and send a question. Check the streamed answer and restored conversation history.

The listener binds to loopback by default. For a remote server, use an SSH tunnel or configure a reverse proxy and the matching `publicOrigin`/`publicUrl`. The [deployment guide](doc/first-deployment.md) covers prerequisites, URLs, and recovery. First builds require access to package and image sources; model use requires your own provider account and may incur charges.

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

External projects currently support pnpm single-package projects and release deployment. Operators can combine packages from several authors without needing their source code. Internal `plugins/*` workspaces remain supported. See the [author guide](doc/plugin-development.md).

## Update and verify

For an existing source deployment, preserve its checkout, configuration, `.local/data`, `.local/artifacts`, and backups:

```sh
git pull --ff-only --recurse-submodules
./build.sh
```

On Windows, use `.\build.ps1` again. Failures after release inputs are prepared require the same build script with `--resume`, including mount preflight failures before the service stops. Resume reuses the saved image and archives; it does not roll back application data. Source updates do not create full runtime-data backups automatically; arrange and verify a separate backup when data recovery is required. An interrupted worker leaves the source lock in place until its owner and descendants are confirmed stopped. Do not delete `.local` or profile state to recover a failed deployment. Follow the [recovery instructions](doc/first-deployment.md#更新与恢复).

The root `package.json` supplies one release version for manager, kit, auth, and example; independent apps and the official host keep their own versions. See [version management](doc/versioning.md).

Compatibility checks cover specific host versions. Other host versions and community plugins need their own checks. Use the host requirements in the release notes, and configure your own model provider before starting a conversation.

## Contribute

Bug reports should include the commit or release, environment, reproduction steps, and redacted error output. Never share API keys, console authentication URLs, passwords, or customer data. See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and the [documentation index](doc/README.md).

Repository-owned code is licensed under [Apache-2.0](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
