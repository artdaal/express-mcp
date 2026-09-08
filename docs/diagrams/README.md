# README diagrams

The main README embeds committed PNGs so readers do not depend on a host's Mermaid renderer. Editable `.mmd` sources and shared styling are kept here.

Render with Mermaid CLI 11.12.0:

```sh
npx --yes --package @mermaid-js/mermaid-cli@11.12.0 mmdc -i docs/diagrams/architecture.mmd -o docs/diagrams/architecture.png -c docs/diagrams/config.json -b white -s 2
npx --yes --package @mermaid-js/mermaid-cli@11.12.0 mmdc -i docs/diagrams/authentication.mmd -o docs/diagrams/authentication.png -c docs/diagrams/config.json -b white -s 2
```

When using an existing Chrome installation, Mermaid CLI accepts a private Puppeteer configuration through `-p /absolute/config.json` with its `executablePath`. Inspect both images after rendering and check the published README, not just Markdown syntax.
