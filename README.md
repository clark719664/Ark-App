# Open When 💌

**Letters for the moments that need them.**

*Open when you can't sleep. Open on the morning of the big day. Open when you miss me.*

"Open when" letters are a beloved paper tradition: a bundle of sealed envelopes,
each labeled with a moment, given to someone before a deployment, a move, a
diagnosis, a first semester, a long trip — so that on the day the moment
arrives, there's a letter waiting that was written just for it.

**Open When** makes them sendable. You write a handful of short letters, seal
them, and get a single link. The recipient opens the link to a shelf of
wax-sealed envelopes — and opens each one only when its moment comes. Cracking
the seal is a small ritual: the wax splits, the flap lifts, the letter rises.

Try it by opening `index.html` in a browser. That file is the entire product.

## The privacy model (and why there's no server)

The letters are compressed and encoded **into the link itself** — the part
after the `#`, which browsers never send over the network. There is no backend,
no account, no analytics, no database. Nobody but the sender and whoever holds
the link can read the letters, and this page couldn't peek even if it wanted
to. It works offline once loaded.

Practical consequences:

- **The link is the only copy in the world.** The app nags senders to keep one.
- Long bundles make long links. A built-in "link health" meter warns when a
  bundle outgrows what messengers reliably carry, and offers the **gift file**
  instead — a downloaded, self-contained HTML file that *is* the bundle plus
  the whole app, and opens anywhere, forever.
- Date-locked envelopes ("keep sealed until Dec 25") are sealed by trust, not
  encryption. The seal is a promise, not a padlock — like paper.

## Features

- **21 curated moments** with writing prompts, so the page never feels blank —
  comfort, courage, celebration, distance, love, grief. Or write your own.
- **Envelope & stationery choices** — five envelope colors, four papers
  (classic, handwritten, typewriter, moonlight).
- **Date locks** for birthdays, anniversaries, arrival days.
- **The ritual** — cracking wax seal with sound and haptics; respects
  `prefers-reduced-motion`.
- **The loop** — after the last letter, the recipient is invited to make a
  bundle of their own, pre-seeded with the same moments.
- **No dependencies, no build step.** One HTML file. Tests run on plain Node.

## Deploy your own (2 minutes)

It's a single static file — anything that serves HTML works:

1. Fork / push this repo to GitHub.
2. Settings → Pages → *Deploy from a branch* → `main`, `/ (root)`.
3. Your copy is live at `https://<you>.github.io/<repo>/`.

## Turning on the tip jar (optional, ~10 minutes)

Open When is free to use and free to run. If you host a copy and want it to
earn its keep, there's a single config block at the top of the UI script in
`index.html`:

```js
var CONFIG = {
  TIP_URL: "",   // <- put your link here
  ...
};
```

1. Create a [Buy Me a Coffee](https://buymeacoffee.com),
   [Ko-fi](https://ko-fi.com), or
   [Stripe Payment Link](https://stripe.com/payments/payment-links) page.
2. Paste its URL into `TIP_URL`.
3. Commit. Done.

The ask appears in exactly two places — a quiet card *after* a sender seals a
bundle (the moment of delivered value), and a one-line footer link. Never
during writing, never a popup, never shown to recipients mid-letter, and the
tip UI stays completely hidden until `TIP_URL` is configured. Realistic
expectations, honestly stated: free tools earn tips at hundredths of a percent.
This is a gift that can buy you the occasional coffee, not a business.

## Development

```
node tests/codec.test.js
```

The tests extract the pure-logic `<script id="ow-core">` block from
`index.html` (codec, validation, date locks, link handling) and exercise it
under Node 22+ — including round-trips, hostile payloads, and clamping rules.

Bundle payload format, for the curious:

```
#g=1c.<base64url(deflate-raw(utf8(json)))>    compressed
#g=1p.<base64url(utf8(json))>                 fallback
```

Every decoded field is validated and clamped, every rendered string goes
through `textContent` (never `innerHTML`) — a crafted link gets you a letter,
not a script.

## Design decisions

- **One file, forever.** No framework, no bundler, no CDN requirement. The
  Google Fonts are progressive enhancement; system fallbacks are designed, not
  accidental.
- **Honor-system seals.** Enforcing date locks would require servers and
  accounts, which would cost the thing that matters most here: that nobody
  else ever holds the letters.
- **The tone is the product.** Everything from the prompts to the error page
  ("This link seems torn") is written like it belongs in a stationery shop,
  not a SaaS dashboard.

## License

[MIT](LICENSE). Make bundles, host copies, gift it forward.
