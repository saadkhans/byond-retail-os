# Running BYOND in containers

The images live in `infra/docker/`. All of them build from the **repository
root** because the workspace lockfile and the other package manifests have to be
inside the build context.

## Local stack

```bash
cp infra/docker/.env.example infra/docker/.env   # then edit it
pnpm run docker:up                               # build and start everything
pnpm run docker:down                             # stop and drop the volume
```

That starts four things: Postgres, a one-shot `migrate` container that runs
`prisma migrate deploy` and exits, the API on port 3000, and the admin console
on port 8080. The API waits for the migration container to finish, so a fresh
volume never serves traffic against an empty schema.

`infra/docker/.env` is gitignored. Nothing in this folder may contain a real
secret; `POSTGRES_PASSWORD` and `JWT_SECRET` have no defaults on purpose, and
compose refuses to start without them.

## Building an image by hand

```bash
docker build -f infra/docker/api.Dockerfile -t byond/api .
docker build -f infra/docker/admin-web.Dockerfile \
  --build-arg VITE_API_BASE_URL=https://api.example.com -t byond/admin-web .
```

## What is in the images, and what is not

The API image contains the compiled Nest bundle, production dependencies and
the Prisma schema plus migrations, running as a non-root user with a healthcheck
against `/health`. It deliberately does **not** contain the optional local CV
runtimes — the Python detector worker, model weights or an Ollama server. Those
are opt-in adapters chosen by environment variable, and baking multi-gigabyte
weights into a control-plane image would be wrong in every deployment that does
not use them. A deployment that wants local inference runs it beside the API and
points the relevant `*_RUNTIME` and `PICKUP_VLM_BASE_URL` variables at it.

The admin console image is nginx serving the static bundle with a single-page
history fallback, so a deep link resolves to `index.html` rather than a 404.
Because Vite inlines `VITE_*` values at build time, the API base URL is a build
argument: each environment needs its own build.

## Migrations in a deployed environment

Run the same image as a one-shot job before rolling out a new version:

```bash
docker run --rm -e DATABASE_URL=... byond/api node_modules/.bin/prisma migrate deploy
```

Never point `prisma migrate dev` at a deployed database — it is a development
command and can reset data.
