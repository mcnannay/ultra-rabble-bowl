# Ultra Rabble Bowl — TSB3 Sprite Edition

A 16-bit inspired NFL play-by-play web game.

## Docker Compose

The repository must contain `server.js` and `index.html` at its root before building.

```bash
docker compose up -d --build
```

Open `http://YOUR-SERVER-IP:3000`.

## Dockhand

Import the repository as a Git-backed stack, choose `compose.yaml`, select the target Docker environment, and deploy with Build enabled. If Dockhand doesn't build from remote Git, clone the repository on the Docker host and deploy from the local folder, or publish an image to a container registry first.

Port: `3000` (set `HOST_PORT` to change it).

Cache is held in the named Docker volume `ultra-rabble-bowl-cache`.

## Current upload status

Deployment configuration has been published. The large game source files (`server.js` and `index.html`) still need to be committed from the downloadable project ZIP before deployment will work.
