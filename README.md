# Koreader Sync

A KOReader sync server implementation using Bun and Hono.

## Setup

### Local Development

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

### Docker Deployment

1. Create a `.env` file with your environment variables:

```bash
PASSWORD_SALT="your_secure_random_string"
```

2. Build and run with Docker Compose:

```bash
docker compose up -d
```

The server will be available at `http://localhost:3000`. The SQLite database will be stored in the `./data` directory.

To view logs:

```bash
docker compose logs -f
```

To stop the server:

```bash
docker compose down
```

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
