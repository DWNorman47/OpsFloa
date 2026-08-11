// Build a Google Maps URL for a coordinate pair or an address string.
// Uses the documented Maps URL scheme (opens in the app on mobile, web otherwise).
// Coordinates win when present; otherwise the address text is geocoded by Maps.
// Returns null when there's nothing to point at.
export function googleMapsUrl({ lat, lng, address } = {}) {
  const hasCoords = lat != null && lat !== '' && lng != null && lng !== '' &&
    !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng));
  if (hasCoords) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${Number(lat)},${Number(lng)}`)}`;
  }
  const a = String(address || '').trim();
  if (a) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
  return null;
}
