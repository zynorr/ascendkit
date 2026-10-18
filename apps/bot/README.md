# @ascendkit/bot

Telegram bot for the Ascend launchpad. M0 scaffold: `/start` and `/fee` respond; the launch wizard (`/launch`, creator as a role — the bot custodies nothing, `launch().creator` is a parameter), the pool watcher and the flywheel-fill alerts land in M4.

## Run

```bash
copy .env.example .env
# set TELEGRAM_BOT_TOKEN from @BotFather
npm run build -w @ascendkit/bot
node apps/bot/dist/index.js
```
