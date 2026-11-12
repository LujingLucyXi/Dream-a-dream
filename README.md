# Dream a Dream

白天造梦，夜里解梦 — Dream decipher + manifestation sleep stories.

A single-page web app: write a daydream, get a sleep story; write a night dream, get a reading built only from your own words.

## Run it

Open `index.html` in a browser, or serve it with any static host (Vercel, Netlify, GitHub Pages).

## Notes

- Readings and stories use Supabase edge functions (`dream-reading`, `dream-voice`, `dream-transcribe`) backed by OpenAI.
- Collections (Dream Journey, Souvenir Shelf, Dreamland Passport) are in-memory for the visit in this build — no accounts yet.
- The $1 per-reading unlock is a preview only in this build — no charge, no checkout.

## Structure

- `index.html` — the app (markup, styles, script).
- `assets/` — watercolour paintings (sky, mist, cat poses, share card) as WebP. The file name ends in a short content hash, so a changed painting gets a new name and browsers never show a stale cached copy.

Serve the folder from a static host (or `python3 -m http.server`) rather than opening `index.html` straight from disk, so the share card can draw the paintings when saved as an image.
