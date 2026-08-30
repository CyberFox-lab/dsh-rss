# DSH RSS

English | [中文](README.zh.md)

DSH RSS is an RSS/Atom reader plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds a full-screen reading workspace, local SQLite storage, automatic feed refresh, and read-only RSS tools for the current Harness Agent.

The plugin uses the Agent, model, Workspace, Session, and Memory capabilities already provided by DeepSeek Harness. It does not create a separate Agent or conversation system.

![DSH RSS desktop reading workspace](assets/screenshots/overview.png)

## Features

- Subscribe to RSS and Atom feeds.
- Add multiple feed URLs at once or import an OPML file, with duplicate removal and retry support for failed entries.
- Refresh one feed manually, refresh all feeds, or let the plugin refresh them automatically every hour.
- Arrange subscriptions manually with drag-and-drop or accessible up/down controls; the order is stored in SQLite.
- Search articles and filter by feed, unread state, or favorites.
- Keep read and favorite state synchronized between the article list and reading view.
- Store subscriptions, articles, and reading state locally in SQLite.
- Open a movable and resizable Agent window without leaving the reader.
- Attach an article to the current Agent conversation with a button or drag-and-drop.
- Let the Agent list, search, and read RSS content through four read-only tools.

## Requirements

- Node.js supported by DeepSeek Harness.
- DeepSeek Harness `0.1.1-rc.2`.
- pnpm available on `PATH` when installing plugins through the `dsh` CLI.
- The `web` profile, because the plugin includes a Web UI.

## Installation

### From GitHub

```sh
dsh plugin --profile web add github:CyberFox-lab/dsh-rss
dsh web
```

Git installations build the plugin from source through its `prepare` script. With pnpm 10 or later, the first installation may ask you to allow that build. Add the package to the Web profile's `pnpm-workspace.yaml`, then run the installation command again:

```yaml
allowBuilds:
  '@deepseek-ai/dsh-rss': true
```

Only grant install-time build permission to source you trust. You can pin a release tag or commit when installing:

```sh
dsh plugin --profile web add github:CyberFox-lab/dsh-rss#<tag-or-commit>
```

### From a local checkout

Run this command from the directory containing the `dsh-rss` folder:

```sh
dsh plugin --profile web add ./dsh-rss
dsh web
```

When running DeepSeek Harness from its source repository, replace `dsh` with `pnpm dsh`:

```sh
pnpm dsh plugin --profile web add ../dsh-rss
pnpm dsh web
```

The Web UI starts at `http://127.0.0.1:3080` by default.

## Usage

Open **RSS Reader** from the DeepSeek Harness sidebar.

### Manage subscriptions

- Use the **+** button in the subscription column to add feeds.
- Use **Import OPML** to load subscriptions from a `.opml` or `.xml` file. Nested OPML groups are supported.
- Enter one RSS or Atom URL per line to add several feeds together.
- Repeated URLs in the same submission are removed automatically.
- If only some feeds fail, the dialog keeps the failed URLs so they can be retried.
- Use the refresh and delete actions beside a subscription to manage it.
- Use **Refresh all** to update every subscription immediately.
- Use **Adjust subscription order** to drag feeds into place or move them with the up/down controls, then save the order.

![Import subscriptions from an OPML file](assets/screenshots/opml-import.png)

### Read articles

- Search across article titles, summaries, and feed-provided content.
- Choose all articles, favorites, unread articles, or a specific subscription.
- Opening an unread article marks it as read and updates its subscription count.
- Favorite articles remain available when old non-favorite articles are pruned.
- Use **Open original** to visit the source page.

### Ask the Agent

Expand the floating Agent control in the reader to use the current Harness conversation. The window supports Workspace, Session, model, and reasoning-level selection. It can be moved by dragging its header and resized from its lower-right corner.

Selecting or opening an article does not automatically place it in model context. To ask about an article, use its Agent action or drag the article into the Agent composer. The submitted question includes the article ID and source URL, and the Agent can retrieve the content through the RSS tools.

#### Ask about one article

![Ask the Harness Agent about the selected RSS article](assets/screenshots/agent-article.png)

#### Summarize daily news across subscriptions

![Use RSS tools to summarize daily news from multiple subscriptions](assets/screenshots/agent-daily-digest.png)

## Agent tools

All model-facing RSS tools are read-only.

| Tool | Purpose |
|---|---|
| `rss_list_feeds` | List subscriptions and unread counts. |
| `rss_list_articles` | List newest-first articles by feed, inclusive ISO date range, read/favorite state, and `limit`/`offset`. The default limit is 30 and the maximum is 50. Optional article text is limited to 5,000 characters per item. |
| `rss_search_articles` | Search titles, summaries, and feed-provided article text. |
| `rss_read_article` | Read article text from a character cursor, up to 25,000 characters per call. |

Tool results include source URLs. The Agent is instructed to treat feed content as untrusted input and cite the original link when using article content. Subscription, deletion, refresh, read, and favorite mutations are not exposed as model tools.

## Configuration

The plugin works without additional configuration. Its default profile layer enables an hourly automatic refresh.

To customize it, replace the full `config` for the `rss` row in the Web profile's `cordis.patch.yml`:

```yaml
- override:
    id: rss
    config:
      databasePath: 'D:/data/dsh-rss/rss.sqlite'
      requestTimeoutMs: 20000
      maxFeedBytes: 5242880
      maxRedirects: 5
      articleLimit: 2000
      toolTimeoutMs: 15000
      autoRefreshIntervalMs: 3600000
```

| Option | Default | Description |
|---|---:|---|
| `databasePath` | `$DSH_HOME/rss/rss.sqlite` | SQLite database file. |
| `requestTimeoutMs` | `20000` | Feed request timeout in milliseconds. |
| `maxFeedBytes` | `5242880` | Maximum downloaded feed size in bytes. |
| `maxRedirects` | `5` | Maximum redirects per feed request. |
| `articleLimit` | `2000` | Maximum retained non-favorite articles per subscription. |
| `toolTimeoutMs` | `15000` | Timeout for an RSS Agent tool call in milliseconds. |
| `autoRefreshIntervalMs` | `3600000` | Delay between automatic refresh runs; minimum 60 seconds. |

Automatic refresh runs while the RSS page is closed and stops when the plugin unloads. Favorite articles are excluded from retention pruning.

## Data and security

- All data is stored locally in the configured SQLite database.
- Feed URLs must use HTTP or HTTPS and must not contain credentials.
- Requests and redirects reject local, private, link-local, and reserved network addresses.
- TLS uses Node.js standard certificate verification.
- Feed HTML is converted to plain text and is never executed in the browser.
- The plugin reads content supplied by feeds; review and trust each subscription source accordingly.
- The plugin does not fetch full article pages. It stores the content included by the feed itself.

## Uninstallation

```sh
dsh plugin --profile web remove @deepseek-ai/dsh-rss
```

Uninstalling removes the plugin from the Web profile but does not delete its SQLite database. Delete the configured database file separately if you also want to remove stored subscriptions and articles.

## License

[Apache License 2.0](LICENSE)
