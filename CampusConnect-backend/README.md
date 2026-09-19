# CampusConnect backend

Express/Supabase API for the existing static CampusConnect frontend. The existing
`signInWithBackend`, `loadBackendEvents`, and `createBackendEvent` helpers remain
compatible.

## Setup

1. Use Node.js 18 or newer and create a Supabase project.
2. Run `schema.sql` in the Supabase SQL editor. It creates profiles, events,
   clubs/posts, follows, comments, RSVPs/interested records, bookmarks,
   teammate listings, teammate requests, messages, indexes, RLS, and the private
   `club-media` bucket.
3. Copy `.env.example` to `.env` and set `SUPABASE_URL`, the publishable/anon
   key, and the server-only service-role key.
4. Run `npm install`, then `npm start` (or `npm run dev`).

The API listens on `http://localhost:3000`. Useful route groups are:

- `/api/auth` (login, signup/register, current user)
- `/api/profiles`, `/api/events`, `/api/clubs`, `/api/organizers`
- `/api/clubs/:clubId/posts`, follows, `/api/posts/:postId/comments`
- event RSVP/interested, organizer-only participants, bookmarks, `/api/teammates`,
  teammate join requests, and `/api/messages`
- `/api/media/upload` accepts a base64 data URL and returns bucket/path,
  content type, size, and an expiring signed URL

Only the server uses `SUPABASE_SERVICE_ROLE_KEY`; it is never returned to the
browser. Limit uploads to 8 MB and use the returned signed URL before expiry.
