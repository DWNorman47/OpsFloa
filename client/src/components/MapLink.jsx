import React from 'react';
import { googleMapsUrl } from '../utils/maps';
import { useT } from '../hooks/useT';

/**
 * "Open in Google Maps" link — opens a coordinate pair or an address in a new tab.
 * Renders nothing when there's no location. `stopPropagation` so it works inside
 * clickable rows/cards. Pass `lat`+`lng`, or `address`, or both (coords win).
 */
export default function MapLink({ lat, lng, address, label, iconOnly = false, showIcon = true, style, className }) {
  const t = useT();
  const url = googleMapsUrl({ lat, lng, address });
  if (!url) return null;
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
      {showIcon ? '📍' : ''}{iconOnly ? '' : <span>{label || t.mapsShort}</span>}
    </a>
  );
}
