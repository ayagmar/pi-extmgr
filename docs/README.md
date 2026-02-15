# pi-extmgr Landing Page

Static site built with Tailwind CSS.

## Development

```bash
cd docs
npm install
npm run watch    # Watch mode for development
npm run build    # Production build (minified)
```

## Deploy to Cloudflare Pages

1. **Connect Repository**
   - Cloudflare Dashboard → Pages → "Connect to Git"
   - Select `ayagmar/pi-extmgr` repository
   - Select `master` branch

2. **Build Settings**
   | Setting | Value |
   |---------|-------|
   | Build command | `npm run build` |
   | Build output directory | `/docs` |
   | Root directory | `/docs` |

3. **Add Custom Domain** (optional)
   - Pages project → Custom domains → "Set up a custom domain"
   - Enter your domain (e.g., `piext.dev`)
   - Update DNS as instructed

Done! Every push to `master` auto-deploys.

## Files

- `index.html` — Main page
- `assets/tailwind.css` — Compiled styles (generated)
- `assets/stats.js` — Live stats fetching
- `assets/*.png` — Screenshots

## Note

`assets/tailwind.css` is compiled and should be checked into git for GitHub Pages. For Cloudflare Pages, it's rebuilt on each deploy.
