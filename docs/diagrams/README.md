# Диаграммы для README

В основном README используются готовые PNG из репозитория: их отображение не зависит от поддержки Mermaid на сайте. Здесь хранятся редактируемые исходники `.mmd` и общие настройки оформления.

Рендеринг через Mermaid CLI 11.12.0:

```sh
npx --yes --package @mermaid-js/mermaid-cli@11.12.0 mmdc -i docs/diagrams/architecture.mmd -o docs/diagrams/architecture.png -c docs/diagrams/config.json -b white -s 2
npx --yes --package @mermaid-js/mermaid-cli@11.12.0 mmdc -i docs/diagrams/authentication.mmd -o docs/diagrams/authentication.png -c docs/diagrams/config.json -b white -s 2
```

Для уже установленного Chrome можно передать приватную конфигурацию Puppeteer через `-p /absolute/config.json`, указав путь к браузеру в `executablePath`. После рендеринга проверьте обе картинки и их отображение в опубликованном README — одной проверки Markdown недостаточно.
