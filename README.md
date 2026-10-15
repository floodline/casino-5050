# Casino Night For The Neuro 50/50

Published page: https://claude.ai/artifact/HpkKz23AKBxmDQhsPi6DL1

`casino-night-5050.html` is the page source (published as a Claude Artifact with the
`db`, `user` and `downloads` capabilities). `test/run-test.js` runs the whole flow under
jsdom against an in-memory mock of the shared database:

    cd test && npm install jsdom@25.0.1 && node run-test.js && node run-test.js --acquire-creates

Data model in the artifact's shared store:
- `raffle/state`  { next, status: "open"|"drawn", draw: {ticket, email, saleId, drawnAt, pool, buyers, gross, drawnBy} }
- `raffle/config` { pinHash (sha256 of "casino5050|" + pin), pinSetAt, pinSetBy }
- `sales/<id>`    { email, pkgTickets, pkgPrice, qty, tickets, amount, from, to, createdAt, sellerId, voided }

Ticket numbers are handed out under a short lease on `raffle/state` (acquire → get → update),
released right after each sale. The draw is uniform over all non-voided tickets using
crypto.getRandomValues with rejection sampling.
