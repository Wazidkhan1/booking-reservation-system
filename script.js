// Browser code: read forms -> call the API -> update the page.
const $ = selector => document.querySelector(selector);
const money = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const roomType = kind => ({ 'meeting-room': 'Meeting room', 'private-office': 'Private office', 'creative-studio': 'Creative studio' })[kind];
const displayDate = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const displayTime = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
let user = null;
let rooms = [];
let bookings = [];
let search = null;
let selectedRoom = null;
let registering = false;
let requestNumber = 0;
let messageTimer;

// 1. A single fetch helper handles all JSON requests.
async function api(route, method = 'GET', body) {
  const response = await fetch(`/api${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && user) { user = null; bookings = []; updateAccount(); renderBookings(); }
    throw new Error(data.error || 'Please try again.');
  }
  return data;
}
function showMessage(text) {
  clearTimeout(messageTimer);
  $('#message').textContent = text;
  $('#message').hidden = false;
  messageTimer = setTimeout(() => { $('#message').hidden = true; }, 6000);
}
function updateAccount() {
  $('#user-name').textContent = user ? `Hi, ${user.name}` : 'Welcome, guest';
  $('#logout').hidden = !user;
  $('#auth-section').hidden = Boolean(user);
  $('#booking-section').hidden = true;
  selectedRoom = null;
}

// 2. Registration and login share one form.
$('#toggle-auth').addEventListener('click', () => {
  registering = !registering;
  $('#name-field').hidden = !registering;
  $('#name').required = registering;
  $('#password').minLength = registering ? 10 : 1;
  $('#password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#password').placeholder = registering ? 'At least 10 characters' : 'Your password';
  $('#auth-title').textContent = registering ? 'Create your account' : 'Sign in to book a room';
  $('#auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  $('#toggle-auth').textContent = registering ? 'Already registered? Sign in' : 'Create an account';
  $('#auth-error').textContent = '';
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#auth-submit').disabled = true;
  $('#auth-error').textContent = '';
  try {
    const result = await api(`/auth/${registering ? 'register' : 'login'}`, 'POST', { name: $('#name').value, email: $('#email').value, password: $('#password').value });
    user = result.user;
    $('#password').value = '';
    updateAccount();
    await loadBookings();
    showMessage('You are signed in. Choose a room below.');
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { $('#auth-submit').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/auth/logout', 'POST', {}); user = null; bookings = []; updateAccount(); renderBookings(); showMessage('Signed out.'); }
  catch (error) { showMessage(error.message); }
});

// 3. Search rooms and display their availability for the submitted time.
async function loadRooms() {
  const currentRequest = ++requestNumber;
  $('#booking-section').hidden = true;
  selectedRoom = null;
  const filters = { date: $('#date').value, start: $('#start').value, end: $('#end').value, capacity: $('#guests').value, kind: $('#kind').value };
  search = null;
  $('#rooms').innerHTML = '<p class="empty">Loading rooms…</p>';
  $('#rooms').setAttribute('aria-busy', 'true');
  $('#results').textContent = 'Finding rooms…';
  try {
    const result = await api(`/rooms?${new URLSearchParams(filters)}`);
    if (currentRequest !== requestNumber) return;
    rooms = result.rooms;
    search = { ...filters, hours: result.hours };
    renderRooms();
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    rooms = []; search = null;
    $('#results').textContent = 'Search could not be completed.';
    $('#rooms').innerHTML = `<p class="empty">${escapeHtml(error.message)} Change your search and try again.</p>`;
  } finally { if (currentRequest === requestNumber) $('#rooms').setAttribute('aria-busy', 'false'); }
}
function renderRooms() {
  if (!search) return;
  const visibleRooms = rooms.filter(room => !$('#available-only').checked || room.available);
  $('#results').textContent = `${visibleRooms.length} rooms · ${visibleRooms.filter(room => room.available).length} available for your selected time`;
  $('#rooms').innerHTML = visibleRooms.map(room => `
    <article class="room-card">
      <div class="room-art ${escapeHtml(room.kind)}" aria-hidden="true"></div>
      <div class="room-body">
        <div class="room-top"><span class="room-kind">${roomType(room.kind)}</span><span class="status ${room.available ? '' : 'reserved'}">${room.available ? 'Available' : 'Reserved'}</span></div>
        <h3>${escapeHtml(room.name)}</h3>
        <p class="room-location">${escapeHtml(room.location)} · Up to ${room.capacity} guests</p>
        <div class="amenities">${room.amenities.map(escapeHtml).join(' · ')}</div>
        <div class="room-bottom"><div><strong>${money(room.hourly_rate)}</strong><small> / hour</small></div><button data-room="${room.id}" ${room.available ? '' : 'disabled'} aria-label="Book ${escapeHtml(room.name)}">${room.available ? 'Book room ↗' : 'Unavailable'}</button></div>
      </div>
    </article>`).join('') || '<p class="empty">No rooms match. Try a different time, fewer guests, or another room type.</p>';
}
$('#search-form').addEventListener('submit', event => { event.preventDefault(); loadRooms(); });
$('#available-only').addEventListener('change', renderRooms);

// 4. Select a room, review its total, then explicitly confirm the booking.
$('#rooms').addEventListener('click', event => {
  const button = event.target.closest('[data-room]');
  if (!button || !search) return;
  if (!user) { $('#auth-section').scrollIntoView(); $('#email').focus(); showMessage('Please sign in before booking.'); return; }
  selectedRoom = rooms.find(room => room.id === Number(button.dataset.room));
  $('#booking-title').textContent = selectedRoom.name;
  $('#booking-details').textContent = `${displayDate(`${search.date}T12:00:00+05:30`)} · ${search.start}–${search.end} IST · ${search.capacity} guests`;
  $('#booking-price').innerHTML = `${money(Math.round(selectedRoom.hourly_rate * search.hours))} <small>total for ${search.hours} hour(s)</small>`;
  $('#purpose').value = '';
  $('#booking-error').textContent = '';
  $('#booking-section').hidden = false;
  $('#booking-section').scrollIntoView();
  $('#booking-title').focus({ preventScroll: true });
});
$('#close-booking').addEventListener('click', () => { selectedRoom = null; $('#booking-section').hidden = true; });
$('#booking-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedRoom || !search) return;
  $('#confirm-booking').disabled = true;
  $('#booking-error').textContent = '';
  try {
    const result = await api('/bookings', 'POST', { roomId: selectedRoom.id, date: search.date, start: search.start, end: search.end, guests: Number(search.capacity), purpose: $('#purpose').value });
    $('#booking-section').hidden = true;
    selectedRoom = null;
    $('#show-history').checked = false;
    await Promise.all([loadRooms(), loadBookings()]);
    showMessage(`Booking confirmed! Reference: ${result.booking.reference}`);
    $('#my-bookings').scrollIntoView();
  } catch (error) { $('#booking-error').textContent = error.message; }
  finally { $('#confirm-booking').disabled = false; }
});

// 5. Display only the signed-in user's bookings and allow upcoming cancellations.
async function loadBookings() {
  if (!user) { renderBookings(); return; }
  try { bookings = (await api('/bookings')).bookings; renderBookings(); }
  catch (error) { $('#bookings').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}
function renderBookings() {
  if (!user) { $('#bookings').innerHTML = '<p class="empty">Sign in to see your bookings.</p>'; return; }
  const visibleBookings = bookings.filter(booking => $('#show-history').checked || (booking.status === 'confirmed' && new Date(booking.ends_at) > new Date()));
  $('#bookings').innerHTML = visibleBookings.map(booking => {
    const status = booking.status === 'cancelled' ? 'cancelled' : new Date(booking.ends_at) <= new Date() ? 'completed' : 'confirmed';
    const canCancel = status === 'confirmed' && new Date(booking.starts_at) > new Date();
    return `<article class="booking-row"><div><span class="status ${status}">${status}</span><h3>${escapeHtml(booking.room_name)}</h3><p>${displayDate(booking.starts_at)} · ${displayTime(booking.starts_at)}–${displayTime(booking.ends_at)} IST · ${booking.guests} guests</p><p class="reference">${escapeHtml(booking.reference)}${booking.purpose ? ` · ${escapeHtml(booking.purpose)}` : ''}</p></div><div class="booking-actions"><strong>${money(booking.total_paise)}</strong>${canCancel ? `<button class="secondary" data-cancel="${escapeHtml(booking.id)}">Cancel booking</button>` : ''}</div></article>`;
  }).join('') || '<p class="empty">No bookings to show. Your next workday starts with a room above.</p>';
}
$('#show-history').addEventListener('change', renderBookings);
$('#bookings').addEventListener('click', async event => {
  const button = event.target.closest('[data-cancel]');
  if (!button || !confirm('Cancel this booking? The room will become available again.')) return;
  button.disabled = true;
  try {
    await api(`/bookings/${button.dataset.cancel}/cancel`, 'POST', {});
    await Promise.all([loadRooms(), loadBookings()]);
    showMessage('Booking cancelled.');
  } catch (error) { showMessage(error.message); button.disabled = false; }
});

// 6. Set default dates/times and restore the user's session on page load.
function indiaDate(daysAhead) { return new Date(Date.now() + daysAhead * 86400000 + 330 * 60000).toISOString().slice(0, 10); }
$('#date').min = indiaDate(0);
$('#date').max = indiaDate(89);
$('#date').value = indiaDate(1);
for (let halfHour = 16; halfHour <= 44; halfHour++) {
  const time = `${String(Math.floor(halfHour / 2)).padStart(2, '0')}:${halfHour % 2 ? '30' : '00'}`;
  if (halfHour < 44) $('#start').add(new Option(time, time));
  if (halfHour > 16) $('#end').add(new Option(time, time));
}
$('#start').value = '09:00';
$('#end').value = '10:00';
loadRooms();
api('/auth/me').then(async result => { user = result.user; updateAccount(); await loadBookings(); }).catch(error => showMessage(error.message));
