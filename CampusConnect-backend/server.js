import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
// This client is intentionally server-only. Never return its key or client to callers.
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(root, "..");
const port = Number(process.env.PORT || 3000);
const mediaBucket = process.env.SUPABASE_MEDIA_BUCKET || "club-media";

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").map((v) => v.trim()).filter(Boolean) || true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(frontendRoot));

const fail = (res, status, error) => res.status(status).json({ error });
const clean = (value, max = 2000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const id = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const email = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const dateTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const dateOnly = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const url = (value, max = 1000) => {
  if (!value) return null;
  try { const parsed = new URL(clean(value, max)); return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null; } catch { return null; }
};
const positiveInteger = (value) => Number.isInteger(value) && value > 0;

async function requireUser(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(res, 401, "Sign in is required.");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return fail(res, 401, "Your session has expired.");
  req.user = data.user;
  next();
}

async function profileFor(userId) {
  const { data } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data;
}
async function requireRole(req, res, next) {
  const profile = await profileFor(req.user.id);
  if (!profile || !["organizer", "admin"].includes(profile.role)) return fail(res, 403, "Organizer access is required.");
  req.profile = profile;
  next();
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
async function writeProfile(user, role, values = {}) {
  const { data, error } = await admin.from("profiles").upsert({
    id: user.id, role, display_name: clean(values.display_name || values.name, 120) || user.user_metadata?.full_name || user.email?.split("@")[0],
    course: clean(values.course, 120) || null, bio: clean(values.bio, 1000) || null, avatar_url: clean(values.avatar_url, 1000) || null
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const signup = asyncRoute(async (req, res) => {
  const { email: address, password, role = "student", ...values } = req.body || {};
  if (!email(address) || typeof password !== "string" || password.length < 8 || !["student", "organizer"].includes(role)) {
    return fail(res, 400, "A valid email, a password of at least 8 characters, and a valid role are required.");
  }
  const { data, error } = await supabase.auth.signUp({ email: address.trim().toLowerCase(), password, options: { data: { role } } });
  if (error || !data.user) return fail(res, 400, error?.message || "Unable to create account.");
  await writeProfile(data.user, role, values);
  res.status(201).json({ user: data.user, session: data.session, access_token: data.session?.access_token || null, refresh_token: data.session?.refresh_token || null, role, confirmation_required: !data.session });
});
app.post("/api/auth/signup", signup);
app.post("/api/auth/register", signup);
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { email: address, password, role } = req.body || {};
  if (!email(address) || !password || !["student", "organizer"].includes(role)) return fail(res, 400, "Email, password, and role are required.");
  const normalizedEmail = address.trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (error || !data.session) return fail(res, 401, error?.message || "Unable to sign in.");
  let profile = await profileFor(data.user.id);
  if (profile && profile.role !== role) return fail(res, 403, `This account is registered as a ${profile.role}.`);
  if (!profile) profile = await writeProfile(data.user, role);
  res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token, user: data.user, profile, role: profile.role });
}));
app.get("/api/auth/me", requireUser, asyncRoute(async (req, res) => res.json({ user: req.user, profile: await profileFor(req.user.id) })));

app.get("/api/profiles/:id", asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return fail(res, 400, "Invalid profile id.");
  const profile = await profileFor(req.params.id);
  if (!profile) return fail(res, 404, "Profile not found.");
  res.json(profile);
}));
app.get("/api/profiles/me", requireUser, asyncRoute(async (req, res) => res.json(await profileFor(req.user.id))));
app.patch("/api/profiles/me", requireUser, asyncRoute(async (req, res) => {
  const allowed = ["display_name", "course", "bio", "avatar_url", "website_url"];
  const values = Object.fromEntries(allowed.filter((key) => key in (req.body || {})).map((key) => [key, clean(req.body[key], 2000) || null]));
  const { data, error } = await admin.from("profiles").update(values).eq("id", req.user.id).select().single();
  if (error) return fail(res, 400, error.message);
  res.json(data);
}));

app.get("/api/events", asyncRoute(async (req, res) => {
  let query = admin.from("events").select("*").order("event_date", { ascending: true, nullsFirst: false });
  if (req.query.search) query = query.or(`title.ilike.%${clean(req.query.search, 80)}%,description.ilike.%${clean(req.query.search, 80)}%`);
  if (req.query.organizer_id && id(req.query.organizer_id)) query = query.eq("organizer_id", req.query.organizer_id);
  if (req.query.event_id) {
    if (!id(req.query.event_id)) return fail(res, 400, "Invalid event id.");
    query = query.eq("id", req.query.event_id);
  }
  if (req.query.category) query = query.eq("category", clean(req.query.category, 80));
  if (req.query.date) {
    if (!dateOnly(req.query.date)) return fail(res, 400, "Date must use YYYY-MM-DD format.");
    query = query.gte("start_time", `${req.query.date}T00:00:00.000Z`).lt("start_time", `${req.query.date}T23:59:59.999Z`);
  }
  if (req.query.live !== undefined) {
    if (!["true", "false"].includes(String(req.query.live).toLowerCase())) return fail(res, 400, "Live must be true or false.");
    const now = new Date().toISOString();
    query = String(req.query.live).toLowerCase() === "true"
      ? query.lte("start_time", now).gte("end_time", now)
      : query.or(`start_time.gt.${now},end_time.lt.${now}`);
  }
  const { data, error } = await query;
  if (error) {
    console.error("Unable to load events:", error.message);
    return fail(res, 500, "Unable to load events.");
  }
  const events = data || [];
  const organizerIds = [...new Set(events.map((event) => event.organizer_id).filter(id))];
  const clubIds = [...new Set(events.map((event) => event.club_id).filter(id))];
  const [{ data: organizers, error: organizersError }, { data: clubs, error: clubsError }] = await Promise.all([
    organizerIds.length ? admin.from("profiles").select("id,display_name,avatar_url").in("id", organizerIds) : { data: [], error: null },
    clubIds.length ? admin.from("clubs").select("id,club_name,name,logo_url,category").in("id", clubIds) : { data: [], error: null }
  ]);
  if (organizersError || clubsError) {
    console.error("Unable to load event metadata:", organizersError?.message || clubsError?.message);
    return fail(res, 500, "Unable to load events.");
  }
  const organizerById = new Map((organizers || []).map((profile) => [profile.id, profile]));
  const clubById = new Map((clubs || []).map((club) => [club.id, club]));
  res.json(events.map((event) => ({
    ...event,
    organizer: organizerById.get(event.organizer_id) || null,
    club: clubById.get(event.club_id) || null
  })));
}));
app.get("/api/events/:id", asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return fail(res, 400, "Invalid event id.");
  const { data, error } = await admin.from("events").select("*").eq("id", req.params.id).single();
  if (error) return fail(res, 404, "Event not found.");
  const [{ data: organizer }, { data: club }] = await Promise.all([
    data.organizer_id ? admin.from("profiles").select("id,display_name,avatar_url").eq("id", data.organizer_id).maybeSingle() : { data: null },
    data.club_id ? admin.from("clubs").select("id,club_name,name,logo_url,category").eq("id", data.club_id).maybeSingle() : { data: null }
  ]);
  res.json({ ...data, organizer: organizer || null, club: club || null });
}));
app.post("/api/events", requireUser, requireRole, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (clean(body.title, 120).length < 3 || clean(body.description, 2000).length < 10) return fail(res, 400, "Title and description are required.");
  if ((body.start_time && !dateTime(body.start_time)) || (body.end_time && !dateTime(body.end_time))) return fail(res, 400, "Start and end times must be valid dates.");
  if (body.start_time && body.end_time && new Date(body.end_time) <= new Date(body.start_time)) return fail(res, 400, "End time must be after start time.");
  if (body.max_team_size !== undefined && body.max_team_size !== null && !positiveInteger(body.max_team_size)) return fail(res, 400, "Maximum team size must be a positive integer.");
  if (body.club_id && !id(body.club_id)) return fail(res, 400, "Invalid club id.");
  const poster = body.poster_url || body.image_url;
  if (poster && !url(poster)) return fail(res, 400, "Poster URL must be a valid HTTP(S) URL.");
  const { data, error } = await admin.from("events").insert({
    organizer_id: req.user.id, club_id: id(body.club_id) ? body.club_id : null,
    title: clean(body.title, 120), description: clean(body.description, 2000),
    event_date: body.event_date || body.start_time || null, location: clean(body.location || body.venue, 300) || null,
    image_url: url(body.image_url) || poster || null, poster_url: poster ? url(poster) : null,
    video_url: url(body.video_url) || null, start_time: body.start_time || body.event_date || null,
    end_time: body.end_time || null, venue: clean(body.venue || body.location, 300) || null,
    category: clean(body.category, 80) || null, max_team_size: body.max_team_size ?? null
  }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.patch("/api/events/:id", requireUser, requireRole, asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return fail(res, 400, "Invalid event id.");
  const body = req.body || {};
  if ((body.start_time && !dateTime(body.start_time)) || (body.end_time && !dateTime(body.end_time))) return fail(res, 400, "Start and end times must be valid dates.");
  if (body.start_time && body.end_time && new Date(body.end_time) <= new Date(body.start_time)) return fail(res, 400, "End time must be after start time.");
  if (body.max_team_size !== undefined && body.max_team_size !== null && !positiveInteger(body.max_team_size)) return fail(res, 400, "Maximum team size must be a positive integer.");
  if (body.club_id && !id(body.club_id)) return fail(res, 400, "Invalid club id.");
  for (const key of ["poster_url", "image_url", "video_url"]) {
    if (body[key] && !url(body[key])) return fail(res, 400, `${key} must be a valid HTTP(S) URL.`);
  }
  const values = {};
  for (const key of ["title", "description", "event_date", "location", "image_url", "video_url", "poster_url", "start_time", "end_time", "venue", "category", "max_team_size", "club_id"]) {
    if (key in body) values[key] = typeof body[key] === "string" ? clean(body[key], key === "description" ? 2000 : 1000) : body[key];
  }
  if ("start_time" in values && !("event_date" in values)) values.event_date = values.start_time;
  if ("venue" in values && !("location" in values)) values.location = values.venue;
  const { data, error } = await admin.from("events").update(values).eq("id", req.params.id).eq("organizer_id", req.user.id).select().single();
  if (error) return fail(res, 404, "Event not found or not owned by you.");
  res.json(data);
}));
app.delete("/api/events/:id", requireUser, requireRole, asyncRoute(async (req, res) => {
  const { error } = await admin.from("events").delete().eq("id", req.params.id).eq("organizer_id", req.user.id);
  if (error) return fail(res, 400, error.message);
  res.status(204).end();
}));

app.get("/api/clubs", asyncRoute(async (_req, res) => {
  const { data, error } = await admin.from("clubs").select("*, organizer:profiles!clubs_organizer_id_fkey(id,display_name,avatar_url)").order("created_at", { ascending: false });
  if (error) return fail(res, 500, "Unable to load clubs.");
  res.json(data || []);
}));
app.get("/api/organizers", asyncRoute(async (_req, res) => {
  const { data, error } = await admin.from("profiles").select("*").eq("role", "organizer").order("display_name");
  if (error) return fail(res, 500, "Unable to load organizers.");
  res.json(data || []);
}));
app.post("/api/clubs", requireUser, requireRole, asyncRoute(async (req, res) => {
  const { name, club_name, description, logo_url, category } = req.body || {};
  const normalizedName = clean(club_name || name, 120);
  if (normalizedName.length < 2) return fail(res, 400, "Club name is required.");
  if (logo_url && !url(logo_url)) return fail(res, 400, "Logo URL must be a valid HTTP(S) URL.");
  const { data, error } = await admin.from("clubs").insert({ organizer_id: req.user.id, name: normalizedName, club_name: normalizedName, description: clean(description, 2000) || null, logo_url: url(logo_url), category: clean(category, 80) || null }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.patch("/api/clubs/:id", requireUser, requireRole, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const values = Object.fromEntries(["name", "club_name", "description", "logo_url", "category", "cover_url"].filter((key) => key in body).map((key) => [key, key === "logo_url" ? url(body[key]) : clean(body[key], 2000) || null]));
  if (values.club_name && !values.name) values.name = values.club_name;
  if (values.name && !values.club_name) values.club_name = values.name;
  const { data, error } = await admin.from("clubs").update(values).eq("id", req.params.id).eq("organizer_id", req.user.id).select().single();
  if (error) return fail(res, 404, "Club not found or not owned by you.");
  res.json(data);
}));

app.get("/api/clubs/:clubId/posts", asyncRoute(async (req, res) => {
  const { data, error } = await admin.from("club_posts").select("*, author:profiles!club_posts_author_id_fkey(id,display_name,avatar_url)").eq("club_id", req.params.clubId).order("created_at", { ascending: false });
  if (error) return fail(res, 500, "Unable to load club posts.");
  res.json(data || []);
}));
app.post("/api/clubs/:clubId/posts", requireUser, asyncRoute(async (req, res) => {
  const { content, media_url, media_type } = req.body || {};
  if (!clean(content, 5000) && !clean(media_url, 1000)) return fail(res, 400, "Post content or media is required.");
  const { data, error } = await admin.from("club_posts").insert({ club_id: req.params.clubId, author_id: req.user.id, content: clean(content, 5000) || null, media_url: clean(media_url, 1000) || null, media_type: clean(media_type, 50) || null }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));

app.post("/api/clubs/:clubId/follow", requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await admin.from("club_followers").upsert({ club_id: req.params.clubId, user_id: req.user.id }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.delete("/api/clubs/:clubId/follow", requireUser, asyncRoute(async (req, res) => { await admin.from("club_followers").delete().match({ club_id: req.params.clubId, user_id: req.user.id }); res.status(204).end(); }));
app.get("/api/clubs/:clubId/followers", asyncRoute(async (req, res) => {
  const { data, error } = await admin.from("club_followers").select("created_at, profile:profiles!club_followers_user_id_fkey(id,display_name,avatar_url)").eq("club_id", req.params.clubId);
  if (error) return fail(res, 500, "Unable to load followers.");
  res.json(data || []);
}));

app.get("/api/posts/:postId/comments", asyncRoute(async (req, res) => {
  const { data, error } = await admin.from("comments").select("*, author:profiles!comments_author_id_fkey(id,display_name,avatar_url)").eq("post_id", req.params.postId).order("created_at");
  if (error) return fail(res, 500, "Unable to load comments.");
  res.json(data || []);
}));
app.post("/api/posts/:postId/comments", requireUser, asyncRoute(async (req, res) => {
  if (clean(req.body?.content, 1000).length < 1) return fail(res, 400, "Comment cannot be empty.");
  const { data, error } = await admin.from("comments").insert({ post_id: req.params.postId, author_id: req.user.id, content: clean(req.body.content, 1000) }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));

async function participation(req, res, kind) {
  const { data, error } = await admin.from("event_participants").upsert({ event_id: req.params.id, user_id: req.user.id, status: kind }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}
app.post("/api/events/:id/rsvp", requireUser, asyncRoute((req, res) => participation(req, res, "going")));
app.post("/api/events/:id/interested", requireUser, asyncRoute((req, res) => participation(req, res, "interested")));
app.delete("/api/events/:id/rsvp", requireUser, asyncRoute(async (req, res) => { await admin.from("event_participants").delete().match({ event_id: req.params.id, user_id: req.user.id }); res.status(204).end(); }));
app.get("/api/events/:id/participants", requireUser, requireRole, asyncRoute(async (req, res) => {
  const { data: event, error: eventError } = await admin.from("events").select("id,title").eq("id", req.params.id).eq("organizer_id", req.user.id).maybeSingle();
  if (eventError) return fail(res, 500, "Unable to verify event ownership.");
  if (!event) return fail(res, 404, "Event not found or not owned by you.");
  const { data, error } = await admin.from("event_participants").select("status,created_at,profile:profiles!event_participants_user_id_fkey(id,display_name,avatar_url,course)").eq("event_id", req.params.id).order("created_at", { ascending: false });
  if (error) return fail(res, 500, "Unable to load participants.");
  res.json({ event, participants: data || [] });
}));
app.get("/api/organizer/registrations", requireUser, requireRole, asyncRoute(async (req, res) => {
  const { data: events, error: eventsError } = await admin.from("events").select("id,title,start_time,end_time,venue,category").eq("organizer_id", req.user.id).order("event_date", { ascending: true, nullsFirst: false });
  if (eventsError) return fail(res, 500, "Unable to load your events.");
  const eventIds = (events || []).map((event) => event.id);
  if (!eventIds.length) return res.json({ events: [], registrations: [] });
  const { data: registrations, error: registrationsError } = await admin.from("event_participants").select("event_id,status,created_at,profile:profiles!event_participants_user_id_fkey(id,display_name,avatar_url,course)").in("event_id", eventIds).order("created_at", { ascending: false });
  if (registrationsError) return fail(res, 500, "Unable to load event registrations.");
  res.json({ events, registrations: registrations || [] });
}));
app.get("/api/bookmarks", requireUser, asyncRoute(async (req, res) => { const { data, error } = await admin.from("bookmarks").select("created_at,event:events(*)").eq("user_id", req.user.id); if (error) return fail(res, 500, "Unable to load bookmarks."); res.json(data || []); }));
app.post("/api/events/:id/bookmark", requireUser, asyncRoute(async (req, res) => { const { data, error } = await admin.from("bookmarks").upsert({ event_id: req.params.id, user_id: req.user.id }).select().single(); if (error) return fail(res, 400, error.message); res.status(201).json(data); }));
app.delete("/api/events/:id/bookmark", requireUser, asyncRoute(async (req, res) => { await admin.from("bookmarks").delete().match({ event_id: req.params.id, user_id: req.user.id }); res.status(204).end(); }));
async function teammateListings(req, res, eventId = req.query.event_id) {
  let query = admin.from("teammate_listings").select("*, profile:profiles!teammate_listings_user_id_fkey(id,display_name,course,avatar_url)").eq("active", true).order("created_at", { ascending: false });
  if (eventId) {
    if (!id(eventId)) return fail(res, 400, "Invalid event id.");
    query = query.eq("event_id", eventId);
  }
  if (req.query.skill) query = query.ilike("skills", `%${clean(req.query.skill, 80)}%`);
  const { data, error } = await query;
  if (error) return fail(res, 500, "Unable to load teammate listings.");
  res.json(data || []);
}
app.get("/api/teammates", asyncRoute(teammateListings));
app.get("/api/events/:id/teammates", asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return fail(res, 400, "Invalid event id.");
  return teammateListings(req, res, req.params.id);
}));
app.post("/api/teammates", requireUser, asyncRoute(async (req, res) => {
  const { title, description, skills, event_id } = req.body || {};
  if (clean(title, 120).length < 3 || !clean(description, 2000)) return fail(res, 400, "Title and description are required.");
  if (event_id && !id(event_id)) return fail(res, 400, "Invalid event id.");
  const { data, error } = await admin.from("teammate_listings").insert({ user_id: req.user.id, event_id: id(event_id) ? event_id : null, title: clean(title, 120), description: clean(description, 2000), skills: clean(skills, 500) || null }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.post("/api/teammates/:listingId/requests", requireUser, asyncRoute(async (req, res) => {
  if (!id(req.params.listingId)) return fail(res, 400, "Invalid teammate listing id.");
  const message = clean(req.body?.message, 500) || null;
  const { data: listing, error: listingError } = await admin.from("teammate_listings").select("id,user_id,event_id").eq("id", req.params.listingId).eq("active", true).maybeSingle();
  if (listingError) return fail(res, 500, "Unable to verify teammate listing.");
  if (!listing) return fail(res, 404, "Teammate listing not found.");
  if (listing.user_id === req.user.id) return fail(res, 400, "You cannot request to join your own listing.");
  const { data, error } = await admin.from("teammate_requests").upsert({ listing_id: listing.id, requester_id: req.user.id, message, status: "pending" }, { onConflict: "listing_id,requester_id" }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.get("/api/teammates/requests", requireUser, asyncRoute(async (req, res) => {
  const { data: ownedListings, error: listingsError } = await admin.from("teammate_listings").select("id").eq("user_id", req.user.id);
  if (listingsError) return fail(res, 500, "Unable to load teammate requests.");
  const ownedIds = (ownedListings || []).map((listing) => listing.id);
  const select = "id,status,message,created_at,listing:teammate_listings!teammate_requests_listing_id_fkey(id,title,event_id,user_id),requester:profiles!teammate_requests_requester_id_fkey(id,display_name,course,avatar_url)";
  const [sentResult, receivedResult] = await Promise.all([
    admin.from("teammate_requests").select(select).eq("requester_id", req.user.id),
    ownedIds.length ? admin.from("teammate_requests").select(select).in("listing_id", ownedIds) : Promise.resolve({ data: [], error: null })
  ]);
  if (sentResult.error || receivedResult.error) return fail(res, 500, "Unable to load teammate requests.");
  const unique = new Map([...sentResult.data || [], ...receivedResult.data || []].map((request) => [request.id, request]));
  res.json([...unique.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
}));
app.patch("/api/teammates/requests/:requestId", requireUser, asyncRoute(async (req, res) => {
  if (!id(req.params.requestId) || !["accepted", "rejected"].includes(req.body?.status)) return fail(res, 400, "A valid request and status are required.");
  const { data: request, error: requestError } = await admin.from("teammate_requests").select("id,listing:teammate_listings!teammate_requests_listing_id_fkey(user_id)").eq("id", req.params.requestId).maybeSingle();
  if (requestError) return fail(res, 500, "Unable to verify request.");
  if (!request || request.listing?.user_id !== req.user.id) return fail(res, 404, "Request not found or not owned by you.");
  const { data, error } = await admin.from("teammate_requests").update({ status: req.body.status, updated_at: new Date().toISOString() }).eq("id", req.params.requestId).select().single();
  if (error) return fail(res, 400, error.message);
  res.json(data);
}));
app.get("/api/messages", requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await admin.from("messages").select("id,sender_id,recipient_id,body,created_at,read_at").or(`sender_id.eq.${req.user.id},recipient_id.eq.${req.user.id}`).order("created_at", { ascending: true });
  if (error) return fail(res, 500, "Unable to load messages.");
  res.json(data || []);
}));
app.post("/api/messages", requireUser, asyncRoute(async (req, res) => {
  if (!id(req.body?.recipient_id) || !clean(req.body?.body, 2000)) return fail(res, 400, "Recipient and message are required.");
  if (req.body.recipient_id === req.user.id) return fail(res, 400, "You cannot message yourself.");
  const { data, error } = await admin.from("messages").insert({ sender_id: req.user.id, recipient_id: req.body.recipient_id, body: clean(req.body.body, 2000) }).select().single();
  if (error) return fail(res, 400, error.message);
  res.status(201).json(data);
}));
app.post("/api/media/upload", requireUser, asyncRoute(async (req, res) => {
  const { filename, contentType = "application/octet-stream", data } = req.body || {};
  if (!filename || typeof data !== "string" || !/^data:/.test(data)) return fail(res, 400, "Provide a data URL and filename.");
  const match = data.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) return fail(res, 400, "Invalid data URL.");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length > 8 * 1024 * 1024) return fail(res, 413, "Media must be 8 MB or smaller.");
  const safeName = path.basename(filename).replace(/[^a-z0-9._-]/gi, "_");
  const storagePath = `${req.user.id}/${Date.now()}-${safeName}`;
  const { error } = await admin.storage.from(mediaBucket).upload(storagePath, buffer, { contentType, upsert: false });
  if (error) return fail(res, 400, error.message);
  const expires = Number(process.env.SUPABASE_SIGNED_URL_TTL || 3600);
  const { data: signed, error: signError } = await admin.storage.from(mediaBucket).createSignedUrl(storagePath, expires);
  if (signError) return fail(res, 400, signError.message);
  res.status(201).json({ bucket: mediaBucket, path: storagePath, signed_url: signed.signedUrl, expires_in: expires, content_type: contentType, size: buffer.length });
}));

app.use((req, res, next) => req.path.startsWith("/api/") ? fail(res, 404, "API route not found.") : next());
app.use((error, _req, res, _next) => { console.error(error); fail(res, 500, "Unexpected server error."); });
app.use((_req, res) => res.sendFile(path.join(frontendRoot, "index.html")));
app.listen(port, () => console.log(`CampusConnect backend running at http://localhost:${port}`));
