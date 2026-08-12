/**
 * Which external map service the app's "open in maps" links point at
 * (settings.map_provider). Coordinate-based links; each provider also accepts a
 * free-text address query as a fallback. See client/src/utils/maps.js +
 * client/src/components/MapLink.jsx. Default Google Maps.
 */
const MAP_PROVIDERS = Object.freeze(['google', 'apple', 'osm', 'waze', 'bing']);
const DEFAULT_MAP_PROVIDER = 'google';

module.exports = { MAP_PROVIDERS, DEFAULT_MAP_PROVIDER };
