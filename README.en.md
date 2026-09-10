# DSH Plugin Manager

[中文](README.md) · [Deployment](doc/first-deployment.md) · [Author guide](doc/plugin-development.md) · [Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases)

Build DSH plugins in your own project, deliver a standard release directory, and deploy them through this framework without the author's source code. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runs plugins, Agents, models, and conversations. This framework handles packaging, configuration, installation, and operations. Each app remains responsible for its business rules and data access.

This is an independent community project, not an official DeepSeek product.

## Deploy a packaged app

Download `dsh-plugin-manager-deployment-<version>.zip` from the chosen release. Extract it and place each app's complete release directory under `incoming/<app>/`. Keep its `manifest.json` and every referenced `.tgz` together; an arbitrary source ZIP or npm archive is not a supported release directory.

Install a supported Node version, system tar, and a local Linux Docker engine with Compose. From the extracted deployment directory:

```sh
bash build.sh
```

On Windows PowerShell, run `.\build.ps1`. Fill in required business configuration when prompted. Apps requiring shared authentication also need the included `optional/auth` directory copied to `incoming/auth`. The example app is not enabled automatically.

The deployment archive includes the manager and fixed runtime image information. Runtime dependencies may still require network access. See the [deployment guide](doc/first-deployment.md) for platform requirements, configuration, verification, and updates. Detailed guides are currently in Chinese.

## Develop your own app

The `dsh-plugin-manager-starters-<version>.zip` asset contains a minimal public endpoint and a shared-authentication example. Install the matching manager archive in a separate tools directory as described in the [author guide](doc/plugin-development.md), then run from that tools directory:

```sh
pnpm exec dsh-plugin-manager pack --root <absolute-author-project> --package . --output <new-release-directory>
```

The command installs locked dependencies, builds, checks, and packages the plugin. Deliver the entire output directory. The optional kit is bundled inside apps that use it; the manager is not a business runtime dependency.

The direct author workflow supports independent pnpm single-package projects. Existing Node apps need a DSH plugin entry and compatible build. Non-Node services can stay independently deployed and be called by a DSH plugin; this framework does not automatically host arbitrary applications.

## Source development and advanced operation

- [Source deployment](deploy/README.md): the existing repository build entry and selective rebuild remain supported.
- [Standalone manager delivery](packages/plugin-manager/DELIVERY.md): explicit release composition and Node/Compose operation without author source.
- [Try auth and example](doc/getting-started.md), or browse the [visual tour](doc/quick-tour.md).
- [Configuration and documentation](doc/README.md).

Preserve the site's configuration, data, and release history when updating. Resume reuses saved inputs; correcting business configuration uses the documented controlled recovery path. A new fixed plugin package is outside that shortcut. Never delete state or data to force installation. A successful health check does not prove model or business behavior.

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and [LICENSE](LICENSE). Report errors with versions and redacted reproduction steps; never include credentials or customer data.
