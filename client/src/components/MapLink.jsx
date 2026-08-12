import React from 'react';
import { mapUrl, MAP_PROVIDER_NAMES } from '../utils/maps';
import { useMapProvider } from '../contexts/SettingsContext';
import { useT } from '../hooks/useT';

/**
 * "Open in maps" link — opens a coordinate pair or an address in a new tab, using
 * the company's chosen map provider (settings.map_provider, default Google Maps).
 * Renders nothing when there's no location. `stopPropagation` so it works inside
 * clickable rows/cards and Leaflet marker popups. Pass `lat`+`lng`, or `address`,
 * or both (coords win). By default the visible label is the provider's name
 * (e.g. "Google Maps"); pass `label` to override, `iconOnly` for just the 📍.
 */
export default function MapLink({ lat, lng, address, label, iconOnly = false, showIcon = true, style, className }) {
  const t = useT();
  const provider = useMapProvider();
  const url = mapUrl({ lat, lng, address }, provider);
  if (!url) return null;
  const text = label ?? (MAP_PROVIDER_NAMES[provider] || 'Maps');
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none',
    color: 'var(--ops-page-accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  };
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={t.openInMaps}
      aria-label={t.openInMaps}
      onClick={e => e.stopPropagation()}
      style={{ ...base, ...style }}
      className={className}
    >
      {showIcon ? '📍' : ''}{iconOnly ? '' : <span>{text}</span>}
    </a>
  );
}
