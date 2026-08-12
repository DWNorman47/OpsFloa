// Build an external map URL for a coordinate pair or an address string, for the
// company's chosen provider (settings.map_provider). Coordinates win when
// present; otherwise the address text is handed to the provider's search.
// Opens the native app on mobile where the scheme supports it. Returns null when
// there's nothing to point at.

export const MAP_PROVIDER_NAMES = {
  google: 'Google Maps',
  apple: 'Apple Maps',
  osm: 'OpenStreetMap',
  waze: 'Waze',
  bing: 'Bing Maps',
};

export function mapUrl({ lat, lng, address } = {}, provider = 'google') {
  const hasCoords = lat != null && lat !== '' && lng != null && lng !== '' &&
    !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng));
  const a = String(address || '').trim();
  if (!hasCoords && !a) return null;
  const nlat = hasCoords ? Number(lat) : null;
  const nlng = hasCoords ? Number(lng) : null;
  const q = encodeURIComponent(hasCoords ? `${nlat},${nlng}` : a);

  switch (provider) {
    case 'apple':
      return `https://maps.apple.com/?q=${q}`;
    case 'osm':
      return hasCoords
        ? `https://www.openstreetmap.org/?mlat=${nlat}&mlon=${nlng}#map=17/${nlat}/${nlng}`
        : `https://www.openstreetmap.org/search?query=${q}`;
    case 'waze':
      return hasCoords ? `https://waze.com/ul?ll=${q}&navigate=yes` : `https://waze.com/ul?q=${q}`;
    case 'bing':
      return hasCoords ? `https://www.bing.com/maps?cp=${nlat}~${nlng}&lvl=16` : `https://www.bing.com/maps?q=${q}`;
    case 'google':
    default:
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
}

// Kept for any caller that specifically wants Google.
export function googleMapsUrl(loc) {
  return mapUrl(loc, 'google');
}
