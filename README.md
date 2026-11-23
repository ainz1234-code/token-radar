# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ainz1234-code/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ainz1234-code/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for DeFi protocols that record no token yet. It prices each one by what the market pays for the snapshot's own live tokens with the same TVL and category (a ridge/Huber fit, checked on held-out tokens), adjusts for the week's TVL growth and how long the protocol has run without a token, and gives every row a farm plan with its chain, deposit, fees, time and expected drop. One file, `dashboard/model.js`, is the model for both `main.ts` (which writes `board.json`) and the static page.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json   # then open out/dashboard/index.html
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=510zfa3n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
