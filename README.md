# Casino Night For The Neuro 50/50

Self-hosted 50/50 raffle app: sellers log ticket sales from any phone (no login, one shared link),
the pot updates live on every device, every buyer gets a bilingual confirmation email with their
ticket numbers, and the organizer draws the winner behind a confirm step plus an admin PIN.

Payments are taken separately (Square). The app only records tickets, email and amount.

## How it works

- `server.js` – Node 22, no dependencies. SQLite via `node:sqlite` at `DB_PATH`. Serves the page and a JSON API.
- `app.html` – the seller page. Polls `/api/state` every 2.5 s; one column on phones, two on desktop; `#stage` or the Stage view button gives a projector view with the buyer email masked.
- Ticket numbers are sequential from #1, allocated inside a single SQLite transaction, so two sellers logging at the same instant never overlap.
- The draw is uniform over every non-voided ticket, using `crypto.randomInt` on the server. It can only happen once; a second attempt returns 409.
- Emails go through GoHighLevel's conversations API (`POST /conversations/messages`) as `EMAIL_FROM`. Each buyer is upserted into the GHL location and tagged `GHL_TAG`. Failed sends retry with backoff (6 attempts); the ledger shows Emailed / queued / failed per sale with Resend and Fix email buttons.

### URLs

| Path | Who | What |
| --- | --- | --- |
| `/` | anyone | landing page, nothing sensitive |
| `/s/<SELLER_TOKEN>` | sellers | the app (share this link) |
| `/s/<SELLER_TOKEN>/export.csv` | sellers | CSV of all sales (+ winner line) |
| `/api/*` | the page | needs header `x-raffle-token: <SELLER_TOKEN>` |
| `/healthz` | Coolify | health check |

Admin actions (`/api/draw`, `/api/winner-email`, `/api/reset`) also need `pin` = `ADMIN_PIN` in the body.
Eight wrong PINs lock that IP for 10 minutes.

### Environment variables

See `.env.example`. Required in production: `ADMIN_PIN`, `GHL_PIT`, `GHL_LOCATION_ID`, `PUBLIC_URL`.
`SELLER_TOKEN` is optional: when unset the server generates one, stores it in the database and prints the
seller link in the logs on every boot.

## Deploy on Coolify (Hetzner)

1. Push this folder to a private GitHub repo (e.g. `floodline/casino-5050`).
2. Coolify → project → **+ Add Resource → Private Repository (with deploy key)**. Pick/create the deploy key, add its public key to the GitHub repo under *Settings → Deploy keys*. Repo `git@github.com:floodline/casino-5050.git`, branch `main`, build pack **Dockerfile**, port **3000**.
3. **Storage**: add a persistent volume mounted at `/data` (the SQLite file lives there; without it a redeploy wipes the raffle).
4. **Environment variables**: paste the keys from `.env.example` with real values (Developer view / bulk editor works best).
5. **Domain**: `https://5050.eliterealestategroup.com`. At NameBright add an **A record `5050` → `87.99.152.133`** (the wildcard points at the WordPress server, so the explicit record is required).
6. Deploy. Check the logs for the `sellerLink` line. Open it, log a test sale to yourself, draw, then Settings → Reset.

Redeploy after a push: Coolify → the app → Redeploy (no auto-deploy webhook), or the deploy API if a token exists for this app.

## Running the night

1. Send each seller the seller link. They open it in their phone browser; nothing to install, nothing to sign in to. Settings → "Seller name on this phone" tags their sales in the ledger.
2. Seller takes payment on Square, then logs the sale: package, quantity, buyer email, **Log sale**. The receipt stub shows the ticket numbers to read out; the buyer's confirmation email arrives within a few seconds.
3. Mistakes: **Void** removes a sale from the draw (restorable until the draw). **Fix email** corrects a typo and resends.
4. Put the Stage view on the projector so the room watches the pot climb.
5. End of night: **Draw the winner** → confirm → admin PIN. The number and email appear on every device. **Email the winner** sends the "you won" email with the prize amount. Export the CSV for your records.

## Local development and tests

```
node --no-warnings=ExperimentalWarning server.js            # http://localhost:3000, prints the seller link
npm install --no-save jsdom@25.0.1 && npm test                # end-to-end test against a real server (dry-run email)
```

`artifact/` holds the earlier claude.ai Artifact version of the app (shared store, needs sign-in) and its test.
