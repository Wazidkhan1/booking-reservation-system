# Booking and Reservation System

A small project using **Node.js, Express, PostgreSQL, HTML, CSS, and vanilla JavaScript**. It lets users sign in, find available rooms, make a booking, see their bookings, and cancel upcoming bookings.

## Start it

Double-click **start-roomly.cmd**, leave the terminal open, and visit **http://localhost:3000**.

Or, in this folder:

```powershell
npm.cmd install
npm.cmd run setup
npm.cmd start
```

Create an account using the form at the top. Choose a date, time, guest count, and room type. Click **Find rooms**, select **Book room**, then **Confirm booking**. Your booking appears below.

You need Node.js 22+ and PostgreSQL 16+ installed. On this computer, setup automatically uses the installed PostgreSQL binaries. It creates a separate local database on port 55432. It preserves existing accounts and bookings. After restarting Windows, run the launcher or setup again.

## Project structure

Read these files to understand the project:

| File | What it does |
| --- | --- |
| `backend/database.sql` | Creates four tables, prevents overlapping bookings, and adds six sample rooms. |
| `backend/server.js` | Connects to PostgreSQL and handles login, room search, booking, and cancellation. |
| `index.html` | Contains the account, search, confirmation, and booking-history sections. |
| `script.js` | Reads forms, sends requests with `fetch()`, and updates the page. |
| `style.css` | Styles the page and adapts it to mobile screens. |

The `backend/` folder contains the API server, database schema, and `setup.js` startup helper. `start-roomly.cmd` launches the project, and `test.js` checks the API against PostgreSQL. `package.json` lists dependencies and commands; `package-lock.json` records their versions. `.env` contains the private database connection. `.local/` contains automatically generated database files; `node_modules/` contains installed libraries. You do not need to study those generated folders to explain the project.

## How to explain the project

> “I built a room booking system with Express and PostgreSQL. The frontend uses HTML, CSS, and plain JavaScript. When a user searches, JavaScript calls an API that checks existing bookings. On confirmation, the server validates the request, calculates the price, and saves the booking. PostgreSQL rejects overlapping reservations even if two users book at the same time. Users can view and cancel only their own bookings.”

Follow one booking through the code:

1. **HTML:** the user chooses a date and time in `search-form`.
2. **JavaScript:** `loadRooms()` calls `GET /api/rooms`.
3. **Express:** the route queries rooms and checks for overlapping confirmed bookings.
4. **JavaScript:** the user selects a room and submits `booking-form`.
5. **Express:** `POST /api/bookings` validates the request and calculates the price inside a transaction.
6. **PostgreSQL:** the exclusion constraint accepts the booking or rejects a conflict. The page displays the result.

### Four tables

| Table | Stores |
| --- | --- |
| `users` | Name, unique email, salted password hash |
| `sessions` | Hashed login tokens, user IDs, expiration times |
| `rooms` | Room details, capacity, amenities, hourly price |
| `bookings` | User, room, start/end time, guest count, total price, status |

One user can have many bookings. One room can have many bookings at different times. A session links a browser's login cookie to its user.

### How double-booking protection works

Two bookings overlap when **existing start < new end AND existing end > new start**.

The search route uses that condition to show availability. The SQL `no_overlapping_bookings` constraint enforces it when saving. This second check matters because a room could be booked after the search results load. PostgreSQL's `btree_gist` extension lets the constraint combine a room ID with a time range. Cancelled bookings do not block the room. Adjacent bookings, such as 09:00–10:00 and 10:00–11:00, are allowed.

### Why a transaction?

`BEGIN` starts a transaction. The server reads the room, checks capacity, calculates its price, and inserts the booking. `COMMIT` saves the work. On a conflict or error, `ROLLBACK` cancels the transaction. The exclusion constraint is what prevents concurrent overlapping bookings.

### Authentication and validation

Passwords are hashed with salted `scrypt`. Signing in creates a random token in an HttpOnly cookie; the database stores its hash. Protected routes identify the user through that session. SQL queries use parameters, and the server checks booking ownership, dates, times, and capacity. Helmet sets HTTP security headers; rate limits restrict request bursts and repeated login attempts.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Check the database connection |
| POST | `/api/auth/register` | Create an account |
| POST | `/api/auth/login` | Sign in |
| GET | `/api/auth/me` | Restore the current session |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/rooms` | Search rooms and availability |
| GET | `/api/bookings` | List the current user's bookings |
| POST | `/api/bookings` | Make a booking |
| POST | `/api/bookings/:id/cancel` | Cancel an upcoming booking |

Room searches require `date` and accept `start`, `end`, `capacity`, and `kind`. API-only optional filters are `q` (name/location search) and `sort` (`recommended`, `price-low`, `capacity`). Write requests use JSON.

## Rules

- All times use India Standard Time (UTC+05:30).
- Rooms are open 08:00–22:00. Book in half-hour increments, from 30 minutes to 8 hours, up to 90 days ahead.
- The guest count must fit the room. Prices are calculated on the server and stored as integer paise.
- No payment is collected. Bookings can be cancelled before their start time.

## Tests and stopping

Run `npm.cmd test`. It creates a temporary test schema, checks the API and concurrent booking protection, and deletes only the test schema. It does not delete your bookings.

Press **Ctrl+C** to stop the website. Run `npm.cmd run db:stop` to stop only this project's local PostgreSQL instance. Data is preserved.

To use your own project database, set `DATABASE_URL` in `.env`, then run setup. It must support `btree_gist`. Keep the existing `.local` folder if you want to keep this computer's project-managed database. `PORT` and `APP_ORIGIN` in `.env` must match your website address.

If PowerShell blocks `npm.ps1`, use `npm.cmd`. If npm reports a certificate error, set `$env:NODE_OPTIONS='--use-system-ca'` and retry. Keep `.env` and `.local` out of Git. The app listens on loopback for local development; a public deployment needs HTTPS, production cookies, and deployment-specific configuration.
