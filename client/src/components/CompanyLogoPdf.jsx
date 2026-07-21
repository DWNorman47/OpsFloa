import React from 'react';
import { Image } from '@react-pdf/renderer';

/**
 * Company logo for report / invoice / estimate PDF headers.
 *
 * Renders nothing when the company hasn't set a logo, so it's safe to drop into
 * any header unconditionally. `src` is `companyInfo.logo_url` (a public R2 URL,
 * which @react-pdf/renderer loads directly, same as report photos). Pass a
 * `style` for size/placement — the caller owns the layout.
 */
export default function CompanyLogoPdf({ src, style }) {
  if (!src) return null;
  return <Image src={src} style={style} />;
}
