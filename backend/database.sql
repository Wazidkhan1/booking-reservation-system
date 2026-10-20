-- Backend schema: users, sessions, rooms, and bookings.
-- Existing accounts and reservations are preserved when this file runs again.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(80) NOT NULL,
  email varchar(254) UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS rooms (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug varchar(60) UNIQUE NOT NULL,
  name varchar(80) NOT NULL,
  kind varchar(30) NOT NULL CHECK (kind IN ('meeting-room', 'private-office', 'creative-studio')),
  description text NOT NULL,
  location varchar(100) NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  hourly_rate integer NOT NULL CHECK (hourly_rate > 0),
  amenities text[] NOT NULL DEFAULT '{}',
  image varchar(100) NOT NULL,
  featured boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY,
  reference varchar(20) UNIQUE NOT NULL,
  user_id integer NOT NULL REFERENCES users(id),
  room_id integer NOT NULL REFERENCES rooms(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  guests integer NOT NULL CHECK (guests BETWEEN 1 AND 100),
  purpose varchar(160) NOT NULL DEFAULT '',
  total_paise integer NOT NULL CHECK (total_paise > 0),
  status varchar(12) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CHECK (ends_at > starts_at AND ends_at - starts_at BETWEEN interval '30 minutes' AND interval '8 hours'),
  CONSTRAINT no_overlapping_bookings EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'confirmed')
);
CREATE INDEX IF NOT EXISTS bookings_user_start_idx ON bookings(user_id, starts_at DESC);


-- Six example rooms. Prices are in paise: 55000 means 550 rupees per hour.
INSERT INTO rooms(slug, name, kind, description, location, capacity, hourly_rate, amenities, image, featured)
VALUES
  ('the-garden-room', 'The Garden Room', 'meeting-room', 'A sunlit corner for good conversations. Gather your team around the table, with greenery and everything you need to get started.', 'Ground floor · East wing', 6, 55000, ARRAY['Wi-Fi', 'Whiteboard', 'Display', 'Natural light'], '', true),
  ('the-boardroom', 'The Boardroom', 'meeting-room', 'Make room for your next big decision. A spacious meeting room with a large display, comfortable seating, and a little extra perspective.', 'First floor · West wing', 12, 95000, ARRAY['Wi-Fi', 'Display', 'Video call', 'Whiteboard'], '', true),
  ('the-focus-suite', 'The Focus Suite', 'private-office', 'Your quiet place to get things done. A private office for deep work, a small team, or a day away from distractions.', 'First floor · East wing', 3, 35000, ARRAY['Wi-Fi', 'Power outlets', 'Quiet zone', 'Natural light'], '', false),
  ('the-creative-loft', 'The Creative Loft', 'creative-studio', 'Big windows, open space, fresh ideas. A flexible studio for brainstorming, workshops, and bringing your next project to life.', 'Second floor · North wing', 10, 85000, ARRAY['Wi-Fi', 'Whiteboard', 'Flexible layout', 'Natural light'], '', true),
  ('the-huddle', 'The Huddle', 'meeting-room', 'Small space, great momentum. A cozy meeting room for quick catch-ups, interviews, and conversations that move things forward.', 'Ground floor · West wing', 4, 40000, ARRAY['Wi-Fi', 'Display', 'Video call', 'Power outlets'], '', false),
  ('the-window-office', 'The Window Office', 'private-office', 'A change of scenery for your working day. An airy private office with room for your team and a view worth looking up for.', 'Second floor · East wing', 5, 65000, ARRAY['Wi-Fi', 'Power outlets', 'Natural light', 'Quiet zone'], '', false)
ON CONFLICT (slug) DO NOTHING;
