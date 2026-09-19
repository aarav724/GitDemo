const API_BASE = window.CAMPUSCONNECT_API || "http://localhost:3000";

async function apiRequest(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  const token = sessionStorage.getItem("campusconnect-access-token");
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Request failed.");
  return body;
}

async function signInWithBackend(email, password, role) {
  const result = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, role })
  });
  sessionStorage.setItem("campusconnect-access-token", result.access_token);
  sessionStorage.setItem("campusconnect-refresh-token", result.refresh_token);
  return result;
}

async function signUpWithBackend(email, password, role = "student", profile = {}) {
  const result = await apiRequest("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify(Object.assign({ email, password, role }, profile))
  });
  if (result.access_token) sessionStorage.setItem("campusconnect-access-token", result.access_token);
  if (result.refresh_token) sessionStorage.setItem("campusconnect-refresh-token", result.refresh_token);
  return result;
}

async function loadBackendEvents(filters = {}) {
  const params = new URLSearchParams();
  ["category", "live", "date", "event_id", "search", "organizer_id"].forEach((key) => {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== "") params.set(key, filters[key]);
  });
  const query = params.toString();
  return apiRequest("/api/events" + (query ? "?" + query : ""));
}
async function createBackendEvent(event) { return apiRequest("/api/events", { method: "POST", body: JSON.stringify(event) }); }
async function loadBackendClubs() { return apiRequest("/api/clubs"); }
async function loadBackendTeammates(eventId) {
  return apiRequest("/api/teammates" + (eventId ? "?event_id=" + encodeURIComponent(eventId) : ""));
}
async function loadBackendEventTeammates(eventId) {
  return apiRequest("/api/events/" + encodeURIComponent(eventId) + "/teammates");
}
async function createBackendTeammateListing(listing) {
  return apiRequest("/api/teammates", { method: "POST", body: JSON.stringify(listing) });
}
async function requestToJoinTeammateListing(listingId, message = "") {
  return apiRequest("/api/teammates/" + encodeURIComponent(listingId) + "/requests", { method: "POST", body: JSON.stringify({ message }) });
}
async function loadTeammateRequests() {
  return apiRequest("/api/teammates/requests");
}
async function loadBackendProfile() { return apiRequest("/api/profiles/me"); }
async function updateBackendProfile(profile) { return apiRequest("/api/profiles/me", { method: "PATCH", body: JSON.stringify(profile) }); }
async function registerForBackendEvent(eventId) {
  return apiRequest("/api/events/" + encodeURIComponent(eventId) + "/rsvp", { method: "POST", body: JSON.stringify({}) });
}
async function loadOrganizerRegistrations() {
  return apiRequest("/api/organizer/registrations");
}
