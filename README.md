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
| `/` | sellers | PIN screen. The seller PIN or the admin PIN signs that phone in for 30 days (HttpOnly cookie) |
| `/app` | signed-in phones | the seller page |
| `/app/export.csv` | signed-in phones | CSV of all sales (+ winner line) |
| `/logout` (POST) | signed-in phones | sign this phone out (Settings → Sign out) |
| `/s/<SELLER_TOKEN>` | legacy | signs in and redirects to `/app` |
| `/api/*` | the page | session cookie, or header `x-raffle-token: <SELLER_TOKEN>` |
| `/healthz` | Coolify | health check |

Admin actions (`/api/draw`, `/api/winner-email`, `/api/reset`, `/api/seller-pin`) also need `pin` = `ADMIN_PIN` in the body.
Eight wrong PINs (gate or admin) lock that IP for 10 minutes.

The seller PIN lives in the database: `SELLER_PIN` only seeds it on the very first boot (otherwise a random
4-digit PIN is generated and printed in the logs). Change it any time from Settings → "Change the seller PIN"
with the admin PIN; that signs every other phone out.

### Fundraising total (Stage view, right panel)

"Raised for The Neuro tonight" = Eventbrite tickets + Square on-site sales (minus the 50/50 sales if they
also go through Square) + the 50/50 share kept by The Neuro (half the pot) + online donations − expenses.

- **Eventbrite**: paste the account's private token in Settings → Fundraising; the live Casino Night event is
  auto-detected (name containing "Casino", else the newest). Orders with status `placed` are summed; refunds are
  skipped. Setting "Count Eventbrite tickets as" picks `base_price` (what you receive after Eventbrite fees,
  default) or `gross` (what attendees paid).
- **Square**: paste a production access token (developer.squareup.com → your app → Production → Access token).
  Completed payments since "Count Square payments from" (default Oct 16 2026 00:00 ET) are summed, refunds subtracted.
- **Online donations**: the McGill crowdfunding page (Raisin platform) needs a browser session handshake, so the
  "Achieved" amount is typed in manually (Settings → Online donations).
- **Expenses**: a number subtracted from the total (default 4000).
- Any source can be overridden manually. Sources refresh every 2 minutes and on "Refresh"; tokens and values
  live in the SQLite settings table, never in env (env `EVENTBRITE_TOKEN` / `SQUARE_TOKEN` / `EXPENSES` only seed).
- API: `POST /api/fund-settings` (admin PIN) and `POST /api/fund-refresh`; the snapshot carries `fund` + `fundSettings`.

### Environment variables

See `.env.example`. Required in production: `ADMIN_PIN`, `GHL_PIT`, `GHL_LOCATION_ID`, `PUBLIC_URL`.
`SELLER_TOKEN` is optional (legacy link); when unset the server generates one and prints it in the logs.

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
