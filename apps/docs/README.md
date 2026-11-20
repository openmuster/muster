# muster docs site

The site at openmuster.ai. It renders the markdown in `packages/muster/docs`,
which stays the source: that folder ships in the package, so an agent reads it
offline, and it reads on GitHub. Nothing is copied here.

```bash
pnpm dev                # http://localhost:3000
pnpm build
pnpm test               # the markdown bridge, and every docs link
pnpm preview:cf         # the Cloudflare Worker, locally
```

`lib/markdown.ts` is the bridge from the docs' conventions to the site:
numbered filenames become clean URLs, relative `.md` links become routes,
GitHub notes become callouts, a filename after a fence's language becomes its
title. Docs prose stays plain markdown, with no JSX.

It deploys as a Cloudflare Worker through OpenNext
(`.github/workflows/deploy-docs.yml`): production on a push to `main`, a
preview Worker per pull request. The workflow runs only once the repository
has a `CLOUDFLARE_ACCOUNT_ID` variable and a `CLOUDFLARE_API_TOKEN` secret.

The token is given only to the step that deploys, never to the install or the
build. Previews are off until the `CLOUDFLARE_PREVIEWS` variable is `true`,
and use their own `CLOUDFLARE_PREVIEW_API_TOKEN`: make that one able to edit
Workers but with no access to the `openmuster.ai` zone, so code from a pull
request can never reach the real domain with it.
