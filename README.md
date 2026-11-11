# OMP CodeBuddy Provider

Register CodeBuddy models as the OMP provider `codebuddy-direct`. The plugin sends chat requests directly to CodeBuddy's Chat Completions endpoint. It does not use ACP and requires no separate API key.

> **Account risk:** The plugin uses the access token from your local CodeBuddy login to call an undocumented endpoint directly. This may trigger account controls and could result in restrictions or account suspension/ban. Use it at your own risk; the endpoint and authentication format may change without notice.

## Quick start

1. Sign in to CodeBuddyExtension so its local auth file exists. OMP `/login` is not required.
2. From the plugin directory, install dependencies and link it:

   ```sh
   npm install
   omp plugin link .
   ```

3. Restart OMP and select a model such as `codebuddy-direct/hy4free` from the model picker.

## Authentication

The CodeBuddy CLI has no token-export command; the plugin reads CodeBuddyExtension's local auth file. On macOS, the default path is:

```text
~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info
```

For each request, the plugin reads `auth.accessToken` from this file and does not use the refresh token. If CodeBuddy updates the file, the next request uses the new access token without restarting OMP. If the token expires, sign in to CodeBuddy again.

Override the path with `CODEBUDDY_AUTH_FILE` or the `authFile` field in `~/.omp/agent/codebuddy-provider.json`. The environment variable takes precedence.

Keep the auth file as a regular, non-symlink file with owner-only permissions, such as mode `600`. The provider settings file must also be a regular, non-symlink file. Treat the auth file as a password; do not share or commit it.

## Models and metadata

The plugin reads the newest `entry_*.info` snapshot from `~/.codebuddy/local_storage`, or `$CODEBUDDY_CONFIG_DIR/local_storage` when that variable is set. It uses the snapshot's model IDs, context windows, output limits, image/reasoning support, and CodeBuddy credit labels. Entries without token limits, such as image- and video-only models, are excluded.

If no usable snapshot exists, the plugin falls back to model IDs known from `codebuddy --help`, with defaults of 128k context and 16k output tokens.

Set per-model overrides in `~/.omp/agent/codebuddy-provider.json`. For example:

```json
{
  "models": {
    "hy4free": {
      "contextWindow": 960000,
      "maxTokens": 64000
    }
  }
}
```

`contextWindow` and `maxTokens` override the local snapshot. A `cost` override may also be supplied with all four fields (`input`, `output`, `cacheRead`, and `cacheWrite`) as verified USD per-million-token rates.

## Pricing

CodeBuddy credit labels appear in model names and are not converted to USD. OMP's provider API cannot mark an unpriced model as `pricingStatus: unknown`, so the plugin labels unknown USD prices in the model name; the model picker may still show `free` for its required zero-cost placeholder.
