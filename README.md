# KOReader Sync

<div style="display: flex; align-items: flex-start; gap: 2rem;">
  <img src="./public/logo.jpg" alt="KOReader Sync Server" width="150">
</div>

A self-hostable sync server for [KOReader](https://koreader.rocks/). Keeps reading progress in sync across all your devices.

[![Build](https://github.com/nperez0111/koreader-sync/actions/workflows/docker-build.yml/badge.svg)](https://github.com/nperez0111/koreader-sync/actions/workflows/docker-build.yml)
[![License: MIT](https://img.shields.io/github/license/nperez0111/koreader-sync)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/nperez0111/koreader-sync)](https://github.com/nperez0111/koreader-sync/releases)

- Less than 1,000 lines of TypeScript in a single file (`src/index.tsx`)
- SQLite database — no external services needed
- Runs on Docker — nothing else to install

**Requirements:** Docker. That's it.

## Quick Start

```bash
docker run -d -p 3000:3000 -v koreader-data:/app/data ghcr.io/nperez0111/koreader-sync:latest
```

The server is now running at `http://localhost:3000`. The SQLite database is persisted in the `koreader-data` volume.

For a more permanent setup, use Docker Compose:

```yaml
# docker-compose.yml
services:
  kosync:
    image: ghcr.io/nperez0111/koreader-sync:latest
    container_name: kosync
    ports:
      - 3000:3000
    restart: unless-stopped
    volumes:
      - data:/app/data

volumes:
  data:
```

```bash
docker compose up -d
```

## Connecting KOReader

1. Open a document on your KOReader device
2. Go to Settings > Progress Sync > Custom sync server
3. Enter your server's URL (e.g., `http://your-server:3000`)
4. Select "Register / Login" to create an account
5. Test with "Push progress from this device now"
6. Enable automatic progress syncing if desired

## Configuration

All configuration is through environment variables. None are required — defaults work out of the box.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `PASSWORD_SALT` | `"default_salt_change_in_production"` | Salt for bcrypt password hashing. Change this in production. |
| `DISABLE_USER_REGISTRATION` | `false` | Set to `true` to block new user registration |
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | — | Set to `development` for pretty-printed logs, otherwise JSON |

Pass them to Docker with `-e` flags or in your `docker-compose.yml`:

```yaml
services:
  kosync:
    image: ghcr.io/nperez0111/koreader-sync:latest
    environment:
      - PASSWORD_SALT=your_secure_random_string
      - DISABLE_USER_REGISTRATION=true
    # ...
```

## Security

Built in:

- Passwords are hashed with bcrypt (with configurable salt)
- Rate limiting on auth endpoints (10 requests/min per IP)
- Input validation on all endpoints (required fields, length limits)
- Parameterized SQL queries (no injection risk)

For production, you should also:

- Put the server behind a reverse proxy with HTTPS (e.g., Caddy, Traefik, nginx)
- Use a strong, random `PASSWORD_SALT`
- Back up the SQLite database regularly (located at `/app/data/koreader-sync.db`)

## API Endpoints

### Register User

- **POST** `/users/create`
- **Body**: `{ "username": "string", "password": "string" }`
- **Response**: `201` Created, `409` Username exists, `403` Registration disabled

### Authenticate

- **GET** `/users/auth`
- **Headers**: `x-auth-user`, `x-auth-key`
- **Response**: `200` OK, `401` Unauthorized

### Update Progress

- **PUT** `/syncs/progress`
- **Headers**: `x-auth-user`, `x-auth-key`
- **Body**:

```json
{
  "document": "8b03a82761fae0ee6cd5a23700361e74",
  "progress": "/body/DocFragment[15]/body/div[65]/text()[1].41",
  "percentage": 0.2082,
  "device": "boox",
  "device_id": "197E7C6B3FD54A749C87DE9C1B05A3CE",
  "metadata": {
    "filename": "the_great_gatsby.epub",
    "title": "The Great Gatsby",
    "authors": "F. Scott Fitzgerald"
  }
}
```

The `metadata` field is optional. KOReader sends it when "Send document metadata" is enabled in KOSync settings (see [koreader/koreader#15306](https://github.com/koreader/koreader/pull/15306)). Previously stored metadata is preserved when omitted.

- **Response**: `200` OK, `401` Unauthorized

### Get Progress

- **GET** `/syncs/progress/:document`
- **Headers**: `x-auth-user`, `x-auth-key`
- **Response**: `200` OK with progress data, `404` Not found

### List Documents

Returns all synced documents for the authenticated user, ordered by most recently updated. This endpoint is not used by the KOReader client — it's available for building dashboards or browsing your library.

- **GET** `/syncs/documents`
- **Headers**: `x-auth-user`, `x-auth-key`
- **Response**: `200` OK

```json
{
  "documents": [
    {
      "document": "8b03a82761fae0ee6cd5a23700361e74",
      "progress": "/body/DocFragment[15]/body/div[65]/text()[1].41",
      "percentage": 0.2082,
      "device": "boox",
      "device_id": "197E7C6B3FD54A749C87DE9C1B05A3CE",
      "filename": "the_great_gatsby.epub",
      "title": "The Great Gatsby",
      "authors": "F. Scott Fitzgerald",
      "timestamp": 1703123456
    }
  ]
}
```

`filename`, `title`, and `authors` are `null` for documents synced before metadata support was added.

### Health Check

- **GET** `/health`
- **Response**: `200` `{"status": "ok"}`

## Local Development

```bash
bun install
bun run dev
```

The dev server runs with hot reload. Create a `.env` file to configure environment variables locally (see [Configuration](#configuration)).
