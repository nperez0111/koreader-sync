# Koreader Sync

<div style="display: flex; align-items: flex-start; gap: 2rem;">
  <img src="./public/logo.jpg" alt="KOReader Sync Server" width="150">
  <p style="margin: 0;">A KOReader sync server implementation using Bun and Hono.</p>
</div>

## Self-Hosting Guide

The easiest way to self-host this sync server is using Docker Compose:

1. Create a new directory for your sync server:

```bash
mkdir koreader-sync && cd koreader-sync
```

2. Create a `docker-compose.yml` file with the following content:

```yaml
services:
  kosync:
    image: ghcr.io/nperez0111/koreader-sync:latest
    container_name: kosync
    ports:
      - 3000:3000
    healthcheck:
      test: ["CMD", "wget" ,"--no-verbose", "--tries=1", "--spider", "http://localhost/health"]
      interval: 5m
      timeout: 3s
    restart: unless-stopped
    volumes:
      - data:/app/data
```

3. Start the server:

```bash
docker compose up -d
```

Your sync server will now be running at `http://localhost:3000`. The SQLite database will be automatically persisted in a Docker volume.

### Connecting Your KOReader Device

1. Open a document on your KOReader device and navigate to Settings → Progress Sync → Custom sync server
2. Enter your server's URL (e.g., `http://localhost:3000` if running locally)
3. Select "Register / Login" to create an account or sign in
4. Test the connection by selecting "Push progress from this device now"
5. Enable automatic progress syncing in the settings if desired

## Local Development

1. Install dependencies:

```bash
bun install
```

2. Set up environment variables:

```bash
# Create a .env file with the following variables (change values as needed):
PASSWORD_SALT="your_secure_random_string"
PORT=3000
HOST="0.0.0.0"
```

3. Run the development server:

```bash
bun run dev
```

## Logging

The application uses Pino for structured logging. Logs are output in JSON format in production and pretty-printed in development.

### Log Levels

- `debug`: Detailed information for debugging (health checks, auth attempts)
- `info`: General information about application flow (user actions, successful operations)
- `warn`: Warning messages (authentication failures, validation errors)
- `error`: Error messages (database errors, unhandled exceptions)

### Environment Variables

- `LOG_LEVEL`: Set the minimum log level (default: `info`)
- `NODE_ENV`: Set to `development` for pretty-printed logs, `production` for JSON logs

### Example Log Output

```json
{
  "level": 30,
  "time": 1703123456789,
  "msg": "User registered successfully",
  "username": "john_doe"
}
```

### Logging Features

- **Request/Response Logging**: All HTTP requests and responses are automatically logged
- **Structured Data**: All logs include relevant context (user IDs, document names, etc.)
- **Error Tracking**: Comprehensive error logging with stack traces
- **Performance Monitoring**: Request duration tracking
- **Security**: Sensitive data like passwords are never logged

## API Endpoints

### Register User

- **POST** `/users/create`
- **Headers**:
  - `content-type`: application/json
- **Body**: `{ "username": "string", "password": "string" }`
- **Response**: 201 (Created) or 402 (Username exists)

### Authenticate

- **GET** `/users/auth`
- **Headers**:
  - `x-auth-user`: Username
  - `x-auth-key`: Password/API Key
  - `accept`: application/vnd.koreader.v1+json
- **Response**: 200 (OK) or 401 (Unauthorized)

### Update Progress

- **PUT** `/syncs/progress`
- **Headers**:
  - `x-auth-user`: Username
  - `x-auth-key`: Password/API Key
  - `accept`: application/vnd.koreader.v1+json
  - `content-type`: application/json
- **Body**:

```json
{
  "document": "8b03a82761fae0ee6cd5a23700361e74",
  "progress": "/body/DocFragment[15]/body/div[65]/text()[1].41",
  "percentage": 0.2082,
  "device": "boox",
  "device_id": "197E7C6B3FD54A749C87DE9C1B05A3CE"
}
```

- **Response**: 200 (OK) or 401 (Unauthorized)

### Get Progress

- **GET** `/syncs/progress/:document`
- **Headers**:
  - `x-auth-user`: Username
  - `x-auth-key`: Password/API Key
  - `accept`: application/vnd.koreader.v1+json
- **Response**: 200 (OK) with progress data or 404 (Not Found)

## Security Features

1. **Password Hashing**: All passwords are hashed using bcrypt with additional salt
2. **Custom Headers**: Uses KOReader's custom authentication headers
3. **SQLite Security**: Uses parameterized queries to prevent SQL injection
4. **Environment Variables**: Sensitive configuration like password salt is loaded from environment variables

## Additional Security Recommendations

For production use, you should also:

1. Use HTTPS to encrypt all traffic
2. Implement rate limiting to prevent brute force attacks
3. Add input validation and sanitization
4. Regularly backup the SQLite database (located in `/app/data/koreader-sync.db`)
5. Consider adding request signing for additional security
6. Use a strong, random PASSWORD_SALT in production
